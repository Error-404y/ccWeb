import { randomInt, randomUUID } from 'node:crypto';
import { validRoomKey, validEnvelope } from './encryption.mjs';
import { nickname } from './contacts.mjs';

export const INVITE_TTL = 10 * 60_000;
export const CHAT_TTL = 30 * 60_000;
export const REACTIONS = ['👍', '❤️', '😂', '🔥', '😮', '👎'];
export const MEDIA_LIMIT = 2 * 1024 * 1024;
const SUPPORT = 'qzu-admin-support';
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const fail = (message, status = 400) => Object.assign(new Error(message), {
  status
});

export function randomCode() {
  return Array.from({
    length: 6
  }, () => alphabet[randomInt(alphabet.length)]).join('');
}

export class Chats {
  constructor(now = Date.now, generate = randomCode, blocks = null) {
    this.now = now;
    this.generate = generate;
    this.codes = new Map();
    this.retiredCodes = new Map();
    this.rooms = new Map();
    this.typing = new Map();
    this.requests = new Map();
    this.presence = new Map();
    this.blocks = blocks || new Set();
    this.requireEncryptedDirect = false;
    this.contacts = null;
    this.nextContactSweep = 0;
  }
  sweep() {
    const now = this.now();
    if (this.contacts && now >= this.nextContactSweep) {
      this.nextContactSweep = now + 60000;
      for (const {a,b} of this.contacts.sweep()) for (const [id,room] of this.rooms) if (!room.group && !room.admin && !room.support && room.users.includes(a) && room.users.includes(b)) this.dropRoom(id);
    }
    for (const [id, request] of this.requests) if (request.expires <= now) this.requests.delete(id);
    for (const [user, until] of this.presence) if (until <= now) this.presence.delete(user);
    for (const [code, until] of this.retiredCodes) {
      if (until <= now) this.retiredCodes.delete(code);
    }

    for (const [code, invite] of this.codes) {
      if (invite.expires <= now) {
        this.codes.delete(code);
        this.retiredCodes.set(code, now + INVITE_TTL);
      }
    }
    for (const [id, room] of this.rooms) {
      if (room.expires <= now) { this.dropRoom(id); continue; }
      if (room.extension?.until <= now) delete room.extension;
      for (const message of room.messages) {
        if (message.burnAt && message.burnAt <= now && !message.deleted) {
          message.deleted = true;
          message.text = '';
          message.media = null;
          message.replyTo = null;
          message.reactions.clear();
        }
      }
    }
    for (const [id, entries] of this.typing) {
      for (const [user, until] of entries) if (until <= now) entries.delete(user);
      if (!entries.size) this.typing.delete(id);
    }
  }
  inviteFor(user) {
    this.sweep();
    for (const [code, inv] of this.codes) if (inv.user === user && !inv.group) return {
      code,
      expires: inv.expires
    };
    return null;
  }
  ensureInvite(user) {
    return this.inviteFor(user) || this.newCode(user);
  }

