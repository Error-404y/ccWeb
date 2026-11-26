'use strict';
const $ = id => document.getElementById(id);
const native = window.Capacitor?.isNativePlatform?.() === true;
if (native) document.documentElement.classList.add('native-app');
const apiOrigin = native ? window.QZU_API_ORIGIN : location.origin;
const devicePlugin = native ? window.Capacitor.registerPlugin('QzuDevice') : null;
const installedVersion = window.QZU_APP_VERSION || '0.9.5';
const roomKeyJobs = new Map();
const roomKeys = new Map();
let nextUpdateCheck = 0, pendingUpdate = null, updateChecking = false;
const updateReminders = new Map();

async function transport(path, options = {}) {
  if (!native) return fetch(path, options);
  if (!apiOrigin || !apiOrigin.startsWith('https://')) throw new Error('Mobile server unavailable.');
  if (!window.Capacitor.isPluginAvailable('QzuDevice')) throw new Error('Native device plugin unavailable.');
  const headers = { ...options.headers };
  const timestamp = String(Date.now());
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const message = JSON.stringify(['qzu-device-v1', options.method || 'GET', path, timestamp, nonce, headers['X-QZU-Unlock'] || '', options.body || '']);
  let result;
  try {
    if (path === '/api/session') console.info('[qzu] Signing session request');
    result = await devicePlugin.sign({ message });
  } catch (error) {
    console.error('[qzu] Device signing failed:', String(error?.message || error));
    throw new Error('Device signing failed.');
  }
  Object.assign(headers, { 'X-QZU-Device': result.publicKey, 'X-QZU-Signature': result.signature, 'X-QZU-Time': timestamp, 'X-QZU-Nonce': nonce });
  try {
    if (path === '/api/session') console.info('[qzu] Sending signed session request');
    const response = await fetch(apiOrigin + path, { ...options, headers, credentials: 'omit' });
    if (path === '/api/session') console.info('[qzu] Session HTTP status:', response.status);
    return response;
  } catch (error) {
    console.error('[qzu] HTTPS request failed:', String(error?.message || error));
    throw new Error('HTTPS connection unavailable.');
  }
}

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const svg = (name, cls) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) node.setAttribute('class', cls);
  node.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(node.namespaceURI, 'use');
  use.setAttribute('href', '#' + name);
  node.append(use);
  return node;
};
let page = routeName(location.pathname);
const mobile = native ? { matches: true, addEventListener() {} } : matchMedia('(max-width:700px)');
let state = {
  rooms: [],
  invite: null,
  pinState: null,
  resetPending: false,
  resetDelivered: false
};

let offset = 0;
const officialChannel = Symbol('qzu-info');
let selected = null;
let burnSeconds = 0;
let mobileOpen = false;
let sequence = 0;
let started = false;
let renderedRoom = null;
let renderedMessages = [];
let contactKey = '';
let qrKey = '';
let pinPrompt = false;
let stream = null;
let scanFrame = 0;
let scannerLoad = null;
let modalLocked = false;
let online = true;
const modal = $('modal'), body = $('modalBody');
let unlockToken = null;
let authEpoch = 0;
let authBusy = false;
let sessionReady = false;
let needsSetup = false;
let lockPromptId = 0;
let qrPending = '';
let loopStarted = false;
let pendingInvite = '';
let sendingMessage = false;
let accessDue = false;
let accessTimer = null;
let checkoutEpoch = 0;
let resumeCheckout = null;
let checkoutReturn = null;
let viewOnce = false;
let mediaRoom = null;
let mediaMessage = null;
let invisibleSaving = false;
let mediaUrl = null;
let recordingCleanup = null;
const reactions = ['👍', '❤️', '😂', '🔥', '😮', '👎'];
let privacyMode = false;
let replyTarget = null;
let lastTypingAt = 0;
let typingRoom = null;
let receiptsInFlight = false;
const revealedMessages = new Set();
const acknowledgedDelivery = new Set();
const acknowledgedRead = new Set();

function routeName(path) {
  return path === '/settings' || path.startsWith('/settings/') ? 'settings': path === '/connect' ? 'connect': 'chat';
}

function updatePages() {
  for (const name of ['chat', 'settings', 'connect']) $(name + 'Page').hidden = !unlockToken || accessDue || name !== page;
  $('loading').hidden = Boolean(unlockToken);
  $('loading').classList.toggle('locked', !unlockToken);
}

function navigate(path, push = true) {
  if (push) history.pushState(null, '', path);
  const nextPage = routeName(location.pathname);
  if (page !== nextPage) {
    resetOnce();
    closeModal();
    stopTyping();
    clearReply();
    revealedMessages.clear();
    contactKey = '';
    renderedRoom = null;
  }
  page = nextPage;
  if (page === 'connect' && pendingInvite && unlockToken) {
    $('enterCode').value = pendingInvite;
    pendingInvite = '';
  }
  updatePages();
  render();
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const url = new URL(a.href);
  if (url.origin !== location.origin || !['/chat', '/connect', '/settings', '/settings/privacy', '/settings/appearance', '/settings/account', '/settings/updates', '/settings/help', '/settings/about', '/'].includes(url.pathname)) return;
  e.preventDefault();
  if (unlockToken) navigate(url.pathname);
});
window.addEventListener('popstate', () => navigate(location.pathname, false));
const fmtTime = ms => new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit'
}).format(new Date(ms));
const clock = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};
const serverNow = () => Date.now() + offset;
const supportClock = (room,now) => room.persistent ? 'No expiry' : room.mobileSupport && room.expires-now >= 3600000 ? Math.ceil((room.expires-now)/60000/60)+'h' : clock(room.expires-now);
const nameFor = room => room.support ? (room.supportAgent ? 'Contact ' + room.id.slice(0,4).toUpperCase() : 'qzu-Support') : room.admin ? 'Announcements' : room.contact?.nickname || (room.group ? 'Group ' : 'Chat ') + room.id.slice(0, 4).toUpperCase();

function stopCamera() {
  cancelAnimationFrame(scanFrame);
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}

function closeModal() {
  if (modalLocked) return;
  stopCheckout();
  delete modal.dataset.checkout;
  clearMedia();
  stopCamera();
  if (modal.open) modal.close();
  body.replaceChildren();
}
$('modalClose').addEventListener('click', closeModal);
modal.addEventListener('cancel', e => {
  e.preventDefault();
  if (modal.classList.contains('update-sheet') && pendingUpdate) deferUpdate(pendingUpdate.latest);
  closeModal();
});
modal.addEventListener('close', () => {
  if (!modal.open) {
    clearMedia();
    stopCamera();
    body.replaceChildren();
    modalLocked = false;
    modal.classList.remove('update-sheet');
  }
});

function show(title, content, locked = false) {
  stopCheckout();
  delete modal.dataset.checkout;
  modal.classList.remove('update-sheet');
  clearMedia();
  stopCamera();
  modalLocked = locked;
  $('modalClose').hidden = locked;
  $('modalTitle').textContent = title;
  modal.classList.toggle('pin-screen', native && content.some(node => node.classList?.contains('pin-screen-form')));
  body.replaceChildren(...content);
  if (!modal.open) modal.showModal();
  if (native) $('modalTitle').focus({ preventScroll: true });
}

function button(text, fn, cls = 'primary-button') {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}

function info(title, message) {
  if (!unlockToken) return;
  show(title, [el('p', '', message), button('OK', closeModal)]);
}

function errorMessage(error) {
  return error instanceof Error ? error.message: 'Try again.';
}

function showError(error) {
  info('qzu.', errorMessage(error));
}

function modalError(error) {
  if (!unlockToken) return;
  dialogError(error);
}

function dialogError(error) {
  let p = body.querySelector('.modal-error');
  if (!p) {
    p = el('p', 'modal-error');
    p.setAttribute('role', 'alert');
    const form = body.querySelector('.pin-screen-form');
    if (form) form.querySelector('.pin-fields').append(p);
    else body.append(p);
  }
  p.textContent = errorMessage(error);
}

async function api(path, data, quiet = false) {
  const write = data !== undefined, epoch = authEpoch, token = unlockToken;
  const authRoute = ['session', 'login/setup', 'login/unlock', 'login/emergency'].includes(path) || path.startsWith('access/');
  const publicPurchase = !token && isPublicCheckout() && (path.startsWith('access/') || path === 'session');
  if (!authRoute && !token) throw new Error('Locked.');
  if (write && !quiet) sequence++;
  const headers = {};
  if (write) {
    headers['Content-Type'] = 'application/json';
    headers['X-QZU'] = '1';
  }
  if (token) headers['X-QZU-Unlock'] = token;
  let res;
  try {
    res = await transport('/api/' + path, {
      method: write ? 'POST': 'GET',
      headers,
      body: write ? JSON.stringify(data): undefined,
      cache: 'no-store',
      credentials: 'same-origin',
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined
    });
  }
  catch (error) {
    if (native) {
      console.error('[qzu] API startup/request error:', String(error?.message || error));
      throw new Error(['Mobile server unavailable.', 'Native device plugin unavailable.', 'Device signing failed.', 'HTTPS connection unavailable.'].includes(error?.message) ? error.message : 'Mobile request failed. See Xcode console.');
    }
    throw new Error('Connection unavailable.');
  }
  const result = await res.json().catch(() => ({}));
  if (epoch !== authEpoch || (document.hidden && !publicPurchase)) {
    if (result.token) revokeToken(result.token);
    throw new Error('Locked.');
  }
  if (res.status === 402 && !authRoute) {
    accessDue = true;
    updatePages();
    showRenewal();
    throw new Error('qzu-Access renewal required.');
  }
  if (res.status === 423 && !authRoute) {
    lock();
    throw new Error('Locked.');
  }
  if (!res.ok) throw new Error(result.error || 'Try again.');
  return result;
}

function revokeToken(token) {
  if (!token) return;
  transport('/api/login/lock', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-QZU': '1',
      'X-QZU-Unlock': token
    },
    body: '{}',
    credentials: 'same-origin',
    cache: 'no-store',
    keepalive: true
  }).catch(() => {});
}

function pinField(label, placeholder = '6-digit PIN') {
  const wrap = el(native ? 'div' : 'label', native ? 'pin-field' : '', label), input = el('input', 'pin-input');
  input.type = 'password';
  input.inputMode = native ? 'none' : 'numeric';
  input.readOnly = native;
  input.autocomplete = 'off';
  input.maxLength = 6;
  input.placeholder = placeholder;
  input.required = true;
  input.pattern = '[0-9]{6}';
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
  });
  wrap.append(input);
  return {
    wrap,
    input
  };
}

function pinKeypad(inputs) {
  if (!native) return null;
  const pad = el('div', 'pin-keypad');
  pad.setAttribute('role', 'group');
  pad.setAttribute('aria-label', 'PIN keypad');
  const displays = new Map();
  let active = inputs[0];

  function update(field) {
    const display = displays.get(field);
    const count = field.value.length;
    display.setAttribute('aria-label', (field.getAttribute('aria-label') || 'PIN') + ', ' + count + ' of 6 digits entered');
    display.classList.toggle('pin-selected', field === active);
    display.setAttribute('aria-pressed', String(field === active));
    Array.from(display.children).forEach((dot, index) => dot.classList.toggle('filled', index < count));
  }

  function select(field) {
    active = field;
    inputs.forEach(update);
  }

  function enter(key) {
    if (!active.isConnected || active.disabled) return;
    const field = active;
    if (key === 'clear') field.value = '';
    else if (key === 'back') field.value = field.value.slice(0, -1);
    else if (field.value.length < 6) field.value += key;
    else return;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    if (/^\d$/.test(key) && field.value.length === 6) {
      const next = inputs[inputs.indexOf(field) + 1];
      if (next) select(next);
    }
  }

  function hardware(event) {
    if (!/^\d$/.test(event.key) && !['Backspace', 'Delete'].includes(event.key)) return;
    event.preventDefault();
    enter(event.key === 'Backspace' ? 'back' : event.key === 'Delete' ? 'clear' : event.key);
  }

  for (const field of inputs) {
    const display = button('', () => select(field), 'pin-dots');
    for (let index = 0; index < 6; index++) {
      const dot = el('span', 'pin-dot');
      dot.setAttribute('aria-hidden', 'true');
      display.append(dot);
    }
    field.hidden = true;
    field.tabIndex = -1;
    displays.set(field, display);
    field.after(display);
    field.addEventListener('input', () => update(field));
    display.addEventListener('focus', () => select(field));
    display.addEventListener('keydown', hardware);
  }
  for (const key of ['1','2','3','4','5','6','7','8','9','clear','0','back']) {
    const control = button(key === 'clear' ? 'Clear' : key === 'back' ? '←' : key, () => enter(key), 'pin-key');
    if (key === 'back') control.setAttribute('aria-label', 'Delete last digit');
    if (key === 'clear') control.setAttribute('aria-label', 'Clear PIN');
    control.addEventListener('keydown', hardware);
    pad.append(control);
  }
  select(active);
  return pad;
}

