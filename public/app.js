'use strict';
const $ = id => document.getElementById(id);
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
let page = location.pathname === '/settings' ? 'settings': location.pathname === '/connect' ? 'connect': 'chat';
const mobile = matchMedia('(max-width:700px)');
let state = {
  rooms: [],
  invite: null,
  pinState: null,
  resetPending: false,
  resetDelivered: false
};

let offset = 0;
let selected = null;
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
  return path === '/settings' ? 'settings': path === '/connect' ? 'connect': 'chat';
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
  if (url.origin !== location.origin || !['/chat', '/connect', '/settings', '/'].includes(url.pathname)) return;
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
const nameFor = room => room.admin ? 'Admin' : (room.group ? 'Group ' : 'Chat ') + room.id.slice(0, 4).toUpperCase();

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
  closeModal();
});
modal.addEventListener('close', () => {
  if (!modal.open) {
    clearMedia();
    stopCamera();
    body.replaceChildren();
    modalLocked = false;
  }
});

function show(title, content, locked = false) {
  stopCheckout();
  delete modal.dataset.checkout;
  clearMedia();
  stopCamera();
  modalLocked = locked;
  $('modalClose').hidden = locked;
  $('modalTitle').textContent = title;
  body.replaceChildren(...content);
  if (!modal.open) modal.showModal();
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
    body.append(p);
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
    res = await fetch('/api/' + path, {
      method: write ? 'POST': 'GET',
      headers,
      body: write ? JSON.stringify(data): undefined,
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(8000)
    });
  }
  catch {
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
  fetch('/api/login/lock', {
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
  const wrap = el('label', '', label), input = el('input', 'pin-input');
  input.type = 'password';
  input.inputMode = 'numeric';
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

function pinDialog(title, fields, submitLabel, onSubmit, {
  locked = false,
  note = '',
  auth = false
} = {}) {
  const form = el('form', 'auth-form'), items = fields.map(label => pinField(label));
  if (note) form.append(el('p', '', note));
  for (const item of items) form.append(item.wrap);
  const submit = el('button', 'primary-button', submitLabel);
  submit.type = 'submit';
  form.append(submit);
  if (!locked) form.append(button('Cancel', closeModal, 'secondary-button'));
  const epoch = authEpoch;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (submit.disabled || epoch !== authEpoch) return;
    const values = items.map(item => item.input.value);
    if (values.some(v => !/^\d{6}$/.test(v))) return;
    submit.disabled = true;
    try {
      await onSubmit(values);
    } catch (err) {
      if (epoch === authEpoch && body.contains(form)) {
        dialogError(err);
        submit.disabled = false;
      }
    }
    finally {
      values.fill('');
    }
  });
  const brand = el('div', 'auth-brand');
  brand.append(svg('logo', 'wordmark'));
  show(title, auth ? [brand, form]: [form], locked);
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
    form.append(divider, emergency);
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
  form.append(wrap, warning, confirmation, actions);

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
      lock(false);

      show('emg.exe', [
        el('p', '', 'Your active chats have been deleted.'),
        button('OK', showLogin)
      ], true);
    } catch (error) {
      if (epoch !== authEpoch || !body.contains(form)) return;
      input.value = '';
      check.checked = false;
      cancel.disabled = false;
      updateButton();
      dialogError(error);
      input.focus();
    }
  });

  show('emg.exe', [form], true);
  input.focus();
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
  sendingMessage = false;
  invisibleSaving = false;
  $('invisibleMode').checked = false;
  resetOnce();
  clearMedia();
  $('connectionRequests').hidden = true;
  $('presenceLabel').hidden = true;
  $('presenceLabel').textContent = '';
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
  const h = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--app-height', Math.round(h) + 'px');
}
setViewport();
window.addEventListener('resize', setViewport);
window.visualViewport?.addEventListener('resize', setViewport);

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

