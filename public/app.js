'use strict';
const $ = id => document.getElementById(id);
const native = window.Capacitor?.isNativePlatform?.() === true;
if (native) document.documentElement.classList.add('native-app');
const apiOrigin = native ? window.QZU_API_ORIGIN : location.origin;
const devicePlugin = native ? window.Capacitor.registerPlugin('QzuDevice') : null;
const installedVersion = window.QZU_APP_VERSION || '0.15.1';
const playBuild=native&&window.QZU_DISTRIBUTION==='google-play';
let termsPending=false,suspendedAccount=false;
const roomKeyJobs = new Map();
const roomKeys = new Map();
let nextUpdateCheck = 0, pendingUpdate = null, updateChecking = false;
const updateReminders = new Map();
let officialReadJob=null,officialRenderKey='',liveRevision='',officialHistory=[],manualRefreshes=0,pushRegistration=null,pushEpoch=-1;

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
const openingOnce = new Set();
let mediaRoom = null;
let mediaMessage = null;
let invisibleSaving = false;
let mediaUrl = null;
let recordingCleanup = null;
const reactions = ['👍', '❤️', '😂', '🔥', '😮', '👎'];
let privacyMode = false;
let backgroundPin=true,backgroundPinSaving=false,bootPending=native&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
try{backgroundPin=localStorage.getItem('qzu-background-pin')!=='off';}catch{}
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

const drafts=new Map(), scrollMemory=new Map(), outbox=new Map();
let flushingOutbox=false, nextOutboxAttempt=0, reconnectDelay=500;
function updateConnection(){const node=$('connectionState');const queued=[...outbox.values()].filter(x=>x.room===selected&&!x.accepted),failed=queued.filter(x=>x.failed),syncing=[...outbox.values()].some(x=>x.room===selected&&x.accepted);node.hidden=online&&!queued.length&&!syncing;node.textContent=(!online?'Reconnecting securely…':'')+(queued.length?((!online?' · ':'')+queued.length+' encrypted '+(queued.length===1?'message':'messages')+' waiting'+(failed.length?' · '+failed.length+' failed':'')):syncing?(online?'Syncing messages…':' · Syncing messages…'):'');$('manageOutbox').hidden=!queued.length;}
function discardRoomQueue(id){for(const [key,item] of outbox)if(item.room===id)outbox.delete(key);}
function reconcileOutbox(){for(const [key,item] of outbox){const room=state.rooms.find(r=>r.id===item.room);if(!room||room.expires<=serverNow()||room.messages.some(m=>m.requestId===key))outbox.delete(key);}updateConnection();}
async function flushOutbox(){if(![...outbox.values()].some(item=>!item.accepted&&!item.failed&&!item.sending)||flushingOutbox||!online||!unlockToken||document.hidden||accessDue||termsPending||suspendedAccount||Date.now()<nextOutboxAttempt||!state.capabilities?.queuedSends)return;flushingOutbox=true;const epoch=authEpoch;
try{for(const [key,item] of outbox){if(epoch!==authEpoch||!unlockToken||!online||document.hidden||accessDue||termsPending||suspendedAccount)break;if(item.failed||item.sending||item.accepted)continue;const room=state.rooms.find(r=>r.id===item.room);if(!room||room.expires<=serverNow()){outbox.delete(key);continue;}if(!encryptionReady(room))continue;if(roomKeys.get(room.id)?.context?.code!==item.binding){item.failed=true;item.error='Conversation key changed. Discard this message.';continue;}item.sending=true;try{await api('encryption/message',item.payload);if(epoch!==authEpoch)break;item.accepted=true;}catch(error){if(epoch!==authEpoch)break;if(error.status>=400&&error.status<500&&![408,429].includes(error.status)){item.failed=true;item.error=errorMessage(error);}else{nextOutboxAttempt=Date.now()+3000;break;}}finally{item.sending=false;}}}finally{flushingOutbox=false;updateConnection();if(unlockToken&&page==='chat'&&!document.hidden)renderChat();}}
function markDisconnected(){online=false;liveRevision='';updateConnection();}

const motionAllowed=()=>!matchMedia('(prefers-reduced-motion: reduce)').matches;
const motionJobs=new WeakMap();
function motion(node,cls){
  if(!node||!motionAllowed()||document.hidden)return;
  let jobs=motionJobs.get(node);if(!jobs){jobs=new Map();motionJobs.set(node,jobs);}
  clearTimeout(jobs.get(cls));
  node.classList.remove(cls);void node.offsetWidth;node.classList.add(cls);
  const timer=setTimeout(()=>{if(jobs.get(cls)===timer){node.classList.remove(cls);jobs.delete(cls);}},420);
  jobs.set(cls,timer);
}
function animateFromComposer(row){
  if(!row||!row.isConnected||!motionAllowed()||document.hidden||!row.animate)return;
  const bubble=row.querySelector('.bubble'),composer=$('composer');
  if(!bubble||composer.hidden)return;
  const start=composer.getBoundingClientRect(),end=bubble.getBoundingClientRect();
  if(!end.width||!end.height)return;
  const dy=Math.max(0,Math.min(48,start.top-end.top));
  bubble.animate([{transform:'translateY('+dy+'px) scale(.93)',opacity:.55},{transform:'translateY(0) scale(1)',opacity:1}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
}
function haptic(){if(native&&!document.hidden)devicePlugin.haptic().catch(()=>{});}
function rememberRoom(){if(typeof selected!=='string'||page!=='chat'||!unlockToken)return;const field=$('message'),view=$('messages');if(field.value)drafts.set(selected,{text:field.value,once:viewOnce,burn:burnSeconds});else drafts.delete(selected);if(renderedRoom===selected&&(!mobile.matches||mobileOpen))scrollMemory.set(selected,{top:view.scrollTop,bottom:view.scrollHeight-view.scrollTop-view.clientHeight<100});}
function restoreDraft(id){const draft=drafts.get(id);$('message').value=draft?.text||'';resetOnce();if(draft?.once)setOnceMode(true);else if(draft?.burn){burnSeconds=draft.burn;$('attachmentMenu').classList.add('once-active');$('message').placeholder='Timed text · '+burnSeconds+'s';}}
function updatePages() {
  updateNavigation();
  for (const name of ['chat', 'settings', 'connect']) {const node=$(name+'Page'),hidden=!unlockToken||accessDue||termsPending||suspendedAccount||name!==page;if(node.hidden&&!hidden)motion(node,'motion-page');node.hidden=hidden;}
  $('loading').hidden = Boolean(unlockToken);
  $('loading').classList.toggle('locked', !unlockToken);
}

function navigate(path, push = true) {
  if (push) history.pushState(null, '', path);
  const nextPage = routeName(location.pathname);
  if (page !== nextPage) {
    closeInlineAttachments();
    rememberRoom();
    if(nextPage==='chat')restoreDraft(selected);else resetOnce();
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
  if (url.origin !== location.origin || !['/chat', '/connect', '/settings', '/settings/privacy', '/settings/notifications', '/settings/motion', '/settings/connections', '/settings/appearance', '/settings/account', '/settings/updates', '/settings/help', '/settings/support-requests', '/settings/admin-feedback', '/settings/about', '/'].includes(url.pathname)) return;
  e.preventDefault();
  if (unlockToken) {if(a.dataset.tab==='chat'){rememberRoom();mobileOpen=false;selected=null;renderedRoom=null;$('message').value='';}navigate(url.pathname);}
});
window.addEventListener('popstate', () => navigate(location.pathname, false));
const fmtTime = ms => new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit'
}).format(new Date(ms));
const clock = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const minutes=String(Math.floor(s/60)%60).padStart(2,'0'),seconds=String(s%60).padStart(2,'0');return s>=3600?String(Math.floor(s/3600)).padStart(2,'0')+':'+minutes+':'+seconds:minutes+':'+seconds;
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
    modal.classList.remove('update-sheet','attachment-sheet');$('attachmentMenu').classList.remove('sheet-open');
  }
});

