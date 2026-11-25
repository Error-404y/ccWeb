import { randomInt, randomUUID } from 'node:crypto';

export const INVITE_TTL = 10 * 60_000;
export const CHAT_TTL = 30 * 60_000;
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
  constructor(now = Date.now, generate = randomCode) {
    this.now = now;
    this.generate = generate;
    this.codes = new Map();
    this.retiredCodes = new Map();
    this.rooms = new Map();
    this.typing = new Map();
  }
  sweep() {
    const now = this.now();
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
      if (room.expires <= now) this.dropRoom(id);
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
  connect(user, code) {
    this.sweep();
    const inv = this.codes.get(code);
    if (!inv) throw fail('Code expired or invalid.', 404);
    if (inv.group) return this.joinGroup(user, inv.group);
    if (inv.user === user) throw fail('This is your code.');
    for (const room of this.rooms.values()) {
      if (!room.group && !room.admin && room.users.includes(user) && room.users.includes(inv.user)) return room.id;
    }
    for (const member of [user, inv.user]) {
      if ([...this.rooms.values()].filter(r => !r.admin && r.users.includes(member)).length >= 50) throw fail('Chat limit reached.', 429);
    }
    const id = randomUUID();
    const created = this.now();
    this.rooms.set(id, {
      id,
      users: [user, inv.user],
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
    for (const [code, invite] of this.codes) {
      if (invite.group === id) {
        this.codes.delete(code);
        this.retiredCodes.set(code, this.now() + INVITE_TTL);
      }
    }
  }

  setTyping(user, id, active) {
    const room = this.requireRoom(user, id);
    if (room.admin) throw fail('This chat is read-only.', 403);
    const entries = this.typing.get(id) || new Map();
    if (active === true) entries.set(user, this.now() + 4500);
    else entries.delete(user);
    if (entries.size) this.typing.set(id, entries);
    else this.typing.delete(id);
  }

  acknowledge(user, entries) {
    this.sweep();
    if (!Array.isArray(entries) || entries.length > 51) throw fail('Invalid receipt.');
    for (const entry of entries) {
      const room = this.rooms.get(entry?.id);
      if (!room || room.admin || !room.users.includes(user)) continue;
      const delivered = new Set(Array.isArray(entry.delivered) ? entry.delivered.slice(0, 500) : []);
      const read = new Set(Array.isArray(entry.read) ? entry.read.slice(0, 500) : []);
      for (const message of room.messages) {
        if (!message.recipients?.includes(user)) continue;
        if (delivered.has(message.id) || read.has(message.id)) message.delivered.add(user);
        if (read.has(message.id)) message.read.add(user);
      }
    }
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

  send(user, id, text, replyTo = null) {
    this.sweep();
    const room = this.rooms.get(id);
    if (!room || !room.users.includes(user)) throw fail('Chat unavailable.', 404);
    if (room.admin) throw fail('You cannot write here.', 403);
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw fail('Message must contain 1–2000 characters.');
    if (room.messages.length >= 500) throw fail('Chat is full.', 429);
    if (replyTo !== null && !room.messages.some(message => message.id === replyTo)) {
      throw fail('Reply target unavailable.', 400);
    }

    const message = {
      id: randomUUID(),
      sender: user,
      text: text.trim(),
      at: this.now(),
      replyTo,
      recipients: room.users.filter(member => member !== user),
      delivered: new Set(),
      read: new Set()
    };
    room.messages.push(message);
    this.typing.get(id)?.delete(user);
    return message.id;
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
    const rooms = [...this.rooms.values()].filter(r => r.users.includes(user)).sort((a, b) => Number(Boolean(b.admin)) - Number(Boolean(a.admin)) || (b.messages.at(-1)?.at ?? b.created) - (a.messages.at(-1)?.at ?? a.created));
    return rooms.map(r => ({
      id: r.id,
      admin: Boolean(r.admin),
      group: Boolean(r.group),
      canInvite: Boolean(r.group && r.owner === user),
      memberCount: r.users.length,
      typing: [...(this.typing.get(r.id)?.keys() || [])].filter(member => member !== user).map(member => r.group ? r.labels.get(member) : 'Contact'),
      created: r.created,
      expires: r.expires,
      messages: r.messages.map(m => {
        const target = r.messages.find(message => message.id === m.replyTo);
        const label = member => member === user ? 'You' : r.admin ? 'Admin' : r.group ? r.labels.get(member) : 'Contact';
        const recipients = m.recipients || [];
        const status = m.sender === user && recipients.length && recipients.every(member => m.read?.has(member)) ? 'read'
          : m.sender === user && recipients.length && recipients.every(member => m.delivered?.has(member)) ? 'delivered' : 'sent';
        return {
          id: m.id,
          mine: m.sender === user,
          sender: label(m.sender),
          text: m.text,
          at: m.at,
          status,
          reply: target ? { id: target.id, sender: label(target.sender), text: target.text.slice(0, 160) } : null
        };
      })
    }));
  }
}