function pinDialog(title, fields, submitLabel, onSubmit, {
  locked = false,
  note = '',
  auth = false
} = {}) {
  const fullScreen = native && auth;
  const autoUnlock = fullScreen && fields.length === 1;
  const form = el('form', 'auth-form' + (fullScreen ? ' pin-screen-form' : '')), items = fields.map(label => pinField(label));
  const fieldGroup = el('div', 'pin-fields');
  if (note) fieldGroup.append(el('p', '', note));
  for (const item of items) fieldGroup.append(item.wrap);
  form.append(fieldGroup);
  const keypad = pinKeypad(items.map(item => item.input));
  if (keypad) form.append(keypad);
  const submit = el('button', 'primary-button', submitLabel);
  submit.type = 'submit';
  form.append(submit);
  if (autoUnlock) {
    submit.hidden = true;
    items[0].input.addEventListener('input', () => {
      if (items[0].input.value.length === 6 && !submit.disabled) form.requestSubmit();
    });
  }
  if (!locked) form.append(button('Cancel', closeModal, 'secondary-button'));
  const epoch = authEpoch;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (submit.disabled || epoch !== authEpoch) return;
    const values = items.map(item => item.input.value);
    if (values.some(v => !/^\d{6}$/.test(v))) {
      dialogError(new Error('Enter all six digits for each PIN.'));
      return;
    }
    submit.disabled = true;
    if (native) items.forEach(item => { item.input.disabled = true; });
    try {
      await onSubmit(values);
    } catch (err) {
      if (epoch === authEpoch && body.contains(form)) {
        dialogError(err);
        submit.disabled = false;
        if (native) items.forEach(item => {
          item.input.disabled = false;
          item.input.value = '';
          item.input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
    }
    finally {
      values.fill('');
    }
  });
  const brand = el('div', 'auth-brand');
  brand.append(svg('logo', 'wordmark'));
  if (fullScreen) form.prepend(brand);
  show(fullScreen && autoUnlock ? 'Enter your PIN' : title, auth && !fullScreen ? [brand, form] : [form], locked);
}

function showLogin() {
  if (document.hidden || unlockToken || !sessionReady) return;
  const setup = needsSetup;
  pinDialog(setup ? 'Create login PIN': 'Unlock', setup ? ['New PIN', 'Confirm PIN']: ['Login PIN'], setup ? 'Create': 'Unlock', async values => {
    if (setup && values[0] !== values[1]) throw new Error('PINs do not match.');
    const result = await api(setup ? 'login/setup': 'login/unlock', {
      pin: values[0]
    });
    unlockToken = result.token;
    accessDue = result.access?.active === false;
    needsSetup = false;
    modalLocked = false;
    closeModal();
    if (accessDue || checkoutReturn) {
      updatePages();
      const resume = checkoutReturn;
      checkoutReturn = null;
      if (resume) resume();
      else showRenewal();
      return;
    }
    navigate(location.pathname, false);
    try {
      await refresh();
    } catch {
      lock();
    }
  }, {
    locked: true,
    auth: true
  });

  if (!setup) {
    const divider = el('div', 'login-divider');
    const emergency = button('emg', showLockedEmergency, 'secondary-button login-emg');
    emergency.prepend(svg('terminal'));
    const form = body.querySelector('.auth-form');
    if (native) form.insertBefore(emergency, form.querySelector('.pin-keypad'));
    else form.append(divider, emergency);
  }
}

function showLockedEmergency() {
  if (unlockToken || document.hidden || !sessionReady || needsSetup) return;

  const form = el('form', 'auth-form');
  const { wrap, input } = pinField('Emergency PIN', 'Enter PIN');
  const warning = el('p', 'emg-warning', 'Delete all your active chats for both participants. This cannot be undone.');
  const confirmation = el('label', 'emg-confirmation');
  const check = el('input');
  check.type = 'checkbox';
  check.required = true;
  confirmation.append(check, el('span', '', 'I confirm deletion.'));

  const actions = el('div', 'emg-actions');
  const cancel = button('Cancel', showLogin, 'secondary-button');
  const execute = el('button', 'primary-button danger-button', 'Execute');
  execute.type = 'submit';
  execute.disabled = true;
  actions.append(cancel, execute);
  form.append(wrap);
  const keypad = pinKeypad([input]);
  if (keypad) form.append(keypad);
  form.append(warning, confirmation, actions);

  function updateButton() {
    execute.disabled = input.value.length !== 6 || !check.checked;
  }

  input.addEventListener('input', updateButton);
  check.addEventListener('change', updateButton);

  const epoch = authEpoch;

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (execute.disabled || epoch !== authEpoch || !check.checked) return;

    execute.disabled = true;
    cancel.disabled = true;

    try {
      await api('login/emergency', {
        pin: input.value,
        confirmed: true
      });

      input.value = '';
      pendingInvite = '';
      roomKeys.clear();
      roomKeyJobs.clear();
      lock(false);

      show('emg.exe', [
        el('p', '', 'Your active chats have been deleted.'),
        button('OK', showLogin)
      ], true);
    } catch (error) {
      if (epoch !== authEpoch || !body.contains(form)) return;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      check.checked = false;
      cancel.disabled = false;
      updateButton();
      dialogError(error);
      if (!native) input.focus();
    }
  });

  show('emg.exe', [form], true);
  if (!native) input.focus();
}

async function getSession() {
  if (authBusy || document.hidden || unlockToken || isPublicCheckout()) return;
  authBusy = true;
  const epoch = authEpoch;
  try {
    const result = await api('session', {});
    if (epoch !== authEpoch) return;
    if (result.accessRequired) {
      sessionReady = false;
      const saved = savedInvoice(false);
      if (saved) showInvoice(saved, null, false);
      else showAccess();
      return;
    }
    sessionReady = true;
    needsSetup = result.needsSetup;
    showLogin();
  }
  catch (e) {
    if (epoch === authEpoch && !document.hidden) show('qzu.', [el('p', '', errorMessage(e)), button('Retry', () => {
      getSession();
    })], true);
  }
  finally {
    authBusy = false;
    if (epoch !== authEpoch && !document.hidden && !unlockToken) getSession();
  }
}

function lock(reopen = true) {
  if (isPublicCheckout()) return;
  if (modal.dataset.checkout === 'renewal') {
    const saved = savedInvoice(true);
    checkoutReturn = saved ? () => showInvoice(saved, null, true) : showRenewal;
  }
  stopCheckout();
  accessDue = false;
  authEpoch++;
  sequence++;
  const old = unlockToken;
  unlockToken = null;
  pendingUpdate = null;
  nextUpdateCheck = 0;
  sendingMessage = false;
  invisibleSaving = false;
  $('invisibleMode').checked = false;
  resetOnce();
  clearMedia();
  $('connectionRequests').hidden = true;
  $('presenceLabel').hidden = true;
  $('presenceLabel').textContent = '';
  $('encryptionStatus').hidden = true;
  $('encryptionNotice').hidden = true;
  typingRoom = null;
  lastTypingAt = 0;
  receiptsInFlight = false;
  acknowledgedDelivery.clear();
  acknowledgedRead.clear();
  revealedMessages.clear();
  clearReply();
  $('typingIndicator').hidden = true;
  $('typingLabel').textContent = '';
  $('memberCount').hidden = true;
  $('memberCount').textContent = '';
  $('expiryProgress').hidden = true;
  $('extensionNotice').hidden = true;
  $('supportOpen').hidden = true;
  $('qzuInfoChannel').hidden = true;
  $('qzuInfoOpen').classList.remove('active');
  $('qzuInfoOpen').setAttribute('aria-pressed', 'false');
  $('groupInvite').hidden = true;
  revokeToken(old);
  stopCamera();
  pinPrompt = false;
  qrKey = '';
  qrPending = '';
  state = {
    rooms: [],
    invite: null,
    pinState: null,
    resetPending: false,
    resetDelivered: false
  };
  selected = null;
  mobileOpen = false;
  contactKey = '';
  renderedRoom = null;
  renderedMessages = [];
  $('contacts').replaceChildren();
  $('messages').replaceChildren();
  $('message').value = '';
  $('enterCode').value = '';
  $('threadName').textContent = 'Chat';
  $('threadBadge').hidden = true;
  $('threadAvatar').setAttribute('href', '#avatar');
  $('adminComposer').hidden = true;
  $('thread').classList.remove('admin-thread');
  $('chatTimer').textContent = '30:00';
  $('chatCount').textContent = '';
  $('inviteCode').textContent = '– – – – – –';
  $('inviteTimer').textContent = 'No active code';
  $('qrImage').removeAttribute('src');
  $('qrImage').hidden = true;
  $('qrPlaceholder').removeAttribute('hidden');
  $('send').disabled = true;
  updatePages();
  modalLocked = false;
  closeModal();
  if (reopen !== false && !document.hidden) getSession();
}

function applyTheme(value) {
  document.documentElement.dataset.theme = value;
  try {
    localStorage.setItem('qzu-theme', value);
  } catch {}
}
let theme = 'system';
try {
  theme = localStorage.getItem('qzu-theme') || 'system';
} catch {}
if (!['system', 'light', 'dark'].includes(theme)) theme = 'system';
applyTheme(theme);
$('theme').value = theme;
$('theme').addEventListener('change', () => applyTheme($('theme').value));

function setViewport() {
  const viewport = window.visualViewport;
  const root = document.documentElement;
  const normalScale = !native || !viewport || Math.abs(viewport.scale - 1) < .02;
  const h = (normalScale && viewport?.height) || window.innerHeight;
  root.style.setProperty('--app-height', Math.round(h) + 'px');
  root.style.setProperty('--viewport-top', Math.max(0, Math.round(normalScale ? viewport?.offsetTop || 0 : 0)) + 'px');
  if (native && (window.scrollX || window.scrollY)) window.scrollTo(0, 0);
}
setViewport();
window.addEventListener('resize', setViewport);
window.visualViewport?.addEventListener('resize', setViewport);
window.visualViewport?.addEventListener('scroll', setViewport);
if (native) {
  const selectable = target => target instanceof Element && Boolean(target.closest('input, textarea, [contenteditable="true"], .access-address, .fingerprint-code, .pin-display, .reference'));
  for (const type of ['selectstart', 'contextmenu']) document.addEventListener(type, event => {
    if (!selectable(event.target)) event.preventDefault();
  });
  document.addEventListener('pointerup', event => {
    if (event.pointerType !== 'touch') return;
    const target = event.target instanceof Element ? event.target.closest('button, a') : null;
    if (target && document.activeElement === target) target.blur();
  }, { passive: true });
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('button, a') : null;
    if (target && document.activeElement === target && event.detail > 0) target.blur();
  });
  for (const event of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(event, e => e.preventDefault(), { passive: false });
  }
  document.addEventListener('touchstart', e => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', e => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  window.addEventListener('scroll', () => {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  }, { passive: true });
}

function selectRoom(id, open = true) {
  if (selected !== id) {
    if (mediaRoom) closeModal();
    resetOnce();
    stopTyping();
    clearReply();
    revealedMessages.clear();
    $('message').value = '';
    $('send').disabled = true;
  }
  selected = id;
  mobileOpen = open;
  renderedRoom = null;
  renderChat();
}