function renderChat() {
  if (page !== 'chat' || !unlockToken) return;
  const now = serverNow(), rooms = state.rooms.filter(r => r.expires > now);
  if (!rooms.some(r => r.id === selected)) {
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
  renderRequests();
  $('chatPage').classList.toggle('thread-open', Boolean(current && mobileOpen));
  $('chatCount').textContent = rooms.length ? String(rooms.length): '';
  const key = JSON.stringify([privacyMode, rooms.map(r => [r.id, r.memberCount, r.activeCount, r.messages.at(-1)?.id, r.messages.at(-1)?.text, r.messages.at(-1)?.opened, r.messages.at(-1)?.deleted, r.id === selected])]);
  if (key !== contactKey) {
    contactKey = key;
    const list = $('contacts'), top = list.scrollTop;
    list.replaceChildren();
    if (!rooms.length) {
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

      if (r.admin) {
        const badge = svg('adminBadge', 'admin-badge');
        badge.setAttribute('aria-label', 'Verified Admin');
        badge.removeAttribute('aria-hidden');
        name.append(badge);
      }

      const preview = last ? (privacyMode ? 'Message hidden' : previewText(last)) : r.group ? r.memberCount + ' members' : 'New chat';
      if (!r.admin && r.activeCount) name.append(el('span', 'presence-dot'));
      content.append(name, el('span', 'contact-preview', preview));
      b.append(svg(r.admin ? 'adminAvatar' : r.group ? 'groupAvatar' : 'avatar', 'avatar'), content, el('span', 'contact-time', fmtTime(last?.at || r.created)));
      b.addEventListener('click', () => selectRoom(r.id));
      list.append(b);
    }
    list.scrollTop = top;
  }
  $('emptyThread').hidden = Boolean(current);
  for (const id of ['threadHeader', 'messages']) $(id).hidden = !current;

  const isAdmin = Boolean(current?.admin);
  $('composer').hidden = !current || isAdmin;
  $('adminComposer').hidden = !isAdmin;
  $('deleteChat').hidden = isAdmin;
  $('threadBadge').hidden = !isAdmin;
  $('threadAvatar').setAttribute('href', isAdmin ? '#adminAvatar' : current?.group ? '#groupAvatar' : '#avatar');
  $('groupInvite').hidden = !current?.canInvite;
  $('chatOptions').hidden = !current || isAdmin;
  $('presenceLabel').hidden = !current || isAdmin;
  $('presenceLabel').textContent = current?.group ? (current.activeCount || 0) + ' active' : current?.activeCount ? 'Active' : 'Offline';
  $('presenceLabel').classList.toggle('online', Boolean(current?.activeCount));
  $('memberCount').hidden = !current?.group;
  $('memberCount').textContent = current?.group ? current.memberCount + ' members' : '';
  $('expiryProgress').hidden = !current;
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
  $('chatTimer').textContent = clock(current.expires - now);
  updateExpiry(current);
  const container = $('messages');
  const ids = current.messages.map(message => JSON.stringify([message.id, message.text, message.edited, message.opened, message.deleted, message.reactions, message.reply]));
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

function renderMessage(room, message) {
  const row = el('div', 'message-row' + (message.mine ? ' mine' : ''));
  row.id = 'message-' + message.id;
  const bubble = el('div', 'bubble');
  const content = el('div', 'message-content');
  const masked = privacyMode && !revealedMessages.has(message.id) && !message.once && !message.deleted;

  if (room.group && !message.mine) content.append(el('strong', 'message-author', message.sender));

  if (message.reply) {
    const quote = el('div', 'message-quote');
    quote.append(el('strong', '', message.reply.sender), el('span', '', message.reply.text));
    content.append(quote);
  }

  if (message.deleted) {
    content.append(el('div', 'deleted-message', 'This message was deleted.'));
  } else if (message.once) {
    const label = message.opened ? 'Opened' : message.mine ? 'View-once message' : 'Open once';
    const open = button(label, () => openOnceMessage(room, message), 'media-message');
    open.disabled = message.mine || message.opened;
    content.append(open);
  } else if (message.kind === 'image' || message.kind === 'audio') {
    const open = button(message.kind === 'image' ? 'View photo' : 'Play voice message', () => openMedia(room, message), 'media-message');
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

  if (masked) {
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

  if (!room.admin && !message.once && !message.deleted) {
    const reply = button('', () => {
      replyTarget = { roomId: room.id, id: message.id, sender: message.sender, text: previewText(message) };
      renderReply();
      $('message').focus();
    }, 'reply-action');
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

  if (!room.admin && message.once && message.mine && !message.deleted) {
    const more = button('⋯', () => messageActions(room, message), 'reply-action message-more');
    more.setAttribute('aria-label', 'Message actions');
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
  if (!unlockToken || state.invisible || page !== 'chat' || !room || room.admin || !$('message').value.trim()) {
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
    if (room.admin) continue;
    const delivered = [];
    const read = [];
    for (const message of room.messages) {
      if (message.mine || message.deleted) continue;
      if (!acknowledgedDelivery.has(message.id)) delivered.push(message.id);
      const node = document.getElementById('message-' + message.id);
      const view = $('messages').getBoundingClientRect();
      const rect = node?.getBoundingClientRect();
      const visible = rect && rect.bottom > view.top && rect.top < view.bottom;
      if (!state.invisible && room.id === selected && canReadCurrent() && visible && (!privacyMode || revealedMessages.has(message.id)) && !message.once && !acknowledgedRead.has(message.id)) read.push(message.id);
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
  $('resetPin').disabled = !state.pinState || Boolean(state.resetDelivered) || ['new', 'approved'].includes(state.pinState);
  $('resetLabel').textContent = state.resetDelivered ? 'Reset pending': 'Request Reset';
  $('emergency').disabled = !state.pinState;
  $('changeLogin').disabled = !unlockToken;
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
  const room = state.rooms.find(r => r.id === selected);
  if (room) {
    $('chatTimer').textContent = clock(room.expires - now);
    updateExpiry(room);
  }
  if (page === 'connect' && state.invite) $('inviteTimer').textContent = clock(state.invite.expires - now);
}

function clearVolatile() {
  stopTyping();
  clearReply();
  revealedMessages.clear();
  acknowledgedDelivery.clear();
  acknowledgedRead.clear();
  sequence++;
  state.rooms = [];
  state.invite = null;
  selected = null;
  mobileOpen = false;
  $('message').value = '';
  $('send').disabled = true;
  render();
}

async function refresh() {
  const ticket = ++sequence;
  const data = await api('state');
  if (ticket !== sequence || document.hidden || !unlockToken) return;
  online = true;
  offset = data.now - Date.now();
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
function updateSendButton() {
  const room = state.rooms.find(room => room.id === selected);
  $('send').disabled = !unlockToken || sendingMessage || !room || room.admin ||
    room.expires <= serverNow() || !$('message').value.trim();
}

async function sendMessage() {
  const id = selected;
  const text = $('message').value.trim();
  const room = state.rooms.find(room => room.id === id);

  if (!unlockToken || sendingMessage || !room || room.admin || room.expires <= serverNow() || !text) {
    updateSendButton();
    return;
  }

  const epoch = authEpoch;
  sendingMessage = true;
  updateSendButton();

  try {
    await api('message', { id, text, once: viewOnce, replyTo: replyTarget?.roomId === id ? replyTarget.id : null });

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
  if (!room || room.admin) return;
  const leave = room.group && !room.canInvite;
  const confirm = button(leave ? 'Leave group' : room.group ? 'Delete for everyone' : 'Delete for both', async() => {
    confirm.disabled = true;
    try {
      await api('chat/delete', {
        id
      });
      closeModal();
      clearVolatile();
      await refresh();
    } catch (e) {
      confirm.disabled = false;
      modalError(e);
    }
  }, 'primary-button danger-button');
  show(leave ? 'Leave group?' : 'Delete chat?', [el('p', '', leave ? 'You will leave this group. Other members keep the conversation.' : room.group ? 'This removes the conversation for all group members.' : 'This removes the conversation for both participants.'), confirm, button('Cancel', closeModal, 'secondary-button')]);
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
  if (selected) showGroupInvite(selected);
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
$('connectForm').addEventListener('submit', async e => {
  e.preventDefault();
  const code = $('enterCode').value.trim();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    info('Connect', 'Enter a 6-character code.');
    return;
  }
  const submit = $('connectForm').querySelector('button');
  submit.disabled = true;
  try {
    const result = await api('connect', {
      code
    });
    await refresh();
    $('enterCode').value = '';
    navigate('/chat');
    if (result.id) selectRoom(result.id);
    else info('Request sent', 'The recipient must accept your connection.');
  } catch (err) {
    showError(err);
  } finally {
    submit.disabled = false;
  }
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
    if (url.origin !== location.origin || url.pathname !== '/connect') return null;
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
  pin.inputMode = 'numeric';
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
      modalError(e);
      execute.disabled = true;
      pin.focus();
    }
  }, 'primary-button danger-button');
  execute.disabled = true;
  pin.addEventListener('input', () => {
    pin.value = pin.value.replace(/\D/g, '').slice(0, 6);
    execute.disabled = pin.value.length !== 6;
  });
  show('emg.exe', [el('p', '', 'Delete all your conversations for both sides. This PIN can only be used once.'), pin, execute, button('Cancel', closeModal, 'secondary-button')]);
  pin.focus();
});
if (page === 'connect' && location.hash) {
  const code = location.hash.slice(1).toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(code)) pendingInvite = code;
  history.replaceState(null, '', location.pathname);
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
  if (message.once) return message.opened ? 'Opened' : 'View-once message';
  if (message.kind === 'image') return 'Photo';
  if (message.kind === 'audio') return 'Voice message';
  return message.text;
}

function resetOnce() {
  viewOnce = false;
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
          try {
            const result = await api('connection/respond', { id: request.id, accept });
            closeModal();
            await refresh();
            if (result.id) selectRoom(result.id);
          } catch (error) { modalError(error); }
        }, accept ? 'primary-button' : 'secondary-button'));
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
  const controls = message.once ? [] : [picker];

  if (!message.once && message.mine && message.kind === 'text' && serverNow() - message.at <= 60_000) {
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
  if (message.mine && !message.deleted) controls.push(button('Unsend', () => confirmUnsend(room, message), 'primary-button danger-button'));
  controls.push(button('Close', closeModal, 'secondary-button'));
  show('Message', controls);
  mediaRoom = room.id;
  mediaMessage = message.id;
}

$('chatOptions').addEventListener('click', () => {
  const room = state.rooms.find(room => room.id === selected);
  if (!room || room.admin) return;
  const controls = [];
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
  if (!accentChoices.includes(value)) value = 'green';
  document.documentElement.dataset.accent = value;
  try { localStorage.setItem('qzu-accent', value); } catch {}
}

try { applyAccent(localStorage.getItem('qzu-accent')); } catch { applyAccent('green'); }
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
    const response = await fetch('/api/media/' + encodeURIComponent(room.id) + '/' + encodeURIComponent(message.id), {
      headers: { 'X-QZU-Unlock': unlockToken }, cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(8000)
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
  const items = [button('Photo', () => choosePhoto(room), 'secondary-button'), button('Voice message', () => recordVoice(room), 'secondary-button')];
  if (!room.group) items.unshift(button(viewOnce ? 'Disable view once' : 'Enable view once', () => {
    viewOnce = !viewOnce;
    $('attachmentMenu').classList.toggle('once-active', viewOnce);
    $('message').placeholder = viewOnce ? 'View-once message' : 'Message';
    closeModal();
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
  if (blob.size > 2 * 1024 * 1024 || !blob.size) throw new Error('Attachment must be under 2 MB.');
  const epoch = authEpoch;
  const data = await blobData(blob);
  if (epoch !== authEpoch || !unlockToken || selected !== room.id || document.hidden) throw new Error('Chat unavailable.');
  await api('message', { id: room.id, kind, mime: blob.type.split(';')[0], data, once });
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
  show('Send photo', [input, el('p', '', 'JPG, PNG or WebP · Up to 2 MB'), send, button('Cancel', closeModal, 'secondary-button')]);
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
  const confirm = button('Unsend', async () => {
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
  show('Unsend message?', [el('p', '', 'Remove this message for everyone in the chat. Saved copies cannot be removed.'), confirm, button('Cancel', closeModal, 'secondary-button')]);
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
  show('Security center', [list, button('Lock now', () => lock(), 'secondary-button'), button('Close', closeModal)]);
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
  controls.push(button('Enter key or reference', () => showKeyEntry(false), 'secondary-button'));
  showCheckout('qzu-Access', controls);
}

function showKeyEntry(renewal) {
  const input = el('input', 'access-key-input');
  input.placeholder = 'QZU-… or QZO-…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 52;
  const submit = button('Continue', () => {
    const value = input.value.trim().toUpperCase();
    if (!/^QZ[UO]-[A-F0-9]{48}$/.test(value)) return dialogError(new Error('Enter a valid access key or order reference.'));
    rememberInvoice(value, renewal);
    showInvoice(value, null, renewal);
  });
  showCheckout('Access key', [input, submit, button('Back', renewal ? showRenewal : showAccess, 'secondary-button')], renewal);
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
        const qr = button('', () => {
          const revealed = qr.classList.toggle('qr-revealed');
          qr.setAttribute('aria-expanded', String(revealed));
          qr.setAttribute('aria-label', revealed ? 'Hide payment QR' : 'Reveal payment QR');
        }, 'payment-qr-wrap');
        qr.setAttribute('aria-expanded', 'false');
        qr.setAttribute('aria-label', 'Reveal payment QR');
        const overlay = el('span', 'payment-qr-lock');
        overlay.append(svg('lock'), el('span', '', 'Tap to reveal'));
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