  allocateCode() {
    let code;
    for (let i = 0; i < 100; i++) {
      const candidate = this.generate();
      if (typeof candidate === 'string' && /^[A-Z0-9]{6}$/.test(candidate) && !this.codes.has(candidate) && !this.retiredCodes.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) throw fail('Try again.', 503);
    return code;
  }

  newCode(user) {
    this.sweep();
    const code = this.allocateCode();
    for (const [old, inv] of this.codes) {
      if (inv.user === user && !inv.group) {
        this.codes.delete(old);
        this.retiredCodes.set(old, this.now() + INVITE_TTL);
      }
    }
    const expires = this.now() + INVITE_TTL;
    this.codes.set(code, {
      user,
      expires
    });
    return {
      code,
      expires
    };
  }
  markPresent(user, invisible = false) {
    if (invisible) {
      this.hidePresence(user);
      return;
    }
    this.presence.set(user, this.now() + 6000);
  }

  hidePresence(user) {
    this.presence.delete(user);
    for (const entries of this.typing.values()) entries.delete(user);
  }

  isBlocked(a, b) {
    if (this.blocks instanceof Set) return this.blocks.has(a + ':' + b) || this.blocks.has(b + ':' + a);
    return this.blocks.has(a, b);
  }

  requestConnection(user, code, alias = 'Contact') {
    this.sweep();
    const invite = this.codes.get(code);
    if (!invite) throw fail('Code expired or invalid.', 404);
    if (invite.user === user && !invite.group) throw fail('This is your code.');
    const group = invite.group ? this.rooms.get(invite.group) : null;
    if (invite.group && !group) throw fail('Group unavailable.', 404);
    if (group?.users.includes(user)) return { id: group.id };
    const target = invite.user;
    const ownName = group ? null : nickname(alias);
    if (this.isBlocked(user, target) || group?.users.some(member => this.isBlocked(member, user))) throw fail('Connection unavailable.', 403);
    const existing = [...this.rooms.values()].find(room => !room.group && !room.admin && room.users.includes(user) && room.users.includes(target));
    if (!group && this.contacts?.between(user,target)) return { id: this.connectPair(user,target) };
    if (!group && existing && !this.contacts) return { id: existing.id };
    for (const request of this.requests.values()) {
      if (request.from === user && request.to === target && request.group === (invite.group || null)) return { pending: true };
    }
    if ([...this.requests.values()].filter(request => request.from === user || request.to === target).length >= 30) throw fail('Request limit reached.', 429);
    const id = randomUUID();
    this.requests.set(id, { id, from: user, to: target, group: invite.group || null, alias: ownName, expires: Math.min(this.now() + INVITE_TTL, group?.expires ?? Infinity) });
    return { pending: true };
  }

  connectionRequests(user) {
    this.sweep();
    return [...this.requests.values()].filter(request => request.to === user || request.from === user).map(request => ({
      id: request.id, incoming: request.to === user, group: Boolean(request.group), expires: request.expires
    }));
  }

  respondConnection(user, id, accept, alias = 'Contact') {
    this.sweep();
    const request = this.requests.get(id);
    if (!request || request.to !== user) throw fail('Request unavailable.', 404);
    if (!accept) {
      this.requests.delete(id);
      return { ok: true };
    }
    if (this.isBlocked(user, request.from)) throw fail('Connection unavailable.', 403);
    if (!request.group && this.contacts) nickname(alias);
    const roomId = request.group ? this.joinGroup(request.from, request.group) : this.connectPair(request.from, user);
    if (!request.group && this.contacts) {
      try { this.contacts.add(request.from,user,request.alias,alias); }
      catch(error){this.dropRoom(roomId);throw error;}
    }
    this.requests.delete(id);
    return { id: roomId };
  }

  blockContact(user, roomId, label) {
    const room = this.requireRoom(user, roomId);
    if (room.admin || room.support) throw fail('Admin cannot be blocked here. You can delete the conversation.', 403);
    const other = room.group ? room.users.find(member => room.labels.get(member) === label && member !== user) : room.users.find(member => member !== user);
    if (!other) throw fail('Contact unavailable.', 404);
    if (this.blocks instanceof Set) this.blocks.add(user + ':' + other);
    else this.blocks.add(user, other);
    this.contacts?.removePair(user,other);
    for (const [id, request] of this.requests) {
      if ((request.from === user && request.to === other) || (request.from === other && request.to === user)) this.requests.delete(id);
    }
    for (const [id, shared] of this.rooms) {
      if (shared.users.includes(user) && shared.users.includes(other)) {
        if (shared.group) {
          const leaving = shared.owner === user ? other : user;
          shared.users = shared.users.filter(member => member !== leaving);
          this.typing.get(id)?.delete(leaving);
        } else this.dropRoom(id);
      }
    }
  }

  connect(user, code) {
    this.sweep();
    const inv = this.codes.get(code);
    if (!inv) throw fail('Code expired or invalid.', 404);
    if (inv.group) return this.joinGroup(user, inv.group);
    if (inv.user === user) throw fail('This is your code.');
    return this.connectPair(user, inv.user);
  }

  openContact(user, id) {
    this.sweep();
    if (!this.contacts) throw fail('Contacts unavailable.',404);
    return this.connectPair(user,this.contacts.peer(user,id));
  }
  connectPair(user, other) {
    if (user === other || this.isBlocked(user, other)) throw fail('Connection unavailable.', 403);
    for (const room of this.rooms.values()) {
      if (!room.group && !room.admin && room.users.includes(user) && room.users.includes(other)) return room.id;
    }
    for (const member of [user, other]) {
      if ([...this.rooms.values()].filter(r => !r.admin && r.users.includes(member)).length >= 50) throw fail('Chat limit reached.', 429);
    }
    const id = randomUUID();
    const created = this.now();
    this.rooms.set(id, {
      id,
      users: [user, other],
      encryption: this.requireEncryptedDirect ? { keys: new Map(), confirmed: new Set(), used: new Set() } : null,
      created,
      expires: created + CHAT_TTL,
      messages: []
    });
    return id;
  }
  requireRoom(user, id) {
    this.sweep();
    const room = this.rooms.get(id);
    if (!room || !room.users.includes(user)) throw fail('Chat unavailable.', 404);
    return room;
  }

  publishRoomKey(user, id, deviceId, record) {
    const room = this.requireRoom(user, id);
    if (!room.encryption || !validRoomKey(id, deviceId, record)) throw fail('Invalid encryption key.', 403);
    const key = { key: record.key, identity: record.identity, signature: record.signature };
    const previous = room.encryption.keys.get(user);
    if (previous && JSON.stringify(previous) !== JSON.stringify(key)) throw fail('Encryption keys cannot be replaced. Create a new chat.', 409);
    room.encryption.keys.set(user, key);
    return { ok: true };
  }
  confirmRoomKey(user, id) {
    const room = this.requireRoom(user, id);
    if (!room.encryption || room.encryption.keys.size !== 2) throw fail('Waiting for both devices.', 409);
    room.encryption.confirmed.add(user);
    return { ok: true };
  }
  sendEncrypted(user, id, envelope, kind = 'text') {
    const room = this.requireRoom(user, id);
    const encryption = room.encryption;
    if (!['text', 'image', 'audio'].includes(kind) || !encryption || encryption.confirmed.size !== 2 || !validEnvelope(envelope, kind === 'text' ? 8016 : MEDIA_LIMIT + 64)) throw fail('Verified encrypted content required.', 403);
    if (kind !== 'text') {
      const used = room.messages.reduce((sum, item) => sum + (item.encryptedMedia?.data.length || 0), 0);
      const total = [...this.rooms.values()].reduce((sum, item) => sum + item.messages.reduce((n, message) => n + (message.encryptedMedia?.data.length || 0), 0), 0);
      if (used + envelope.data.length > 16 * 1024 * 1024 || total + envelope.data.length > 64 * 1024 * 1024) throw fail('Attachment capacity reached.', 429);
    }
    const nonce = user + ':' + envelope.iv;
    if (encryption.used.has(nonce)) throw fail('Duplicate encrypted message.', 409);
    if (room.messages.length >= 500) throw fail('Chat is full.', 429);
    encryption.used.add(nonce);
    const cipher = { v: 2, iv: envelope.iv, data: envelope.data };
    const message = { id: randomUUID(), sender: user, text: '', cipher: kind === 'text' ? cipher : null, encryptedMedia: kind !== 'text' ? cipher : null, kind, at: this.now(), reactions: new Map(), recipients: room.users.filter(member => member !== user), delivered: new Set(), read: new Set() };
    if (!room.group && !room.admin && !room.support && this.contacts) this.contacts.touch(user,room.users.find(member=>member!==user));
    room.messages.push(message);
    this.typing.get(id)?.delete(user);
    return message.id;
  }

  getEncryptedMedia(user, id, messageId) {
    const { room, message } = this.getMessage(user, id, messageId);
    if (!room.encryption || room.encryption.confirmed.size !== 2 || message.deleted || !message.encryptedMedia) throw fail('Attachment unavailable.', 404);
    return { cipher: message.encryptedMedia, kind: message.kind };
  }

  extend(user, id, action, requestId = null) {
    const room = this.requireRoom(user, id);
    if (room.admin || room.support || room.group || room.users.length !== 2 || room.extended) throw fail('Extension unavailable.', 403);
    if (action === 'request') {
      if (room.extension) throw fail('An extension is already pending.');
      room.extension = { id: randomUUID(), from: user, until: Math.min(room.expires, this.now() + 5 * 60_000) };
    } else {
      if (!room.extension || room.extension.id !== requestId || room.extension.from === user || !['accept', 'decline'].includes(action)) throw fail('Request unavailable.', 403);
      delete room.extension;
      if (action === 'accept') { room.expires += CHAT_TTL; room.extended = true; }
    }
    return { expires: room.expires };
  }

  openBurn(user, id, messageId, invisible = false) {
    const { room, message } = this.getMessage(user, id, messageId);
    if (room.group || room.admin || room.support || message.deleted || !message.burnSeconds || message.sender === user || !message.recipients.includes(user)) throw fail('Message unavailable.', 404);
    if (!message.burnAt) message.burnAt = Math.min(room.expires, this.now() + message.burnSeconds * 1000);
    message.delivered.add(user);
    if (!invisible) message.read.add(user);
    return { burnAt: message.burnAt };
  }

  createGroup(user) {
    this.sweep();
    if ([...this.rooms.values()].filter(room => !room.admin && room.users.includes(user)).length >= 50) {
      throw fail('Chat limit reached.', 429);
    }

    const id = randomUUID();
    const created = this.now();
    this.rooms.set(id, {
      id, group: true, owner: user, users: [user],
      labels: new Map([[user, 'Member 1']]), nextLabel: 2,
      created, expires: created + CHAT_TTL, messages: []
    });
    return id;
  }

  groupInvite(user, id) {
    const room = this.requireRoom(user, id);
    if (!room.group || room.owner !== user) throw fail('Only the group creator can invite.', 403);

    for (const [code, invite] of this.codes) {
      if (invite.group === id) return { code, expires: invite.expires };
    }

    const code = this.allocateCode();
    const expires = Math.min(this.now() + INVITE_TTL, room.expires);
    this.codes.set(code, { user, group: id, expires });
    return { code, expires };
  }

  joinGroup(user, id) {
    const room = this.rooms.get(id);
    if (!room?.group) throw fail('Group unavailable.', 404);
    if (room.users.includes(user)) return id;
    if (room.users.some(member => this.isBlocked(member, user))) throw fail('Connection unavailable.', 403);
    if (room.users.length >= 12) throw fail('Group is full.', 429);
    if ([...this.rooms.values()].filter(room => !room.admin && room.users.includes(user)).length >= 50) {
      throw fail('Chat limit reached.', 429);
    }

    room.users.push(user);
    room.labels.set(user, 'Member ' + room.nextLabel++);
    return id;
  }

  dropRoom(id) {
    this.rooms.delete(id);
    this.typing.delete(id);
    for (const [key, request] of this.requests) if (request.group === id) this.requests.delete(key);
    for (const [code, invite] of this.codes) {
      if (invite.group === id) {
        this.codes.delete(code);
        this.retiredCodes.set(code, this.now() + INVITE_TTL);
      }
    }
  }

  setTyping(user, id, active, invisible = false) {
    const room = this.requireRoom(user, id);
    if (room.admin) throw fail('This chat is read-only.', 403);
    const entries = this.typing.get(id) || new Map();
    if (active === true && !invisible) entries.set(user, this.now() + 4500);
    else entries.delete(user);
    if (entries.size) this.typing.set(id, entries);
    else this.typing.delete(id);
  }

  acknowledge(user, entries, invisible = false) {
    this.sweep();
    if (!Array.isArray(entries) || entries.length > 51) throw fail('Invalid receipt.');
    for (const entry of entries) {
      const room = this.rooms.get(entry?.id);
      if (!room || room.admin || !room.users.includes(user)) continue;
      const delivered = new Set(Array.isArray(entry.delivered) ? entry.delivered.slice(0, 500) : []);
      const read = new Set(Array.isArray(entry.read) ? entry.read.slice(0, 500) : []);
      for (const message of room.messages) {
        if (message.deleted || !message.recipients?.includes(user)) continue;
        if (delivered.has(message.id) || read.has(message.id)) message.delivered.add(user);
        if (!invisible && read.has(message.id) && (!message.burnSeconds || message.burnAt)) message.read.add(user);
      }
    }
  }

  startSupport(code, text) {
    this.sweep();
    if (typeof code !== 'string' || !/^[A-Z0-9]{6}$/.test(code)) throw fail('Enter a valid connection code.');
    const invite = this.codes.get(code);
    if (!invite || invite.group) throw fail('Connection code unavailable.', 404);
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw fail('Message must contain 1–2000 characters.');
    if ([...this.rooms.values()].filter(room => room.support && room.users.includes(invite.user)).length >= 3) throw fail('Admin chat limit reached.');
    const id = randomUUID(), created = this.now();
    this.rooms.set(id, { id, users: [invite.user, SUPPORT], support: true, created, expires: created + CHAT_TTL, messages: [] });
    this.send(SUPPORT, id, text);
    return id;
  }

  supportRooms() {
    return this.snapshot(SUPPORT).filter(room => room.support);
  }

  supportMessage(id, text) {
    const room = this.requireRoom(SUPPORT, id);
    if (!room.support) throw fail('Admin conversation unavailable.');
    return this.send(SUPPORT, id, text);
  }

  sendAdmin(user, text) {
    this.sweep();

    if (typeof user !== 'string' || typeof text !== 'string' || !text.trim() || text.length > 2000) {
      throw fail('Message must contain 1–2000 characters.');
    }

    let room = [...this.rooms.values()].find(room => room.admin && room.users.includes(user));

    if (!room) {
      const id = randomUUID();
      const created = this.now();
      room = {
        id,
        users: [user],
        admin: true,
        created,
        expires: created + CHAT_TTL,
        messages: []
      };
      this.rooms.set(id, room);
    }

    if (room.messages.length >= 500) {
      room.messages.shift();
    }

    room.messages.push({
      id: randomUUID(),
      sender: null,
      text: text.trim(),
      at: this.now()
    });

    return room.id;
  }

  send(user, id, text, replyTo = null, options = {}) {
    this.sweep();
    const room = this.rooms.get(id);
    if (!room || !room.users.includes(user)) throw fail('Chat unavailable.', 404);
    if (room.admin) throw fail('You cannot write here.', 403);
    if (room.encryption || (this.requireEncryptedDirect && !room.group && !room.support)) throw fail('Update qzu. and use verified encrypted text.', 403);
    const kind = options.kind || 'text';
    const once = options.once === true;
    const burnSeconds = options.burnSeconds ?? 0;
    if (![0,5,10,30].includes(burnSeconds) || (burnSeconds && (once || kind !== 'text' || room.group || room.admin || room.support || replyTo !== null))) throw fail('Timed messages are available for direct text messages only.');
    if (room.support && (kind !== 'text' || once)) throw fail('Admin support accepts regular text only.');
    if (!['text', 'image', 'audio'].includes(kind)) throw fail('Unsupported message.');
    if (once && room.group) throw fail('View-once is available in direct chats only.');
    if (kind === 'text' && (typeof text !== 'string' || !text.trim() || text.length > 2000)) throw fail('Message must contain 1–2000 characters.');
    let media = null;
    if (kind !== 'text') {
      const mime = options.mime;
      const allowed = kind === 'image' ? ['image/jpeg', 'image/png', 'image/webp'] : ['audio/webm', 'audio/mp4', 'audio/ogg'];
      if (!allowed.includes(mime) || typeof options.data !== 'string' || options.data.length > Math.ceil(MEDIA_LIMIT / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(options.data)) throw fail('Invalid attachment.');
      const bytes = Buffer.from(options.data, 'base64');
      if (!bytes.length || bytes.length > MEDIA_LIMIT) throw fail('Attachment too large.');
      const imageValid = mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 : mime === 'image/png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' : mime === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' : true;
      const audioValid = mime === 'audio/webm' ? bytes.subarray(0, 4).toString('hex') === '1a45dfa3' : mime === 'audio/mp4' ? bytes.toString('ascii', 4, 8) === 'ftyp' : mime === 'audio/ogg' ? bytes.toString('ascii', 0, 4) === 'OggS' : true;
      if (!imageValid || !audioValid) throw fail('Unsupported attachment.');
      const used = room.messages.reduce((sum, message) => sum + (message.media?.bytes.length || 0), 0);
      const total = [...this.rooms.values()].reduce((sum, item) => sum + item.messages.reduce((n, message) => n + (message.media?.bytes.length || 0), 0), 0);
      if (used + bytes.length > 12 * 1024 * 1024 || total + bytes.length > 64 * 1024 * 1024) throw fail('Attachment capacity reached.', 429);
      media = { mime, bytes };
    }
    if (room.messages.length >= 500) throw fail('Chat is full.', 429);
    if (replyTo !== null && !room.messages.some(message => message.id === replyTo && !message.burnSeconds)) {
      throw fail('Reply target unavailable.', 400);
    }

    const message = {
      id: randomUUID(),
      sender: user,
      text: kind === 'text' ? text.trim() : '',
      kind, once, media, burnSeconds, burnAt: null, opened: false, reactions: new Map(), edited: false,
      at: this.now(),
      replyTo,
      recipients: room.users.filter(member => member !== user),
      delivered: new Set(),
      read: new Set()
    };
    if (!room.group && !room.admin && !room.support && this.contacts) this.contacts.touch(user,room.users.find(member=>member!==user));
    room.messages.push(message);
    this.typing.get(id)?.delete(user);
    return message.id;
  }
  getMessage(user, id, messageId) {
    const room = this.requireRoom(user, id);
    const message = room.messages.find(item => item.id === messageId);
    if (!message) throw fail('Message unavailable.', 404);
    return { room, message };
  }

  edit(user, id, messageId, text) {
    const { room, message } = this.getMessage(user, id, messageId);
    if (room.encryption || room.admin || message.deleted || message.sender !== user || message.once || message.burnSeconds || message.kind !== 'text' || this.now() - message.at > 60_000) throw fail('Message cannot be edited.', 403);
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw fail('Invalid message.');
    message.text = text.trim();
    message.edited = true;
  }

  react(user, id, messageId, emoji) {
    const { room, message } = this.getMessage(user, id, messageId);
    if (room.encryption || room.admin || message.deleted || message.once || message.burnSeconds || !REACTIONS.includes(emoji)) throw fail('Reaction unavailable.');
    if (message.reactions.get(user) === emoji) message.reactions.delete(user);
    else message.reactions.set(user, emoji);
  }

  openOnce(user, id, messageId, invisible = false) {
    const { message } = this.getMessage(user, id, messageId);
    if (message.deleted || !message.once || message.opened || message.sender === user || !message.recipients.includes(user)) throw fail('Message unavailable.', 404);
    const result = { kind: message.kind, text: message.text, media: message.media ? { mime: message.media.mime, data: message.media.bytes.toString('base64') } : null };
    message.opened = true;
    message.text = '';
    message.media = null;
    message.delivered.add(user);
    if (!invisible) message.read.add(user);
    return result;
  }

  unsend(user, id, messageId) {
    const { room, message } = this.getMessage(user, id, messageId);
    if (room.admin || message.sender !== user) throw fail('Only the sender can unsend this message.', 403);
    if (message.deleted) return;
    message.deleted = true;
    message.text = '';
    message.cipher = null;
    message.encryptedMedia = null;
    message.media = null;
    message.replyTo = null;
    message.reactions?.clear();
    message.delivered?.clear();
    message.read?.clear();
    message.edited = false;
  }

  getMedia(user, id, messageId) {
    const { message } = this.getMessage(user, id, messageId);
    if (message.deleted || !message.media || message.once) throw fail('Attachment unavailable.', 404);
    return message.media;
  }

  remove(user, id) {
    this.sweep();
    const room = this.rooms.get(id);
    if (!room || !room.users.includes(user)) throw fail('Chat unavailable.', 404);
    if (room.admin) throw fail('This chat is read-only.', 403);
    if (room.group && room.owner !== user) {
      room.users = room.users.filter(member => member !== user);
      this.typing.get(id)?.delete(user);
      return;
    }
    this.dropRoom(id);
  }
  erase(user) {
    this.contacts?.removeAll(user);
    for (const [id, request] of this.requests) if (request.from === user || request.to === user) this.requests.delete(id);
    for (const [id, room] of this.rooms) if (room.users.includes(user)) this.dropRoom(id);
    for (const [code, inv] of this.codes) {
      if (inv.user === user) {
        this.codes.delete(code);
        this.retiredCodes.set(code, this.now() + INVITE_TTL);
      }
    }
  }
  snapshot(user) {
    this.sweep();
    const rooms = [...this.rooms.values()].filter(r => r.users.includes(user)).sort((a, b) => Number(Boolean(b.admin || b.support)) - Number(Boolean(a.admin || a.support)) || (b.messages.at(-1)?.at ?? b.created) - (a.messages.at(-1)?.at ?? a.created));
    return rooms.map(r => ({
      id: r.id,
      admin: Boolean(r.admin || r.support),
      readOnly: Boolean(r.admin),
      support: Boolean(r.support),
      group: Boolean(r.group),
      contact: !r.group && !r.admin && !r.support && this.contacts ? this.contacts.between(user,r.users.find(member=>member!==user)) : null,
      encryption: r.encryption ? {
        own: r.encryption.keys.get(user) || null,
        peer: r.encryption.keys.get(r.users.find(member => member !== user)) || null,
        confirmed: r.encryption.confirmed.has(user),
        peerConfirmed: r.encryption.confirmed.has(r.users.find(member => member !== user))
      } : null,
      canInvite: Boolean(r.group && r.owner === user),
      memberCount: r.users.length,
      activeCount: r.users.filter(member => member !== user && (this.presence.get(member) || 0) > this.now()).length,
      members: r.group ? r.users.filter(member => member !== user).map(member => r.labels.get(member)) : [],
      typing: [...(this.typing.get(r.id)?.keys() || [])].filter(member => member !== user).map(member => r.group ? r.labels.get(member) : 'Contact'),
      created: r.created,
      expires: r.expires,
      extended: Boolean(r.extended),
      extension: r.extension ? { id: r.extension.id, incoming: r.extension.from !== user, until: r.extension.until } : null,
      messages: r.messages.map(m => {
        const target = r.messages.find(message => message.id === m.replyTo);
        const label = member => member === user ? 'You' : r.admin || member === SUPPORT ? 'Admin' : r.group ? r.labels.get(member) : this.contacts?.between(user,member)?.nickname || 'Contact';
        const recipients = m.recipients || [];
        const status = m.sender === user && recipients.length && recipients.every(member => m.read?.has(member)) ? 'read'
          : m.sender === user && recipients.length && recipients.every(member => m.delivered?.has(member)) ? 'delivered' : 'sent';
        return {
          id: m.id,
          mine: m.sender === user,
          sender: label(m.sender),
          text: m.once || m.deleted || (m.burnSeconds && !m.burnAt && m.sender !== user) ? '' : m.cipher ? 'Encrypted message' : m.text,
          cipher: !m.deleted && m.cipher ? m.cipher : null,
          encryptedMedia: Boolean(!m.deleted && m.encryptedMedia),
          burnSeconds: m.burnSeconds || 0, burnAt: m.burnAt || null,
          deleted: Boolean(m.deleted),
          kind: m.kind || 'text', once: Boolean(m.once), opened: Boolean(m.opened), edited: Boolean(m.edited),
          reactions: REACTIONS.map(emoji => ({ emoji, count: [...(m.reactions?.values() || [])].filter(value => value === emoji).length, mine: m.reactions?.get(user) === emoji })).filter(item => item.count),
          at: m.at,
          status,
          reply: target ? { id: target.id, sender: label(target.sender), text: target.deleted ? 'This message was deleted.' : target.burnSeconds ? 'Timed message' : target.once ? 'View-once message' : target.kind === 'image' ? 'Photo' : target.kind === 'audio' ? 'Voice message' : target.text.slice(0, 160) } : null
        };
      })
    }));
  }
}