function identityChanged(room) {
  return Boolean(room?.contact?.peerIdentity && room.encryption?.peer?.identity && room.contact.peerIdentity!==room.encryption.peer.identity);
}
function addContactMarks(node,contact,room=null) {
  if(!contact)return;
  if(contact.favorite){const mark=el('span','contact-mark','★');mark.title='Favorite';node.append(mark);}
  if(identityChanged(room)){const mark=el('span','contact-warning','!');mark.title='Identity changed';node.append(mark);}
  else if(contact.trusted){const mark=svg('lock','contact-trusted');mark.setAttribute('aria-label','Trusted contact');mark.setAttribute('role','img');mark.removeAttribute('aria-hidden');node.append(mark);}
  if(contact.muted)node.append(el('span','contact-muted','Muted'));
}
function showContactManagement(contact) {
  const field=el('input','nickname-input');
  field.type='text';field.value=contact.nickname;field.maxLength=40;field.setAttribute('aria-label','Nickname');
  const favorite=el('input');favorite.type='checkbox';favorite.checked=contact.favorite;
  const muted=el('input');muted.type='checkbox';muted.checked=contact.muted;
  const favoriteLabel=el('label','contact-setting');favoriteLabel.append(el('span','','Favorite'),favorite);
  const mutedLabel=el('label','contact-setting');mutedLabel.append(el('span','','Mute message previews'),muted);
  const save=button('Save',async()=>{
    save.disabled=true;
    try{await api('contacts/update',{id:contact.id,nickname:field.value.trim(),favorite:favorite.checked,muted:muted.checked});closeModal();await refresh();}
    catch(error){modalError(error);save.disabled=false;}
  });
  const confirmRemove=block=>show(block?'Block contact?':'Remove contact?',[el('p','',block?'This removes the contact and prevents new connections.':'This removes the contact and shared chat for both users.'),button(block?'Block':'Remove',async()=>{try{await api('contacts/remove',{id:contact.id,block});closeModal();await refresh();}catch(error){modalError(error);}},'primary-button danger-button'),button('Cancel',()=>showContactManagement(contact),'secondary-button')]);
  const controls=[el('p','',contact.trusted?'Trusted contact · 30 days inactivity':'Contact · 14 days inactivity'),field,favoriteLabel,mutedLabel,save];
  if(contact.trusted)controls.push(button('Reset trust',()=>show('Reset trust?',[el('p','','Both users must verify a new chat. The regular inactivity limit applies.'),button('Reset trust',async()=>{try{await api('contacts/update',{id:contact.id,resetTrust:true});closeModal();await refresh();}catch(error){modalError(error);}},'primary-button danger-button'),button('Cancel',()=>showContactManagement(contact),'secondary-button')]),'secondary-button'));
  controls.push(button('Remove contact',()=>confirmRemove(false),'secondary-button'),button('Block contact',()=>confirmRemove(true),'secondary-button'),button('Close',closeModal,'secondary-button'));
  show('Manage contact',controls);
}
$('manageContacts').addEventListener('click',()=>{
  const list=el('div','request-list');
  for(const contact of state.contacts||[]){
    const row=el('div','request-item'),name=el('strong','contact-name',contact.nickname);
    addContactMarks(name,contact);
    row.append(name,button('Manage',()=>showContactManagement(contact),'secondary-button'));
    list.append(row);
  }
  if(!list.children.length)list.append(el('p','','No contacts.'));
  show('Contacts',[list,button('Close',closeModal)]);
});
function renderChat() {
  if (page !== 'chat' || !unlockToken) return;
  $('supportOpen').hidden=!state.supportAvailable || state.rooms.some(room=>room.mobileSupport&&!room.supportAgent&&room.expires>serverNow());
  const now = serverNow(), rooms = state.rooms.filter(r => r.expires > now);
  if (selected !== officialChannel && !rooms.some(r => r.id === selected)) {
    if (selected !== null) {
      resetOnce();
      stopTyping();
      clearReply();
      revealedMessages.clear();
      $('message').value = '';
      $('send').disabled = true;
      mobileOpen = false;
    }
    selected = !mobile.matches ? rooms[0]?.id || null: null;
  }
  const current = rooms.find(r => r.id === selected);
  const infoOpen = selected === officialChannel;
  renderRequests();
  $('qzuInfoOpen').classList.toggle('active', infoOpen);
  $('qzuInfoOpen').setAttribute('aria-pressed', String(infoOpen));
  $('qzuInfoChannel').hidden = !infoOpen;
  $('chatPage').classList.toggle('thread-open', Boolean((current || infoOpen) && mobileOpen));
  const total = (state.contacts || []).filter(contact=>contact.deleteAt>now).length + rooms.filter(room=>!room.contact).length;
  $('chatCount').textContent = total ? String(total): '';
  const savedContacts = (state.contacts || []).filter(contact => contact.deleteAt > now);
  const key = JSON.stringify([privacyMode, savedContacts.map(c=>[c.id,c.nickname,c.warning,c.trusted,c.favorite,c.muted]), rooms.map(r => [r.id, r.contact?.nickname, r.contact?.warning, r.contact?.trusted, r.contact?.favorite, r.contact?.muted, r.encryption?.peer?.identity, r.contact?.peerIdentity, r.memberCount, r.activeCount, r.messages.at(-1)?.id, r.messages.at(-1)?.text, r.messages.at(-1)?.opened, r.messages.at(-1)?.deleted, r.deletionRequested, r.id === selected])]);
  if (key !== contactKey) {
    contactKey = key;
    const list = $('contacts'), top = list.scrollTop;
    list.replaceChildren();
    if (!rooms.length && !savedContacts.length) {
      const box = el('div', 'empty-list');
      box.append(el('p', '', 'No chats'));
      const a = el('a', 'subtle-link', 'New chat');
      a.href = '/connect';
      box.append(a);
      list.append(box);
    }
    for (const r of rooms) {
      const last = r.messages.at(-1);
      const classes = 'contact' + (r.admin ? ' admin-contact' : '') + (r.id === selected ? ' active' : '');
      const b = el('button', classes);
      b.type = 'button';
      const content = el('div', 'contact-body');
      const name = el('span', 'contact-name', nameFor(r));

      addContactMarks(name,r.contact,r);
      b.dataset.contactPriority=String(r.admin?2:r.contact?.favorite?1:0);
      if (r.admin && !r.supportAgent) {
        const badge = svg('adminBadge', 'admin-badge');
        badge.setAttribute('aria-label', 'Verified Admin');
        badge.removeAttribute('aria-hidden');
        name.append(badge);
      }

      const preview = r.deletionRequested ? 'Deletion requested' : identityChanged(r) ? 'Contact identity changed' : r.contact?.warning ? 'Contact deletion incoming' : last ? (privacyMode || r.contact?.muted ? 'Message hidden' : previewText(last)) : r.group ? r.memberCount + ' members' : 'New chat';
      if (!r.admin && r.activeCount) name.append(el('span', 'presence-dot'));
      content.append(name, el('span', 'contact-preview' + (r.contact?.warning || identityChanged(r) ? ' contact-warning' : ''), preview));
      b.append(svg(r.support && !r.supportAgent ? 'supportAvatar' : r.readOnly ? 'adminAvatar' : r.group ? 'groupAvatar' : 'avatar', 'avatar'), content, el('span', 'contact-time', fmtTime(last?.at || r.created)));
      b.addEventListener('click', () => selectRoom(r.id));
      list.append(b);
    }
    for (const contact of savedContacts.filter(c=>!rooms.some(r=>r.contact?.id===c.id))) {
      const row = el('button','contact saved-contact');
      row.type='button';
      const content=el('div','contact-body');
      const name=el('span','contact-name',contact.nickname);
      addContactMarks(name,contact);
      row.dataset.contactPriority=String(contact.favorite?1:0);
      content.append(name,el('span','contact-preview'+(contact.warning?' contact-warning':''),contact.warning?'Contact deletion incoming':'Start a new chat'));
      row.append(svg('avatar','avatar'),content,svg('chevron','official-chevron'));
      row.addEventListener('click',async()=>{
        row.disabled=true;
        try {
          const result=await api('contacts/open',{id:contact.id});
          await refresh();
          selectRoom(result.id);
        }catch(error){showError(error);}
        finally{row.disabled=false;}
      });
      list.append(row);
    }
    for(const child of [...list.children].sort((a,b)=>Number(b.dataset.contactPriority||0)-Number(a.dataset.contactPriority||0)))list.append(child);
    list.scrollTop = top;
  }
  $('emptyThread').hidden = Boolean(current || infoOpen);
  for (const id of ['threadHeader', 'messages']) $(id).hidden = !current;

  const isAdmin = Boolean(current?.admin);
  const readOnly = Boolean(current?.readOnly);
  $('composer').hidden = !current || readOnly;
  renderEncryptionNotice(current);
  $('adminComposer').hidden = !readOnly;
  $('deleteChat').hidden = readOnly;
  $('deleteChat').title = current?.mobileSupport && !current?.supportAgent ? 'Request deletion' : 'Delete chat';
  $('deleteChat').setAttribute('aria-label',$('deleteChat').title);
  $('attachmentMenu').hidden = Boolean(current?.support || ((current?.encryption || (native && directRoom(current))) && !encryptionReady(current)));
  const encryptionStatus = $('encryptionStatus');
  encryptionStatus.hidden = !current;
  encryptionStatus.textContent = !current ? '' : directRoom(current) && (native || current.encryption) ? encryptionReady(current) ? '🔒 Verified encrypted chat' : current.encryptionStatus === 'lost' || current.encryptionStatus === 'error' ? 'Encryption key unavailable' : current.encryptionStatus === 'verify' ? 'Compare safety code' : 'Set up encryption' : 'Not end-to-end encrypted';
  $('threadBadge').hidden = !isAdmin || Boolean(current?.supportAgent);
  $('threadAvatar').setAttribute('href', current?.support && !current?.supportAgent ? '#supportAvatar' : readOnly ? '#adminAvatar' : current?.group ? '#groupAvatar' : '#avatar');
  $('groupInvite').hidden = !current?.canInvite;
  $('chatOptions').hidden = !current || (isAdmin && !(current.supportAgent && state.supportAgent));
  $('presenceLabel').hidden = !current || isAdmin;
  $('presenceLabel').textContent = current?.group ? (current.activeCount || 0) + ' active' : current?.activeCount ? 'Active' : 'Offline';
  $('presenceLabel').classList.toggle('online', Boolean(current?.activeCount));
  $('memberCount').hidden = !current?.group;
  $('memberCount').textContent = current?.group ? current.memberCount + ' members' : '';
  $('expiryProgress').hidden = !current || current.persistent;
  $('extensionNotice').hidden = !current?.extension && !current?.deletionRequested;
  $('extensionNotice').textContent = current?.deletionRequested ? 'Deletion requested · Awaiting support action' : current?.extension?.incoming ? 'Chat extension requested · Review' : 'Waiting for extension approval';
  $('typingIndicator').hidden = !current?.typing?.length;
  $('typingLabel').textContent = current?.typing?.length ? (current.group ? current.typing.join(', ') : 'Contact') + (current.typing.length === 1 ? ' is typing' : ' are typing') : '';
  renderReply();
  $('thread').classList.toggle('admin-thread', isAdmin);
  updateSendButton();
  if (!current) {
    $('messages').replaceChildren();
    renderedRoom = null;
    renderedMessages = [];
    return;
  }
  $('threadName').textContent = nameFor(current);
  addContactMarks($('threadName'),current.contact,current);
  $('chatTimer').textContent = supportClock(current,now);
  updateExpiry(current);
  const container = $('messages');
  const ids = current.messages.map(message => JSON.stringify([message.id, message.text, message.edited, message.opened, message.deleted, message.reactions, message.reply, message.burnSeconds, message.burnAt, message.encryptedMedia, current.encryptionStatus]));
  const sameRoom = renderedRoom === current.id;
  const appendOnly = sameRoom && renderedMessages.length <= ids.length &&
    renderedMessages.every((id, index) => ids[index] === id);

  const follow = !sameRoom || container.scrollHeight - container.scrollTop - container.clientHeight < 100 ||
    (ids.length > renderedMessages.length && current.messages.at(-1)?.mine);

  if (!appendOnly) container.replaceChildren();

  const first = appendOnly ? renderedMessages.length : 0;

  for (const message of current.messages.slice(first)) {
    container.append(renderMessage(current, message));
  }

  for (const message of current.messages) {
    if (!message.mine) continue;
    const row = document.getElementById('message-' + message.id);
    const status = row?.querySelector('.message-status');
    if (status && status.dataset.status !== message.status) updateStatus(status, message.status);
  }

  renderedRoom = current.id;
  renderedMessages = ids;
  if (follow) container.scrollTop = container.scrollHeight;
}

function updateExpiry(room) {
  if (room.persistent) return;
  const remaining = Math.max(0, room.expires - serverNow());
  const bar = $('expiryProgress');
  bar.max = room.expires - room.created;
  bar.value = remaining;
  bar.classList.toggle('expiring', remaining <= 5 * 60_000);
  bar.classList.toggle('critical', remaining <= 60_000);
}

function updateStatus(node, status) {
  node.dataset.status = status;
  node.title = status === 'read' ? 'Read' : status === 'delivered' ? 'Delivered' : 'Sent';
  node.setAttribute('aria-label', node.title);
  node.replaceChildren(svg(status === 'sent' ? 'check' : 'doubleCheck'));
}

function attachSwipeReply(bubble, reply) {
  let gesture = null;
  let suppressClick = false;
  const reset = () => {
    gesture = null;
    bubble.classList.remove('swipe-tracking', 'swipe-ready');
    bubble.style.removeProperty('--reply-shift');
  };
  bubble.classList.add('swipe-reply');
  const indicator = svg('reply', 'swipe-reply-indicator');
  bubble.append(indicator);
  bubble.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || !event.isPrimary || event.target.closest('button, a, input, textarea, audio, video') || bubble.classList.contains('masked-message')) return;
    suppressClick = false;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
  });
  bubble.addEventListener('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.dragging) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { reset(); return; }
      if (dx < -10) { reset(); return; }
      if (dx < 12 || dx < Math.abs(dy) * 1.5) return;
      gesture.dragging = true;
      bubble.classList.add('swipe-tracking');
      try { bubble.setPointerCapture(event.pointerId); } catch {}
    }
    const distance = Math.max(0, Math.min(76, dx));
    bubble.style.setProperty('--reply-shift', distance + 'px');
    bubble.classList.toggle('swipe-ready', distance >= 52);
  });
  bubble.addEventListener('pointerup', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dragging = gesture.dragging;
    const accepted = dragging && event.clientX - gesture.x >= 52;
    reset();
    if (dragging) suppressClick = true;
    if (accepted) reply();
  });
  bubble.addEventListener('pointercancel', reset);
  bubble.addEventListener('lostpointercapture', reset);
  bubble.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function renderMessage(room, message) {
  const row = el('div', 'message-row' + (message.mine ? ' mine' : ''));
  row.id = 'message-' + message.id;
  const bubble = el('div', 'bubble');
  const content = el('div', 'message-content');
  const masked = privacyMode && !revealedMessages.has(message.id) && !message.once && !message.deleted && !(message.burnSeconds && !message.burnAt && !message.mine);

  if (room.group && !message.mine) content.append(el('strong', 'message-author', message.sender));

  if (message.reply) {
    const quote = el('div', 'message-quote');
    quote.append(el('strong', '', message.reply.sender), el('span', '', message.reply.text));
    content.append(quote);
  }

  if (message.deleted) {
    content.append(el('div', 'deleted-message', message.burnSeconds ? 'Timed message expired or removed.' : 'This message was deleted.'));
  } else if (message.burnSeconds && !message.burnAt && !message.mine) {
    content.append(button('Open · ' + message.burnSeconds + 's', async () => {
      try { await api('message/burn-open', { id: room.id, messageId: message.id }); await refresh(); } catch (error) { showError(error); }
    }, 'media-message'));
  } else if (message.once) {
    const label = message.opened ? 'Opened' : message.mine ? 'View-once message' : 'Open once';
    const open = button(label, () => openOnceMessage(room, message), 'media-message');
    open.disabled = message.mine || message.opened;
    content.append(open);
  } else if (message.kind === 'image' || message.kind === 'audio') {
    const open = button(message.kind === 'image' ? 'View photo' : 'Play voice message', () => openMedia(room, message), 'media-message');
    open.disabled = Boolean(room.encryption && !encryptionReady(room));
    content.append(open);
  } else {
    content.append(el('div', 'message-text', message.text));
  }
  bubble.append(content);

  const footer = el('div', 'message-footer');
  if (message.edited) footer.append(el('span', 'edited-label', 'Edited'));
  footer.append(el('span', 'bubble-time', fmtTime(message.at)));

  if (message.mine && !message.deleted) {
    const status = el('span', 'message-status');
    updateStatus(status, message.status);
    footer.append(status);
  }

  bubble.append(footer);

  if (message.burnSeconds && !message.deleted) {
    const label = el('span', 'burn-label', message.burnAt ? 'Expires shortly' : message.burnSeconds + 's after opening');
    if (message.burnAt) label.dataset.burnAt = String(message.burnAt);
    bubble.append(label);
  }

  if (masked && !(message.burnSeconds && !message.burnAt && !message.mine)) {
    bubble.classList.add('masked-message');
    content.setAttribute('aria-hidden', 'true');
    const reveal = button('Tap to reveal', () => {
      revealedMessages.add(message.id);
      bubble.classList.remove('masked-message');
      content.removeAttribute('aria-hidden');
      reveal.remove();
      if (canReadCurrent()) acknowledgeMessages();
    }, 'reveal-message');
    bubble.append(reveal);
  }

  if (!room.readOnly && !room.encryption && !(native && directRoom(room)) && !message.once && !message.burnSeconds && !message.deleted) {
    const startReply = () => {
      if (!unlockToken || page !== 'chat' || selected !== room.id || document.hidden) return;
      const current = state.rooms.find(item => item.id === room.id && !item.readOnly && item.expires > serverNow());
      const target = current?.messages.find(item => item.id === message.id && !item.deleted && !item.once);
      if (!target) return;
      replyTarget = { roomId: room.id, id: target.id, sender: target.sender, text: previewText(target) };
      renderReply();
      $('message').focus({ preventScroll: true });
    };
    const reply = button('', startReply, 'reply-action');
    attachSwipeReply(bubble, startReply);
    reply.title = 'Reply';
    reply.setAttribute('aria-label', 'Reply to message');
    reply.append(svg('reply'));
    row.append(reply);
    const more = button('⋯', () => messageActions(room, message), 'reply-action message-more');
    more.setAttribute('aria-label', 'Message actions');
    row.append(more);
    if (message.reactions?.length) {
      const bar = el('div', 'message-reactions');
      for (const reaction of message.reactions) {
        const chip = button(reaction.emoji + ' ' + reaction.count, () => reactTo(room, message, reaction.emoji), 'reaction-chip' + (reaction.mine ? ' chosen' : ''));
        bar.append(chip);
      }
      bubble.append(bar);
    }
  }

  if (!room.readOnly && (message.once || message.burnSeconds) && message.mine && !message.deleted) {
    const more = button('⋯', () => messageActions(room, message), 'reply-action message-more');
    more.setAttribute('aria-label', 'Message actions');
    row.append(more);
  }
  if (room.encryption && message.mine && !message.deleted) {
    const more = button('⋯', () => confirmUnsend(room, message), 'reply-action message-more');
    more.setAttribute('aria-label', 'Unsend encrypted message');
    row.append(more);
  }
  row.append(bubble);
  return row;
}

