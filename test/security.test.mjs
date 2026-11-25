import test from 'node:test';
import assert from 'node:assert/strict';
import { openAccounts, createAccount, setLogin, verifyLogin, changeLogin, issuePin, requestReset, approveReset, markRequestSent } from '../lib/accounts.mjs';
import { Unlocks } from '../lib/unlocks.mjs';
import { sendReset } from '../lib/discord.mjs';

test('login setup, independent emergency PIN, current PIN required for changes', () => {
  const db = openAccounts(':memory:'), {
    id
  } = createAccount(db);
  assert.equal(setLogin(db, id, '123456'), true);
  assert.equal(setLogin(db, id, '555555'), false);
  assert.equal(verifyLogin(db, id, '123456'), 'ok');
  assert.equal(issuePin(db, id, '123456'), null);
  assert.equal(issuePin(db, id, '123457'), '123457');
  assert.equal(changeLogin(db, id, '123456', '123457'), 'same-emergency');
  assert.equal(changeLogin(db, id, '000000', '123458'), 'invalid');
  assert.equal(changeLogin(db, id, '123456', '123458'), 'ok');
  assert.equal(verifyLogin(db, id, '123458'), 'ok');
  db.close();
});

test('login lockout persists', () => {
  const db = openAccounts(':memory:'), {
    id
  } = createAccount(db);
  setLogin(db, id, '123456');
  for (let i = 0; i < 5; i++) assert.equal(verifyLogin(db, id, '000000', 100), 'invalid');
  assert.equal(verifyLogin(db, id, '123456', 101), 'locked');
  assert.equal(verifyLogin(db, id, '123456', 100 + 900000), 'ok');
  db.close();
});

test('unlock tokens scoped, revocable and expiring', () => {
  let now = 0;
  const s = new Unlocks(() => now, 100);
  const a = s.issue('a');
  assert(!s.check('b', a));
  assert(s.check('a', a));
  s.revoke('a', a);
  assert(!s.check('a', a));
  const b = s.issue('a');
  now = 100;
  assert(!s.check('a', b));
  const c = s.issue('a');
  s.revokeAll('a');
  assert(!s.check('a', c));
});

test('Discord reset payload and Swiss time', async() => {
  let payload;
  await sendReset('ABC123', 'https://discord.com/api/webhooks/123/test', async(url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true
    };
  }, new Date('2026-11-25T20:00:00Z'));
  assert.equal(payload.content, undefined);
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, 'emg.exe | Reset request');
  assert.equal(payload.embeds[0].color, 0xBD0000);
  assert.equal(payload.embeds[0].description, '```\nTime: 21:00:00\nReference: ABC123\nApplied\n```');
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  await assert.rejects(sendReset('ABC', 'https://example.com/api/webhooks/123/test', async() => ({
    ok: true
  })));
});

test('request delivery bookkeeping and developer approval', () => {
  const db = openAccounts(':memory:'), {
    id
  } = createAccount(db);
  issuePin(db, id, '123456');
  const ref = requestReset(db, id);
  markRequestSent(db, ref);
  assert.equal(db.prepare('SELECT request_sent FROM accounts WHERE id=?').get(id).request_sent, 1);
  assert(approveReset(db, ref));
  assert.equal(issuePin(db, id, '123457'), '123457');
  db.close();
});