function show(title, content, locked = false) {
  stopCheckout();
  delete modal.dataset.checkout;
  modal.classList.remove('update-sheet','attachment-sheet');$('attachmentMenu').classList.remove('sheet-open');
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
  return typeof error?.message==='string'&&error.message?error.message:'Try again.';
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
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(path==='push/test'||path.startsWith('access/')?25000:8000) : undefined
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
  if (!res.ok) throw Object.assign(new Error(result.error || 'Try again.'),{status:res.status});
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
        dialogError(err);motion(form,'pin-error-motion');haptic();
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
  if (bootPending || document.hidden || unlockToken || !sessionReady) return;
  const setup = needsSetup;
  pinDialog(setup ? 'Create login PIN': 'Unlock', setup ? ['New PIN', 'Confirm PIN']: ['Login PIN'], setup ? 'Create': 'Unlock', async values => {
    if (setup && values[0] !== values[1]) throw new Error('PINs do not match.');
    const result = await api(setup ? 'login/setup': 'login/unlock', {
      pin: values[0],keepUnlocked:native&&!backgroundPin
    });
    unlockToken = result.token;
    accessDue = result.access?.active === false;
    termsPending=result.termsAccepted!==true;suspendedAccount=result.suspended===true;
    needsSetup = false;
    modalLocked = false;
    closeModal();
    if(suspendedAccount){updatePages();showRestrictedAccount('Account suspended','Your account access has been restricted.');return;}
    if(termsPending){updatePages();showTermsGate(result.termsVersion||1);return;}
    if (accessDue || checkoutReturn || (!playBuild&&savedInvoice(true))) {
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
      roomKeyJobs.clear();if(native)await clearPrivateKeys();
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
    await finishBoot();
    if (epoch !== authEpoch || document.hidden) return;
    if (result.accessRequired) {
      sessionReady = false;
      const saved = playBuild?'':savedInvoice(false);
      if (saved) showInvoice(saved, null, false);
      else showAccess();
      return;
    }
    sessionReady = true;
    needsSetup = result.needsSetup;
    showLogin();
  }
  catch (e) {
    await finishBoot();
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
  closeInlineAttachments();
  if (!playBuild && modal.dataset.checkout === 'renewal') {
    const saved = savedInvoice(true);
    checkoutReturn = saved ? () => showInvoice(saved, null, true) : showRenewal;
  }
  stopCheckout();
  accessDue = false;termsPending=false;suspendedAccount=false;
  drafts.clear();scrollMemory.clear();outbox.clear();nextOutboxAttempt=0;updateConnection();
  authEpoch++;
  sequence++;
  const old = unlockToken;
  unlockToken = null;roomKeys.clear();roomKeyJobs.clear();keyPruneSignature='';nextCryptoRetry=0;nextPrekeyAttempt=0;lastBadge=-1;clearTimeout(activityTimer);$('activityBanner').hidden=true;
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
  $('officialUnread').hidden=true;$('officialPosts').replaceChildren();$('officialMessage').value='';$('officialSend').disabled=true;$('officialComposer').hidden=true;officialRenderKey='';officialHistory=[];$('officialOlder').hidden=true;liveRevision='';pushRegistration=null;pushEpoch=-1;
  $('qzuInfoOpen').classList.remove('active');
  $('qzuInfoOpen').setAttribute('aria-pressed', 'false');
  $('groupInvite').hidden = true;
  revokeToken(old);
  stopCamera();
  pinPrompt = false;
  qrKey = '';
  qrPending = '';
  scrubRemovedRooms(state.rooms,[],false);
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
  $('supportRequestsList').replaceChildren();
  $('adminInterface').hidden=true;$('adminLogout').hidden=true;$('userInterfaceHeading').hidden=true;clearAdminFeedback();
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
  if(document.documentElement.dataset.theme&&document.documentElement.dataset.theme!==value)motion($('app'),'motion-theme');
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

let viewportFrame=0,viewportHeight=0,viewportTop=-1;
function setViewport(){
 if(viewportFrame)return;
 viewportFrame=requestAnimationFrame(()=>{
  viewportFrame=0;
  const viewport=window.visualViewport,root=document.documentElement;
  if(native&&viewport&&Math.abs(viewport.scale-1)>=.02)return;
  const h=Math.round(viewport?.height||window.innerHeight),top=Math.max(0,Math.round(viewport?.offsetTop||0));
  if(h===viewportHeight&&top===viewportTop)return;
  const views=[$('messages'),document.querySelector('.pay-ticket-messages')].filter(v=>v&&v.clientHeight>0);
  const positions=views.map(v=>({v,bottom:v.scrollHeight-v.clientHeight-v.scrollTop<85,scroll:v.scrollTop}));
  viewportHeight=h;viewportTop=top;root.style.setProperty('--app-height',h+'px');root.style.setProperty('--viewport-top',top+'px');
  for(const {v,bottom,scroll} of positions)v.scrollTop=bottom?v.scrollHeight:scroll;
  if(native&&(window.scrollX||window.scrollY))window.scrollTo(0,0);
 });
}
setViewport();
window.addEventListener('resize',setViewport);
window.visualViewport?.addEventListener('resize',setViewport);
window.visualViewport?.addEventListener('scroll',setViewport);
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
    closeInlineAttachments();
    rememberRoom();
    if (mediaRoom) closeModal();
    resetOnce();
    stopTyping();
    clearReply();
    revealedMessages.clear();
    restoreDraft(id);
    $('send').disabled = true;
  }
  selected = id;
  mobileOpen = open;
  renderedRoom = null;
  updateConnection();renderChat();if(open&&mobile.matches)motion($('thread'),'motion-thread');updateNavigation();void acknowledgeMessages();
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
let lastBadge=-1,activityTimer=null;
function syncBadge(count){if(pushOptedOut())count=0;if(!native||window.Capacitor.getPlatform()!=='ios'||lastBadge===count)return;lastBadge=count;devicePlugin.setBadge({count}).catch(()=>{lastBadge=-1;});}
function showActivityBanner(){if(pushOptedOut())return;const banner=$('activityBanner');banner.textContent='New message';banner.hidden=false;clearTimeout(activityTimer);activityTimer=setTimeout(()=>{banner.hidden=true;},2400);}
function unreadCount(room){return room.messages.filter(m=>!m.mine&&!m.deleted&&m.unread===true).length;}
function updateNavigation(){const nav=$('bottomNav');const enabled=Boolean(unlockToken&&!accessDue&&!termsPending&&!suspendedAccount&&!(page==='chat'&&mobileOpen&&mobile.matches));nav.hidden=!enabled; $('app').classList.toggle('with-nav',enabled);for(const link of nav.querySelectorAll('[data-tab]')){const active=link.dataset.tab===page;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}const n=state.rooms.filter(r=>r.expires>serverNow()).reduce((sum,r)=>sum+unreadCount(r),0)+(state.official?.unread?1:0);$('navUnread').hidden=!n;$('navUnread').textContent=n>99?'99+':String(n);if(unlockToken&&state.now&&!termsPending&&!suspendedAccount&&!accessDue)syncBadge(n);}
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
  renderOfficial(infoOpen);
  $('chatPage').classList.toggle('thread-open', Boolean((current || infoOpen) && mobileOpen));
  const total = (state.contacts || []).filter(contact=>contact.deleteAt>now).length + rooms.filter(room=>!room.contact).length;
  $('chatCount').textContent = total ? String(total): '';
  const savedContacts = (state.contacts || []).filter(contact => contact.deleteAt > now);
  const key = JSON.stringify([Boolean(state.now),privacyMode, savedContacts.map(c=>[c.id,c.nickname,c.warning,c.trusted,c.favorite,c.muted]), rooms.map(r => [r.id, r.contact?.nickname, r.contact?.warning, r.contact?.trusted, r.contact?.favorite, r.contact?.muted, r.encryption?.peer?.identity, r.contact?.peerIdentity, r.memberCount, r.activeCount, r.messages.at(-1)?.id, r.messages.at(-1)?.text, r.messages.at(-1)?.opened, r.messages.at(-1)?.deleted, r.deletionRequested, unreadCount(r), r.id === selected])]);
  if (key !== contactKey) {
    contactKey = key;
    const list = $('contacts'), top = list.scrollTop;
    list.replaceChildren();
    if (!state.now){const skeleton=el('div','chat-skeleton');skeleton.setAttribute('aria-hidden','true');for(let i=0;i<5;i++){const line=el('div','skeleton-contact');line.append(el('i'),el('span'),el('b'));skeleton.append(line);}list.append(skeleton);}
    else if (!rooms.length && !savedContacts.length) {
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
      const count=unreadCount(r);if(count){const badge=el('span','unread-badge',count>99?'99+':String(count));badge.setAttribute('aria-label',count+' unread messages');b.append(badge);}
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
  if(!current||readOnly||current.support||!unlockToken)closeInlineAttachments();
  renderEncryptionNotice(current);
  $('adminComposer').hidden = !readOnly;
  $('deleteChat').hidden = readOnly;
  $('deleteChat').title = current?.mobileSupport && !current?.supportAgent ? 'Request deletion' : 'Delete chat';
  $('deleteChat').setAttribute('aria-label',$('deleteChat').title);
  $('attachmentMenu').hidden = Boolean(current?.support || ((current?.encryption || (native && directRoom(current))) && !encryptionReady(current)));
  const encryptionStatus = $('encryptionStatus');
  const showDirectSecurity = encryptionRequired(current) && directRoom(current);
  encryptionStatus.hidden = !showDirectSecurity;
  encryptionStatus.textContent = !showDirectSecurity ? '' : encryptionReady(current) ? '🔒 Encrypted' : current.encryptionStatus === 'lost' || current.encryptionStatus === 'error' ? 'Key unavailable' : 'Connecting securely';
  $('threadBadge').hidden = !isAdmin || Boolean(current?.supportAgent);
  $('threadAvatar').setAttribute('href', current?.support && !current?.supportAgent ? '#supportAvatar' : readOnly ? '#adminAvatar' : current?.group ? '#groupAvatar' : '#avatar');
  $('groupInvite').hidden = !current?.canInvite;
  $('chatOptions').hidden = true;
  $('profileAvatar').disabled=!current||readOnly;$('profileName').disabled=!current||readOnly;updateNavigation();
  $('presenceLabel').hidden = !current || isAdmin;
  $('presenceLabel').textContent = current?.group ? (current.activeCount || 0) + ' active' : current?.activeCount ? 'Active' : 'Offline';
  $('presenceLabel').classList.toggle('online', Boolean(current?.activeCount));
  $('memberCount').hidden = !current?.group;
  $('memberCount').textContent = current?.group ? current.memberCount + ' members' : '';
  $('expiryProgress').hidden = !current || current.persistent;
  const supportNotice = current?.supportStatus==='pending' ? 'Waiting for Support to accept' : current?.supportStatus==='rejected' ? 'Send a message to contact Support again' : '';
  $('extensionNotice').hidden = !current?.extension && !current?.deletionRequested && !supportNotice;
  $('extensionNotice').textContent = current?.deletionRequested ? 'Deletion requested · Awaiting support action' : supportNotice || (current?.extension?.incoming ? 'Chat extension requested · Review' : 'Waiting for extension approval');
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

  const previousTop=container.scrollTop, remembered=scrollMemory.get(current.id);
  const follow = (!sameRoom&&(!remembered||remembered.bottom)) || (sameRoom&&container.scrollHeight - container.scrollTop - container.clientHeight < 100 ||
    (ids.length > renderedMessages.length && current.messages.at(-1)?.mine));

  if (!sameRoom) container.replaceChildren();
  const oldRows=new Map([...container.children].map(node=>[node.id,node]));
  const keep=new Set();
  current.messages.forEach((message,index)=>{
    const id='message-'+message.id, old=oldRows.get(id);let row=old;
    if(!old||!sameRoom||renderedMessages[index]!==ids[index]){
      row=renderMessage(current,message);
      if(old){const before=old.querySelector('.message-reactions')?.textContent;if(before!==row.querySelector('.message-reactions')?.textContent)motion(row.querySelector('.message-reactions'),'motion-reaction');old.replaceWith(row);}
      else if(sameRoom){motion(row,'motion-message');if(message.mine)requestAnimationFrame(()=>animateFromComposer(row));}
    }
    keep.add(row);if(container.children[index]!==row)container.insertBefore(row,container.children[index]||null);
  });
  for(const [key,item] of outbox){if(item.room!==current.id)continue;
    let row=oldRows.get('pending-'+key);const context=roomKeys.get(current.id)?.context;
    const safe=Boolean(!privacyMode&&encryptionReady(current)&&context?.code===item.binding);
    if(!row||row.dataset.previewAllowed!==String(safe)){
      const epoch=authEpoch;row=el('div','message-row mine pending-row');row.id='pending-'+key;row.dataset.previewAllowed=String(safe);
      const bubble=el('div','bubble'),content=el('div','message-text',safe?'Encrypted message…':'Message hidden'),footer=el('div','message-footer');
      footer.append(el('span','bubble-time',fmtTime(item.at)),el('span','pending-status'));bubble.append(content,footer);row.append(bubble);
      if(safe)QzuCrypto.decrypt(context,item.payload.cipher,true).then(text=>{if(row.isConnected&&epoch===authEpoch&&unlockToken&&selected===current.id&&!privacyMode&&outbox.get(key)===item&&roomKeys.get(current.id)?.context===context)content.textContent=text;}).catch(()=>{});
      if(sameRoom&&!oldRows.has(row.id)){motion(row,'motion-message');requestAnimationFrame(()=>animateFromComposer(row));}
    }
    row.querySelector('.pending-status').textContent=item.failed?'! Failed':item.accepted?'✓ Sent':'◷ Waiting';keep.add(row);if(row.parentNode!==container)container.append(row);
  }
  for(const node of [...container.children])if(!keep.has(node))node.remove();

  for (const message of current.messages) {
    if (!message.mine) continue;
    const row = document.getElementById('message-' + message.id);
    const status = row?.querySelector('.message-status');
    if (status && status.dataset.status !== message.status) updateStatus(status, message.status);
  }

  renderedRoom = current.id;
  renderedMessages = ids;
  if (follow) container.scrollTop = container.scrollHeight;else container.scrollTop=sameRoom?previousTop:remembered?.top||0;
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
  const changed=Boolean(node.dataset.status&&node.dataset.status!==status);
  node.dataset.status = status;
  node.title = status === 'read' ? 'Read' : status === 'delivered' ? 'Delivered' : 'Sent';
  node.setAttribute('aria-label', node.title);
  node.replaceChildren(svg(status === 'sent' ? 'check' : 'doubleCheck'));if(changed)motion(node,'motion-tick');
}

function attachMessageGesture(bubble,reply,actions){
  let gesture=null,timer=null,suppress=false;
  const indicator=svg('reply','swipe-reply-indicator');bubble.classList.add('swipe-reply');bubble.append(indicator);
  function clear(){clearTimeout(timer);timer=null;gesture=null;bubble.classList.remove('swipe-tracking','swipe-ready');bubble.style.removeProperty('--reply-shift');}
  function owns(e){return gesture!==null&&e.pointerId===gesture.id;}
  function horizontal(dx,dy){return Math.abs(dx)>=Math.abs(dy)*1.4;}
  bubble.addEventListener('pointerdown',e=>{
    if(!e.isPrimary||e.button!==0)return;
    clear();suppress=false;
    if(e.target.closest('button,a,input,textarea,audio,video')||bubble.classList.contains('masked-message'))return;
    const active={id:e.pointerId,x:e.clientX,y:e.clientY,swipe:false};
    gesture=active;
    timer=setTimeout(()=>{if(gesture!==active||!bubble.isConnected)return;suppress=true;clear();haptic();actions();},430);
  });
  bubble.addEventListener('pointermove',e=>{
    if(!owns(e))return;
    const dx=e.clientX-gesture.x,dy=e.clientY-gesture.y;
    if(Math.abs(dx)>9||Math.abs(dy)>9){clearTimeout(timer);timer=null;}
    if(!gesture.swipe&&Math.abs(dy)>12&&Math.abs(dy)>=Math.abs(dx)){clear();return;}
    if(!reply||(!gesture.swipe&&(Math.abs(dx)<12||!horizontal(dx,dy))))return;
    if(!gesture.swipe){gesture.swipe=true;bubble.classList.add('swipe-tracking');try{bubble.setPointerCapture(e.pointerId);}catch{}}
    const shift=horizontal(dx,dy)?Math.sign(dx)*Math.min(72,Math.abs(dx)):0;
    bubble.style.setProperty('--reply-shift',shift+'px');bubble.classList.toggle('swipe-ready',Math.abs(shift)>=48);
  });
  bubble.addEventListener('pointerup',e=>{
    if(!owns(e))return;
    const dx=e.clientX-gesture.x,dy=e.clientY-gesture.y,swipe=gesture.swipe;
    const accepted=swipe&&Math.abs(dx)>=48&&horizontal(dx,dy);
    clear();if(swipe)suppress=true;
    if(accepted){haptic();reply();}
  });
  bubble.addEventListener('pointercancel',e=>{if(owns(e)){if(gesture.swipe)suppress=true;clear();}});
  // Touch starts with implicit capture on the child. Transferring capture to
  // the bubble emits a bubbling lostpointercapture from that child, not a cancellation.
  bubble.addEventListener('lostpointercapture',e=>{if(owns(e)&&e.target===bubble&&!bubble.hasPointerCapture(e.pointerId)){if(gesture.swipe)suppress=true;clear();}});
  bubble.addEventListener('pointerleave',e=>{if(owns(e)&&e.target===bubble&&!gesture.swipe)clear();});
  bubble.addEventListener('click',e=>{if(suppress&&e.detail!==0){suppress=false;e.preventDefault();e.stopPropagation();}},true);
  bubble.addEventListener('contextmenu',e=>{e.preventDefault();if(suppress)return;clear();actions();});
  bubble.tabIndex=0;bubble.addEventListener('keydown',e=>{if(e.target===bubble&&(e.key==='Enter'||e.key===' ')){e.preventDefault();actions();}});
}

function beginReply(room,message){
  if(!unlockToken||page!=='chat'||selected!==room.id||document.hidden)return;
  const current=state.rooms.find(r=>r.id===room.id&&r.expires>serverNow()&&!r.readOnly),target=current?.messages.find(m=>m.id===message.id&&!m.deleted&&!m.once&&!m.burnSeconds);
  if(!target||room.encryption&&!target.decrypted&&target.kind==='text')return;
  replyTarget={roomId:room.id,id:target.id,sender:target.sender,text:previewText(target)};renderReply();$('message').focus({preventScroll:true});
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
    const label = onceLabel(message);
    const open = button(label, () => openOnceMessage(room, message), 'once-message'+(message.opened?' once-opened':''));
    open.prepend(svg(message.opened?'viewOnceOpened':'viewOnceIcon'));
    open.disabled = message.mine || message.opened || (room.encryption&&(!state.capabilities?.encryptedOnce||!encryptionReady(room)));
    open.setAttribute('aria-label',message.opened?'Opened view-once content':message.mine?'Sent view-once '+label:'Open '+label.toLowerCase()+' once');
    content.append(open);
  } else if (message.kind === 'image' || message.kind === 'audio') {
    const open = button('', () => openMedia(room, message), 'media-message media-tile');open.setAttribute('aria-label',message.kind==='image'?'View photo':'Play voice message');open.append(svg(message.kind==='image'?'camera':'mic'),el('span','',message.kind==='image'?'Photo':'Voice message'));
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

  if (!room.readOnly && !message.deleted) {
    const canReply=!message.once&&!message.burnSeconds&&(!room.encryption||(state.capabilities?.encryptedExtras&&encryptionReady(room)));
    attachMessageGesture(bubble,canReply?()=>beginReply(room,message):null,()=>messageActions(room,message));
    if(message.reactions?.length){const bar=el('div','message-reactions');for(const reaction of message.reactions)bar.append(button(reaction.emoji+' '+reaction.count,()=>reactTo(room,message,reaction.emoji),'reaction-chip'+(reaction.mine?' chosen':'')));bubble.append(bar);}
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
  if (!online || !unlockToken || state.invisible || page !== 'chat' || !room || room.readOnly || !$('message').value.trim()) {
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
  if (receiptsInFlight || !online || !unlockToken || document.hidden) return;
  const epoch = authEpoch;
  const entries = [];
  for (const room of state.rooms) {
    const delivered = [];
    const read = [],seen=[];
    for (const message of room.messages) {
      if (message.mine || message.deleted) continue;
      if(room.encryption&&!message.once&&!message.decrypted&&message.kind==='text')continue;
      if (!acknowledgedDelivery.has(message.id)) delivered.push(message.id);
      const node = document.getElementById('message-' + message.id);
      const view = $('messages').getBoundingClientRect();
      const rect = node?.getBoundingClientRect();
      const visible = rect && rect.bottom > view.top && rect.top < view.bottom;
      if(message.unread===true&&room.id===selected&&canReadCurrent()&&visible&&(!privacyMode||revealedMessages.has(message.id)))seen.push(message.id);
      if (!state.invisible && room.id === selected && canReadCurrent() && visible && (!privacyMode || revealedMessages.has(message.id)) && !message.once && (!message.burnSeconds || message.burnAt) && !acknowledgedRead.has(message.id)) read.push(message.id);
    }
    if (delivered.length || read.length || seen.length) entries.push({ id: room.id, delivered, read, seen });
  }

  if (!entries.length) return;
  const batch = [];
  let size = 0;
  for (const entry of entries) {
    const ids = [...new Set([...entry.delivered, ...entry.read, ...entry.seen])];
    const deliveredSet = new Set(entry.delivered);
    const readSet = new Set(entry.read),seenSet=new Set(entry.seen);
    for (let index = 0; index < ids.length; index += 40) {
      const part = ids.slice(index, index + Math.min(40,75-size));
      if (!part.length || batch.length >= 51) break;
      batch.push({ id: entry.id, delivered: part.filter(id => deliveredSet.has(id)), read: part.filter(id => readSet.has(id)),seen:part.filter(id=>seenSet.has(id)) });
      size += part.length;
    }
    if (size >= 75 || batch.length >= 51) break;
  }

  receiptsInFlight = true;
  try {
    await api('receipts', { entries: batch }, true);
    if (epoch !== authEpoch) return;
    for (const entry of batch) {
      entry.delivered.forEach(id => acknowledgedDelivery.add(id));
      entry.read.forEach(id => acknowledgedRead.add(id));
      const room=state.rooms.find(r=>r.id===entry.id);for(const message of room?.messages||[])if(entry.seen.includes(message.id))message.unread=false;
    }
    updateNavigation();if(page==='chat')renderChat();
  } catch {} finally {
    if (epoch === authEpoch) receiptsInFlight = false;
  }

}

let inviteMotionKey='',inviteMotionDuration=1;
function updateInviteMotion(inv,now=serverNow()){const key=inv?.code+':'+inv?.expires;if(key!==inviteMotionKey){inviteMotionKey=key;inviteMotionDuration=Math.max(1,(inv?.expires||now)-now);}const remaining=inv?Math.max(0,inv.expires-now):0;$('inviteProgress').max=inviteMotionDuration;$('inviteProgress').value=remaining;$('inviteTimer').textContent=inv?clock(remaining):'Generating code…';}
function fitConnectPage(){
  const content=$('connectPage').querySelector('.page-content'),panel=content.querySelector('.connect-panel');
  if(!content.clientHeight)return;
  const style=getComputedStyle(content),available=content.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
  content.classList.toggle('connect-fits',panel.getBoundingClientRect().height<=available+1);
}
if(typeof ResizeObserver==='function'){
  const connectObserver=new ResizeObserver(fitConnectPage);
  connectObserver.observe($('connectPage').querySelector('.page-content'));
  connectObserver.observe($('connectPage').querySelector('.connect-panel'));
}
function renderConnect() {
  if (page !== 'connect' || !unlockToken) return;
  fitConnectPage();
  const inv = state.invite && state.invite.expires > serverNow() ? state.invite: null;
  $('inviteCode').textContent = inv?.code || '– – – – – –';
  updateInviteMotion(inv);
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
      $('qrPlaceholder').setAttribute('hidden', '');motion($('qrBox'),'motion-qr');
    }).catch(() => {}).finally(() => {
      if (qrPending === key) qrPending = '';
    });
  }
}

function renderSettings() {
  if (page !== 'settings') return;
  const requested = location.pathname.split('/')[2] || 'main';
  const category = ['support-requests','admin-feedback'].includes(requested) && !state.supportAgent ? 'main' : requested;
  for (const panel of document.querySelectorAll('[data-settings-category]')) {const hidden=panel.dataset.settingsCategory!==category;const entering=panel.hidden&&!hidden;panel.hidden=hidden;if(entering)motion(panel,'motion-settings');}
  $('settingsBack').href = category === 'main' ? '/chat' : '/settings';
  $('resetPin').disabled = !state.pinState || Boolean(state.resetDelivered) || ['new', 'approved'].includes(state.pinState);
  $('resetLabel').textContent = state.resetDelivered ? 'Reset pending': 'Request Reset';
  $('emergency').disabled = !state.pinState;
  $('changeLogin').disabled = !unlockToken;
  $('backgroundPin').checked=backgroundPin;$('backgroundPin').disabled=!native||!unlockToken||backgroundPinSaving;
  $('privateNotifications').checked=!pushOptedOut();
  $('privateNotifications').disabled=!unlockToken||Boolean(pushRemovalJob||pushRegisterJob);
  $('pushStatus').textContent=pushOptedOut()?'Message notifications are off.':state.push?.registered?'Message notifications are enabled.':native&&window.Capacitor.getPlatform()==='ios'?'In-app alerts enabled. Remote delivery depends on Apple push configuration.':'Allow notifications in your device settings if prompted.';
  $('writeSupport').disabled = !unlockToken;
  $('supportRequestsLink').hidden = !state.supportAgent;
  $('recoverySettings').hidden=Boolean(state.supportAgent)||!native;
  $('adminInterface').hidden=!state.supportAgent;$('adminLogout').hidden=!state.supportAgent;
  $('userInterfaceHeading').hidden=!state.supportAgent;
  $('adminInboxCount').textContent=state.supportAgent?String((state.supportRequests||[]).length):'';
  $('adminFeedbackCount').textContent=state.supportAgent?String(state.feedbackCount||0):'';
  if(category==='admin-feedback'&&state.supportAgent){if(feedbackLoadedCount!==state.feedbackCount&&!feedbackLoading)loadAdminFeedback();}
  else if(feedbackLoadedCount!==null||feedbackLoading){clearAdminFeedback();}
  $('supportRequestCount').textContent = state.supportAgent ? String((state.supportRequests || []).length) : '';
  if(category==='support-requests')renderSupportRequests();
  else $('supportRequestsList').replaceChildren();
  if (!invisibleSaving) $('invisibleMode').checked = Boolean(state.invisible);
  $('invisibleMode').disabled = invisibleSaving || !unlockToken;
}

function render() {
  updateConnection();updateNavigation();renderChat();
  renderConnect();
  renderSettings();
}

function purgeExpired() {
  if (!unlockToken) return;
  const now = serverNow();
  if (mediaRoom && !state.rooms.some(room => room.id === mediaRoom && room.expires > now)) closeModal();
  if (state.rooms.some(r => r.expires <= now) || state.invite && state.invite.expires <= now) {
    const remaining=state.rooms.filter(r=>r.expires>now);
    scrubRemovedRooms(state.rooms,remaining);
    state.rooms=remaining;
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
  if (page === 'connect' && state.invite) updateInviteMotion(state.invite,now);
}

function scrubRemovedRooms(previous,next,clearKeys=true){
  const retained=new Map(next.map(room=>[room.id,room]));
  for(const room of previous){
    const current=retained.get(room.id);
    if(!current&&clearKeys){discardRoomQueue(room.id);drafts.delete(room.id);scrollMemory.delete(room.id);roomKeys.delete(room.id);roomKeyJobs.delete(room.id);if(native)roomVault('remove',room.id).catch(()=>{});if(mediaRoom===room.id)closeModal();}
    const messages=new Map((current?.messages||[]).map(message=>[message.id,message]));
    for(const message of room.messages){
      if(!messages.has(message.id)||messages.get(message.id).deleted){message.text='';message.cipher=null;message.reply=null;message.replyCipher=null;message.encryptedReactions=[];message.reactions=[];message.decrypted=false;revealedMessages.delete(message.id);acknowledgedDelivery.delete(message.id);acknowledgedRead.delete(message.id);}
    }
    if(!current)room.messages.length=0;
  }
}
function clearVolatile() {
  drafts.clear();scrollMemory.clear();outbox.clear();nextOutboxAttempt=0;updateConnection();
  scrubRemovedRooms(state.rooms,[]);
  liveRevision='';
  roomKeys.clear();roomKeyJobs.clear();if(native)clearPrivateKeys().catch(()=>{});
  stopTyping();
  clearReply();
  revealedMessages.clear();
  acknowledgedDelivery.clear();
  acknowledgedRead.clear();
  sequence++;
  state.rooms = [];
  state.supportRequests = [];
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
  return Boolean(local?.until > Date.now() && room.encryption && room.encryption.confirmed && (room.encryption.offline||room.encryption.peerConfirmed) && local?.context && local.verified === local.context.code && room.encryptionStatus === 'ready');
}
async function roomVault(action,room,extra={}){return devicePlugin.roomVault({action,room,...extra});}
let prekeyJob=null,nextPrekeyAttempt=0;
async function clearPrivateKeys(){await Promise.allSettled([roomVault('clear',''),roomVault('clear','',{vault:'prekeys'})]);}
function replenishPrekeys(data){
  if(!native||!data.capabilities?.offlinePrekeys||!unlockToken||prekeyJob||data.prekeyCount>=8||Date.now()<nextPrekeyAttempt||document.hidden)return;
  nextPrekeyAttempt=Date.now()+15000;
  const epoch=authEpoch;
  prekeyJob=(async()=>{
    await roomVault('sweep','',{vault:'prekeys'});
    const items=[];
    for(let n=0;n<12-Math.max(0,Number(data.prekeyCount)||0);n++){
      if(epoch!==authEpoch||!unlockToken||document.hidden)return;
      const id=crypto.randomUUID(),until=Date.now()+7*86400000+600000;
      const local=await QzuCrypto.generate(id,message=>devicePlugin.sign({message}),value=>{
        if(epoch!==authEpoch||!unlockToken||document.hidden)throw Error('Locked.');
        return roomVault('save',id,{vault:'prekeys',value:JSON.stringify({...value,until})});
      });
      items.push({id,record:local.record});
    }
    if(items.length&&epoch===authEpoch&&unlockToken&&!document.hidden){
      await api('encryption/prekeys',{items},true);
      liveRevision='';
    }
  })().catch(()=>{}).finally(()=>{prekeyJob=null;});
}
async function localRoomKey(room,until){
  const epoch=authEpoch;
  const saved=await roomVault('load',room.id);
  if(epoch!==authEpoch||!unlockToken)throw Error('Locked.');
  let value,local;
  if(saved?.value){value=JSON.parse(saved.value);local=await QzuCrypto.restore(value);if(Math.abs(value.until-until)>5000)await roomVault('save',room.id,{value:JSON.stringify({...value,until})});}
  else if(room.encryption.own?.prekey){
    const id=room.encryption.own.prekey;
    const reserved=await roomVault('load',id,{vault:'prekeys'});
    if(!reserved?.value)return null;
    value=JSON.parse(reserved.value);local=await QzuCrypto.restore(value);
    const expected=room.encryption.own;
    if(local.record.key!==expected.key||local.record.identity!==expected.identity||local.record.signature!==expected.signature)throw Error('Reserved key mismatch.');
    if(epoch!==authEpoch||!unlockToken)throw Error('Locked.');
    await roomVault('save',room.id,{value:JSON.stringify({...value,until})});
    await roomVault('remove',id,{vault:'prekeys'});
  }
  else if(room.encryption.own)return null;
  else local=await QzuCrypto.generate(room.id,message=>devicePlugin.sign({message}),data=>{if(epoch!==authEpoch||!unlockToken)throw Error('Locked.');return roomVault('save',room.id,{value:JSON.stringify({...data,until})});});
  if(epoch!==authEpoch||!unlockToken)throw Error('Locked.');
  local.until=until;roomKeys.set(room.id,local);return local;
}
function dropExpiredKeys(rooms = null) {
  const now = Date.now();
  for (const [id, local] of roomKeys) if (local.until <= now || (rooms && !rooms.some(room => room.id === id))) {roomKeys.delete(id);roomKeyJobs.delete(id);if(native)roomVault('remove',id).catch(()=>{});}
}
setInterval(dropExpiredKeys, 1000);
let keyPruneSignature='',nextCryptoRetry=0;
async function prepareEncryptedRooms(data,ticket) {
  const epoch=authEpoch;dropExpiredKeys();
  const current=()=>ticket===sequence&&epoch===authEpoch&&Boolean(unlockToken)&&!document.hidden;
  for (const room of data.rooms) {
    if(!current())return;
    if (!directRoom(room) || (!native && !room.encryption)) continue;
    room.encryptionStatus = 'waiting';
    let local=roomKeys.get(room.id);const encryption=room.encryption,until=Date.now()+Math.max(0,room.expires-data.now);
    if(native&&encryption&&data.capabilities?.encryptedDirect&&until>Date.now()&&!identityChanged(room)){
      try{
        if(!local||Math.abs(local.until-until)>5000){if(!roomKeyJobs.has(room.id))roomKeyJobs.set(room.id,localRoomKey(room,until));const job=roomKeyJobs.get(room.id);try{local=await job;}finally{if(roomKeyJobs.get(room.id)===job)roomKeyJobs.delete(room.id);}}
        if(!current())return;
        if(local&&!encryption.own){await api('encryption/key',{id:room.id,record:local.record},true);encryption.own=local.record;}
      }catch(error){room.encryptionStatus='error';}
    }
    if(!current())return;
    if(local)local.until=until;
    if (!data.capabilities?.encryptedDirect || data.capabilities.encryptedProtocol !== 2 || !encryption || !globalThis.crypto?.subtle) room.encryptionStatus = 'unavailable';
    else if (encryption.own && !local && room.encryptionStatus!=='error') room.encryptionStatus = 'lost';
    else if (local && encryption.own && encryption.peer) {
      try {
        const binding = JSON.stringify([encryption.own, encryption.peer]);
        if (local.binding !== binding || !local.context) {
          if (local.binding && local.binding !== binding) throw Error('Encryption key changed.');
          local.context = await QzuCrypto.establish(room.id, local, encryption.own, encryption.peer);
          local.binding = binding;
        }
        if(!current())return;
        if(identityChanged(room))throw Error('Contact identity changed.');
        if(!encryption.confirmed){await api('encryption/confirm',{id:room.id,code:local.context.code,automatic:true},true);encryption.confirmed=true;}
        local.verified=local.context.code;room.encryptionStatus=encryption.confirmed&&(encryption.offline||encryption.peerConfirmed)?'ready':'waiting';
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
      if (message.once || message.deleted || !encryptionReady(room)) continue;
      if (message.encryptedMedia) { message.text = 'Encrypted attachment'; continue; }
      if (!message.cipher) continue;
      const nonce = String(message.mine) + ':' + message.cipher.iv;
      if (seen.has(nonce)) { message.text = 'Duplicate encrypted message'; continue; }
      seen.add(nonce);
      try { message.text = await QzuCrypto.decrypt(local.context, message.cipher, message.mine); message.decrypted = true; }
      catch { message.text = 'Encrypted message could not be authenticated'; }
    }
    if(encryptionReady(room))for(const message of room.messages){
      if(message.deleted)continue;
      if(message.replyCipher&&message.cipher&&message.decrypted){try{const id=await QzuCrypto.decryptReply(local.context,message.cipher.iv,message.replyCipher,message.mine);const target=room.messages.find(m=>m.id===id);if(target)message.reply={id,sender:target.sender,text:target.deleted?'This message was deleted.':previewText(target).slice(0,160)};}catch{}}
      const totals=new Map();for(const reaction of message.encryptedReactions||[]){try{const emoji=await QzuCrypto.decryptReaction(local.context,message.id,reaction.cipher,reaction.mine);if(emoji==='-')continue;const value=totals.get(emoji)||{emoji,count:0,mine:false};value.count++;value.mine||=reaction.mine;totals.set(emoji,value);}catch{}}message.reactions=[...totals.values()];
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
    if(room.contact&&!identityChanged(room)){show('Encryption unavailable',[el('p','','The old key cannot be recovered. Starting a new encrypted conversation deletes the current chat for both participants.'),button('Start new encrypted chat',async()=>{try{await api('chat/delete',{id:room.id});const next=await api('contacts/open',{id:room.contact.id});closeModal();await refresh();selectRoom(next.id);}catch(error){modalError(error);}},'primary-button'),button('Cancel',closeModal,'secondary-button')]);return;}
    info('Encryption unavailable','The temporary key is missing or changed. No plaintext will be sent.');
    return;
  }
  const local = roomKeys.get(room.id);
  if(!local?.context||!room.encryption.peer){info('Connecting securely','No code comparison is needed. A contact who has not registered encryption keys must unlock the updated app before the first encrypted message can be sent.');return;}
  const code = local.context.code;
  const content = [
    el('p', '', 'Compare the entire safety code in person or through a separate trusted channel. Do not confirm unless every character matches.'),
    el('div', 'fingerprint-code', code.match(/.{1,4}/g).join(' ')),
    el('p','','Comparing the safety code is optional. Automatic encryption authenticates registered device keys, not the person.'),
  ];
  if (!room.contact?.identityVerified) content.push(button('Codes match — verify', async () => {
    try {
      if (roomKeys.get(room.id) !== local || local.context?.code !== code || !unlockToken) throw Error('Encryption key changed.');
      await api('encryption/confirm', { id: room.id, code, automatic:false });
      local.verified = code;
      closeModal();
      await refresh();
    } catch (error) { modalError(error); }
  }));
  else content.push(el('p', '', room.encryption.peerConfirmed ? 'Both devices have confirmed.' : 'Waiting for your contact to confirm.'));
  content.push(button('Close', closeModal, 'secondary-button'));
  show('Encryption information', content);
}
$('encryptionStatus').addEventListener('click', () => {
  const room = state.rooms.find(item => item.id === selected);
  if (encryptionRequired(room) && directRoom(room)) showEncryption(room);
});

async function refresh(live=false) {
  if(live&&manualRefreshes)return;
  if(!live)manualRefreshes++;
  try{
  const ticket = ++sequence;
  const data = await api(live&&liveRevision?'state/live?since='+liveRevision:'state');
  if (ticket !== sequence || document.hidden || !unlockToken) return;
  online = true;reconnectDelay=500;updateConnection();
  offset = data.now - Date.now();
  if(!data.unchanged&&data.termsAccepted!==true){termsPending=true;updatePages();showTermsGate(data.termsVersion||1);return;}
  if(data.unchanged){liveRevision=data.revision;void flushOutbox();if(state.rooms.some(r=>directRoom(r)&&r.encryption&&r.encryptionStatus==='error')&&Date.now()>=nextCryptoRetry){liveRevision='';nextCryptoRetry=Date.now()+5000;}purgeExpired();maybePromptUpdate();void acknowledgeMessages();restorePushRegistration();replenishPrekeys(state);return;}
  await prepareEncryptedRooms(data,ticket);
  if (ticket !== sequence || document.hidden || !unlockToken) return;
  scrubRemovedRooms(state.rooms,data.rooms);
  const previouslyKnown=new Set(state.rooms.flatMap(r=>r.messages.map(m=>m.id)));const newActivity=Boolean(state.now)&&data.rooms.some(r=>!r.contact?.muted&&(r.id!==selected||!canReadCurrent())&&r.messages.some(m=>m.unread&&!previouslyKnown.has(m.id)));state = data;reconcileOutbox();
  if(newActivity&&!document.hidden)showActivityBanner();
  liveRevision=data.revision||'';
  const keep=state.rooms.filter(directRoom).map(r=>r.id).sort();const sig=JSON.stringify(keep);if(native&&sig!==keyPruneSignature){keyPruneSignature=sig;roomVault('prune','',{rooms:keep}).catch(()=>{if(keyPruneSignature===sig)keyPruneSignature='';});}
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
  restorePushRegistration();replenishPrekeys(state);void flushOutbox();
  }finally{if(!live)manualRefreshes--;}
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
async function openLegal(path){
  const url=new URL(path,apiOrigin).href;
  try{if(native)await devicePlugin.openUpdate({url});else window.open(url,'_blank','noopener,noreferrer');}catch(error){dialogError(error);}
}
function legalButtons(){return [button('Terms of Service',()=>openLegal('/terms'),'secondary-button'),button('Privacy policy',()=>openLegal('/privacy'),'secondary-button')];}
function showTermsGate(version){
  const check=el('input');check.type='checkbox';const label=el('label','feedback-confirm');label.append(check,el('span','','I am 18 or older and agree to the Terms of Service.'));
  const accept=button('Accept and continue',async()=>{accept.disabled=true;try{await api('terms/accept',{version});termsPending=false;modalLocked=false;closeModal();if(accessDue||(!playBuild&&savedInvoice(true))){showRenewal();return;}navigate(location.pathname,false);await refresh();}catch(error){dialogError(error);accept.disabled=!check.checked;}});
  accept.disabled=true;check.addEventListener('change',()=>{accept.disabled=!check.checked;});
  show('Terms of Service',[el('p','','Harassment, abuse, exploitation, threats and unlawful content are prohibited. Reports are reviewed and violations may result in suspension.'),...legalButtons(),label,accept,button('Decline and lock',()=>lock(),'secondary-button'),button('Delete account',showDeleteAccount,'secondary-button')],true);
}
function showRestrictedAccount(title,message){show(title,[el('p','',message),button('Delete account',showDeleteAccount,'secondary-button'),button('External deletion code',showDeletionCode,'secondary-button'),button('Lock',()=>lock(),'secondary-button'),...legalButtons()],true);}
$('adminLogout').addEventListener('click',()=>{
  if(!state.supportAgent||!unlockToken)return;
  const confirm=button('Log out',async()=>{
    confirm.disabled=true;
    try{
      await api('admin/logout',{confirmed:true});
      if(native)await clearPrivateKeys().catch(()=>{});
      sessionReady=false;needsSetup=false;clearCheckoutHistory();checkoutReturn=null;
      lock(false);history.replaceState(null,'','/chat');navigate('/chat',false);await getSession();
    }catch(error){dialogError(error);confirm.disabled=false;}
  });
  show('Admin logout?',[el('p','','This ends your admin session and releases its access key.'),confirm,button('Cancel',closeModal,'secondary-button')]);
});
function showDeleteAccount(){
  const confirm=button('Permanently delete account',async()=>{
    confirm.disabled=true;
    try{
      await api('account/delete',{confirmed:true});
      roomKeys.clear();roomKeyJobs.clear();if(native)await clearPrivateKeys();sessionReady=false;needsSetup=false;clearCheckoutHistory();
      checkoutReturn=null;lock(false);history.replaceState(null,'','/chat');navigate('/chat',false);await getSession();
    }catch(error){dialogError(error);confirm.disabled=false;}
  },'primary-button danger-button');
  show('Delete account?',[el('p','','Your account, active chats, contacts and access will be permanently removed. Limited legal or safety records may remain. This cannot be undone.'),confirm,button('Cancel',()=>{if(suspendedAccount)showRestrictedAccount('Account suspended','Your account access has been restricted.');else if(termsPending)showTermsGate(1);else if(accessDue)showRenewal();else closeModal();},'secondary-button')]);
}
function showDeletionCode(){
  show('External deletion code',[el('p','','Generate a private code to delete your account later from the public website. A new code invalidates any previous code.'),button('Generate code',async()=>{try{const result=await api('account/deletion-code',{});const code=el('p','fingerprint-code',result.code);show('Save your deletion code',[el('p','','Anyone with this code can permanently delete your account. Keep it private.'),code,button('Copy code',async()=>{try{await navigator.clipboard.writeText(result.code);}catch{dialogError(Error('Select and copy the code manually.'));}},'secondary-button'),button('Deletion website',()=>openLegal('/delete-account'),'secondary-button'),button('Done',()=>{if(suspendedAccount)showRestrictedAccount('Account suspended','Your account access has been restricted.');else if(termsPending)showTermsGate(1);else if(accessDue)showRenewal();else closeModal();},'secondary-button')]);}catch(error){dialogError(error);}}),button('Cancel',()=>{if(suspendedAccount)showRestrictedAccount('Account suspended','Your account access has been restricted.');else if(accessDue)showRenewal();else closeModal();},'secondary-button')]);
}
$('logout').addEventListener('click',showDeleteAccount);
$('deleteAccount').addEventListener('click',showDeleteAccount);
$('externalDeletion').addEventListener('click',showDeletionCode);
$('termsPolicy').addEventListener('click',()=>openLegal('/terms'));
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
let feedbackItems=[],feedbackLoadedCount=null,feedbackLoading=false,feedbackEpoch=0;
function clearAdminFeedback(){
  feedbackEpoch++;feedbackItems=[];feedbackLoadedCount=null;feedbackLoading=false;
  $('adminFeedbackList').replaceChildren();$('feedbackOlder').hidden=true;
}
function renderAdminFeedback(){
  const list=$('adminFeedbackList');list.replaceChildren();
  if(!feedbackItems.length)list.append(el('p','support-help-notes','No feedback yet.'));
  for(const entry of feedbackItems){
    const item=el('div','request-item');
    item.append(el('strong','','Feedback #'+entry.id),el('span','',new Date(entry.at).toLocaleString()),el('p','support-request-preview',privacyMode?'Feedback hidden':entry.text));
    const workflow=entry.workflow|| (entry.reviewed?'solved':'inspection');item.append(el('p','case-status '+workflow,workflow==='solved'?'Solved':workflow==='help'?'Need Additional Help':'Under Inspection'));
    const actions=el('div','request-actions');
    const act=async action=>{
      try{await api('admin/feedback/'+action,{id:entry.id});closeModal();await refresh();if(state.supportAgent&&location.pathname==='/settings/admin-feedback')await loadAdminFeedback();}
      catch(error){showError(error);}
    };
    actions.append(button('Review case',()=>{
      const note=el('textarea','edit-input');note.maxLength=1000;note.placeholder='Internal support note';
      const controls=[el('p','',privacyMode?'Feedback hidden':entry.text),note];
      for(const event of entry.events||[])controls.push(el('p','','Admin '+(event.actor||'Deleted')+' · '+event.status+' · '+new Date(event.at).toLocaleString()+' · '+event.note));
      for(const [label,status] of [['Under Inspection','inspection'],['Need Additional Help','help'],['Solved','solved']])controls.push(button(label,async()=>{try{await api('admin/feedback/status',{id:entry.id,status,note:note.value});closeModal();await refresh();await loadAdminFeedback();}catch(e){modalError(e);}},'secondary-button'));
      controls.push(button('Close',closeModal,'secondary-button'));show('Feedback #'+entry.id,controls);
    },'secondary-button'));
    actions.append(button('Delete',()=>show('Delete feedback?',[el('p','','Remove this feedback permanently?'),button('Delete',()=>act('delete'),'primary-button danger-button'),button('Cancel',closeModal,'secondary-button')]),'secondary-button'));
    item.append(actions);list.append(item);
  }
}
async function loadAdminFeedback(older=false){
  if(!state.supportAgent||!unlockToken||feedbackLoading)return;
  feedbackLoading=true;const epoch=feedbackEpoch,auth=authEpoch,count=state.feedbackCount;
  try{
    const before=older?feedbackItems.at(-1)?.id:null;
    const result=await api('admin/feedback'+(before?'?before='+before:''));
    if(epoch!==feedbackEpoch||auth!==authEpoch||!state.supportAgent||location.pathname!=='/settings/admin-feedback')return;
    feedbackItems=older?[...feedbackItems,...result.items]:result.items;
    feedbackLoadedCount=count;renderAdminFeedback();
    $('feedbackOlder').hidden=result.items.length<100;
  }catch(error){if(epoch===feedbackEpoch&&auth===authEpoch){feedbackLoadedCount=count;const list=$('adminFeedbackList');list.replaceChildren(el('p','','Unable to load feedback.'),button('Retry',()=>loadAdminFeedback(),'secondary-button'));}}
  finally{if(epoch===feedbackEpoch)feedbackLoading=false;}
}
$('feedbackOlder').addEventListener('click',()=>loadAdminFeedback(true));
function renderSupportRequests() {
  const list=$('supportRequestsList');
  const requests=state.supportAgent ? state.supportRequests || [] : [];
  const key=JSON.stringify([requests,privacyMode]);
  if(list.dataset.key===key && list.childElementCount)return;
  list.dataset.key=key;
  list.replaceChildren();
  if(!requests.length){list.append(el('p','support-help-notes','No pending requests.'));return;}
  for(const request of requests){
    const item=el('div','request-item');
    const label='Contact '+request.id.slice(0,4).toUpperCase();
    item.append(el('strong','',label),el('span','',fmtTime(request.at)));
    if(request.deletionRequested)item.append(el('p','','Deletion requested'));
    item.append(el('p','support-request-preview',privacyMode?'Message hidden':request.preview||'New support request'));
    const actions=el('div','request-actions');
    const respond=async action=>{
      for(const control of actions.querySelectorAll('button'))control.disabled=true;
      try{
        await api('support/respond',{id:request.id,action});
        state.supportRequests=(state.supportRequests||[]).filter(entry=>entry.id!==request.id);
        renderSettings();
        await refresh();
      }catch(error){showError(error);for(const control of actions.querySelectorAll('button'))control.disabled=false;}
    };
    actions.append(button('Accept',()=>respond('accept')),button('Reject',()=>respond('reject'),'secondary-button'));
    item.append(actions);list.append(item);
  }
}

async function confirmSupport() {
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
  const epoch=authEpoch;
  $('writeSupport').disabled=true;
  $('supportOpen').disabled=true;
  try {
    const result=await api('support/open',{});
    if(epoch!==authEpoch||!unlockToken)return;
    await refresh();
    if(epoch!==authEpoch||!unlockToken)return;
    closeModal();navigate('/chat');selectRoom(result.id);
  }catch(error){if(epoch===authEpoch)showError(error);}
  finally {if(epoch===authEpoch){$('writeSupport').disabled=false;$('supportOpen').disabled=false;}}
}
$('supportOpen').addEventListener('click',confirmSupport);
$('writeSupport').addEventListener('click',confirmSupport);
function renderOfficial(open){
  const feed=state.official||{posts:[],latest:0,seen:0,unread:false};
  $('officialUnread').hidden=!feed.unread;
  $('officialComposer').hidden=!state.supportAgent;
  $('officialReadOnly').hidden=Boolean(state.supportAgent);
  if(!open)return;
  const postsToShow=[...new Map([...officialHistory,...feed.posts].map(post=>[post.id,post])).values()].sort((a,b)=>a.id-b.id);
  $('officialOlder').hidden=!(postsToShow[0]?.id>1);
  const key=JSON.stringify(postsToShow);
  if(key!==officialRenderKey){
    officialRenderKey=key;
    const posts=$('officialPosts');posts.replaceChildren();
    for(const post of postsToShow){
      const article=el('article','official-post');
      const head=el('div','official-post-title');
      head.append(el('strong','','qzu.'),svg('adminBadge','admin-badge'),el('time','official-date',new Date(post.at).toLocaleString()));
      article.append(head,el('p','official-text',post.text));posts.append(article);
    }
  }
  if(feed.unread&&canReadCurrent()&&!officialReadJob){
    const epoch=authEpoch,latest=feed.latest;
    officialReadJob=api('official/read',{id:latest},true).then(()=>{
      if(epoch!==authEpoch||!state.official)return;
      state.official.seen=Math.max(state.official.seen,latest);
      state.official.unread=state.official.latest>state.official.seen;
      $('officialUnread').hidden=!state.official.unread;
    }).catch(()=>{}).finally(()=>{officialReadJob=null;});
  }
}
$('officialOlder').addEventListener('click',async()=>{
  const older=$('officialOlder'),first=Math.min(...[...officialHistory,...(state.official?.posts||[])].map(post=>post.id));
  if(!Number.isFinite(first)||first<=1)return;
  older.disabled=true;const epoch=authEpoch;
  try{const result=await api('official/history?before='+first);if(epoch!==authEpoch||!unlockToken)return;officialHistory=[...result.posts,...officialHistory];renderOfficial(selected===officialChannel);if(!result.posts.length)older.hidden=true;}
  catch(error){if(epoch===authEpoch)showError(error);}finally{older.disabled=false;}
});
$('officialMessage').addEventListener('input',()=>{$('officialSend').disabled=!$('officialMessage').value.trim();});
$('officialComposer').addEventListener('submit',event=>{
  event.preventDefault();
  const text=$('officialMessage').value.trim();
  if(!state.supportAgent||!text||selected!==officialChannel)return;
  const publish=button('Publish to everyone',async()=>{
    publish.disabled=true;
    try{await api('official/publish',{text});$('officialMessage').value='';$('officialSend').disabled=true;closeModal();await refresh();}
    catch(error){publish.disabled=false;modalError(error);}
  });
  show('Publish announcement?',[el('p','','This message will be visible to every qzu. account.'),publish,button('Cancel',closeModal,'secondary-button')]);
});
$('qzuInfoOpen').addEventListener('click', () => {
  if (unlockToken && !accessDue) selectRoom(officialChannel);
});
$('qzuInfoBack').addEventListener('click', () => $('backToChats').click());
$('backToChats').addEventListener('click', () => {
  closeInlineAttachments();
  if(recordingCleanup)clearMedia();
  rememberRoom();
  resetOnce();
  stopTyping();
  clearReply();
  revealedMessages.clear();
  mobileOpen = false;
  selected = null;
  renderedRoom = null;
  $('message').value = '';
  $('send').disabled = true;
  updateConnection();renderChat();motion($('chatPage').querySelector('.sidebar'),'motion-page');
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
    : 'Connecting securely…';
}
$('encryptionNotice').addEventListener('click', () => {
  const room = state.rooms.find(item => item.id === selected);
  if (encryptionRequired(room)) showEncryption(room);
});
function updateSendButton() {
  const room = state.rooms.find(room => room.id === selected);
  const needsSetup = encryptionRequired(room) && !encryptionReady(room);
  const send = $('send');
  const mediaReady=Boolean(room&&!room.admin&&!room.readOnly&&!needsSetup&&unlockToken&&!sendingMessage&&room.expires>serverNow());
  const hasText=Boolean($('message').value.trim());$('cameraShortcut').hidden=!mediaReady||hasText;$('voiceShortcut').hidden=!mediaReady||hasText;send.hidden=mediaReady&&!hasText;
  $('onceShortcut').hidden=!unlockToken||!onceAllowed(room)||(!hasText&&!viewOnce);
  $('onceShortcut').disabled=sendingMessage;
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
  closeInlineAttachments();
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
  const epoch = authEpoch, once=viewOnce;
  sendingMessage = true;
  updateSendButton();

  try {
    if (room.encryption || (native && directRoom(room))) {
      if (!encryptionReady(room)) throw Error('Verify encryption before sending.');
      const cipher = await QzuCrypto.encrypt(roomKeys.get(id).context, text);
      if (epoch !== authEpoch || document.hidden || !unlockToken || selected !== id || room.expires <= serverNow()) throw Error('Chat unavailable.');
      const replyCipher=!once&&state.capabilities?.encryptedExtras&&replyTarget?.roomId===id?await QzuCrypto.encryptReply(roomKeys.get(id).context,cipher.iv,replyTarget.id):null;
      if(epoch!==authEpoch||!unlockToken||document.hidden||selected!==id)throw Error('Chat unavailable.');
      if(once){if(!state.capabilities?.encryptedOnce)throw Error('Update the server before sending view-once content.');if(!online)throw Error('Reconnect to send view-once content. Your draft is kept.');await api('encryption/once/send',{id,cipher});}
      else if(state.capabilities?.queuedSends){
        if(outbox.size>=30)throw Error('Outgoing queue is full. Wait for messages to send.');
        const requestId=crypto.randomUUID(),payload={id,cipher,requestId,...(replyCipher?{replyCipher}:{})};
        outbox.set(requestId,{room:id,payload,binding:roomKeys.get(id).context.code,at:Date.now(),failed:false,sending:false});
        if(selected===id&&$('message').value.trim()===text){$('message').value='';drafts.delete(id);resetOnce();clearReply();stopTyping();}
        haptic();updateConnection();renderChat();$('messages').scrollTop=$('messages').scrollHeight;void flushOutbox();return;
      }
      else {if(!online)throw Error('Reconnect to send this message.');await api('encryption/message', { id, cipher,...(replyCipher?{replyCipher}:{}) });}
    } else {
      if(!online)throw Error('Reconnect to send this message. Your draft is kept.');
      await api('message', { id, text, once, burnSeconds, replyTo: once||burnSeconds ? null : replyTarget?.roomId === id ? replyTarget.id : null });
    }

    if (epoch !== authEpoch) return;

    if (selected === id && $('message').value.trim() === text) {
      $('message').value = '';drafts.delete(id);
      resetOnce();haptic();
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

$('manageOutbox').addEventListener('click',()=>{const entries=[...outbox.entries()].filter(([,item])=>item.room===selected&&!item.accepted);const controls=[el('p','','Encrypted outgoing messages are kept in memory until sent, locked or expired. Cancelling an already accepted message does not delete it from the chat.')];for(const [key,item] of entries){const row=el('div','request-item');row.append(el('span','',item.failed?item.error:'Waiting to send'));if(item.failed)row.append(button('Retry',()=>{item.failed=false;nextOutboxAttempt=0;closeModal();void flushOutbox();},'secondary-button'));const cancel=button('Discard',()=>{if(item.sending||item.accepted)return;outbox.delete(key);closeModal();updateConnection();renderChat();},'secondary-button');cancel.disabled=item.sending||item.accepted;row.append(cancel);controls.push(row);}controls.push(button('Close',closeModal,'secondary-button'));show('Outgoing messages',controls);});
$('message').addEventListener('input', () => {
  rememberRoom();updateSendButton();
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
      if (!result.requested){const remaining=state.rooms.filter(r=>r.id!==id);scrubRemovedRooms(state.rooms,remaining);state.rooms=remaining;selectRoom(null,false);}
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

$('backgroundPin').checked=backgroundPin;
$('backgroundPin').addEventListener('change',async()=>{const input=$('backgroundPin'),next=input.checked,epoch=authEpoch;backgroundPinSaving=true;input.disabled=true;try{const result=await api('login/background-lock',{keepUnlocked:!next});if(!result.ok||epoch!==authEpoch)throw Error('Session unavailable.');backgroundPin=next;try{localStorage.setItem('qzu-background-pin',next?'on':'off');}catch{}}catch(error){if(epoch===authEpoch)showError(error);}finally{backgroundPinSaving=false;input.checked=backgroundPin;input.disabled=!native||!unlockToken;}});
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
  show('New group', [el('p', '', 'Up to 12 members. Expires 24 hours after creation.'), create, button('Cancel', closeModal, 'secondary-button')]);
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
    await api('invite', {minutes:Number($('inviteLifetime').value)});
    haptic();await refresh();
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
    const control=$('copyCode');control.replaceChildren(svg('check'));control.setAttribute('aria-label','Copied');motion(control,'motion-reaction');haptic();
    setTimeout(()=>{control.replaceChildren(svg('copy'));control.setAttribute('aria-label','Copy code');},1000);
  } catch {
    info('Your code', inv.code);
  }
});
$('enterCode').addEventListener('paste',event=>{
  const match=(event.clipboardData?.getData('text')||'').trim().match(/#([A-Z0-9]{6})$/i);
  if(match){event.preventDefault();$('enterCode').value=match[1].toUpperCase();}
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
              haptic();motion($('enterCode'),'motion-tick');$('enterCode').focus();
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
    ['Notifications', 'Private notifications show only generic activity. Enable them in Privacy when the server is configured.'],
    ['Temporary chats', 'Ordinary chats expire after their timer. Support chats are stored until deleted or expired. Private backups exclude support chat content.'],
    ['Anonymous access', 'No phone number, email address or public username is required.'],
    ['Connection codes', 'New codes can last 5, 10 or 15 minutes. Generating a new code invalidates the previous one.'],
    ['Automatic lock', 'Leaving the tab locks qzu. Unlock with your login PIN.'],
    ['emg.exe', 'Your single-use emergency PIN removes your active chats for all participants. A replacement requires developer approval.'],
    ['Groups', 'Up to 12 anonymous members. Groups expire 24 hours after creation. New members can see existing group messages.'],
    ['Privacy mode', 'Hide chat previews and blur messages until you reveal them.'],
    ['View once', 'Direct-chat messages can be opened once by the recipient. Screenshots and saved copies cannot be prevented.'],
    ['Media', 'Photos and voice messages are held temporarily in server memory and expire with the chat.'],
    ['Connections', 'New connections require approval. Blocked accounts cannot reconnect while using the same account.'],
    ['Invisible mode', 'Hides active status, typing and read receipts. Delivery status and opening view-once messages may still be visible.'],
    ['Feedback', 'Only the feedback you explicitly submit is shared with Support.'],
    ['Privacy', 'Screenshots and externally saved copies cannot be removed by qzu.']
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
function backgroundApp(){if(isPublicCheckout())return;if(!native||backgroundPin){if(unlockToken||pinPrompt)lock();return;}if(recordingCleanup||mediaRoom||stream)closeModal();stopCamera();stopTyping();}
function resumeApp(){if(isPublicCheckout()||(unlockToken&&modal.dataset.checkout==='renewal'))resumeCheckout?.();else if(!unlockToken)getSession();else if(!document.hidden)refresh().catch(()=>{});}
if (native) {
  if(window.Capacitor.getPlatform()==='ios')devicePlugin.addListener('screenCaptured',()=>{if(unlockToken)lock();}).catch(()=>{});
  console.info('[qzu] Mobile startup; device plugin available:', window.Capacitor.isPluginAvailable('QzuDevice'), '; server:', apiOrigin);
  window.Capacitor.registerPlugin('App').addListener('appStateChange', ({ isActive }) => {
    if (!isActive) backgroundApp();else resumeApp();
  });
}
window.addEventListener('offline', () => {
  markDisconnected();
});
window.addEventListener('online', () => {
  resumeApp();
});
document.addEventListener('visibilitychange', () => {
  if (isPublicCheckout()) {
    if (!document.hidden) resumeCheckout?.();
    return;
  }
  if (document.hidden) backgroundApp();else resumeApp();
});
window.addEventListener('pagehide',backgroundApp);
window.addEventListener('pageshow', e => {
  if (!e.persisted) return;
  if (isPublicCheckout()) resumeCheckout?.();
  else if (!unlockToken) getSession();
});
setInterval(purgeExpired, 250);

async function loop() {
  if (unlockToken && !accessDue && !termsPending && !suspendedAccount && !document.hidden) {
    const epoch=authEpoch;
    try {
      await refresh(Boolean(state.capabilities?.live));
    } catch(error) {
      if([401,403].includes(error.status)&&epoch===authEpoch&&unlockToken){lock();}
      else if(epoch===authEpoch&&unlockToken&&!accessDue){markDisconnected();reconnectDelay=Math.min(10000,reconnectDelay*2);}
    }
  }
  setTimeout(loop,!online?reconnectDelay:unlockToken&&state.capabilities?.live?500:1500);
}
updatePages();
const boot=$('bootSplash');
const bootMinimum=bootPending?new Promise(resolve=>{document.documentElement.classList.add('booting');boot.classList.add('boot-running');setTimeout(resolve,1150);}):Promise.resolve();
async function finishBoot(){if(!bootPending)return;await bootMinimum;if(!bootPending)return;bootPending=false;boot.classList.add('boot-ready');await new Promise(resolve=>setTimeout(resolve,240));boot.remove();document.documentElement.classList.remove('booting');}
if(!bootPending)boot.remove();getSession();
loop();


function previewText(message) {
  if (message.deleted) return 'This message was deleted.';
  if (message.burnSeconds) return 'Timed message';
  if (message.once) return message.opened ? 'Opened' : 'View-once '+onceLabel(message).toLowerCase();
  if (message.kind === 'image') return 'Photo';
  if (message.kind === 'audio') return 'Voice message';
  return message.text;
}

function onceLabel(message){return message.opened?'Opened':message.kind==='image'?'Photo':message.kind==='audio'?'Voice message':'Message';}
function onceAllowed(room){
  return Boolean(room&&!room.group&&!room.admin&&!room.support&&!room.readOnly&&room.expires>serverNow()&&(!encryptionRequired(room)||(state.capabilities?.encryptedOnce&&encryptionReady(room))));
}
function syncOnceToggle(control,value){
  control.classList.toggle('once-selected',value);
  control.setAttribute('aria-pressed',String(value));
  control.setAttribute('aria-label',value?'Disable view once':'Enable view once');
  control.title=value?'View once enabled':'View once';
}
function setOnceMode(value){viewOnce=value;burnSeconds=0;if(value)clearReply();$('attachmentMenu').classList.toggle('once-active',value);$('message').placeholder=value?'View-once message':'Message';syncOnceToggle($('onceShortcut'),value);updateSendButton();}
function resetOnce() {
  viewOnce = false;
  burnSeconds = 0;
  $('attachmentMenu').classList.remove('once-active');
  $('message').placeholder = 'Message';
  syncOnceToggle($('onceShortcut'),false);
}
$('onceShortcut').addEventListener('click',()=>{
  const room=state.rooms.find(r=>r.id===selected);
  if(!unlockToken||sendingMessage||!onceAllowed(room))return;
  setOnceMode(!viewOnce);rememberRoom();haptic();
});

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
    if(room.encryption){if(!state.capabilities?.encryptedExtras||!encryptionReady(room))throw Error('Encryption unavailable.');const epoch=authEpoch;const value=message.reactions?.some(r=>r.mine&&r.emoji===emoji)?'-':emoji;const cipher=await QzuCrypto.encryptReaction(roomKeys.get(room.id).context,message.id,value);if(epoch!==authEpoch||!unlockToken||document.hidden)throw Error('Locked.');await api('encryption/reaction',{id:room.id,messageId:message.id,cipher});}else await api('message/react', { id: room.id, messageId: message.id, emoji });
    haptic();closeModal();
    await refresh();
  } catch (error) { showError(error); }
}

function showReport(room,selection={}){
  const reason=el('select','edit-input');reason.setAttribute('aria-label','Reason');for(const name of ['Harassment','Threats or violence','Sexual exploitation','Spam or scam','Other']){const option=el('option','',name);option.value=name;reason.append(option);}
  const evidence=el('textarea','edit-input');evidence.maxLength=2000;evidence.placeholder='Additional details (optional)';
  const available=room.messages.filter(m=>m.kind==='text'&&!m.deleted&&!m.once&&!m.burnSeconds&&(!room.encryption||m.decrypted)&&(!privacyMode||revealedMessages.has(m.id)));
  const anchor=available.findIndex(m=>m.id===selection.messageId),candidates=anchor>=0?available.slice(Math.max(0,anchor-12),anchor+13):available.slice(-24);
  const chosen=new Set(),list=el('div','report-context-list');if(candidates.length)list.append(el('p','','Select up to 24 messages to share with moderators. Review the conversation snapshot before submitting.'));
  for(const m of candidates){const check=el('input');check.type='checkbox';const item=el('label','report-context-row');const copy=el('div');copy.append(el('strong','',(m.mine?'You':m.sender)+' · '+fmtTime(m.at)+(m.id===selection.messageId?' · Reported':'')),el('p','',m.text.slice(0,1000)));item.append(check,copy);check.addEventListener('change',()=>{if(check.checked&&chosen.size>=24){check.checked=false;return;}if(check.checked)chosen.add(m.id);else chosen.delete(m.id);});list.append(item);}
  const selectedMessage=room.messages.find(m=>m.id===selection.messageId&&!m.deleted&&!m.once&&!m.burnSeconds),share=el('input');share.type='checkbox';const shareLabel=el('label','feedback-confirm');shareLabel.append(share,el('span','','Share the reported photo or voice message with moderators'));shareLabel.hidden=!(selectedMessage&&['image','audio'].includes(selectedMessage.kind)&&(!room.encryption||encryptionReady(room))&&(!privacyMode||revealedMessages.has(selectedMessage.id)));
  const send=button('Submit report',async()=>{send.disabled=true;try{const epoch=authEpoch,context=candidates.filter(m=>chosen.has(m.id)).map(m=>({id:m.id,text:m.text.slice(0,1000)}));let attachment=null;
    if(share.checked&&!shareLabel.hidden){let blob;if(room.encryption){const value=await api('encryption/media/'+encodeURIComponent(room.id)+'/'+encodeURIComponent(selectedMessage.id));blob=await QzuCrypto.decryptMedia(roomKeys.get(room.id).context,selectedMessage.kind,value.cipher,selectedMessage.mine);}else{const response=await transport('/api/media/'+encodeURIComponent(room.id)+'/'+encodeURIComponent(selectedMessage.id),{headers:{'X-QZU-Unlock':unlockToken},cache:'no-store',credentials:'same-origin'});if(!response.ok)throw Error('Evidence unavailable.');blob=await response.blob();}
      attachment={mime:blob.type.split(';')[0],data:await blobData(blob)};
    }
    if(epoch!==authEpoch||!unlockToken||document.hidden||!body.contains(send))throw Error('Locked.');
    await api('report',{id:room.id,...selection,reason:reason.value,evidence:evidence.value,context,...(attachment?{attachment}:{})});info('Report received','Your report has been submitted.');}catch(error){dialogError(error);send.disabled=false;}});
  show('Report abuse',[el('p','','Selected messages and details will be shared with authorized moderators, even if this chat is encrypted.'),reason,list,shareLabel,evidence,send,button('Cancel',closeModal,'secondary-button')]);mediaRoom=room.id;
}
function reportDetail(item){
  const controls=[el('h3','',item.reason),el('p','','Report '+item.id),el('p','','Reported account: '+(item.target||'Deleted account')),el('p','','Reporter: '+(item.reporter||'Deleted account')),el('p','','Chat: '+item.chat_type+' · '+item.room),el('p','','Received '+new Date(item.created).toLocaleString()),el('p','','Previous reports: '+item.previousReports),el('p','',item.evidence||'No additional details')];
  const transcript=el('div','report-transcript');
  for(const entry of item.context||[]){const bubble=el('div','report-evidence'+(entry.sender==='Reporter'?' snapshot-mine':' snapshot-other')+(entry.reported?' reported':''));bubble.append(el('strong','',entry.sender+' · '+new Date(entry.at).toLocaleTimeString()),el('p','',entry.text),el('small','',entry.source==='reporter-submitted'?'Reporter-submitted text':'Server-confirmed text'));transcript.append(bubble);}
  controls.push(el('p','case-status '+(item.resolved?'solved':item.workflow==='help'?'help':'inspection'),item.resolved?'Solved':item.workflow==='help'?'Need Additional Help':'Under Inspection'),el('h3','','Conversation snapshot · '+(item.context?.length||0)+' messages'),transcript);
  if(item.attachment)controls.push(button('View reported '+(item.attachment.kind==='image'?'photo':'audio'),async()=>{try{const epoch=authEpoch,response=await transport('/api/admin/reports/media/'+encodeURIComponent(item.id),{headers:{'X-QZU-Unlock':unlockToken},cache:'no-store',credentials:'same-origin'});if(!response.ok)throw Error('Evidence unavailable.');const blob=await response.blob();if(epoch!==authEpoch||!unlockToken||document.hidden)return;const media=el(item.attachment.kind==='image'?'img':'audio','temporary-media');if(item.attachment.kind==='audio')media.controls=true;else media.alt='Reported photo';show('Report evidence',[el('p','',item.attachment.source==='reporter-submitted'?'Reporter-submitted attachment':'Server-confirmed attachment'),media,button('Back',()=>reportDetail(item),'secondary-button')]);mediaUrl=URL.createObjectURL(blob);media.src=mediaUrl;}catch(error){modalError(error);}},'secondary-button'));if(!item.context?.length)controls.push(el('p','','No message content was shared.'));
  if(item.history?.length){controls.push(el('h3','','Moderation history'));for(const event of item.history)controls.push(el('p','',new Date(event.created).toLocaleString()+' · '+event.action+(event.notes?' · '+event.notes:'')));}
  const notes=el('textarea','edit-input');notes.placeholder='Moderator notes';notes.maxLength=1000;
  if(item.collaboration?.length){controls.push(el('h3','','Support collaboration'));for(const event of item.collaboration)controls.push(el('p','','Admin '+(event.actor||'Deleted')+' · '+new Date(event.at).toLocaleString()+' · '+event.status+' · '+event.note));}
  if(!item.resolved){controls.push(notes);for(const [label,status] of [['Under Inspection','inspection'],['Need Additional Help','help']])controls.push(button(label,async()=>{try{await api('admin/reports/collaborate',{id:item.id,status,note:notes.value});openModeration();}catch(error){modalError(error);}},'secondary-button'));for(const [label,action] of [['Dismiss','dismiss'],['Warn account','warn'],['Restrict messaging for 24h','restrict'],['Suspend for 24h','suspend24h'],['Suspend for 7 days','suspend7d'],['Permanently suspend','suspend']])controls.push(button(label,()=>{show('Confirm '+label.toLowerCase()+'?',[el('p','','This action will be recorded in moderation history.'),button('Confirm',async()=>{try{await api('admin/reports/resolve',{id:item.id,action,notes:notes.value});openModeration();}catch(error){dialogError(error);}}),button('Cancel',()=>reportDetail(item),'secondary-button')]);},'secondary-button'+(action.startsWith('suspend')?' danger-button':'')));}
  else{controls.push(el('p','','Resolved: '+(item.action||'reviewed')),el('p','',item.notes||''));if(item.account?.suspended||item.account?.restrictedUntil){controls.push(notes,button('Reinstate account',()=>{show('Reinstate account?',[button('Confirm',async()=>{try{await api('admin/reports/reinstate',{target:item.target,notes:notes.value});openModeration();}catch(error){dialogError(error);}}),button('Cancel',()=>reportDetail(item),'secondary-button')]);},'secondary-button trusted-action'));}}
  controls.push(button('Back',openModeration,'secondary-button'));show('Report details',controls);
}
async function openModeration(){
  try{const {items}=await api('admin/reports'),search=el('input','edit-input'),filter=el('select','edit-input'),list=el('div','request-list');search.placeholder='Search report, account or reason';for(const value of ['Pending','Resolved','All']){const o=el('option','',value);o.value=value;filter.append(o);}
    function renderReports(){list.replaceChildren();const query=search.value.toLowerCase().trim();const matches=items.filter(x=>(filter.value==='All'||Boolean(x.resolved)===(filter.value==='Resolved'))&&[x.id,x.reason,x.target,x.reporter].some(v=>String(v||'').toLowerCase().includes(query)));for(const item of matches){const row=el('div','request-item');row.append(el('strong','',item.reason),el('p','',(item.resolved?'Solved':item.workflow==='help'?'Need Additional Help':'Under Inspection')+' · '+new Date(item.created).toLocaleDateString()+' · '+item.previousReports+' previous reports'),button('View report',()=>reportDetail(item),'secondary-button'));list.append(row);}if(!matches.length)list.append(el('p','','No reports found.'));}
    search.addEventListener('input',renderReports);filter.addEventListener('change',renderReports);renderReports();show('Moderation',[el('p','',items.filter(x=>!x.resolved).length+' pending · '+items.filter(x=>x.resolved).length+' resolved'),search,filter,list,button('Close',closeModal,'secondary-button')]);
  }catch(error){showError(error);}
}
$('adminReports').addEventListener('click',openModeration);
$('recoverySettings').addEventListener('click',()=>{
 if(!unlockToken||state.supportAgent)return;
 const pin=el('input','access-key-input');pin.type='password';pin.inputMode='numeric';pin.maxLength=6;pin.placeholder='Current login PIN';pin.autocomplete='off';
 const issue=button('Create recovery code',async()=>{issue.disabled=true;try{const result=await api('account/recovery-code',{pin:pin.value});pin.value='';if(!body.contains(issue)||!unlockToken||document.hidden)return;show('Save your recovery code',[el('p','','Keep this code offline. It requires your existing login PIN. Creating a new code invalidates the old one.'),el('p','access-address',result.recoveryCode),button('Copy recovery code',()=>navigator.clipboard.writeText(result.recoveryCode)),button('Done',closeModal,'secondary-button')]);}catch(e){dialogError(e);issue.disabled=false;}});
 show('Account recovery',[el('p','','Recover your account and paid access on a new device using your recovery code and current login PIN. Old encrypted conversations and saved contacts cannot be transferred. This replaces any existing recovery code.'),pin,issue,button('Cancel',closeModal,'secondary-button')]);
});
function messageActions(room, message) {
  const picker = el('div', 'reaction-picker');
  for (const emoji of reactions) picker.append(button(emoji, () => reactTo(room, message, emoji), 'reaction-choice'));
  const extras=!room.encryption||(state.capabilities?.encryptedExtras&&encryptionReady(room));
  const controls = message.once || message.burnSeconds || !extras ? [] : [picker];
  if(!message.once&&!message.burnSeconds&&extras)controls.push(button('Reply',()=>{closeModal();beginReply(room,message);},'secondary-button'));
  if(message.kind==='text'&&!message.once&&!message.burnSeconds&&(!room.encryption||message.decrypted))controls.push(button('Copy',async()=>{try{await navigator.clipboard.writeText(message.text);closeModal();}catch(error){modalError(error);}},'secondary-button'));
  if(!message.mine)controls.push(button('Report',()=>showReport(room,{messageId:message.id}),'secondary-button'));

  if (!room.encryption && !message.once && !message.burnSeconds && message.mine && message.kind === 'text' && serverNow() - message.at <= 60_000) {
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
    show('Device fingerprints', [el('p', '', 'Compare the entire code with your contact through a separate trusted channel.'), el('div', 'fingerprint-code', result.code.match(/.{1,4}/g).join(' ')), el('p', '', 'Based on server-registered device keys.'), button('Close', closeModal)]);
  } catch (error) { showError(error); }
}
for(const id of ['profileAvatar','profileName'])$(id).addEventListener('click',()=>$('chatOptions').click());
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
  if (room.admin&&!room.support) return;
  const profileMark=svg(room.group?'groupAvatar':'avatar','profile-transition-mark');
  const controls = [profileMark,el('h3','profile-heading',nameFor(room))];
  if(room.support){show('Chat options',[button('Report support conversation',()=>showReport(room),'secondary-button'),button('Close',closeModal,'secondary-button')]);return;}
  if(room.group){for(const member of room.members||[])controls.push(button('Report '+member,()=>showReport(room,{member}),'secondary-button'));}else controls.push(button('Report contact',()=>showReport(room),'secondary-button'));
  if (!room.group) {
    if(room.contact){controls.push(button(room.contact.personallyTrusted?'Remove trusted contact':'Add trusted contact',async()=>{try{await api('contacts/update',{id:room.contact.id,trusted:!room.contact.personallyTrusted});closeModal();await refresh();}catch(error){modalError(error);}},'secondary-button trusted-action'));controls.push(button('Manage contact',()=>showContactManagement(room.contact),'secondary-button'));}
    if (encryptionRequired(room) && directRoom(room)) controls.push(button('Verify encryption', () => showEncryption(room), 'secondary-button'));
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
  } else controls.push(button('Block contact', () => confirm(null), 'secondary-button danger-button'));
  controls.push(button('Close', closeModal, 'secondary-button'));
  const origin=$('profileAvatar').getBoundingClientRect();
  show('Contact information', controls);
  if(motionAllowed()&&profileMark.animate){const target=profileMark.getBoundingClientRect();if(target.width&&origin.width)profileMark.animate([{transform:'translate('+((origin.left+origin.width/2)-(target.left+target.width/2))+'px,'+((origin.top+origin.height/2)-(target.top+target.height/2))+'px) scale('+origin.width/target.width+')',opacity:.6},{transform:'none',opacity:1}],{duration:260,easing:'cubic-bezier(.2,.8,.2,1)'});}
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
  if(message.mine||message.opened||message.deleted||openingOnce.has(message.id)||!unlockToken||document.hidden||selected!==room.id)return;
  const epoch=authEpoch,encrypted=Boolean(room.encryption);
  if(encrypted&&(!state.capabilities?.encryptedOnce||!encryptionReady(room))){showError(Error('View-once encryption unavailable.'));return;}
  const marker=el('p','once-loading','Opening once…');
  marker.prepend(svg('viewOnceIcon'));
  openingOnce.add(message.id);
  const active=()=>epoch===authEpoch&&Boolean(unlockToken)&&!document.hidden&&selected===room.id&&modal.open&&body.contains(marker)&&state.rooms.some(r=>r.id===room.id&&r.expires>serverNow()&&r.messages.some(m=>m.id===message.id&&!m.deleted));
  show('View once',[marker,el('p','media-status','Closing this view or leaving the app ends the view permanently.'),button('Close',closeModal,'secondary-button')]);
  mediaRoom=room.id;mediaMessage=message.id;
  try {
    if(!active())return;
    const context=encrypted?roomKeys.get(room.id)?.context:null;
    const result = await api(encrypted?'encryption/once/open':'message/open', { id: room.id, messageId: message.id });
    for(const r of state.rooms)if(r.id===room.id){const m=r.messages.find(m=>m.id===message.id);if(m){m.opened=true;m.unread=false;m.text='';m.cipher=null;m.encryptedMedia=false;}}
    message.opened=true;
    if(epoch===authEpoch)render();
    if(!active())return;
    let text=result.text,source=null;
    if(result.kind!==message.kind)throw Error('Invalid view-once message.');
    if(encrypted){
      if(!context||roomKeys.get(room.id)?.context!==context||!result.cipher)throw Error('Encryption key unavailable.');
      if(result.kind==='text')text=await QzuCrypto.decrypt(context,result.cipher,false);
      else source=await QzuCrypto.decryptMedia(context,result.kind,result.cipher,false);
    }else if(result.media)source='data:'+result.media.mime+';base64,'+result.media.data;
    if(!active())return;
    if(source)showMedia(room,result.kind,source,message.id);
    else {show('View once',[el('p','once-content',text),button('Close',closeModal)]);mediaRoom=room.id;mediaMessage=message.id;}
    haptic();
  }catch(error){if(active())modalError(error);}
  finally{openingOnce.delete(message.id);if(epoch===authEpoch&&unlockToken)refresh().catch(()=>{});}
}

function currentMediaRoom(){const room=state.rooms.find(r=>r.id===selected);return room&&!room.admin&&!room.readOnly&&(!encryptionRequired(room)||encryptionReady(room))?room:null;}
$('cameraShortcut').addEventListener('click',()=>{const room=currentMediaRoom();if(room){choosePhoto(room,true);}});
const voiceControl=$('voiceShortcut');
let voiceGesture=null;
voiceControl.addEventListener('pointerdown',event=>{
  if(event.button!==0||voiceGesture||recordingCleanup)return;
  const room=currentMediaRoom();if(!room||!unlockToken)return;
  event.preventDefault();voiceControl.setPointerCapture(event.pointerId);
  const gesture={id:event.pointerId,x:event.clientX,y:event.clientY,action:'hold',session:null};
  voiceGesture=gesture;haptic();
  recordVoice(room,gesture).catch(error=>{if(voiceGesture===gesture)voiceGesture=null;showError(error);});
});
function voiceSwipe(dx,dy){return dx>=75&&dx>=dy?'cancel':dy>=65?'locked':'hold';}
voiceControl.addEventListener('pointermove',event=>{
  const g=voiceGesture;if(!g||event.pointerId!==g.id||g.action!=='hold')return;
  const action=voiceSwipe(g.x-event.clientX,g.y-event.clientY);
  if(action==='cancel'){g.action=action;g.session?.cancel();haptic();}
  else if(action==='locked'){g.action=action;g.session?.lock();haptic();}
});
function endVoiceGesture(event, cancelled=false){
  const g=voiceGesture;if(!g||g.id!==event.pointerId)return;
  voiceGesture=null;
  if(cancelled&&g.action!=='locked'){g.action='cancel';g.session?.cancel();return;}
  if(g.action==='hold'){g.action='send';g.session?.send();}
}
voiceControl.addEventListener('pointerup',event=>endVoiceGesture(event));
voiceControl.addEventListener('pointercancel',event=>endVoiceGesture(event,true));
voiceControl.addEventListener('lostpointercapture',event=>endVoiceGesture(event,true));
voiceControl.addEventListener('click',event=>{if(event.detail===0){const room=currentMediaRoom();if(room)recordVoice(room);}});
function closeInlineAttachments(focus=false){
  const panel=$('inlineAttachments'),toggle=$('attachmentMenu');
  if(panel.hidden)return;
  panel.hidden=true;panel.replaceChildren();toggle.classList.remove('inline-open');
  toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Message options');toggle.replaceChildren(svg('plus'));
  if(focus)$('message').focus({preventScroll:true});
}
function showAttachmentGrid(title,options){
  const panel=$('inlineAttachments'),toggle=$('attachmentMenu');
  $('message').blur();panel.replaceChildren();
  for(const control of options){
    const label=control.textContent;
    const icon=label.includes('Gallery')?'photosIcon':label.includes('Camera')?'camera':label.includes('Voice')?'mic':label.toLowerCase().includes('once')?'viewOnceIcon':label.includes('reading')||label.includes('Timed')?'clock':'chat';
    const name=label==='Gallery'?'Photos':label==='Voice message'?'Voice':label.includes('once')?'View Once':label.includes('reading')?'Timed Text':label;
    const tile=el('span','inline-attachment-icon');tile.dataset.icon=icon;tile.append(svg(icon));
    control.className='inline-attachment-tile';control.setAttribute('aria-label',label);control.replaceChildren(tile,el('span','',name));
    control.addEventListener('click',()=>closeInlineAttachments(),{capture:true,once:true});panel.append(control);
  }
  panel.hidden=false;toggle.classList.add('inline-open');toggle.replaceChildren(svg('keyboardIcon'));toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-label','Show keyboard');haptic();
}
$('message').addEventListener('focus',()=>closeInlineAttachments());
$('attachmentMenu').addEventListener('click', () => {
  if(!$('inlineAttachments').hidden){closeInlineAttachments(true);return;}
  const room = state.rooms.find(room => room.id === selected);
  if (!room || room.admin) return;
  if (room.encryption || (native && directRoom(room))) {
    if (!encryptionReady(room)) { showEncryption(room); return; }
    const options=[button('Gallery', () => choosePhoto(room), 'secondary-button'),button('Camera',()=>choosePhoto(room,true),'secondary-button'),button('Voice message',()=>recordVoice(room),'secondary-button')];
    if(state.capabilities?.encryptedOnce)options.unshift(button(viewOnce?'Disable view once':'Enable view once',()=>{setOnceMode(!viewOnce);rememberRoom();closeModal();},'secondary-button'));
    showAttachmentGrid('Encrypted attachments',options);
    return;
  }
  const items = burnSeconds ? [] : [button('Gallery', () => choosePhoto(room), 'secondary-button'), button('Camera',()=>choosePhoto(room,true),'secondary-button'), button('Voice message', () => recordVoice(room), 'secondary-button')];
  if (!room.group && !burnSeconds) items.unshift(button(viewOnce ? 'Disable view once' : 'Enable view once', () => {
    setOnceMode(!viewOnce);rememberRoom();
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
  showAttachmentGrid('Message options',items);
});

function blobData(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function sendAttachment(room, kind, blob, once, cleaned=false) {
  const startEpoch=authEpoch;
  if(kind==='image'&&!cleaned)blob=await QzuMetadata.cleanImage(blob);
  if(startEpoch!==authEpoch||!unlockToken||selected!==room.id||document.hidden||room.expires<=serverNow())throw Error('Chat unavailable.');
  if (blob.size > 2 * 1024 * 1024 || !blob.size) throw new Error('Attachment must be under 2 MB.');
  const epoch = authEpoch;
  if (room.encryption || (native && directRoom(room))) {
    if (!encryptionReady(room)) throw Error('Verified encryption required.');
    if(once&&!state.capabilities?.encryptedOnce)throw Error('Update the server before sending view-once content.');
    const cipher = await QzuCrypto.encryptMedia(roomKeys.get(room.id).context, kind, blob);
    if (epoch !== authEpoch || !unlockToken || selected !== room.id || document.hidden || room.expires <= serverNow()) throw Error('Chat unavailable.');
    await api(once?'encryption/once/send':'encryption/message', { id: room.id, kind, cipher });
  } else {
    const data = await blobData(blob);
    if (epoch !== authEpoch || !unlockToken || selected !== room.id || document.hidden) throw new Error('Chat unavailable.');
    await api('message', { id: room.id, kind, mime: blob.type.split(';')[0], data, once });
  }
  if(!$('message').value.trim())resetOnce();
  closeModal();
  await refresh();
}

function choosePhoto(room,camera=false){
  const input=el('input','photo-file');input.type='file';input.accept='image/jpeg,image/png,image/webp';if(camera)input.setAttribute('capture','environment');
  const preview=el('img','temporary-media photo-preview');preview.alt='Photo preview';preview.hidden=true;
  const status=el('p','media-status','Choose a photo');
  const epoch=authEpoch;let once=viewOnce&&onceAllowed(room),prepared=null,selection=0,sending=false;
  const toggle=button('',()=>{if(sending||!onceAllowed(room))return;once=!once;syncPhotoMode();haptic();},'icon-button once-toggle photo-once-toggle');
  toggle.append(svg('viewOnceIcon'));toggle.hidden=!onceAllowed(room);
  const mode=el('span','photo-once-label','');
  const send=button('Send photo',async()=>{if(!prepared||sending)return;sending=true;send.disabled=true;toggle.disabled=true;input.disabled=true;status.textContent='Sending…';try{await sendAttachment(room,'image',prepared,once,true);}catch(error){sending=false;send.disabled=false;toggle.disabled=false;input.disabled=false;status.textContent='';modalError(error);}});send.disabled=true;
  function syncPhotoMode(){syncOnceToggle(toggle,once);mode.textContent=once?'View once enabled':'View once';send.textContent=once?'Send once':'Send photo';}
  syncPhotoMode();
  const onceRow=el('div','photo-once-row');onceRow.hidden=toggle.hidden;onceRow.append(mode,toggle);
  input.addEventListener('change',async()=>{const n=++selection,file=input.files?.[0];prepared=null;send.disabled=true;preview.hidden=true;if(mediaUrl){URL.revokeObjectURL(mediaUrl);mediaUrl=null;}if(!file)return;status.textContent='Preparing photo…';try{const blob=await QzuMetadata.cleanImage(file);if(epoch!==authEpoch||n!==selection||!body.contains(input)||document.hidden)return;prepared=blob;mediaUrl=URL.createObjectURL(blob);preview.src=mediaUrl;preview.hidden=false;status.textContent=Math.round(blob.size/1024)+' KB';send.disabled=false;}catch(error){status.textContent='';dialogError(error);}});
  show(camera?'Camera':'Gallery',[input,preview,status,onceRow,send,button('Cancel',closeModal,'secondary-button')]);mediaRoom=room.id;
  // File chooser must be opened synchronously from the user's tap.
  input.click();
}

async function recordVoice(room,gesture=null) {
  const once=viewOnce;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    if(voiceGesture===gesture)voiceGesture=null;
    info('Voice message', 'Recording is unavailable in this browser.');
    return;
  }
  const epoch=authEpoch, label=el('p','voice-gesture-status','Allow microphone access to record.');
  const panel=el('div','voice-gesture-panel'), controls=el('div','voice-gesture-controls');
  const wave=el('canvas','voice-wave');wave.width=320;wave.height=38;
  panel.append(label,wave,controls);
  let microphone,recorder,context,source,analyser,ticker,timer,chunks=[],cancelled=false,instant=false,locked=!gesture,pausedAt=0,pausedTotal=0,started=0,finished=false;
  const active=()=>epoch===authEpoch&&Boolean(unlockToken)&&selected===room.id&&page==='chat'&&(!mobile.matches||mobileOpen)&&!document.hidden&&room.expires>serverNow()&&panel.isConnected;
  const stopTracks=()=>{microphone?.getTracks().forEach(track=>track.stop());if(context){context.close().catch(()=>{});context=null;}clearInterval(ticker);clearTimeout(timer);};
  const cleanup=()=>{cancelled=true;stopTracks();if(recorder&&recorder.state!=='inactive')recorder.stop();chunks=[];panel.remove();$('composer').classList.remove('voice-recording');if(recordingCleanup===cleanup)recordingCleanup=null;if(voiceGesture===gesture)voiceGesture=null;};
  const cancel=()=>{cleanup();if(!gesture)closeModal();};
  const stop=(send=false)=>{if(finished||cancelled||!recorder||recorder.state==='inactive')return;instant=send;recorder.stop();};
  const pause=button('Pause',()=>{if(recorder?.state==='recording'){recorder.pause();pausedAt=Date.now();pause.textContent='Resume';}else if(recorder?.state==='paused'){recorder.resume();pausedTotal+=Date.now()-pausedAt;pausedAt=0;pause.textContent='Pause';}},'secondary-button');
  const preview=button('Preview',()=>stop(false),'secondary-button');preview.disabled=true;
  const sendNow=button('Send',()=>stop(true));sendNow.disabled=true;pause.disabled=true;
  const discard=button('Discard',cancel,'secondary-button');
  const lock=()=>{locked=true;controls.replaceChildren(discard,pause,preview,sendNow);label.textContent='Recording hands-free';motion(controls,'motion-page');};
  if(gesture)gesture.session={cancel,lock,send:()=>stop(true)};
  // A modal would make the pointer-capture target inert. Keep hold gestures in the composer.
  if(gesture){$('composer').before(panel);$('composer').classList.add('voice-recording');controls.replaceChildren(discard);label.textContent='Hold · Slide left to cancel · Slide up to lock';}
  else{show('Voice message',[panel]);lock();}
  mediaRoom=room.id;
  recordingCleanup=cleanup;
  try{
    microphone=await navigator.mediaDevices.getUserMedia({audio:true});
    if(cancelled||!active()||gesture?.action==='cancel'){cleanup();return;}
    if(gesture?.action==='send'){cleanup();return;}
    const mime=['audio/mp4','audio/webm','audio/ogg'].find(type=>MediaRecorder.isTypeSupported(type));
    if(!mime)throw Error('No supported recording format.');
    recorder=new MediaRecorder(microphone,{mimeType:mime,audioBitsPerSecond:64000});
    recorder.ondataavailable=event=>{if(!cancelled&&event.data.size)chunks.push(event.data);};
    recorder.onerror=()=>{const visible=active();cleanup();if(visible)showError(Error('Recording interrupted.'));};
    for(const track of microphone.getTracks())track.addEventListener('ended',()=>{if(!finished&&!cancelled)cancel();},{once:true});
    recorder.onstop=async()=>{
      if(finished)return;finished=true;stopTracks();
      if(recordingCleanup===cleanup)recordingCleanup=null;
      if(cancelled||!active()){cleanup();return;}
      const blob=new Blob(chunks,{type:mime});chunks=[];
      if(!blob.size){cleanup();if(!gesture)closeModal();return;}
      panel.remove();$('composer').classList.remove('voice-recording');
      if(instant){try{await sendAttachment(room,'audio',blob,once);return;}catch(error){if(epoch!==authEpoch||!unlockToken||document.hidden||selected!==room.id)return;/* Do not auto-retry: delivery may already have succeeded. */showError(error);return;}}
      const player=el('audio','temporary-media');player.controls=true;
      const send=button(once?'Send once':'Send recording',async()=>{send.disabled=true;try{await sendAttachment(room,'audio',blob,once);}catch(error){send.disabled=false;modalError(error);}});
      show('Voice message',[player,send,button('Discard',closeModal,'secondary-button')]);mediaRoom=room.id;mediaUrl=URL.createObjectURL(blob);player.src=mediaUrl;
    };
    recorder.start();started=Date.now();pause.disabled=false;preview.disabled=false;sendNow.disabled=false;if(gesture?.action==='locked')lock();
    try{const AudioCtx=window.AudioContext||window.webkitAudioContext;if(AudioCtx){context=new AudioCtx();source=context.createMediaStreamSource(microphone);analyser=context.createAnalyser();analyser.fftSize=256;source.connect(analyser);}}catch{}
    ticker=setInterval(()=>{
      if(!active()){cancel();return;}
      const seconds=Math.floor(((pausedAt||Date.now())-started-pausedTotal)/1000);
      label.textContent=(locked?'Recording':'‹ Slide left to cancel · ↑ Lock')+' · '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
      const ctx=wave.getContext('2d');if(!ctx)return;ctx.clearRect(0,0,wave.width,wave.height);
      const data=new Uint8Array(128);if(analyser)analyser.getByteTimeDomainData(data);else data.fill(128);
      ctx.fillStyle=getComputedStyle(wave).color;for(let i=0;i<40;i++){const h=Math.max(2,Math.abs(data[i*3]-128)/128*36);ctx.fillRect(i*8,(38-h)/2,4,h);}
    },100);
    timer=setTimeout(()=>stop(false),60000);
  }catch(error){const visible=active();cleanup();if(visible)showError(error);}
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

$('privacyPolicy').addEventListener('click',async()=>{
  const url=new URL('/privacy',apiOrigin).href;
  try{if(native)await devicePlugin.openUpdate({url});else location.assign(url);}
  catch(error){showError(error);}
});
$('securityCenter').addEventListener('click', () => {
  const list = el('div', 'security-list');
  const items = [
    ['Login PIN', 'Enabled'],
    ['Automatic lock', 'Enabled'],
    ['Chat lifetime', '24 hours'],
    ['Privacy mode', privacyMode ? 'Enabled' : 'Disabled'],
    ['Invisible mode', state.invisible ? 'Enabled' : 'Disabled'],
    ['Emergency PIN', state.pinState === 'active' ? 'Ready' : state.pinState === 'used' ? 'Used' : 'Not configured'],
    ['Direct chat security', 'Device verification required'],
    ['Support and group security', 'Transport encryption; server can access content'],
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
  if (!native || playBuild) return null;
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
  const description = el('p', 'update-description', 'Version '+release.latest+' is available. Installed: '+installedVersion+'.');
  const changes=el('ul','update-changes');for(const change of release.changes||[release.notes])if(change)changes.append(el('li','',change));
  const actions = el('div', 'update-actions');
  actions.append(button('Remind me later', () => { deferUpdate(release.latest); closeModal(); }, 'secondary-button update-later'));
  if (updateDownload(release)) actions.append(button('Install now', () => installUpdate(release), 'primary-button update-install'));
  else actions.classList.add('update-single');
  const details=[logo,description,changes];if(!updateDownload(release))details.push(el('p','access-mini','No install link is available for this device yet.'));
  show('Update available', [...details,actions]);
  modal.classList.add('update-sheet');
  $('modalClose').hidden = true;
}

function maybePromptUpdate() {
  if (!native || playBuild || !unlockToken || accessDue || document.hidden) return;
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
  if(playBuild){info('Update center','Installed: '+installedVersion+'. Updates are delivered by Google Play.');return;}
  try {
    const release = await api('version');
    if (newerVersion(release.latest)) { pendingUpdate = release; showUpdatePrompt(release); return; }
    const changes=el('ul','update-changes');for(const change of release.changes||[release.notes])if(change)changes.append(el('li','',change));
    show('Update center', [el('strong', '', 'You are up to date'), el('p', '', 'Installed: ' + installedVersion + ' · Server release: ' + release.latest),changes, button('Close', closeModal)]);
  } catch (error) { showError(error); }
});
let pushPlugin=null,pushListenersReady=false,pushRetryAt=0,pushRegisterJob=null,pushRemovalJob=null;
function pushOptedOut(){try{return localStorage.getItem('qzu-push-opt-out')==='1';}catch{return false;}}
function shouldPromptPush(){try{return localStorage.getItem('qzu-push-permission-requested')!=='1';}catch{return false;}}
function notePushPrompt(){try{localStorage.setItem('qzu-push-permission-requested','1');}catch{}}
function pushAvailable(){return Boolean(state.push?.available&&(!state.push.platforms||state.push.platforms.includes(window.Capacitor?.getPlatform?.())));}
function getPushPlugin(){
  if(!native||!window.Capacitor.isPluginAvailable('PushNotifications'))return null;
  if(!pushPlugin)pushPlugin=window.Capacitor.registerPlugin('PushNotifications');
  return pushPlugin;
}
async function registerPrivatePush(interactive=false,requestPermission=interactive){
  if(pushRegisterJob)return pushRegisterJob;
  const job=registerPrivatePushOnce(interactive,requestPermission);pushRegisterJob=job;
  try{return await job;}finally{if(pushRegisterJob===job)pushRegisterJob=null;}
}
async function registerPrivatePushOnce(interactive,requestPermission){
  const plugin=getPushPlugin(),epoch=authEpoch;
  if(!plugin||!pushAvailable())throw Error('Push delivery is not available on this device yet.');
  if(!pushListenersReady){
    await plugin.addListener('registration',async({value})=>{
      const job=pushRegistration;
      if(!job||job.epoch!==authEpoch||!unlockToken||pushOptedOut())return;
      pushRegistration=null;
      try{await api('push/register',{platform:window.Capacitor.getPlatform(),token:value});await refresh();if(job.interactive)info('Private notifications','Enabled. Message content is never included.');}
      catch(error){pushEpoch=-1;pushRetryAt=Date.now()+15000;if(job.interactive)showError(error);}
    });
    await plugin.addListener('registrationError',()=>{const job=pushRegistration;pushRegistration=null;pushEpoch=-1;pushRetryAt=Date.now()+15000;if(job?.interactive&&job.epoch===authEpoch)info('Private notifications','Registration failed. Check device configuration.');});
    await plugin.addListener('pushNotificationReceived',()=>{if(unlockToken&&!document.hidden)refresh().catch(()=>{});});
    pushListenersReady=true;
  }
  if(window.Capacitor.getPlatform()==='android')await plugin.createChannel({id:'qzu_messages',name:'Messages',description:'New private messages',importance:5,visibility:0,vibration:true,sound:'default'}).catch(()=>{});
  let permission=await plugin.checkPermissions();
  if(requestPermission&&permission.receive!=='granted'){notePushPrompt();permission=await plugin.requestPermissions();}
  if(permission.receive!=='granted'){if(interactive)throw Error('Notification permission is disabled.');return;}
  if(epoch!==authEpoch||!unlockToken||document.hidden||pushOptedOut())return;
  const pending={epoch:authEpoch,interactive};pushRegistration=pending;pushEpoch=authEpoch;
  setTimeout(()=>{if(pushRegistration===pending){pushRegistration=null;pushEpoch=-1;pushRetryAt=Date.now()+15000;if(interactive&&epoch===authEpoch&&unlockToken)info('Private notifications','Registration timed out. Try again.');}},15000);
  try{await plugin.register();}catch(error){pushRegistration=null;pushEpoch=-1;pushRetryAt=Date.now()+15000;throw error;}
}
async function disablePrivatePush(){if(pushRemovalJob)return pushRemovalJob;const job=(async()=>{pushRegistration=null;pushEpoch=authEpoch;await api('push/remove',{});try{await getPushPlugin()?.unregister?.();}catch{}})();pushRemovalJob=job;try{await job;}finally{if(pushRemovalJob===job)pushRemovalJob=null;}}
function restorePushRegistration(){
  if(pushOptedOut()){if(state.push?.registered&&!pushRemovalJob&&Date.now()>=pushRetryAt){pushRetryAt=Date.now()+15000;disablePrivatePush().catch(()=>{});}return;}
  if(!pushOptedOut()&&native&&window.Capacitor.getPlatform()==='android'&&pushAvailable()&&pushEpoch!==authEpoch&&!pushRegisterJob&&Date.now()>=pushRetryAt&&getPushPlugin()&&unlockToken&&!document.hidden){
    pushEpoch=authEpoch;registerPrivatePush(false,shouldPromptPush()).catch(()=>{pushEpoch=-1;pushRetryAt=Date.now()+15000;});
  }
}
$('privateNotifications').addEventListener('change',async event=>{
  if(!unlockToken)return;
  const toggle=event.currentTarget,enabled=toggle.checked;
  try{if(enabled)localStorage.removeItem('qzu-push-opt-out');else localStorage.setItem('qzu-push-opt-out','1');}catch{}
  toggle.disabled=true;pushRetryAt=0;
  try{
    if(!enabled){$('activityBanner').hidden=true;syncBadge(0);await disablePrivatePush();}
    else{
      if(pushRemovalJob)await pushRemovalJob;
      pushEpoch=-1;lastBadge=-1;
      if(native&&window.Capacitor.getPlatform()==='ios'){
        const count=state.rooms.reduce((n,r)=>n+unreadCount(r),0);
        await devicePlugin.setBadge({count,requestPermission:true});
      }
      if(pushAvailable()&&getPushPlugin())await registerPrivatePush(false,true);
    }
    await refresh();
  }catch(error){$('pushStatus').textContent='Notification setting saved. Device registration will retry.';}
  finally{toggle.disabled=false;toggle.checked=!pushOptedOut();updateNavigation();}
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

// Persist intent before sending a request, so even a lost response can resume safely.
function checkoutStorage(renewal){return renewal?'qzu-checkout-v2-renewal':'qzu-checkout-v2-access';}
function readCheckout(renewal){
 const storage=checkoutStorage(renewal),legacy=renewal?'qzu-renewal':'qzu-access';
 let state={active:null,orders:[],draft:{plan:'month',coin:'LTC'}};
 try{const parsed=JSON.parse(localStorage.getItem(storage)||'null');if(parsed&&Array.isArray(parsed.orders))state={...state,...parsed};
 const old=localStorage.getItem(legacy);
 if(old&&/^QZ[UO]-[A-F0-9]{48}$/.test(old)&&!state.orders.some(x=>x.key===old)){
  state.orders.push({key:old,stage:'legacy',created:Date.now()});
  localStorage.setItem(storage,JSON.stringify(state));
 }
 if(old)localStorage.removeItem(legacy);
 }catch{}
 return state;
}
function saveCheckout(renewal,state){localStorage.setItem(checkoutStorage(renewal),JSON.stringify(state));}
function checkoutOrder(renewal,key){return readCheckout(renewal).orders.find(x=>x.key===key);}
function updateCheckoutOrder(renewal,key,patch={},activate=false){
 const state=readCheckout(renewal),index=state.orders.findIndex(x=>x.key===key);
 const next={...(index<0?{key,created:Date.now()}:state.orders[index]),...patch,key};
 if(index<0)state.orders.push(next);else state.orders[index]=next;
 if(activate)state.active=key;
 saveCheckout(renewal,state);return next;
}
function saveCheckoutDraft(renewal,plan,coin){try{const state=readCheckout(renewal);state.draft={plan,coin};saveCheckout(renewal,state);}catch{}}
function rememberInvoice(key,renewal){const existing=checkoutOrder(renewal,key);updateCheckoutOrder(renewal,key,existing?{}:{stage:'order'},true);}
function savedInvoice(renewal){const state=readCheckout(renewal);return state.orders.some(x=>x.key===state.active&&!['redeemed','archived'].includes(x.stage))?state.active:'';}
function leaveInvoice(renewal,key){const state=readCheckout(renewal);if(state.active===key)state.active=null;saveCheckout(renewal,state);}
function completeInvoice(renewal,key){try{updateCheckoutOrder(renewal,key,{stage:'redeemed',txDraft:''});leaveInvoice(renewal,key);}catch{}}
function forgetInvoice(renewal){try{const state=readCheckout(renewal);state.active=null;saveCheckout(renewal,state);}catch{}}
function clearCheckoutHistory(){try{for(const key of ['qzu-access','qzu-renewal',checkoutStorage(false),checkoutStorage(true)])localStorage.removeItem(key);}catch{}}
function checkoutSecret(){return 'QZO-'+Array.from(crypto.getRandomValues(new Uint8Array(24)),v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();}
const checkoutPlans=[['week','1 Week','1.99','7 days of private messaging'],['month','1 Month','5.99','A full month of access'],['year','1 Year','69.99','12 months of access'],['lifetime','Lifetime','79.99','Pay once, no renewal']];
function checkoutName(plan){return checkoutPlans.find(p=>p[0]===plan)?.[1]|| (plan==='monthly'?'Legacy · 5 months':plan==='renewal'?'Legacy renewal':'Access order');}
function checkoutPrice(plan){return checkoutPlans.find(p=>p[0]===plan)?.[2]||null;}

function showAccountRecovery(){
 if(!native){dialogError(Error('Recover your account in the mobile app.'));return;}
 const code=el('input','access-key-input');code.placeholder='Recovery code';code.autocomplete='off';code.spellcheck=false;code.maxLength=56;
 const pin=el('input','access-key-input');pin.type='password';pin.inputMode='numeric';pin.maxLength=6;pin.placeholder='Existing login PIN';pin.autocomplete='off';
 const check=el('input');check.type='checkbox';const label=el('label','feedback-confirm');label.append(check,el('span','','I understand this disconnects the old device and deletes its active conversations and saved contacts. Paid access and account ID are preserved.'));
 const submit=button('Recover account',async()=>{if(!check.checked)return;submit.disabled=true;try{const result=await api('access/recover',{code:code.value.trim().toUpperCase(),pin:pin.value,confirmed:true});if(!result.ok)throw Error('Recovery unavailable.');code.value='';pin.value='';forgetInvoice(false);delete modal.dataset.checkout;stopCheckout();sessionReady=true;needsSetup=false;showLogin();}catch(e){dialogError(e);submit.disabled=false;}});
 showCheckout('Recover account',[el('p','','Enter the recovery code saved on your old device and your existing login PIN.'),code,pin,label,submit,button('Back',showAccess,'secondary-button')]);
}
function showAccess(){
 if(playBuild){showCheckout('qzu-Access',[el('p','','Enter your existing access key to continue.'),button('Redeem Key', () => showKeyEntry(false)),button('Recover account',showAccountRecovery,'secondary-button'),...legalButtons()]);return;}
 const saved=savedInvoice(false);if(saved){showInvoice(saved,null,false);return;}showPlanCheckout(false);
}
function checkoutHeading(step,title,description=''){
 const head=el('div','pay-heading'),brand=el('div','pay-brand');brand.append(svg('lock'),el('span','','qzu. ACCESS'));
 const steps=el('div','pay-steps');for(const [i,label] of ['Plan','Pay','Ticket'].entries()){const item=el('div','pay-step'+(i<=step?' current':'')+(i<step?' done':''));item.append(el('span','',i<step?'✓':String(i+1)),el('small','',label));steps.append(item);}
 head.append(brand,steps,el('h2','',title));if(description)head.append(el('p','',description));return head;
}
function checkoutLegal(){
 const row=el('div','pay-legal');
 for(const [label,path] of [['Terms of Service','/terms'],['Privacy policy','/privacy']]){
  if(row.children.length)row.append(el('span','','·'));
  const link=el('a','',label);link.href=new URL(path,apiOrigin).href;link.addEventListener('click',e=>{e.preventDefault();openLegal(path);});row.append(link);
 }return row;
}
function showSavedOrders(renewal){
 const shell=el('div','pay-shell'),orders=readCheckout(renewal).orders.filter(o=>!['redeemed','archived'].includes(o.stage)).sort((a,b)=>b.created-a.created);
 shell.append(button('‹ Back',()=>showPlanCheckout(renewal),'pay-back'),el('h2','','Saved orders'));
 if(!orders.length)shell.append(el('p','pay-note','No saved orders.'));
 for(const o of orders){
  const label=o.stage==='legacy'?'Previous order':checkoutName(o.plan)+' · '+(o.priceLabel||(o.usd?'$'+o.usd:'Saved quote'))+' · '+(o.coin||'Legacy');
  const b=button(label+'  ›',()=>{try{updateCheckoutOrder(renewal,o.key,{},true);showInvoice(o.key,null,renewal);}catch(e){dialogError(e);}},'pay-history-row');shell.append(b);
 }showCheckout('Saved orders',[shell],renewal);
}
function showPlanCheckout(renewal){
 const saved=readCheckout(renewal);let plan=checkoutPrice(saved.draft?.plan)?saved.draft.plan:'month',coin=['LTC','BTC','SOL'].includes(saved.draft?.coin)?saved.draft.coin:'LTC',available=new Set(),busy=false;
 const shell=el('div','pay-shell pay-compact'),cards=el('div','pay-plans'),coins=el('div','pay-coins'),notice=el('p','pay-note','Connecting…');
 const purchase=button('Continue',()=>{
  if(busy||!available.has(coin))return;
  busy=true;renderChoice();
  try{const key=checkoutSecret();updateCheckoutOrder(renewal,key,{stage:'intent',plan,coin,usd:checkoutPrice(plan)},true);showInvoice(key,null,renewal);}
  catch(e){notice.textContent='Cannot save order. No payment requested.';busy=false;renderChoice();}
 },'primary-button pay-primary');
 function renderChoice(){
  cards.replaceChildren();for(const [id,label,price] of checkoutPlans){const b=button('',()=>{if(!busy){plan=id;saveCheckoutDraft(renewal,plan,coin);renderChoice();haptic();}},'pay-plan'+(plan===id?' selected':''));b.setAttribute('aria-pressed',String(plan===id));b.append(el('span','pay-radio',plan===id?'●':'○'),el('span','',label),el('strong','pay-price','$'+price));cards.append(b);}
  coins.replaceChildren();for(const [id,label,symbol] of [['LTC','Litecoin','Ł'],['BTC','Bitcoin','₿'],['SOL','Solana','◎']]){const b=button('',()=>{if(!busy){coin=id;saveCheckoutDraft(renewal,plan,coin);renderChoice();haptic();}},'pay-coin '+id.toLowerCase()+(coin===id?' selected':''));b.append(el('span','pay-coin-symbol',symbol),el('strong','',id));b.disabled=busy||!available.has(id);b.setAttribute('aria-label',label);b.setAttribute('aria-pressed',String(coin===id));coins.append(b);}
  purchase.disabled=busy||!available.has(coin);purchase.textContent=busy?'Preparing…':'Continue · $'+checkoutPrice(plan)+'  →';
 }
 const footer=el('div','pay-minilinks');
 footer.append(button(renewal?'Renewal key':'Redeem key',()=>showKeyEntry(renewal),'pay-link'));
 if(!renewal)footer.append(button('Recover account',showAccountRecovery,'pay-link'));
 if(saved.orders.some(o=>!['redeemed','archived'].includes(o.stage)))footer.append(button('Saved orders',()=>showSavedOrders(renewal),'pay-link'));
 if(renewal)footer.append(button(accessDue?'Lock':'Close',()=>{modalLocked=false;if(accessDue){delete modal.dataset.checkout;checkoutReturn=null;lock();}else closeModal();},'pay-link'),button('Delete account',showDeleteAccount,'pay-link'));
 shell.append(el('div','pay-wordmark','qzu.'),el('h2','','Your access.'),cards,el('h3','','Pay with crypto'),coins,notice,el('p','pay-agreement','By continuing, you accept the payment terms.'),purchase,footer,checkoutLegal());
 showCheckout(renewal?'Renew access':'Access',[shell],renewal);renderChoice();
 api('access/methods',undefined,true).then(data=>{if(!body.contains(shell))return;available=new Set(data.coins.filter(c=>c.available).map(c=>c.coin));if(!available.has(coin)&&available.size)coin=[...available][0];notice.textContent=available.size?'':'Payments temporarily unavailable.';renderChoice();}).catch(()=>{if(body.contains(shell))notice.textContent='Connection unavailable.';});
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
    if(renewal&&/^QZU-[A-F0-9]{48}$/.test(value)){submit.disabled=true;try{await api('access/renew',{key:value});forgetInvoice(true);accessDue=false;modalLocked=false;closeModal();updatePages();await refresh();}catch(e){dialogError(e);submit.disabled=false;}return;}
    if(!renewal&&(/^QZU-ADMIN-[A-F0-9]{48}$/.test(value)||/^QZU-REVIEW-[A-F0-9]{40}$/.test(value)||(playBuild&&/^QZU-[A-F0-9]{48}$/.test(value)))){
      submit.disabled=true;
      try{
        const result=await api('session',{accessKey:value});
        if(result.accessRequired||typeof result.needsSetup!=='boolean')throw Error('Key activation unavailable.');
        input.value='';forgetInvoice(false);delete modal.dataset.checkout;stopCheckout();sessionReady=true;needsSetup=result.needsSetup;showLogin();
      }catch(error){dialogError(error);submit.disabled=false;}
      return;
    }
    if (playBuild || !/^QZ[UO]-[A-F0-9]{48}$/.test(value)) return dialogError(new Error('Enter a valid key.'));
    try{rememberInvoice(value, renewal);showInvoice(value, null, renewal);}catch(e){dialogError(e);}
  });
  showCheckout('Use Access-Key', [input, submit, button('Back', renewal ? showRenewal : showAccess, 'secondary-button')], renewal);
}

function showRenewal(){
 if(playBuild){showRestrictedAccount('Access unavailable','Your current access is no longer active.');return;}
 const saved=savedInvoice(true);if(saved){showInvoice(saved,null,true);return;}showPlanCheckout(true);
}

function showInvoice(secret,initial,renewal){
 if(playBuild){if(renewal)showRenewal();else showAccess();return;}
 if(checkoutOrder(renewal,secret)?.ticketOpen){showPaymentTicket(secret,renewal);return;}
 let record=checkoutOrder(renewal,secret),current=null,busy=false,polling=false,serverOffset=0,lastFingerprint='',nextPoll=0,mutation=0,failures=0;
 const shell=el('div','pay-shell pay-invoice'),heading=el('div'),status=el('div','pay-status'),details=el('div','pay-details'),timer=el('p','pay-timer'),errorLine=el('p','pay-note pay-error'),controls=el('div','pay-controls');
 const back=button('‹ Back',()=>{if(busy)return;try{leaveInvoice(renewal,secret);showPlanCheckout(renewal);}catch(e){dialogError(e);}},'pay-back');
 shell.append(back,heading,status,details,timer,errorLine,controls);
 showCheckout('Secure checkout',[shell],renewal);
 const ticket=checkoutEpoch,active=()=>ticket===checkoutEpoch&&body.contains(shell);
 const copy=(label,value)=>button(label,async()=>{try{await navigator.clipboard.writeText(value);errorLine.textContent='Copied '+label.replace('Copy ','')+'.';haptic();}catch{errorLine.textContent='Select and copy manually.';}},'secondary-button pay-copy');
 function persist(patch){try{record=updateCheckoutOrder(renewal,secret,patch);}catch{errorLine.textContent='Unable to save locally. Copy your private order reference before leaving.';}}
 function setHeading(step,title,description){heading.replaceChildren(checkoutHeading(step,title,description));}
 function showReference(){if(!secret.startsWith('QZO-'))return;const ref=el('details','pay-reference');ref.append(el('summary','','Private order reference'),el('p','access-address',secret),el('p','pay-note','Save this reference securely. It is needed to recover this order.'),copy('Copy reference',secret));details.append(ref);}
 function setBusy(value){if(value)mutation++;busy=value;back.disabled=value;}
 function matching(invoice){return !record?.plan||(invoice.plan===record.plan&&invoice.coin===record.coin&&invoice.usd===record.usd);}
 function renderInvoice(invoice){
  if(!active())return;
  if(!matching(invoice)){current=null;lastFingerprint='';setHeading(1,'Order mismatch','This reference does not match your selected plan.');status.textContent='Payment blocked';details.replaceChildren();controls.replaceChildren();errorLine.textContent='Return to saved orders. Do not pay this invoice.';return;}
  current=invoice;serverOffset=invoice.now-Date.now();
  const approved=invoice.state==='confirmed'&&!invoice.redeemed&&invoice.activationKey;
  persist({stage:invoice.redeemed?'redeemed':'order',plan:invoice.plan,coin:invoice.coin,usd:invoice.usd,legacy:!invoice.coin,serverState:invoice.state,priceLabel:invoice.usd?'$'+invoice.usd:'€'+invoice.euro});
  const fp=JSON.stringify([invoice.state,invoice.redeemed,invoice.activationKey,invoice.ticketReleased,invoice.confirmations,invoice.txid,invoice.amount,Boolean(invoice.qr)]);
  if(fp===lastFingerprint){updateTimer();return;}lastFingerprint=fp;details.replaceChildren();controls.replaceChildren();
  const legacy=!invoice.coin&&secret.startsWith('QZO-'),expired=invoice.state==='expired';
  setHeading(approved||invoice.redeemed?2:1,approved?'Payment verified':invoice.redeemed?'Access activated':legacy?'Previous legacy order':invoice.state==='submitted'?'Verifying payment':expired?'Payment window ended':'Complete your payment',approved?'Your access is ready to activate.':legacy?'Previous EUR order.':'');
  status.className='pay-status '+(approved||invoice.redeemed?'success':invoice.state==='submitted'?'waiting':expired||legacy?'warning':'');
  status.replaceChildren(el('span','pay-status-dot'),el('strong','',invoice.redeemed?'Activated':approved?(invoice.coin?'Confirmed on blockchain':secret.startsWith('QZO-')?'Payment approved':'Access key verified'):invoice.state==='submitted'?'Waiting for confirmations':expired?'Quote expired':invoice.state==='rejected'?'Payment rejected':invoice.state==='pending'?'Awaiting payment':invoice.state));
  const order=el('div','pay-order-summary');order.append(el('div','',checkoutName(invoice.plan)),el('strong','',invoice.usd?'$'+invoice.usd:legacy?'€'+invoice.euro:'Access key'));details.append(order);
  if(invoice.ticketRequired&&!invoice.redeemed&&invoice.state==='confirmed'&&!invoice.activationKey){
   details.append(el('div','pay-success-mark','✓'),el('p','pay-note','Payment verified. Open your ticket for key delivery.'));
   controls.append(button('Open Ticket  →',()=>showPaymentTicket(secret,renewal,record?.ticketStatus==='rejected'||record?.ticketStatus==='completed'),'primary-button pay-primary'));
  }else if(approved){
   const keyBox=el('div','pay-success-box');keyBox.append(el('div','pay-success-mark','✓'),el('h3','','Your activation key'),el('p','access-address',invoice.activationKey),copy('Copy key',invoice.activationKey));details.append(keyBox);
   const activate=button(renewal?'Apply access':'Activate account',async()=>{if(busy)return;setBusy(true);activate.disabled=true;try{
    if(renewal){await api('access/renew',{key:invoice.activationKey});completeInvoice(true,secret);accessDue=false;modalLocked=false;closeModal();updatePages();await refresh();}
    else{const result=await api('session',{accessKey:invoice.activationKey});if(result.accessRequired||typeof result.needsSetup!=='boolean')throw Error('Activation unavailable.');completeInvoice(false,secret);delete modal.dataset.checkout;stopCheckout();sessionReady=true;needsSetup=result.needsSetup;showLogin();}
   }catch(e){if(active())errorLine.textContent=errorMessage(e);}finally{setBusy(false);activate.disabled=false;}},'primary-button pay-primary');controls.append(activate);if(invoice.coin&&record?.ticketStatus==='completed')controls.append(button('Open new ticket',()=>showPaymentTicket(secret,renewal,true),'pay-link'));
  }else if(invoice.redeemed){completeInvoice(renewal,secret);controls.append(button('Continue',()=>{delete modal.dataset.checkout;stopCheckout();modalLocked=false;if(renewal){closeModal();refresh().catch(()=>{});}else getSession();}));}
  else if(['pending','submitted','expired'].includes(invoice.state)&&secret.startsWith('QZO-')){
   if(legacy){details.append(el('p','pay-warning','Do not send a new payment to this old order. If already paid, submit its original transaction ID for review. Create a new USD order from All plans.'));}
   else if(invoice.state==='pending'){
    const amount=el('div','pay-amount');amount.append(el('small','','EXACT AMOUNT TO SEND'),el('strong','',invoice.amount+' '+invoice.coin),copy('Copy amount',invoice.amount));details.append(amount);
    if(invoice.qr){const qr=el('div','pay-qr-frame'),image=el('img');image.src=invoice.qr;image.alt='QR code for the exact payment amount';qr.append(image);details.append(qr);}
    const addr=el('div','pay-address');addr.append(el('small','','RECEIVING ADDRESS · '+invoice.coin),el('p','access-address',invoice.address),copy('Copy address',invoice.address));details.append(addr,el('p','pay-warning','Send only '+invoice.coin+' on its native network. Fees are separate.'));
   }else if(expired){details.append(el('p','pay-warning','Do not send a new payment. If you already paid, submit your transaction ID. Delayed blockchain inclusion may be reviewed for up to 24 hours after the quote expired.'));}
   if(invoice.state==='submitted'){
    const count=invoice.confirmations||0,required=invoice.requiredConfirmations||0,progress=el('div','pay-confirmation');
    progress.append(el('strong','',legacy?'Manual review':count+' / '+required+' confirmations'),el('p','pay-note','You can close the app. Do not pay twice.'));
    if(required){const track=el('div','pay-progress');for(let i=0;i<required;i++)track.append(el('span',i<count?'':'',i<count?'filled':''));progress.append(track);}details.append(progress);
    if(invoice.txid)details.append(el('p','pay-note pay-txid','Transaction: '+invoice.txid));
   }
   if(!legacy){controls.append(button(invoice.state==='pending'?"I've paid  →":'Open Ticket  →',()=>showPaymentTicket(secret,renewal,record?.ticketStatus==='rejected'||record?.ticketStatus==='completed'),'primary-button pay-primary'));showReference();updateTimer();return;}
   const form=el('form','pay-tx-form'),input=el('input','access-key-input');input.placeholder=invoice.coin==='SOL'?'Transaction signature':'Transaction ID (TXID)';input.setAttribute('aria-label',input.placeholder);input.autocomplete='off';input.spellcheck=false;input.maxLength=88;input.value=record?.txDraft||invoice.txid||'';
   const valid=()=>invoice.coin==='SOL'?/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(input.value.trim()):/^[a-f0-9]{64}$/i.test(input.value.trim());
   const submit=el('button','primary-button pay-primary',invoice.state==='submitted'?'Update transaction ID':'Verify payment');submit.type='submit';submit.disabled=!valid()||(invoice.state==='submitted'&&(legacy||invoice.confirmations>0));
   input.disabled=invoice.state==='submitted'&&(legacy||invoice.confirmations>0);
   input.addEventListener('input',()=>{persist({txDraft:input.value});submit.disabled=busy||!valid();});form.append(input,submit);
   form.addEventListener('submit',async e=>{e.preventDefault();if(busy||submit.disabled||!valid())return;setBusy(true);submit.disabled=true;const txid=input.value.trim();persist({txDraft:txid});try{const result=await api('access/submit',{key:secret,txid});if(active()){errorLine.textContent='';renderInvoice(result);}}catch(e){if(active())errorLine.textContent=errorMessage(e);}finally{setBusy(false);submit.disabled=!valid()||(current?.state==='submitted'&&current?.confirmations>0);}});controls.append(form);
  }else details.append(el('p','pay-note','This order cannot be paid. Keep its reference if you need support.'));
  if(!invoice.redeemed)showReference();updateTimer();
 }
 function updateTimer(){if(!current||current.state!=='pending'||!current.coin){timer.textContent='';return;}const remaining=current.expires-(Date.now()+serverOffset);timer.textContent=remaining>0?'Expires in '+clock(remaining):'Quote expired · checking status';if(remaining<=0){for(const item of details.querySelectorAll('.pay-qr-frame,.pay-address,.pay-amount'))item.remove();}}
 async function requestInvoice(){
  if(record?.stage==='intent'){
   const invoice=await api('access/invoice',{plan:record.plan,coin:record.coin,renewal,accepted:true,requestKey:secret,ticketFlow:true},true);
   if(!matching(invoice)||invoice.orderKey!==secret)throw Error('Order identity mismatch. Payment blocked.');return invoice;
  }
  return api('access/status',{key:secret},true);
 }
 async function tick(force=false){
  if(!active()||polling||document.hidden)return;clearTimeout(accessTimer);updateTimer();polling=true;
  try{if(!busy&&(force||Date.now()>=nextPoll)){nextPoll=Date.now()+5000;const observed=mutation;const invoice=await requestInvoice();if(active()&&!busy&&observed===mutation){failures=0;errorLine.textContent='';renderInvoice(invoice);}}}
  catch(e){failures++;nextPoll=Date.now()+Math.min(60000,5000*2**Math.min(failures,4));if(active()){errorLine.textContent=errorMessage(e)+' · Your order is saved. Retry below or reconnect.';if(!current){status.textContent=e.status===404?'Order not found':'Waiting for connection';controls.replaceChildren(button('Retry',()=>tick(true),'primary-button pay-primary'));}}}
  finally{polling=false;if(active()&&!current?.redeemed)accessTimer=setTimeout(()=>tick(),1000);}
 }
 setHeading(1,record?.stage==='intent'?'Preparing your order':'Restoring your order',record?.usd?checkoutName(record.plan)+' · $'+record.usd+' · '+record.coin:'Retrieving the saved invoice.');status.textContent='Connecting securely…';showReference();resumeCheckout=()=>tick(true);
 if(initial)renderInvoice(initial);tick(true);
}

function showPaymentTicket(secret,renewal,fresh=false){
 if(playBuild)return;
 try{updateCheckoutOrder(renewal,secret,{ticketOpen:true,...(fresh?{ticketId:null,ticketFresh:true,ticketDraft:''}:{})},true);}catch(e){dialogError(e);return;}
 const root=el('div','pay-ticket'),head=el('div','pay-ticket-head'),list=el('div','pay-ticket-messages'),composer=el('div','pay-ticket-compose'),notice=el('p','pay-note pay-ticket-notice');
 const backToPayment=()=>{try{updateCheckoutOrder(renewal,secret,{ticketOpen:false});showInvoice(secret,null,renewal);}catch(e){dialogError(e);}};const back=button('‹',backToPayment,'pay-ticket-back');back.setAttribute('aria-label','Back to payment');
 const title=el('div');title.append(el('strong','','Payment Ticket'),el('small','','qzu-Support'));head.append(back,title,el('span','pay-ticket-dot'));
 const field=el('textarea');field.rows=1;field.maxLength=2000;field.placeholder='Message…';field.setAttribute('aria-label','Message');
 field.value=checkoutOrder(renewal,secret)?.ticketDraft||'';
 field.addEventListener('input',()=>{try{updateCheckoutOrder(renewal,secret,{ticketDraft:field.value});}catch{}});
 const file=el('input');file.type='file';file.accept='image/png,image/jpeg,image/webp';file.hidden=true;
 const attach=button('+',()=>file.click(),'pay-ticket-attach');attach.setAttribute('aria-label','Upload payment proof');
 const send=button('➤',()=>sendText(),'pay-ticket-send');send.setAttribute('aria-label','Send message');
 const closedPanel=el('div','pay-ticket-closed');closedPanel.hidden=true;closedPanel.append(el('p','','You can’t write here.'),button('Close Ticket',backToPayment,'primary-button'));composer.append(attach,field,send,file);root.append(head,list,notice,composer,closedPanel);
 showCheckout('Payment Ticket',[root],renewal);
 const epoch=checkoutEpoch,active=()=>epoch===checkoutEpoch&&body.contains(root);
 let current=null,last='',polling=false,busy=false,opened=false,mutation=0,pending=null;let ticketId=checkoutOrder(renewal,secret)?.ticketId||null;let wantFresh=Boolean(checkoutOrder(renewal,secret)?.ticketFresh);
 function setBusy(v){busy=v;if(v)mutation++;attach.disabled=v;send.disabled=v;}
 async function request(path,data={}){return api('access/ticket/'+path,{key:secret,ticketId,...data},true);}
 function render(t){
  if(!active())return;current=t;ticketId=t.id;wantFresh=false;try{updateCheckoutOrder(renewal,secret,{ticketId:t.id,ticketFresh:false,ticketStatus:t.status});}catch{}
  const key=JSON.stringify([t.messages.map(m=>m.id),t.state,t.txid,t.confirmations,t.released,t.closed,t.activationKey,t.redeemed,t.status,t.reason]);if(key===last)return;last=key;
  const pinned=list.scrollHeight-list.scrollTop-list.clientHeight<85,top=list.scrollTop;
  const info=el('div','pay-ticket-system');info.append(el('strong','',checkoutName(t.plan)+' · $'+t.usd+' · '+t.coin),el('small','',t.status==='rejected'?'Ticket rejected':t.status==='completed'?'Ticket completed':t.status==='review'?'Under review':t.state==='confirmed'?'Payment verified':t.txid?'Verification pending':'Send your transaction ID and proof.'));list.replaceChildren(info);if(t.reason)list.append(el('p','pay-ticket-system pay-ticket-rejected',t.reason));
  if(!t.messages.length&&!t.closed)list.append(el('div','pay-ticket-bubble other','Welcome! Please send your transaction ID and a payment screenshot if needed.'));
  for(const m of t.messages){
   const b=el('div','pay-ticket-bubble '+(m.actor==='customer'?'mine':'other'));
   if(m.actor!=='customer')b.append(el('small','pay-ticket-agent','qzu-Support'));
   if(m.text)b.append(el('p','',m.text));
   if(m.hasProof)b.append(button('View payment proof',async e=>{const btn=e.currentTarget;btn.disabled=true;try{const result=await request('proof',{message:m.id});if(active()&&b.isConnected){const img=el('img','pay-ticket-proof');img.src='data:image/png;base64,'+result.data;img.alt='Uploaded payment proof';btn.replaceWith(img);}}catch(e){notice.textContent=errorMessage(e);btn.disabled=false;}},'pay-proof-link'));
   b.append(el('small','pay-ticket-time',new Date(m.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})));list.append(b);
  }
  if(!t.txid&&t.state!=='confirmed'&&!t.closed){const form=el('form','pay-ticket-system'),tx=el('input','access-key-input');tx.placeholder=t.coin==='SOL'?'Transaction signature':'Transaction ID';tx.maxLength=88;tx.autocomplete='off';tx.value=checkoutOrder(renewal,secret)?.txDraft||'';tx.setAttribute('aria-label','Transaction ID');tx.addEventListener('input',()=>{try{updateCheckoutOrder(renewal,secret,{txDraft:tx.value});}catch{}});
   const submit=el('button','primary-button','Submit transaction');form.append(tx,submit);form.addEventListener('submit',async e=>{e.preventDefault();if(busy)return;setBusy(true);submit.disabled=true;try{render(await request('transaction',{txid:tx.value.trim()}));notice.textContent='';}catch(e){notice.textContent=errorMessage(e);}finally{setBusy(false);submit.disabled=false;}});list.append(form);
  }else if(t.txid&&!t.closed&&t.state==='submitted'&&!t.confirmations){list.append(button('Change transaction ID',()=>{if(list.querySelector('.pay-ticket-correct'))return;const form=el('form','pay-ticket-system pay-ticket-correct'),input=el('input','access-key-input');input.value=t.txid;input.maxLength=88;input.setAttribute('aria-label','Correct transaction ID');const submit=el('button','primary-button','Update');form.append(input,submit);form.addEventListener('submit',async e=>{e.preventDefault();if(busy)return;setBusy(true);try{render(await request('transaction',{txid:input.value.trim()}));form.remove();}catch(e){notice.textContent=errorMessage(e);}finally{setBusy(false);}});list.append(form);input.focus();},'pay-link'));}
  if(t.activationKey&&!t.redeemed){
   const b=el('div','pay-ticket-bubble other');b.append(el('small','pay-ticket-agent','qzu-Support'),el('p','','Payment verified. Your key is ready.'),el('p','access-address',t.activationKey),button('Copy key',()=>navigator.clipboard.writeText(t.activationKey).catch(()=>{}),'pay-proof-link'));
   const activate=button(renewal?'Apply access':'Activate account',async()=>{if(busy)return;setBusy(true);activate.disabled=true;try{if(renewal){await api('access/renew',{key:t.activationKey});completeInvoice(true,secret);accessDue=false;modalLocked=false;closeModal();updatePages();await refresh();}else{const result=await api('session',{accessKey:t.activationKey});if(result.accessRequired||typeof result.needsSetup!=='boolean')throw Error('Activation unavailable.');completeInvoice(false,secret);delete modal.dataset.checkout;stopCheckout();sessionReady=true;needsSetup=result.needsSetup;showLogin();}}catch(e){if(active())notice.textContent=errorMessage(e);}finally{setBusy(false);activate.disabled=false;}},'primary-button');b.append(activate);list.append(b);
  }
  composer.hidden=t.closed||t.redeemed;closedPanel.hidden=!t.closed;closedPanel.classList.toggle('rejected',t.status==='rejected');
  if(t.redeemed){completeInvoice(renewal,secret);list.append(button('Continue',()=>{delete modal.dataset.checkout;stopCheckout();modalLocked=false;if(renewal){closeModal();refresh().catch(()=>{});}else getSession();}));}
  requestAnimationFrame(()=>{if(active())list.scrollTop=pinned?list.scrollHeight:top;});
 }
 async function sendText(proof=null){
  if(busy||!active()||!current||current.closed)return;
  const text=field.value.trim();if(!text&&!proof)return;
  const requestId=pending?.text===text&&pending?.proof===proof?pending.requestId:crypto.randomUUID();pending={text,proof,requestId};
  setBusy(true);try{const t=await request('send',{text,proof,requestId});if(active()){if(field.value.trim()===text){field.value='';updateCheckoutOrder(renewal,secret,{ticketDraft:''});}pending=null;notice.textContent='';render(t);list.scrollTop=list.scrollHeight;haptic();}}catch(e){if(active())notice.textContent=errorMessage(e);}finally{setBusy(false);}
 }
 file.addEventListener('change',async()=>{const selected=file.files?.[0];file.value='';if(!selected||busy)return;setBusy(true);try{const cleaned=await QzuMetadata.cleanImage(selected);const bytes=new Uint8Array(await cleaned.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));if(!active())return;setBusy(false);await sendText(btoa(binary));}catch(e){if(active())notice.textContent=errorMessage(e);}finally{setBusy(false);}});
 field.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendText();}});
 async function tick(){if(!active()||polling||document.hidden)return;clearTimeout(accessTimer);polling=true;try{if(!busy){const observed=mutation,t=await request(ticketId?'state':'open',ticketId?{}:{fresh:wantFresh});if(active()&&observed===mutation&&!busy){opened=true;render(t);notice.textContent='';}}}catch(e){if(active())notice.textContent=errorMessage(e)+' · Tap to retry.';}finally{polling=false;if(active()&&!current?.closed)accessTimer=setTimeout(tick,5000);}}
 notice.addEventListener('click',tick);resumeCheckout=tick;tick();
}

$('accessSettings').addEventListener('click', () => {
  const access = state.access;
  if (!access || !['monthly','week','month','year'].includes(access.plan)) {
    info('qzu-Access', 'Lifetime or existing account access.');
    return;
  }
  if(playBuild){info('qzu-Access','Existing access until '+new Date(access.paidUntil).toLocaleDateString()+'.');return;}
  const date = new Date(access.paidUntil).toLocaleDateString();
  show('qzu-Access', [el('p', '', 'Paid through ' + date), el('p', '', 'Renew with any of the four USD access plans or a valid renewal key.'), button('Renew access', showRenewal), button('Close', closeModal, 'secondary-button')]);
});