function clearReply() {
  replyTarget = null;
  $('replyComposer').hidden = true;
  $('replyName').textContent = '';
  $('replyText').textContent = '';
}

function renderReply() {
  if (!replyTarget || replyTarget.roomId !== selected || page !== 'chat') {
    $('replyComposer').hidden = true;
    return;
  }

  $('replyComposer').hidden = false;
  $('replyName').textContent = 'Reply to ' + replyTarget.sender;
  $('replyText').textContent = privacyMode && !revealedMessages.has(replyTarget.id) ? 'Message hidden' : replyTarget.text;
}

function stopTyping() {
  const id = typingRoom;
  typingRoom = null;
  lastTypingAt = 0;
  if (id && unlockToken) api('typing', { id, active: false }, true).catch(() => {});
}

function reportTyping() {
  const room = state.rooms.find(room => room.id === selected);
  if (!unlockToken || state.invisible || page !== 'chat' || !room || room.readOnly || !$('message').value.trim()) {
    stopTyping();
    return;
  }
  if (typingRoom !== room.id) stopTyping();
  if (Date.now() - lastTypingAt < 1800) return;
  typingRoom = room.id;
  lastTypingAt = Date.now();
  api('typing', { id: room.id, active: true }, true).catch(() => {});
}

function canReadCurrent() {
  return page === 'chat' && !document.hidden && (!mobile.matches || mobileOpen);
}

async function acknowledgeMessages() {
  if (receiptsInFlight || !unlockToken || document.hidden) return;
  const epoch = authEpoch;
  const entries = [];
  for (const room of state.rooms) {
    if (room.readOnly) continue;
    const delivered = [];
    const read = [];
    for (const message of room.messages) {
      if (message.mine || message.deleted || (room.encryption && !message.decrypted)) continue;
      if (!acknowledgedDelivery.has(message.id)) delivered.push(message.id);
      const node = document.getElementById('message-' + message.id);
      const view = $('messages').getBoundingClientRect();
      const rect = node?.getBoundingClientRect();
      const visible = rect && rect.bottom > view.top && rect.top < view.bottom;
      if (!state.invisible && room.id === selected && canReadCurrent() && visible && (!privacyMode || revealedMessages.has(message.id)) && !message.once && (!message.burnSeconds || message.burnAt) && !acknowledgedRead.has(message.id)) read.push(message.id);
    }
    if (delivered.length || read.length) entries.push({ id: room.id, delivered, read });
  }

  if (!entries.length) return;
  const batch = [];
  let size = 0;
  for (const entry of entries) {
    const ids = [...new Set([...entry.delivered, ...entry.read])];
    const deliveredSet = new Set(entry.delivered);
    const readSet = new Set(entry.read);
    for (let index = 0; index < ids.length; index += 60) {
      const part = ids.slice(index, index + 60);
      if (size + part.length > 100) break;
      batch.push({ id: entry.id, delivered: part.filter(id => deliveredSet.has(id)), read: part.filter(id => readSet.has(id)) });
      size += part.length;
    }
    if (size >= 100) break;
  }

  receiptsInFlight = true;
  try {
    await api('receipts', { entries: batch }, true);
    if (epoch !== authEpoch) return;
    for (const entry of batch) {
      entry.delivered.forEach(id => acknowledgedDelivery.add(id));
      entry.read.forEach(id => acknowledgedRead.add(id));
    }
  } catch {} finally {
    if (epoch === authEpoch) receiptsInFlight = false;
  }

}

function renderConnect() {
  if (page !== 'connect' || !unlockToken) return;
  const inv = state.invite && state.invite.expires > serverNow() ? state.invite: null;
  $('inviteCode').textContent = inv?.code || '– – – – – –';
  $('inviteTimer').textContent = inv ? clock(inv.expires - serverNow()) : 'Generating code…';
  $('copyCode').disabled = !inv;
  const key = inv ? inv.code + ':' + inv.expires: '';
  if (key !== qrKey && key !== qrPending) {
    $('qrImage').hidden = true;
    $('qrImage').removeAttribute('src');
    $('qrPlaceholder').removeAttribute('hidden');
    if (!inv) {
      qrKey = '';
      qrPending = '';
      return;
    }
    qrPending = key;
    api('qr').then(({ image, code, expires }) => {
      if (!unlockToken || qrPending !== key || state.invite?.code !== inv.code || state.invite?.expires !== inv.expires) return;
      if (code !== inv.code || expires !== inv.expires) return;
      if (typeof image !== 'string' || !image.startsWith('data:image/png;base64,')) return;
      qrKey = key;
      $('qrImage').src = image;
      $('qrImage').hidden = false;
      $('qrPlaceholder').setAttribute('hidden', '');
    }).catch(() => {}).finally(() => {
      if (qrPending === key) qrPending = '';
    });
  }
}

function renderSettings() {
  if (page !== 'settings') return;
  const category = location.pathname.split('/')[2] || 'main';
  for (const panel of document.querySelectorAll('[data-settings-category]')) panel.hidden = panel.dataset.settingsCategory !== category;
  $('settingsBack').href = category === 'main' ? '/chat' : '/settings';
  $('resetPin').disabled = !state.pinState || Boolean(state.resetDelivered) || ['new', 'approved'].includes(state.pinState);
  $('resetLabel').textContent = state.resetDelivered ? 'Reset pending': 'Request Reset';
  $('emergency').disabled = !state.pinState;
  $('changeLogin').disabled = !unlockToken;
  $('writeSupport').disabled = !unlockToken;
  $('writeSupport').querySelector('span').textContent = state.supportAgent ? 'Support inbox' : 'Write Support';
  if (!invisibleSaving) $('invisibleMode').checked = Boolean(state.invisible);
  $('invisibleMode').disabled = invisibleSaving || !unlockToken;
}

function render() {
  renderChat();
  renderConnect();
  renderSettings();
}

function purgeExpired() {
  if (!unlockToken) return;
  const now = serverNow();
  if (mediaRoom && !state.rooms.some(room => room.id === mediaRoom && room.expires > now)) closeModal();
  if (state.rooms.some(r => r.expires <= now) || state.invite && state.invite.expires <= now) {
    state.rooms = state.rooms.filter(r => r.expires > now);
    if (state.invite?.expires <= now) state.invite = null;
    render();
  }
  for (const item of state.rooms) for (const message of item.messages) {
    if (message.burnAt && message.burnAt <= now) { message.text = ''; message.deleted = true; }
  }
  for (const label of $('messages').querySelectorAll('[data-burn-at]')) {
    const remaining = Number(label.dataset.burnAt) - now;
    label.textContent = remaining > 0 ? Math.ceil(remaining / 1000) + 's remaining' : 'Expired';
    if (remaining <= 0) label.closest('.message-row')?.replaceChildren(el('span', 'deleted-message', 'Timed message expired.'));
  }
  const room = state.rooms.find(r => r.id === selected);
  if (room) {
    $('chatTimer').textContent = supportClock(room,now);
    updateExpiry(room);
  }
  if (page === 'connect' && state.invite) $('inviteTimer').textContent = clock(state.invite.expires - now);
}

function clearVolatile() {
  roomKeys.clear();
  roomKeyJobs.clear();
  stopTyping();
  clearReply();
  revealedMessages.clear();
  acknowledgedDelivery.clear();
  acknowledgedRead.clear();
  sequence++;
  state.rooms = [];
  state.contacts = [];
  state.invite = null;
  selected = null;
  mobileOpen = false;
  $('message').value = '';
  $('send').disabled = true;
  render();
}

function directRoom(room) {
  return room && !room.group && !room.admin && !room.support;
}
function encryptionRequired(room) {
  return Boolean(room && (room.encryption || (native && directRoom(room))));
}
function encryptionReady(room) {
  const local = roomKeys.get(room.id);
  if(identityChanged(room))return false;
  return Boolean(local?.until > Date.now() && room.encryption && room.encryption.confirmed && room.encryption.peerConfirmed && local?.context && local.verified === local.context.code && room.encryptionStatus === 'ready');
}
function dropExpiredKeys(rooms = null) {
  const now = Date.now();
  for (const [id, local] of roomKeys) if (local.until <= now || (rooms && !rooms.some(room => room.id === id))) roomKeys.delete(id);
}
setInterval(dropExpiredKeys, 1000);
async function prepareEncryptedRooms(data) {
  dropExpiredKeys(data.rooms);
  for (const room of data.rooms) {
    if (!directRoom(room) || (!native && !room.encryption)) continue;
    room.encryptionStatus = 'waiting';
    const local = roomKeys.get(room.id), encryption = room.encryption;
    if (local) local.until = Date.now() + Math.max(0, room.expires - data.now);
    if (!data.capabilities?.encryptedDirect || data.capabilities.encryptedProtocol !== 2 || !encryption || !globalThis.crypto?.subtle) room.encryptionStatus = 'unavailable';
    else if (encryption.own && !local) room.encryptionStatus = 'lost';
    else if (local && encryption.own && encryption.peer) {
      try {
        const binding = JSON.stringify([encryption.own, encryption.peer]);
        if (local.binding !== binding || !local.context) {
          if (local.binding && local.binding !== binding) throw Error('Encryption key changed.');
          local.context = await QzuCrypto.establish(room.id, local, encryption.own, encryption.peer);
          local.binding = binding;
        }
        room.encryptionStatus = local.verified === local.context.code && encryption.confirmed && encryption.peerConfirmed ? 'ready' : 'verify';
      } catch {
        local.context = null;
        local.verified = null;
        room.encryptionStatus = 'error';
      }
    }
    const seen = new Set();
    for (const message of room.messages) {
      message.text = message.deleted ? '' : 'Encrypted message — locked';
      message.reply = null;
      if (message.deleted || !encryptionReady(room)) continue;
      if (message.encryptedMedia) { message.text = 'Encrypted attachment'; continue; }
      if (!message.cipher) continue;
      const nonce = String(message.mine) + ':' + message.cipher.iv;
      if (seen.has(nonce)) { message.text = 'Duplicate encrypted message'; continue; }
      seen.add(nonce);
      try { message.text = await QzuCrypto.decrypt(local.context, message.cipher, message.mine); message.decrypted = true; }
      catch { message.text = 'Encrypted message could not be authenticated'; }
    }
  }
}
async function showEncryption(room) {
  if(identityChanged(room)){show('Contact identity changed',[el('p','','Do not send messages until you verify your contact again.'),button('Manage contact',()=>showContactManagement(room.contact)),button('Close',closeModal,'secondary-button')]);return;}
  if (!native || !state.capabilities?.encryptedDirect || state.capabilities.encryptedProtocol !== 2 || !room.encryption || !globalThis.crypto?.subtle) {
    info('Encryption unavailable', 'Both devices need the current app and compatible encryption support. No plaintext will be sent.');
    return;
  }
  if (room.encryptionStatus === 'lost' || room.encryptionStatus === 'error') {
    info('Encryption unavailable', 'The temporary encryption key is missing or changed. Delete this chat and start a new one. No plaintext will be sent.');
    return;
  }
  const local = roomKeys.get(room.id);
  if (!room.encryption.own) {
    show('Set up encryption', [el('p', '', 'Generate a temporary key on this device. Both participants must compare the safety code before sending. Closing the app completely can remove the temporary key.'), button('Generate key', async () => {
      const epoch = authEpoch;
      try {
        let key = roomKeys.get(room.id);
        if (!key) {
          if (!roomKeyJobs.has(room.id)) roomKeyJobs.set(room.id, QzuCrypto.generate(room.id, message => devicePlugin.sign({ message })));
          const job = roomKeyJobs.get(room.id);
          try { key = await job; } finally { if (roomKeyJobs.get(room.id) === job) roomKeyJobs.delete(room.id); }
          if (epoch !== authEpoch || !unlockToken || room.expires <= serverNow()) return;
          key = roomKeys.get(room.id) || key;
          key.until = Date.now() + Math.max(0, room.expires - serverNow());
          roomKeys.set(room.id, key);
        }
        await api('encryption/key', { id: room.id, record: key.record });
        closeModal();
        await refresh();
        const current = state.rooms.find(item => item.id === room.id);
        if (current && selected === room.id && unlockToken && current.encryption?.own) showEncryption(current);
      } catch (error) { if (epoch === authEpoch) modalError(error); }
    }), button('Cancel', closeModal, 'secondary-button')]);
    return;
  }
  if (!local?.context || !room.encryption.peer) {
    show('Waiting for contact', [
      el('p', '', 'Your key is ready. Ask your contact to open this conversation and tap Set up encryption. Both devices must compare the same safety code.'),
      button('Check again', async () => {
        try {
          await refresh();
          const current = state.rooms.find(item => item.id === room.id);
          if (current && selected === room.id && unlockToken) showEncryption(current);
        } catch (error) { modalError(error); }
      }),
      button('Close', closeModal, 'secondary-button')
    ]);
    return;
  }
  const code = local.context.code;
  const content = [
    el('p', '', 'Compare the entire safety code in person or through a separate trusted channel. Do not confirm unless every character matches.'),
    el('div', 'fingerprint-code', code.match(/.{1,4}/g).join(' ')),
    el('p', '', 'Experimental encrypted text, photos and audio. Replies, edits and timed messages are disabled here.'),
  ];
  if (local.verified !== code || !room.encryption.confirmed) content.push(button('Codes match — verify', async () => {
    try {
      if (roomKeys.get(room.id) !== local || local.context?.code !== code || !unlockToken) throw Error('Encryption key changed.');
      await api('encryption/confirm', { id: room.id });
      local.verified = code;
      closeModal();
      await refresh();
    } catch (error) { modalError(error); }
  }));
  else content.push(el('p', '', room.encryption.peerConfirmed ? 'Both devices have confirmed.' : 'Waiting for your contact to confirm.'));
  content.push(button('Close', closeModal, 'secondary-button'));
  show('Verify encrypted chat', content);
}
$('encryptionStatus').addEventListener('click', () => {
  const room = state.rooms.find(item => item.id === selected);
  if (directRoom(room)) showEncryption(room);
  else if (room) info('Connection security', 'This conversation uses transport encryption only. It is not end-to-end encrypted.');
});

