import express from 'express';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Chats } from './lib/chats.mjs';
import { openAccounts, createAccount, findAccount, issuePin, usePin, requestReset, setLogin, verifyLogin, changeLogin, validPin, markRequestSent, connectionBlocks } from './lib/accounts.mjs';

import { Unlocks } from './lib/unlocks.mjs';
import { sendReset } from './lib/discord.mjs';
import { handleAdminCommand } from './lib/admin.mjs';
import { startAdminSocket } from './lib/admin-socket.mjs';

process.umask(0o077);
const root = dirname(fileURLToPath(import.meta.url));
const app = express(), db = openAccounts();
const blocks = connectionBlocks(db);
const chats = new Chats(Date.now, undefined, blocks);
const unlocks = new Unlocks(), sendingResets = new Map();
const production = process.env.NODE_ENV === 'production';
if (production && !process.env.PUBLIC_ORIGIN) throw new Error('Set PUBLIC_ORIGIN to your HTTPS origin.');
const publicOrigin = process.env.PUBLIC_ORIGIN;
if (production && !publicOrigin.startsWith('https://')) throw new Error('HTTPS required.');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob: data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  if (production) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use((req, res, next) => express.json({ limit: req.path === '/api/message' ? '3mb' : '12kb' })(req, res, next));
const cookieName = production ? '__Host-qzu': 'qzu';
const readToken = req => req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
const limits = new Map();

function rate(key, max, period) {
  const now = Date.now(), old = limits.get(key);
  const bucket = old && old.until > now ? old: {
    count: 0,
    until: now + period
  };
  limits.set(key, bucket);
  return++bucket.count <= max;
}
const timer = setInterval(() => {
  chats.sweep();
  unlocks.sweep();
  const now = Date.now();
  for (const [k, v] of limits) if (v.until <= now) limits.delete(k);
}, 1000);
timer.unref();
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.get('origin');
    const allowed = publicOrigin || req.protocol + '://' + req.get('host');
    if (req.get('x-qzu') !== '1' || (origin && origin !== allowed)) return res.status(403).json({
      error: 'Request rejected.'
    });
  }
  if (!rate('ip:' + req.ip, 600, 60_000)) return res.status(429).json({
    error: 'Try again shortly.'
  });
  req.account = findAccount(db, readToken(req));
  next();
});
app.post('/api/session', (req, res) => {
  if (!req.account) {
    if (!rate('new:' + req.ip, 20, 60 * 60_000)) return res.status(429).json({
      error: 'Try again later.'
    });
    const {
      token,
      id
    } = createAccount(db);
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: production,
      sameSite: 'strict',
      path: '/',
      maxAge: 365 * 24 * 60 * 60_000
    });
    req.account = {
      id,
      login_hash: null
    };
  }
  res.json({
    needsSetup: !req.account.login_hash
  });
});
app.use('/api', (req, res, next) => req.account ? next(): res.status(401).json({
  error: 'Session unavailable.'
}));
const guard = (name, max, period) => (req, res, next) => rate(name + ':' + req.account.id, max, period) ? next(): res.status(429).json({
  error: 'Try again shortly.'
});