async function refresh() {
  const ticket = ++sequence;
  const data = await api('state');
  if (ticket !== sequence || document.hidden || !unlockToken) return;
  online = true;
  offset = data.now - Date.now();
  await prepareEncryptedRooms(data);
  if (ticket !== sequence || document.hidden || !unlockToken) return;
  state = data;
  if (mediaRoom && !state.rooms.some(room => room.id === mediaRoom && (!mediaMessage || room.messages.some(message => message.id === mediaMessage && !message.deleted)))) closeModal();
  if (replyTarget && !state.rooms.some(room => room.id === replyTarget.roomId && room.messages.some(message => message.id === replyTarget.id && !message.deleted))) clearReply();
  if (page === 'chat' && !selected) {
    let target = null;
    try {
      target = sessionStorage.getItem('qzu-open');
      sessionStorage.removeItem('qzu-open');
    } catch {}
    if (target && data.rooms.some(r => r.id === target)) {
      selected = target;
      mobileOpen = true;
    }
  }
  render();
  purgeExpired();
  acknowledgeMessages();
  maybePromptUpdate();
}

function offerPin() {
  pinDialog('emg.exe', ['New PIN', 'Confirm PIN'], 'Save', async values => {
    if (values[0] !== values[1]) throw new Error('PINs do not match.');
    await api('pin/issue', {
      pin: values[0]
    });
    closeModal();
    await refresh();
    info('emg.exe', 'PIN saved.');
  }, {
    note: 'Choose a different PIN from your login PIN. Single-use.'
  });
}
$('logout').addEventListener('click',()=>{
  const confirm=button('Log out',async()=>{
    confirm.disabled=true;
    try{
      await api('logout',{confirmed:true});
      roomKeys.clear();
      roomKeyJobs.clear();
      sessionReady=false;
      needsSetup=false;
      forgetInvoice(false);
      forgetInvoice(true);
      lock(false);
      history.replaceState(null,'','/chat');
      navigate('/chat',false);
      await getSession();
    }catch(error){modalError(error);confirm.disabled=false;}
  },'primary-button danger-button');
  show('Are you sure?',[el('p','','This account cannot be recovered. A new activation key is required.'),confirm,button('Cancel',closeModal,'secondary-button')]);
});
$('changeLogin').addEventListener('click', () => {
  pinDialog('Change login PIN', ['Current PIN', 'New PIN', 'Confirm PIN'], 'Save', async values => {
    if (values[1] !== values[2]) throw new Error('PINs do not match.');
    const result = await api('login/change', {
      current: values[0],
      next: values[1]
    });
    unlockToken = result.token;
    closeModal();
    await refresh();
    info('qzu.', 'PIN changed.');
  });
});
function confirmSupport() {
  if (!unlockToken || accessDue) return;
  if (state.supportAgent) {
    const rooms = state.rooms.filter(room => room.mobileSupport && room.supportAgent && room.expires > serverNow());
    const controls = rooms.map(room => button(nameFor(room) + (room.deletionRequested ? ' · Deletion requested' : ''), () => {
      closeModal();
      navigate('/chat');
      selectRoom(room.id);
    }, 'secondary-button'));
    if (!controls.length) controls.push(el('p','','No support conversations yet.'));
    controls.push(button('Close',closeModal,'secondary-button'));
    show('Support inbox', controls);
    return;
  }
  if (!state.supportAvailable) return info('Support','Support is currently unavailable. Please try again later.');
  const yes=button('Yes',async()=>{
    yes.disabled=true;
    try {const result=await api('support/open',{});await refresh();closeModal();navigate('/chat');selectRoom(result.id);}
    catch(error){yes.disabled=false;modalError(error);}
  });
  show('Contact Support',[el('p','','Do you want to contact Support through chat?'),el('p','','Stored on the server until deleted. Not end-to-end encrypted.'),yes,button('No',closeModal,'secondary-button')]);
}
$('supportOpen').addEventListener('click',confirmSupport);
$('writeSupport').addEventListener('click',confirmSupport);
$('qzuInfoOpen').addEventListener('click', () => {
  if (unlockToken && !accessDue) selectRoom(officialChannel);
});
$('qzuInfoBack').addEventListener('click', () => $('backToChats').click());
$('backToChats').addEventListener('click', () => {
  resetOnce();
  stopTyping();
  clearReply();
  revealedMessages.clear();
  mobileOpen = false;
  selected = null;
  renderedRoom = null;
  $('message').value = '';
  $('send').disabled = true;
  renderChat();
});
mobile.addEventListener('change', () => {
  if (!mobile.matches) mobileOpen = false;
  renderChat();
});
function renderEncryptionNotice(room) {
  const notice = $('encryptionNotice');
  const required = encryptionRequired(room) && !encryptionReady(room);
  notice.hidden = !required;
  if (!required) return;
  const local = roomKeys.get(room.id);
  $('encryptionNoticeText').textContent = ['lost', 'error'].includes(room.encryptionStatus) ? 'Encryption key unavailable. Tap for help.'
    : room.encryptionStatus === 'unavailable' ? 'Encryption unavailable. Tap for details.'
    : !room.encryption?.own ? 'Set up encryption to send messages'
    : !room.encryption?.peer ? 'Waiting for your contact to set up encryption'
    : local?.context && local.verified === local.context.code && room.encryption.confirmed ? 'Waiting for your contact to verify the safety code'
    : 'Compare safety codes before sending';
}
$('encryptionNotice').addEventListener('click', () => {
  const room = state.rooms.find(item => item.id === selected);
  if (encryptionRequired(room)) showEncryption(room);
});
function updateSendButton() {
  const room = state.rooms.find(room => room.id === selected);
  const needsSetup = encryptionRequired(room) && !encryptionReady(room);
  const send = $('send');
  send.disabled = !unlockToken || sendingMessage || !room || room.readOnly ||
    room.expires <= serverNow() || (!$('message').value.trim() && !needsSetup);
  send.setAttribute('aria-label', needsSetup ? 'Set up or verify encryption' : 'Send');
  send.title = needsSetup ? 'Set up or verify encryption' : 'Send';
  send.classList.toggle('send-setup', needsSetup);
  const icon = needsSetup ? 'lock' : 'sendIcon';
  if (send.dataset.icon !== icon) {
    send.dataset.icon = icon;
    send.replaceChildren(svg(icon));
  }
}

async function sendMessage() {
  const id = selected;
  const text = $('message').value.trim();
  const room = state.rooms.find(room => room.id === id);

  if (!unlockToken || sendingMessage || !room || room.readOnly || room.expires <= serverNow()) {
    updateSendButton();
    return;
  }
  if (encryptionRequired(room) && !encryptionReady(room)) {
    $('message').blur();
    showEncryption(room);
    return;
  }
  if (!text) return;
  const epoch = authEpoch;
  sendingMessage = true;
  updateSendButton();

  try {
    if (room.encryption || (native && directRoom(room))) {
      if (!encryptionReady(room)) throw Error('Verify encryption before sending.');
      const cipher = await QzuCrypto.encrypt(roomKeys.get(id).context, text);
      if (epoch !== authEpoch || document.hidden || !unlockToken || selected !== id || room.expires <= serverNow()) throw Error('Chat unavailable.');
      await api('encryption/message', { id, cipher });
    } else {
      await api('message', { id, text, once: viewOnce, burnSeconds, replyTo: burnSeconds ? null : replyTarget?.roomId === id ? replyTarget.id : null });
    }

    if (epoch !== authEpoch) return;

    if (selected === id && $('message').value.trim() === text) {
      $('message').value = '';
      resetOnce();
      clearReply();
      stopTyping();
    }

    await refresh();
  } catch (error) {
    if (epoch === authEpoch) showError(error);
  } finally {
    if (epoch === authEpoch) {
      sendingMessage = false;
      updateSendButton();
    }
  }
}

$('message').addEventListener('input', () => {
  updateSendButton();
  reportTyping();
});
$('cancelReply').addEventListener('click', clearReply);
$('messages').addEventListener('scroll', acknowledgeMessages, { passive: true });
$('send').addEventListener('click', sendMessage);

$('message').addEventListener('keydown', event => {
  if (!mobile.matches && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});

$('composer').addEventListener('submit', event => {
  event.preventDefault();
  sendMessage();
});

$('deleteChat').addEventListener('click', () => {
  const id = selected;
  if (!id) return;
  const room = state.rooms.find(room => room.id === id);
  if (!room || room.readOnly) return;
  const leave = room.group && !room.canInvite;
  const requestDeletion = room.mobileSupport && !room.supportAgent;
  if (requestDeletion && room.deletionRequested) return info('Deletion requested','Support has received your request.');
  const confirm = button(requestDeletion ? 'Request deletion' : leave ? 'Leave group' : room.group ? 'Delete for everyone' : 'Delete for both', async() => {
    confirm.disabled = true;
    try {
      const result=await api('chat/delete', {id});
      closeModal();
      if (!result.requested) clearVolatile();
      await refresh();
      if(result.requested)info('Deletion requested','Support can now delete this conversation for both sides.');
    } catch (e) {
      confirm.disabled = false;
      modalError(e);
    }
  }, 'primary-button danger-button');
  show(requestDeletion ? 'Request deletion?' : leave ? 'Leave group?' : 'Delete chat?', [el('p', '', requestDeletion ? 'Ask support to delete this conversation for both participants.' : leave ? 'You will leave this group. Other members keep the conversation.' : room.group ? 'This removes the conversation for all group members.' : 'This removes the conversation for both participants.'), confirm, button('Cancel', closeModal, 'secondary-button')]);
});
try {
  privacyMode = localStorage.getItem('qzu-privacy') === '1';
} catch {}

$('privacyMode').checked = privacyMode;
$('privacyMode').addEventListener('change', () => {
  privacyMode = $('privacyMode').checked;
  revealedMessages.clear();
  contactKey = '';
  renderedRoom = null;
  try { localStorage.setItem('qzu-privacy', privacyMode ? '1' : '0'); } catch {}
  render();
});

$('createGroup').addEventListener('click', () => {
  const create = button('Create group', async () => {
    create.disabled = true;
    try {
      const result = await api('group/create', {});
      closeModal();
      await refresh();
      navigate('/chat');
      selectRoom(result.id);
      await showGroupInvite(result.id);
    } catch (error) {
      create.disabled = false;
      showError(error);
    }
  });
  show('New group', [el('p', '', 'Up to 12 members. Expires 30 minutes after creation.'), create, button('Cancel', closeModal, 'secondary-button')]);
});

async function showGroupInvite(id) {
  try {
    const invite = await api('group/invite', { id });
    const code = el('strong', 'pin-display', invite.code);
    const copy = button('Copy code', async () => {
      try { await navigator.clipboard.writeText(invite.code); } catch {}
    });
    const expires = el('p', '', 'Valid for ' + clock(invite.expires - serverNow()) + ' at the time of opening.');
    show('Group invite', [code, expires, el('p', '', 'Share this code. Members join using Connect.'), copy, button('Close', closeModal, 'secondary-button')]);
  } catch (error) {
    showError(error);
  }
}

$('groupInvite').addEventListener('click', () => {
  if (state.rooms.some(room => room.id === selected && room.canInvite)) showGroupInvite(selected);
});

$('newCode').addEventListener('click', async() => {
  $('newCode').disabled = true;
  try {
    await api('invite', {});
    await refresh();
  } catch (e) {
    showError(e);
  } finally {
    $('newCode').disabled = false;
  }
});
$('copyCode').addEventListener('click', async() => {
  const inv = state.invite;
  if (!inv || inv.expires <= serverNow()) return;
  try {
    await navigator.clipboard.writeText(inv.code);
    info('Copied', inv.code);
  } catch {
    info('Your code', inv.code);
  }
});
$('enterCode').addEventListener('input', () => {
  $('enterCode').value = $('enterCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
});
function askNickname(action, submitLabel = 'Continue') {
  const field=el('input','nickname-input');
  field.type='text';
  field.maxLength=40;
  field.placeholder='Nickname';
  field.autocomplete='off';
  field.setAttribute('aria-label','Contact nickname');
  const save=button(submitLabel,async()=>{
    const value=field.value.trim();
    if(!value)return;
    save.disabled=true;
    try { await action(value); }
    catch(error){modalError(error);save.disabled=false;}
  });
  save.disabled=true;
  field.addEventListener('input',()=>{save.disabled=!field.value.trim();});
  field.addEventListener('keydown',event=>{if(event.key==='Enter'&&!save.disabled){event.preventDefault();save.click();}});
  show('Give your contact a nickname',[field,el('p','','Only visible to you.'),save,button('Cancel',closeModal,'secondary-button')]);
}
$('connectForm').addEventListener('submit', e => {
  e.preventDefault();
  const code=$('enterCode').value.trim().toUpperCase();
  if(!/^[A-Z0-9]{6}$/.test(code)){info('Connect','Enter a 6-character code.');return;}
  askNickname(async nickname=>{
    const result=await api('connect',{code,nickname});
    closeModal();
    await refresh();
    $('enterCode').value='';
    navigate('/chat');
    if(result.id)selectRoom(result.id);
    else info('Request sent','Awaiting approval.');
  },'Send request');
});

function loadScanner() {
  if (window.jsQR) return Promise.resolve();
  if (!scannerLoad) scannerLoad = new Promise((resolve, reject) => {
    const script = el('script');
    script.src = '/vendor/jsqr.js';
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      scannerLoad = null;
      reject(new Error('Scanner unavailable.'));
    };
    document.head.append(script);
  });
  return scannerLoad;
}

function parseScan(raw) {
  const value = raw.trim().toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(value)) return value;
  try {
    const url = new URL(raw);
    if (url.origin !== apiOrigin || url.pathname !== '/connect') return null;
    const code = url.hash.slice(1).toUpperCase();
    return /^[A-Z0-9]{6}$/.test(code) ? code: null;
  } catch {
    return null;
  }
}
$('scanCode').addEventListener('click', async() => {
  if (!navigator.mediaDevices?.getUserMedia) {
    info('Scan QR', 'Camera requires HTTPS. You can enter a code instead.');
    return;
  }
  const video = el('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  show('Scan QR', [video, button('Cancel', closeModal, 'secondary-button')]);
  try {
    await loadScanner();
    if (!modal.open || !body.contains(video)) return;
    const camera = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: {
          ideal: 'environment'
        }
      },
      audio: false
    });
    if (!modal.open || !body.contains(video)) {
      camera.getTracks().forEach(t => t.stop());
      return;
    }
    stream = camera;
    video.srcObject = camera;
    await video.play();
    const canvas = el('canvas'), ctx = canvas.getContext('2d', {
      willReadFrequently: true
    });
    let last = 0;
    function frame(ts) {
      if (!stream || !modal.open || !body.contains(video)) return;
      if (ts - last > 150 && video.readyState >= 2) {
        last = ts;
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        if (canvas.width && canvas.height) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const hit = window.jsQR(image.data, image.width, image.height, {
            inversionAttempts: 'dontInvert'
          });
          if (hit) {
            const code = parseScan(hit.data);
            if (code) {
              closeModal();
              $('enterCode').value = code;
              $('enterCode').focus();
              return;
            }
          }
        }
      }
      scanFrame = requestAnimationFrame(frame);
    }
    scanFrame = requestAnimationFrame(frame);
  } catch (e) {
    stopCamera();
    if (modal.open && body.contains(video)) modalError(new Error('Camera unavailable. Enter a code instead.'));
  }
});
$('appInfo').addEventListener('click', () => {
  if (!unlockToken) return;

  const topics = [
    ['Notifications', 'Stay in qzu. to receive messages. No push or sound notifications.'],
    ['Temporary chats', 'Conversations and messages are automatically removed from the server 30 minutes after the chat begins. No message backups are created.'],
    ['Anonymous access', 'No phone number, email address or public username is required.'],
    ['Connection codes', 'Invite codes expire after 10 minutes. Generate a new code when needed.'],
    ['Automatic lock', 'Leaving the tab locks qzu. Unlock with your login PIN.'],
    ['emg.exe', 'Your single-use emergency PIN removes your active chats for all participants. A replacement requires developer approval.'],
    ['Groups', 'Up to 12 anonymous members. Groups expire 30 minutes after creation. New members can see existing group messages.'],
    ['Privacy mode', 'Hide chat previews and blur messages until you reveal them. This is a visual privacy feature, not encryption.'],
    ['View once', 'Direct-chat messages can be opened once by the recipient. Screenshots and saved copies cannot be prevented.'],
    ['Media', 'Photos and voice messages are held temporarily in server memory and expire with the chat.'],
    ['Connections', 'New connections require approval. Blocked accounts cannot reconnect while using the same account.'],
    ['Invisible mode', 'Hides active status, typing and read receipts. Delivery status and opening view-once messages may still be visible.'],
    ['Feedback', 'Only the text you explicitly submit is sent to the developer via Discord.'],
    ['Privacy', 'Messages are not yet end-to-end encrypted. Screenshots and externally saved copies cannot be removed by qzu.']
  ];

  const list = el('div', 'info-list');

  for (const [title, description] of topics) {
    const item = el('div', 'info-item');
    item.append(el('h3', '', title), el('p', '', description));
    list.append(item);
  }

  show('Info', [list, button('Close', closeModal)]);
});

$('resetPin').addEventListener('click', () => {
  if (['new', 'approved'].includes(state.pinState)) {
    offerPin();
    return;
  }
  const request = button('Request Reset', async() => {
    request.disabled = true;
    try {
      await api('pin/reset', {});
      await refresh();
      info('Reset requested', 'Pending developer approval.');
    } catch (e) {
      request.disabled = false;
      modalError(e);
    }
  });
  if (state.resetDelivered) {
    info('Reset pending', 'Pending developer approval.');
    return;
  }
  show('Request Reset', [request, button('Cancel', closeModal, 'secondary-button')]);
});
$('emergency').addEventListener('click', () => {
  if (['new', 'approved'].includes(state.pinState)) {
    offerPin();
    return;
  }
  if (state.pinState !== 'active') {
    info('emg.exe', 'Request Reset to set a new PIN.');
    return;
  }
  const pin = el('input', 'pin-input');
  pin.type = 'password';
  pin.inputMode = native ? 'none' : 'numeric';
  pin.readOnly = native;
  pin.maxLength = 6;
  pin.autocomplete = 'off';
  pin.setAttribute('aria-label', 'Six-digit security PIN');
  pin.placeholder = '••••••';
  const execute = button('Execute', async() => {
    if (!/^\d{6}$/.test(pin.value)) return;
    execute.disabled = true;
    try {
      await api('emergency', {
        pin: pin.value
      });
      pin.value = '';
      state.pinState = 'used';
      clearVolatile();
      info('emg.exe', 'Your chats were removed.');
      await refresh();
    }
    catch (e) {
      pin.value = '';
      pin.dispatchEvent(new Event('input', { bubbles: true }));
      modalError(e);
      execute.disabled = true;
      if (!native) pin.focus();
    }
  }, 'primary-button danger-button');
  execute.disabled = true;
  pin.addEventListener('input', () => {
    pin.value = pin.value.replace(/\D/g, '').slice(0, 6);
    execute.disabled = pin.value.length !== 6;
  });
  const keypad = pinKeypad([pin]);
  const content = [el('p', '', 'Delete all your conversations for both sides. This PIN can only be used once.'), pin];
  if (keypad) content.push(keypad);
  content.push(execute, button('Cancel', closeModal, 'secondary-button'));
  show('emg.exe', content);
  if (!native) pin.focus();
});
if (page === 'connect' && location.hash) {
  const code = location.hash.slice(1).toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(code)) pendingInvite = code;
  history.replaceState(null, '', location.pathname);
}
if (native) {
  if(window.Capacitor.getPlatform()==='ios')devicePlugin.addListener('screenCaptured',()=>{if(unlockToken)lock();}).catch(()=>{});
  console.info('[qzu] Mobile startup; device plugin available:', window.Capacitor.isPluginAvailable('QzuDevice'), '; server:', apiOrigin);
  window.Capacitor.registerPlugin('App').addListener('appStateChange', ({ isActive }) => {
    if (!isActive) { if (!isPublicCheckout()) lock(); }
    else if (isPublicCheckout()) resumeCheckout?.();
    else if (!unlockToken) getSession();
  });
}
window.addEventListener('offline', () => {
  if (unlockToken) lock();
});
window.addEventListener('online', () => {
  if (isPublicCheckout()) resumeCheckout?.();
  else if (!unlockToken) getSession();
});
document.addEventListener('visibilitychange', () => {
  if (isPublicCheckout()) {
    if (!document.hidden) resumeCheckout?.();
    return;
  }
  if (document.hidden) lock();
  else if (!unlockToken) getSession();
});
window.addEventListener('pagehide', () => { if (!isPublicCheckout()) lock(); });
window.addEventListener('pageshow', e => {
  if (!e.persisted) return;
  if (isPublicCheckout()) resumeCheckout?.();
  else if (!unlockToken) getSession();
});
setInterval(purgeExpired, 250);

async function loop() {
  if (unlockToken && !accessDue && !document.hidden) {
    try {
      await refresh();
    } catch {
      if (unlockToken && !accessDue) lock();
    }
  }
  setTimeout(loop, 1500);
}
updatePages();
getSession();
loop();


function previewText(message) {
  if (message.deleted) return 'This message was deleted.';
  if (message.burnSeconds) return 'Timed message';
  if (message.once) return message.opened ? 'Opened' : 'View-once message';
  if (message.kind === 'image') return 'Photo';
  if (message.kind === 'audio') return 'Voice message';
  return message.text;
}

function resetOnce() {
  viewOnce = false;
  burnSeconds = 0;
  $('attachmentMenu').classList.remove('once-active');
  $('message').placeholder = 'Message';
}

function renderRequests() {
  const requests = state.requests || [];
  const incoming = requests.filter(request => request.incoming).length;
  $('connectionRequests').hidden = !requests.length;
  $('connectionRequests').textContent = incoming ? 'Connection requests (' + incoming + ')' : 'Pending connections (' + requests.length + ')';
}

$('connectionRequests').addEventListener('click', () => {
  const list = el('div', 'request-list');
  for (const request of state.requests || []) {
    const item = el('div', 'request-item');
    item.append(el('strong', '', request.incoming ? (request.group ? 'Group join request' : 'Connection request') : 'Awaiting approval'));
    if (request.incoming) {
      const actions = el('div', 'request-actions');
      for (const accept of [false, true]) {
        actions.append(button(accept ? 'Accept' : 'Decline', async () => {
          const respond=async nickname=>{
            const result=await api('connection/respond',{id:request.id,accept,nickname});
            closeModal();
            await refresh();
            if(result.id)selectRoom(result.id);
          };
          if(accept&&!request.group){askNickname(respond,'Accept');return;}
          try{await respond(undefined);}catch(error){modalError(error);}
        },accept?'primary-button':'secondary-button'));
      }
      item.append(actions);
    }
    list.append(item);
  }
  show('Connections', [list, button('Close', closeModal)]);
});

async function reactTo(room, message, emoji) {
  try {
    await api('message/react', { id: room.id, messageId: message.id, emoji });
    closeModal();
    await refresh();
  } catch (error) { showError(error); }
}

function messageActions(room, message) {
  const picker = el('div', 'reaction-picker');
  for (const emoji of reactions) picker.append(button(emoji, () => reactTo(room, message, emoji), 'reaction-choice'));
  const controls = message.once || message.burnSeconds ? [] : [picker];

  if (!message.once && !message.burnSeconds && message.mine && message.kind === 'text' && serverNow() - message.at <= 60_000) {
    controls.push(button('Edit message', () => {
      const input = el('textarea', 'edit-input');
      input.value = message.text;
      input.maxLength = 2000;
      input.setAttribute('aria-label', 'Edit message');
      const save = button('Save', async () => {
        try {
          await api('message/edit', { id: room.id, messageId: message.id, text: input.value });
          closeModal();
          await refresh();
        } catch (error) { modalError(error); }
      });
      show('Edit message', [input, save, button('Cancel', closeModal, 'secondary-button')]);
      mediaRoom = room.id;
      mediaMessage = message.id;
    }, 'secondary-button'));
  }
  if ((message.mine || (room.supportAgent && state.supportAgent)) && !message.deleted) controls.push(button(message.mine ? 'Unsend' : 'Delete for both', () => confirmUnsend(room, message), 'primary-button danger-button'));
  controls.push(button('Close', closeModal, 'secondary-button'));
  show('Message', controls);
  mediaRoom = room.id;
  mediaMessage = message.id;
}

function showExtension(room) {
  const request = room.extension;
  const action = (label, value) => button(label, async () => {
    try { await api('chat/extend', { id: room.id, action: value, requestId: request?.id }); closeModal(); await refresh(); } catch (error) { modalError(error); }
  }, 'secondary-button');
  const content = [el('p', '', 'Add 30 minutes once, only if both participants agree.')];
  if (request?.incoming) content.push(action('Accept +30 minutes', 'accept'), action('Decline', 'decline'));
  else if (request) content.push(el('p', '', 'Waiting for the other participant.'));
  else if (!room.extended) content.push(action('Request extension', 'request'));
  content.push(button('Close', closeModal));
  show('Extend chat', content);
}
$('extensionNotice').addEventListener('click', () => {
  const room = state.rooms.find(item => item.id === selected);
  if (room?.extension) showExtension(room);
});
async function showFingerprint(room) {
  try {
    const result = await api('chat/fingerprint', { id: room.id });
    if (selected !== room.id) return;
    show('Device fingerprints', [el('p', '', 'Compare the entire code with your contact through a separate trusted channel.'), el('div', 'fingerprint-code', result.code.match(/.{1,4}/g).join(' ')), el('p', '', 'Based on server-registered device keys. This is not end-to-end encryption or independent proof against the server.'), button('Close', closeModal)]);
  } catch (error) { showError(error); }
}
$('chatOptions').addEventListener('click', () => {
  const room = state.rooms.find(room => room.id === selected);
  if (!room) return;
  if (room.supportAgent && state.supportAgent) {
    const control=(label,mode)=>button(label,async()=>{
      try {await api('support/lifetime',{id:room.id,mode});closeModal();await refresh();}catch(error){modalError(error);}
    },'secondary-button');
    show('Support admin controls',[el('p','',room.deletionRequested?'The user has requested deletion.':'Manage retention for both participants.'),el('p','','Timers delete the conversation for both sides. +30 minutes adds to the existing timer, or starts a 30-minute timer if none is active.'),control('10 minutes from now','10m'),control('+30 minutes','30m'),control('24 hours from now','24h'),control('48 hours from now','48h'),control('Keep until deleted','keep'),button('Delete for both',()=>{$('deleteChat').click();},'primary-button danger-button'),button('Close',closeModal,'secondary-button')]);
    return;
  }
  if (room.admin) return;
  const controls = [];
  if (!room.group) {
    if(room.contact)controls.push(button('Manage contact',()=>showContactManagement(room.contact),'secondary-button'));
    controls.push(button('Verify encryption', () => showEncryption(room), 'secondary-button'));
    if (!room.extended) controls.push(button('Extend chat', () => showExtension(room), 'secondary-button'));
  }
  const confirm = member => {
    show('Block contact?', [
      el('p', '', 'This prevents new connections with this account and separates you from shared chats.'),
      button('Block', async () => {
        try {
          await api('block', { id: room.id, member });
          closeModal();
          await refresh();
        } catch (error) { modalError(error); }
      }, 'primary-button danger-button'),
      button('Cancel', closeModal, 'secondary-button')
    ]);
  };
  if (room.group) {
    for (const member of room.members || []) controls.push(button('Block ' + member, () => confirm(member), 'secondary-button'));
  } else controls.push(button('Block contact', () => confirm(null), 'secondary-button'));
  controls.push(button('Close', closeModal, 'secondary-button'));
  show('Chat options', controls);
});

$('blockedContacts').addEventListener('click', async () => {
  try {
    const result = await api('blocks');
    const list = el('div', 'request-list');
    if (!result.blocks.length) list.append(el('p', '', 'No blocked contacts.'));
    for (const id of result.blocks) {
      const item = el('div', 'request-item');
      item.append(el('strong', '', 'Contact ' + id.slice(0, 4).toUpperCase()), button('Unblock', async () => {
        try {
          await api('unblock', { target: id });
          item.remove();
        } catch (error) { modalError(error); }
      }, 'secondary-button'));
      list.append(item);
    }
    show('Blocked contacts', [list, button('Close', closeModal)]);
  } catch (error) { showError(error); }
});