function loginError(res, result) {
  return res.status(result === 'locked' ? 429: 400).json({
    error: result === 'locked' ? 'Try again in 15 minutes.': result === 'same-emergency' ? 'Choose a different PIN.': 'Incorrect or unavailable PIN.'
  });
}
app.post('/api/login/setup', guard('login-setup', 5, 60_000), (req, res) => {
  if (!validPin(req.body?.pin) || !setLogin(db, req.account.id, req.body.pin)) return res.status(400).json({
    error: 'Choose a different PIN or unlock.'
  });
  if (!chats.inviteFor(req.account.id)) chats.newCode(req.account.id);
  res.json({
    token: unlocks.issue(req.account.id)
  });
});
app.post('/api/login/unlock', guard('unlock', 10, 60_000), (req, res) => {
  const result = verifyLogin(db, req.account.id, req.body?.pin);
  if (result !== 'ok') return loginError(res, result);
  res.json({
    token: unlocks.issue(req.account.id)
  });
});
app.post('/api/login/lock', (req, res) => {
  unlocks.revoke(req.account.id, req.get('x-qzu-unlock'));
  res.json({
    ok: true
  });
});
app.post('/api/login/emergency', guard('pin-use', 10, 15 * 60_000), (req, res) => {
  if (req.body?.confirmed !== true) {
    return res.status(400).json({ error: 'Confirm the deletion first.' });
  }

  const result = usePin(db, req.account.id, req.body?.pin);

  if (result !== 'ok') {
    return res.status(result === 'locked' ? 429 : 400).json({
      error: result === 'locked' ? 'Try again in 15 minutes.' : 'Invalid or unavailable emergency PIN.'
    });
  }

  chats.erase(req.account.id);
  unlocks.revokeAll(req.account.id);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (!unlocks.check(req.account.id, req.get('x-qzu-unlock'))) return res.status(423).json({
    error: 'Locked.'
  });
  next();
});
app.post('/api/login/change', guard('login-change', 10, 60_000), (req, res) => {
  const result = changeLogin(db, req.account.id, req.body?.current, req.body?.next);
  if (result !== 'ok') return loginError(res, result);
  unlocks.revokeAll(req.account.id);
  res.json({
    token: unlocks.issue(req.account.id)
  });
});
app.get('/api/state', (req, res) => {
  const a = req.account;
  chats.markPresent(a.id);
  res.json({
    now: Date.now(),
    rooms: chats.snapshot(a.id),
    requests: chats.connectionRequests(a.id),
    invite: chats.ensureInvite(a.id),
    pinState: a.pin_state,
    resetPending: Boolean(a.request),
    resetDelivered: Boolean(a.request && a.request_sent)
  });
});
app.post('/api/invite', guard('invite', 15, 60_000), (req, res) => res.json(chats.newCode(req.account.id)));
app.get('/api/qr', async(req, res) => {
  const inv = chats.ensureInvite(req.account.id);
  const origin = publicOrigin || req.protocol + '://' + req.get('host');
  const image = await QRCode.toDataURL(origin + '/connect#' + inv.code, {
    width: 320,
    margin: 4,
    errorCorrectionLevel: 'M'
  });
  res.json({ image, code: inv.code, expires: inv.expires });
});
app.post('/api/connect', guard('connect', 10, 60_000), (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase(): '';
  if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({
    error: 'Enter a 6-character code.'
  });
  res.json(chats.requestConnection(req.account.id, code));
});
app.post('/api/message', guard('send', 80, 60_000), (req, res) => {
  chats.send(req.account.id, req.body?.id, req.body?.text, req.body?.replyTo ?? null, req.body || {});
  res.json({
    ok: true
  });
});
app.post('/api/connection/respond', guard('connection-response', 30, 60_000), (req, res) => {
  res.json(chats.respondConnection(req.account.id, req.body?.id, req.body?.accept === true));
});

app.post('/api/message/edit', guard('edit', 40, 60_000), (req, res) => {
  chats.edit(req.account.id, req.body?.id, req.body?.messageId, req.body?.text);
  res.json({ ok: true });
});

app.post('/api/message/react', guard('react', 80, 60_000), (req, res) => {
  chats.react(req.account.id, req.body?.id, req.body?.messageId, req.body?.emoji);
  res.json({ ok: true });
});

app.post('/api/message/open', guard('open', 80, 60_000), (req, res) => {
  res.json(chats.openOnce(req.account.id, req.body?.id, req.body?.messageId));
});

app.get('/api/media/:room/:message', guard('media', 120, 60_000), (req, res) => {
  const media = chats.getMedia(req.account.id, req.params.room, req.params.message);
  res.type(media.mime).send(media.bytes);
});