const accentChoices = ['green', 'red', 'blue', 'purple', 'gold', 'grey'];
function applyAccent(value) {
  if (!accentChoices.includes(value)) value = 'red';
  document.documentElement.dataset.accent = value;
  try { localStorage.setItem('qzu-accent', value); } catch {}
}

try { applyAccent(localStorage.getItem('qzu-accent')); } catch { applyAccent('red'); }
$('accentSettings').addEventListener('click', () => {
  const picker = el('div', 'accent-picker');
  for (const color of accentChoices) {
    const choice = button(color, () => { applyAccent(color); closeModal(); }, 'accent-choice');
    choice.dataset.color = color;
    picker.append(choice);
  }
  show('Accent color', [picker, button('Close', closeModal)]);
});

function clearMedia() {
  if (recordingCleanup) {
    const cleanup = recordingCleanup;
    recordingCleanup = null;
    cleanup();
  }
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = null;
  mediaRoom = null;
  mediaMessage = null;
}

function showMedia(room, kind, source, messageId) {
  const node = el(kind === 'image' ? 'img' : 'audio', 'temporary-media');
  if (kind === 'image') node.alt = 'Temporary photo';
  else node.controls = true;
  show(kind === 'image' ? 'Photo' : 'Voice message', [node, button('Close', closeModal)]);
  mediaRoom = room.id;
  mediaMessage = messageId;
  if (source instanceof Blob) {
    mediaUrl = URL.createObjectURL(source);
    node.src = mediaUrl;
  } else node.src = source;
}

async function openMedia(room, message) {
  const epoch = authEpoch;
  try {
    if (room.encryption || (native && directRoom(room))) {
      if (!encryptionReady(room) || !message.encryptedMedia) throw Error('Verify encryption before opening attachments.');
      const result = await api('encryption/media/' + encodeURIComponent(room.id) + '/' + encodeURIComponent(message.id));
      if (result.kind !== message.kind) throw Error('Invalid attachment.');
      const context = roomKeys.get(room.id)?.context;
      if (!context) throw Error('Encryption key unavailable.');
      const blob = await QzuCrypto.decryptMedia(context, message.kind, result.cipher, message.mine);
      if (epoch !== authEpoch || document.hidden || selected !== room.id || !state.rooms.some(item => item.id === room.id && item.messages.some(m => m.id === message.id && !m.deleted))) return;
      showMedia(room, message.kind, blob, message.id);
      return;
    }
    const response = await transport('/api/media/' + encodeURIComponent(room.id) + '/' + encodeURIComponent(message.id), {
      headers: { 'X-QZU-Unlock': unlockToken }, cache: 'no-store', credentials: 'same-origin', signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined
    });
    if (!response.ok) throw new Error('Attachment unavailable.');
    const blob = await response.blob();
    if (epoch !== authEpoch || document.hidden || selected !== room.id) return;
    if (!state.rooms.some(item => item.id === room.id && item.messages.some(m => m.id === message.id && !m.deleted))) return;
    showMedia(room, message.kind, blob, message.id);
  } catch (error) { if (epoch === authEpoch) showError(error); }
}

async function openOnceMessage(room, message) {
  const open = button('Open once', async () => {
    open.disabled = true;
    try {
      const result = await api('message/open', { id: room.id, messageId: message.id });
      if (selected !== room.id) return;
      if (result.media) showMedia(room, result.kind, 'data:' + result.media.mime + ';base64,' + result.media.data, message.id);
      else {
        show('View once', [el('p', 'once-content', result.text), button('Close', closeModal)]);
        mediaRoom = room.id;
        mediaMessage = message.id;
      }
      await refresh();
    } catch (error) { modalError(error); }
  });
  show('View once', [el('p', '', 'This message cannot be reopened.'), open, button('Cancel', closeModal, 'secondary-button')]);
  mediaRoom = room.id;
  mediaMessage = message.id;
}

$('attachmentMenu').addEventListener('click', () => {
  const room = state.rooms.find(room => room.id === selected);
  if (!room || room.admin) return;
  if (room.encryption || (native && directRoom(room))) {
    if (!encryptionReady(room)) { showEncryption(room); return; }
    resetOnce();
    show('Encrypted attachments', [button('Photo', () => choosePhoto(room), 'secondary-button'), button('Voice message', () => recordVoice(room), 'secondary-button'), button('Close', closeModal)]);
    return;
  }
  const items = burnSeconds ? [] : [button('Photo', () => choosePhoto(room), 'secondary-button'), button('Voice message', () => recordVoice(room), 'secondary-button')];
  if (!room.group && !burnSeconds) items.unshift(button(viewOnce ? 'Disable view once' : 'Enable view once', () => {
    viewOnce = !viewOnce;
    burnSeconds = 0;
    $('attachmentMenu').classList.toggle('once-active', viewOnce);
    $('message').placeholder = viewOnce ? 'View-once message' : 'Message';
    closeModal();
  }, 'secondary-button'));
  if (!room.group) items.unshift(button(burnSeconds ? 'Timed text · ' + burnSeconds + 's' : 'Burn after reading', () => {
    show('Burn after reading', [el('p', '', 'Text is revealed only when opened. The timer then runs for both sides. Copies cannot be prevented.'), ...[5,10,30,0].map(seconds => button(seconds ? seconds + ' seconds' : 'Off', () => {
      resetOnce();
      burnSeconds = seconds;
      if (seconds) clearReply();
      $('attachmentMenu').classList.toggle('once-active', Boolean(seconds));
      $('message').placeholder = seconds ? 'Timed text · ' + seconds + 's' : 'Message';
      closeModal();
    }, 'secondary-button'))]);
  }, 'secondary-button'));
  show('Message options', [...items, button('Close', closeModal)]);
});

function blobData(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function sendAttachment(room, kind, blob, once) {
  const startEpoch=authEpoch;
  if(kind==='image')blob=await QzuMetadata.cleanImage(blob);
  if(startEpoch!==authEpoch||!unlockToken||selected!==room.id||document.hidden||room.expires<=serverNow())throw Error('Chat unavailable.');
  if (blob.size > 2 * 1024 * 1024 || !blob.size) throw new Error('Attachment must be under 2 MB.');
  const epoch = authEpoch;
  if (room.encryption || (native && directRoom(room))) {
    if (!encryptionReady(room) || once) throw Error('Verified encryption required.');
    const cipher = await QzuCrypto.encryptMedia(roomKeys.get(room.id).context, kind, blob);
    if (epoch !== authEpoch || !unlockToken || selected !== room.id || document.hidden || room.expires <= serverNow()) throw Error('Chat unavailable.');
    await api('encryption/message', { id: room.id, kind, cipher });
  } else {
    const data = await blobData(blob);
    if (epoch !== authEpoch || !unlockToken || selected !== room.id || document.hidden) throw new Error('Chat unavailable.');
    await api('message', { id: room.id, kind, mime: blob.type.split(';')[0], data, once });
  }
  resetOnce();
  closeModal();
  await refresh();
}

function choosePhoto(room) {
  const input = el('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  const send = button(viewOnce ? 'Send once' : 'Send photo', async () => {
    const file = input.files[0];
    if (!file) return;
    send.disabled = true;
    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) throw new Error('Choose a JPG, PNG or WebP image under 2 MB.');
      await sendAttachment(room, 'image', file, viewOnce);
    } catch (error) { send.disabled = false; modalError(error); }
  });
  show('Send photo', [input, el('p', '', 'JPG, PNG or WebP · Up to 2 MB · Metadata removed'), send, button('Cancel', closeModal, 'secondary-button')]);
  mediaRoom = room.id;
}

async function recordVoice(room) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    info('Voice message', 'Recording is unavailable in this browser.');
    return;
  }
  const label = el('p', '', 'Allow microphone access to record.');
  const stop = button('Stop recording', () => {}, 'secondary-button');
  stop.disabled = true;
  show('Voice message', [label, stop, button('Cancel', closeModal, 'secondary-button')]);
  mediaRoom = room.id;
  const epoch = authEpoch;
  let microphone;
  try {
    microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (epoch !== authEpoch || !body.contains(label) || document.hidden) {
      microphone.getTracks().forEach(track => track.stop());
      return;
    }
    const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) {
      microphone.getTracks().forEach(track => track.stop());
      throw new Error('No supported recording format.');
    }
    const recorder = new MediaRecorder(microphone, { mimeType: mime, audioBitsPerSecond: 64000 });
    const chunks = [];
    let cancelled = false;
    let timer;
    const cleanup = () => {
      cancelled = true;
      clearTimeout(timer);
      if (recorder.state !== 'inactive') recorder.stop();
      microphone.getTracks().forEach(track => track.stop());
    };
    recordingCleanup = cleanup;
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      clearTimeout(timer);
      microphone.getTracks().forEach(track => track.stop());
      if (recordingCleanup === cleanup) recordingCleanup = null;
      if (cancelled || epoch !== authEpoch || !body.contains(label)) return;
      const blob = new Blob(chunks, { type: mime });
      const send = button(viewOnce ? 'Send once' : 'Send recording', async () => {
        send.disabled = true;
        try { await sendAttachment(room, 'audio', blob, viewOnce); }
        catch (error) { send.disabled = false; modalError(error); }
      });
      const player = el('audio', 'temporary-media');
      player.controls = true;
      show('Voice message', [player, send, button('Discard', closeModal, 'secondary-button')]);
      mediaRoom = room.id;
      mediaUrl = URL.createObjectURL(blob);
      player.src = mediaUrl;
    };
    stop.disabled = false;
    stop.addEventListener('click', () => { if (recorder.state !== 'inactive') recorder.stop(); });
    recorder.start();
    label.textContent = 'Recording… Maximum 60 seconds.';
    timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 60_000);
  } catch (error) {
    microphone?.getTracks().forEach(track => track.stop());
    if (epoch === authEpoch && body.contains(label)) modalError(error);
  }
}

function confirmUnsend(room, message) {
  const confirm = button(message.mine ? 'Unsend' : 'Delete for both', async () => {
    confirm.disabled = true;
    try {
      await api('message/unsend', { id: room.id, messageId: message.id });
      closeModal();
      await refresh();
    } catch (error) {
      confirm.disabled = false;
      modalError(error);
    }
  }, 'primary-button danger-button');
  show(message.mine ? 'Unsend message?' : 'Delete message for both?', [el('p', '', 'Remove this message for everyone in the chat. Saved copies cannot be removed.'), confirm, button('Cancel', closeModal, 'secondary-button')]);
  mediaRoom = room.id;
  mediaMessage = message.id;
}

$('invisibleMode').addEventListener('change', async () => {
  const enabled = $('invisibleMode').checked;
  const epoch = authEpoch;
  invisibleSaving = true;
  $('invisibleMode').disabled = true;
  if (enabled) stopTyping();
  try {
    const result = await api('privacy/invisible', { enabled });
    state.invisible = result.invisible;
    await refresh();
  } catch (error) {
    if (epoch === authEpoch) showError(error);
  } finally {
    if (epoch === authEpoch) {
      invisibleSaving = false;
      renderSettings();
    }
  }
});

$('securityCenter').addEventListener('click', () => {
  const list = el('div', 'security-list');
  const items = [
    ['Login PIN', 'Enabled'],
    ['Automatic lock', 'Enabled'],
    ['Chat lifetime', '30 minutes'],
    ['Privacy mode', privacyMode ? 'Enabled' : 'Disabled'],
    ['Invisible mode', state.invisible ? 'Enabled' : 'Disabled'],
    ['Emergency PIN', state.pinState === 'active' ? 'Ready' : state.pinState === 'used' ? 'Used' : 'Not configured'],
    ['End-to-end encryption', 'Not implemented'],
    ['Saved copies', 'Outside qzu. control']
  ];
  for (const [name, value] of items) {
    const item = el('div', 'security-item');
    item.append(el('span', '', name), el('strong', '', value));
    list.append(item);
  }
  show('Security center', [list, button('Security activity', showSecurityActivity, 'secondary-button'), button('Lock now', () => lock(), 'secondary-button'), button('Close', closeModal)]);
});

async function showSecurityActivity() {
  try {
    const { events } = await api('security/activity');
    const list = el('div', 'security-list');
    if (!events.length) list.append(el('p', '', 'No recent activity.'));
    for (const event of events) {
      const item = el('div', 'security-item');
      item.append(el('span', '', event.event), el('strong', '', new Date(event.at).toLocaleString()));
      list.append(item);
    }
    show('Security activity', [el('p', '', 'Up to 50 events from the last 30 days. No PINs, messages or IP addresses recorded here.'), list, button('Close', closeModal)]);
  } catch (error) { showError(error); }
}
function newerVersion(latest, current = installedVersion) {
  if (![latest, current].every(value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value))) return false;
  const a = latest.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function reminderUntil(version) {
  let until = updateReminders.get(version) || 0;
  try { until = Math.max(until, Number(localStorage.getItem('qzu-update-later-' + version)) || 0); } catch {}
  return until;
}

function deferUpdate(version) {
  const until = Date.now() + 6 * 60 * 60 * 1000;
  updateReminders.set(version, until);
  try { localStorage.setItem('qzu-update-later-' + version, String(until)); } catch {}
}

function updateDownload(release) {
  if (!native) return null;
  try {
    const url = new URL(release.downloads?.[window.Capacitor?.getPlatform?.()]);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

async function installUpdate(release) {
  const url = updateDownload(release);
  if (!url) { showUpdatePrompt(release); return; }
  try {
    await devicePlugin.openUpdate({ url });
    deferUpdate(release.latest);
    closeModal();
  } catch (error) { modalError(error); }
}

function showUpdatePrompt(release) {
  const logo = svg('logo', 'wordmark update-wordmark');
  const description = el('p', 'update-description', 'A new version is available.');
  const actions = el('div', 'update-actions');
  actions.append(button('Remind me later', () => { deferUpdate(release.latest); closeModal(); }, 'secondary-button update-later'));
  if (updateDownload(release)) actions.append(button('Install now', () => installUpdate(release), 'primary-button update-install'));
  else actions.classList.add('update-single');
  show('Update available', [logo, description, actions]);
  modal.classList.add('update-sheet');
  $('modalClose').hidden = true;
}

function maybePromptUpdate() {
  if (!native || !unlockToken || accessDue || document.hidden) return;
  const now = Date.now();
  if (!updateChecking && now >= nextUpdateCheck) {
    updateChecking = true;
    nextUpdateCheck = now + 15 * 60 * 1000;
    const epoch = authEpoch;
    api('version').then(release => {
      if (epoch === authEpoch && unlockToken) pendingUpdate = newerVersion(release.latest) ? release : null;
    }).catch(() => {}).finally(() => { updateChecking = false; });
  }
  if (!pendingUpdate || !newerVersion(pendingUpdate.latest) || reminderUntil(pendingUpdate.latest) > now || modal.open || $('message').value.trim() || mediaRoom) return;
  showUpdatePrompt(pendingUpdate);
}

$('updateCenter').addEventListener('click', async () => {
  try {
    const release = await api('version');
    if (newerVersion(release.latest)) { pendingUpdate = release; showUpdatePrompt(release); return; }
    show('Update center', [el('strong', '', 'You are up to date'), el('p', '', 'Installed: ' + installedVersion + ' · Server release: ' + release.latest), el('p', '', release.notes), button('Close', closeModal)]);
  } catch (error) { showError(error); }
});
const backgroundChoices = ['plain', 'grid', 'dots'];
function applyChatBackground(value) {
  if (!backgroundChoices.includes(value)) value = 'plain';
  document.documentElement.dataset.chatBackground = value;
  try { localStorage.setItem('qzu-chat-background', value); } catch {}
}

try { applyChatBackground(localStorage.getItem('qzu-chat-background')); } catch { applyChatBackground('plain'); }

$('chatBackground').addEventListener('click', () => {
  const picker = el('div', 'background-picker');
  for (const name of backgroundChoices) {
    const choice = button('', () => { applyChatBackground(name); closeModal(); }, 'background-choice');
    const sample = el('div', 'background-preview pattern-' + name);
    sample.append(el('span', 'preview-bubble'), el('span', 'preview-bubble mine'));
    choice.append(sample, el('span', '', name === 'plain' ? 'Minimal' : name === 'grid' ? 'Grid' : 'Dots'));
    choice.setAttribute('aria-pressed', String(document.documentElement.dataset.chatBackground === name));
    picker.append(choice);
  }
  show('Chat background', [picker, button('Close', closeModal)]);
});

$('submitFeedback').addEventListener('click', () => {
  const input = el('textarea', 'edit-input feedback-input');
  input.placeholder = 'Your feedback';
  input.maxLength = 2000;
  input.setAttribute('aria-label', 'Your feedback');
  const label = el('label', 'feedback-confirm');
  const check = el('input');
  check.type = 'checkbox';
  label.append(check, el('span', '', 'Submit your Feedback'));
  const submit = button('Submit', async () => {
    if (!check.checked || !input.value.trim()) return;
    submit.disabled = true;
    try {
      await api('feedback', { message: input.value.trim(), confirmed: true });
      input.value = '';
      info('Feedback sent', 'Thank you for your feedback.');
    } catch (error) {
      submit.disabled = false;
      modalError(error);
    }
  });
  const update = () => { submit.disabled = !check.checked || !input.value.trim(); };
  input.addEventListener('input', update);
  check.addEventListener('change', update);
  update();
  show('Submit feedback', [input, el('p', '', 'Do not include PINs, personal details or private messages.'), label, submit, button('Cancel', closeModal, 'secondary-button')]);
});

function isPublicCheckout() {
  return !unlockToken && modal.dataset.checkout === 'public';
}

function showCheckout(title, content, renewal = false) {
  show(title, content, true);
  modal.dataset.checkout = renewal ? 'renewal' : 'public';
}

function stopCheckout() {
  resumeCheckout = null;
  checkoutEpoch++;
  clearTimeout(accessTimer);
  accessTimer = null;
}

function rememberInvoice(key, renewal) {
  try { localStorage.setItem(renewal ? 'qzu-renewal' : 'qzu-access', key); } catch {}
}

function savedInvoice(renewal) {
  try { return localStorage.getItem(renewal ? 'qzu-renewal' : 'qzu-access') || ''; } catch { return ''; }
}

function forgetInvoice(renewal) {
  try { localStorage.removeItem(renewal ? 'qzu-renewal' : 'qzu-access'); } catch {}
}

function showAccess() {
  const plan = el('div', 'access-plan');
  plan.append(el('strong', 'access-price', '€19.99'), el('span', '', 'First 5 months included'), el('span', 'access-mini', 'Then €2.99/month · Incl. 19% tax'), el('span', 'access-mini', '12 months · €40.92 total'));
  const terms = el('label', 'feedback-confirm');
  const check = el('input');
  check.type = 'checkbox';
  terms.append(check, el('span', '', 'I accept the payment terms.'));
  const purchase = button('Purchase access', async () => {
    purchase.disabled = true;
    try {
      const invoice = await api('access/invoice', { plan: 'monthly', accepted: true });
      rememberInvoice(invoice.orderKey, false);
      showInvoice(invoice.orderKey, invoice, false);
    } catch (error) {
      dialogError(error);
      purchase.disabled = !check.checked;
    }
  });
  purchase.disabled = true;
  check.addEventListener('change', () => { purchase.disabled = !check.checked; });
  const controls = [plan, terms, purchase];
  const saved = savedInvoice(false);
  if (saved) controls.push(button('Resume purchase', () => showInvoice(saved, null, false), 'secondary-button'));
  controls.push(button('Redeem Key', () => showKeyEntry(false), 'secondary-button'));
  showCheckout('qzu-Access', controls);
}

function showKeyEntry(renewal) {
  const input = el('input', 'access-key-input');
  input.placeholder = 'Use Access-Key';
  input.setAttribute('aria-label', 'Use Access-Key');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = renewal ? 52 : 58;
  const submit = button('Continue', async () => {
    const value = input.value.trim().toUpperCase();
    if(!renewal&&/^QZU-ADMIN-[A-F0-9]{48}$/.test(value)){
      submit.disabled=true;
      try{
        const result=await api('session',{accessKey:value});
        if(result.accessRequired||!result.needsSetup)throw Error('Key activation unavailable.');
        input.value='';forgetInvoice(false);delete modal.dataset.checkout;stopCheckout();sessionReady=true;needsSetup=result.needsSetup;showLogin();
      }catch(error){dialogError(error);submit.disabled=false;}
      return;
    }
    if (!/^QZ[UO]-[A-F0-9]{48}$/.test(value)) return dialogError(new Error('Enter a valid key.'));
    rememberInvoice(value, renewal);
    showInvoice(value, null, renewal);
  });
  showCheckout('Use Access-Key', [input, submit, button('Back', renewal ? showRenewal : showAccess, 'secondary-button')], renewal);
}

function showRenewal() {
  const plan = el('div', 'access-plan');
  plan.append(el('strong', 'access-price', '€2.99'), el('span', '', 'One month · Incl. 19% tax'));
  const controls = [plan, button('Renew access', async () => {
    try {
      const invoice = await api('access/invoice', { plan: 'renewal', accepted: true });
      rememberInvoice(invoice.orderKey, true);
      showInvoice(invoice.orderKey, invoice, true);
    } catch (error) { dialogError(error); }
  })];
  const saved = savedInvoice(true);
  if (saved) controls.push(button('Resume renewal', () => showInvoice(saved, null, true), 'secondary-button'));
  controls.push(button('Enter renewal key or reference', () => showKeyEntry(true), 'secondary-button'));
  controls.push(button(accessDue ? 'Lock' : 'Close', accessDue ? () => { delete modal.dataset.checkout; checkoutReturn = null; lock(); } : () => { modalLocked = false; closeModal(); }, 'secondary-button'));
  showCheckout('Renew access', controls, true);
}

function showInvoice(secret, initial, renewal) {
  const content = el('div', 'access-invoice');
  const status = el('strong', 'access-status', 'Checking order…');
  const details = el('div', 'access-details');
  const timer = el('span', 'access-timer');
  const controls = el('div', 'access-controls');
  content.append(status, details, timer, controls);
  showCheckout('Litecoin checkout', [content, button('Back', renewal ? showRenewal : showAccess, 'secondary-button')], renewal);
  const ticket = checkoutEpoch;
  let current = null;
  let busy = false;
  let lastKey = '';
  let serverOffset = 0;
  let polling = false;

  function copy(label, value) {
    return button(label, async () => {
      try { await navigator.clipboard.writeText(value); }
      catch { dialogError(new Error('Select and copy the text manually.')); }
    }, 'secondary-button');
  }

  function renderInvoice(invoice) {
    current = invoice;
    serverOffset = invoice.now - Date.now();
    const fingerprint = JSON.stringify([invoice.state, invoice.redeemed, invoice.activationKey, invoice.reviewUntil]);
    if (lastKey === fingerprint) return;
    lastKey = fingerprint;
    const approved = invoice.state === 'confirmed' && !invoice.redeemed && invoice.activationKey;
    status.textContent = invoice.redeemed ? 'Key redeemed' : approved ? 'Payment confirmed' : invoice.state === 'submitted' ? 'Please wait until the Payment has been confirmed' : invoice.state === 'rejected' ? 'Payment not approved' : invoice.state === 'pending' ? 'Pay with Litecoin' : 'Contact the developer';
    details.replaceChildren();
    controls.replaceChildren();

    if (invoice.state === 'pending' && secret.startsWith('QZO-')) {
      details.append(el('strong', 'access-price', '€' + invoice.euro), el('span', '', 'Including 19% tax'));
      if (invoice.qr || initial?.qr) {
        const image = el('img', 'payment-qr');
        image.src = invoice.qr || initial.qr;
        image.alt = 'Litecoin receiving address QR code';
        const qr = el('div', 'payment-qr-wrap');
        qr.setAttribute('aria-label', 'Payment QR not available');
        image.alt = '';
        image.setAttribute('aria-hidden', 'true');
        const overlay = el('span', 'payment-qr-lock');
        overlay.append(svg('lock'), el('span', '', 'Not Available'));
        qr.append(image, overlay);
        details.append(qr);
      }
      details.append(el('p', 'access-address', invoice.address), el('p', 'access-mini', 'Pay the EUR equivalent in LTC. Network fees extra.'));
      controls.append(copy('Copy address', invoice.address));
      const form = el('form', 'access-details');
      const input = el('input', 'access-key-input');
      input.placeholder = 'Transaction ID (TXID)';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.maxLength = 64;
      input.required = true;
      const submit = el('button', 'primary-button', 'I have paid');
      submit.type = 'submit';
      submit.disabled = true;
      input.addEventListener('input', () => { submit.disabled = !/^[a-f0-9]{64}$/i.test(input.value.trim()); });
      form.append(input, submit);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || submit.disabled) return;
        busy = true;
        submit.disabled = true;
        try {
          const result = await api('access/submit', { key: secret, txid: input.value.trim() });
          if (ticket === checkoutEpoch) renderInvoice(result);
        } catch (error) {
          if (ticket === checkoutEpoch) dialogError(error);
          submit.disabled = false;
        } finally { busy = false; }
      });
      controls.append(form);
    }

    if (secret.startsWith('QZO-') && !invoice.redeemed) {
      const reference = el('details', 'access-reference');
      reference.append(el('summary', '', 'Order reference'), el('p', 'access-address', secret), el('p', 'access-mini', 'Keep private to resume your purchase.'), copy('Copy reference', secret));
      details.append(reference);
    }

    const keyBox = el('div', 'access-key-box');
    if (approved) {
      keyBox.append(el('strong', '', renewal ? 'Your renewal key' : 'Your qzu-Access key'), el('p', 'access-address', invoice.activationKey));
      controls.append(copy('Copy key', invoice.activationKey));
      if (!renewal) details.append(el('p', 'access-mini', 'Keep your key private.'));
      controls.append(button(renewal ? 'Apply renewal' : 'Activate account', async () => {
        if (busy) return;
        busy = true;
        try {
          if (renewal) {
            await api('access/renew', { key: invoice.activationKey });
            forgetInvoice(true);
            accessDue = false;
            modalLocked = false;
            closeModal();
            updatePages();
            await refresh();
          } else {
            const result = await api('session', { accessKey: invoice.activationKey });
            if (result.accessRequired) throw new Error('Activation unavailable.');
            forgetInvoice(false);
            delete modal.dataset.checkout;
            stopCheckout();
            sessionReady = true;
            needsSetup = result.needsSetup;
            showLogin();
          }
        } catch (error) {
          if (ticket === checkoutEpoch) dialogError(error);
        } finally { busy = false; }
      }));
    } else {
      keyBox.append(svg('lock'), el('strong', '', invoice.redeemed ? 'Key redeemed' : 'Not Available Yet'));
    }
    details.append(keyBox);
    updateTimer();
  }

  function updateTimer() {
    if (!current || current.state !== 'submitted') {
      timer.textContent = '';
      return;
    }
    const remaining = current.reviewUntil - (Date.now() + serverOffset);
    timer.textContent = remaining > 0 ? clock(remaining) : 'Awaiting confirmation';
  }

  let nextPoll = 0;
  async function tick() {
    if (ticket !== checkoutEpoch || !body.contains(content) || polling) return;
    clearTimeout(accessTimer);
    if (document.hidden) return;
    polling = true;
    updateTimer();
    if (!busy && Date.now() >= nextPoll) {
      nextPoll = Date.now() + 5000;
      try {
        const result = await api('access/status', { key: secret }, true);
        if (ticket !== checkoutEpoch || !body.contains(content)) return;
        renderInvoice(result);
      } catch (error) {
        if (ticket === checkoutEpoch) status.textContent = errorMessage(error);
      }
    }
    polling = false;
    if (ticket === checkoutEpoch && !current?.redeemed) accessTimer = setTimeout(tick, 1000);
  }

  resumeCheckout = () => { nextPoll = 0; tick(); };
  if (initial) renderInvoice(initial);
  tick();
}

$('accessSettings').addEventListener('click', () => {
  const access = state.access;
  if (!access || access.plan !== 'monthly') {
    info('qzu-Access', 'Lifetime or existing account access.');
    return;
  }
  const date = new Date(access.paidUntil).toLocaleDateString();
  show('qzu-Access', [el('p', '', 'Paid through ' + date), el('p', '', 'Months paid: ' + access.monthsPaid + '. Renewal €2.99 including 19% tax.'), button('Renew access', showRenewal), button('Close', closeModal, 'secondary-button')]);
});