app.post('/api/block', guard('block', 20, 60_000), (req, res) => {
  chats.blockContact(req.account.id, req.body?.id, req.body?.member);
  res.json({ ok: true });
});

app.get('/api/blocks', (req, res) => {
  res.json({ blocks: blocks.list(req.account.id) });
});

app.post('/api/unblock', guard('unblock', 20, 60_000), (req, res) => {
  blocks.remove(req.account.id, req.body?.target);
  res.json({ ok: true });
});

app.post('/api/group/create', guard('group-create', 10, 60_000), (req, res) => {
  res.json({ id: chats.createGroup(req.account.id) });
});

app.post('/api/group/invite', guard('group-invite', 20, 60_000), (req, res) => {
  res.json(chats.groupInvite(req.account.id, req.body?.id));
});

app.post('/api/typing', guard('typing', 100, 60_000), (req, res) => {
  chats.setTyping(req.account.id, req.body?.id, req.body?.active);
  res.json({ ok: true });
});

app.post('/api/receipts', guard('receipts', 100, 60_000), (req, res) => {
  chats.acknowledge(req.account.id, req.body?.entries);
  res.json({ ok: true });
});

app.post('/api/chat/delete', (req, res) => {
  chats.remove(req.account.id, req.body?.id);
  res.json({
    ok: true
  });
});
app.post('/api/pin/issue', guard('pin-issue', 5, 60_000), (req, res) => {
  const pin = issuePin(db, req.account.id, req.body?.pin);
  if (pin === null) return res.status(409).json({
    error: 'Choose a different PIN, or request a reset.'
  });
  res.json({
    ok: true
  });
});
app.post('/api/pin/reset', guard('pin-reset', 5, 60_000), async(req, res) => {
  const id = req.account.id;
  const ref = requestReset(db, id);
  if (!ref) return res.status(409).json({
    error: 'Reset unavailable.'
  });
  if (req.account.request === ref && req.account.request_sent) return res.json({
    pending: true
  });
  try {
    if (!sendingResets.has(ref)) {
      const delivery = sendReset(ref).then(() => markRequestSent(db, ref)).finally(() => sendingResets.delete(ref));
      sendingResets.set(ref, delivery);
    }
    await sendingResets.get(ref);
    res.json({
      pending: true
    });
  } catch {
    res.status(503).json({
      error: 'Reset delivery unavailable. Try again.'
    });
  }
});
app.post('/api/emergency', guard('pin-use', 10, 15 * 60_000), (req, res) => {
  const result = usePin(db, req.account.id, req.body?.pin);
  if (result !== 'ok') return res.status(result === 'locked' ? 429: 400).json({
    error: result === 'locked' ? 'Try again in 15 minutes.': result === 'unavailable' ? 'PIN unavailable.': 'Incorrect PIN.'
  });
  chats.erase(req.account.id);
  res.json({
    ok: true
  });
});
app.use('/api', (req, res) => res.status(404).json({
  error: 'Not found.'
}));
app.get('/vendor/jsqr.js', (req, res) => res.sendFile(resolve(root, 'node_modules/jsqr/dist/jsQR.js')));
app.use(express.static(resolve(root, 'public'), {
  index: false,
  etag: false,
  lastModified: false
}));
app.get(['/', '/chat', '/connect', '/settings'], (req, res) => res.sendFile(resolve(root, 'public/index.html')));
app.use((req, res) => res.status(404).send('Not found'));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status: 500;
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong.': err.message
  });
});
const port = Number(process.env.PORT || 3000);
startAdminSocket(command => handleAdminCommand(db, chats, command))
  .then(() => {
    app.listen(port, process.env.HOST || '0.0.0.0', () => console.log('qzu. listening on ' + port));
  })
  .catch(error => {
    console.error(error.message);
    db.close();
    process.exitCode = 1;
  });
