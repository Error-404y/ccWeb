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
    this.rooms = new Map();
  }
  sweep() {
    const now = this.now();
    for (const [code, invite] of this.codes) if (invite.expires <= now) this.codes.delete(code);
    for (const [id, room] of this.rooms) if (room.expires <= now) this.rooms.delete(id);
  }
  inviteFor(user) {
    this.sweep();
    for (const [code, inv] of this.codes) if (inv.user === user) return {
      code,
      expires: inv.expires
    };
    return null;
  }
  newCode(user) {
    this.sweep();
    // Reserve before returning; synchronous single-process operation is atomic.
    let code;
    for (let i = 0; i < 100; i++) {
      const candidate = this.generate();
      if (!this.codes.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) throw fail('Try again.', 503);
    for (const [old, inv] of this.codes) if (inv.user === user) this.codes.delete(old);
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
    if (inv.user === user) throw fail('This is your code.');
    for (const room of this.rooms.values()) {
      if (room.users.includes(user) && room.users.includes(inv.user)) return room.id;
    }
    for (const member of [user, inv.user]) {
      if ([...this.rooms.values()].filter(r => r.users.includes(member)).length >= 50) throw fail('Chat limit reached.', 429);
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
  send(user, id, text) {
    this.sweep();
    const room = this.rooms.get(id);
    if (!room || !room.users.includes(user)) throw fail('Chat unavailable.', 404);
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw fail('Message must contain 1–2000 characters.');
    if (room.messages.length >= 500) throw fail('Chat is full.', 429);
    room.messages.push({
      id: randomUUID(),
      sender: user,
      text: text.trim(),
      at: this.now()
    });
  }
  remove(user, id) {
    this.sweep();
    const room = this.rooms.get(id);
    if (!room || !room.users.includes(user)) throw fail('Chat unavailable.', 404);
    this.rooms.delete(id);
  }
  erase(user) {
    for (const [id, room] of this.rooms) if (room.users.includes(user)) this.rooms.delete(id);
    for (const [code, inv] of this.codes) if (inv.user === user) this.codes.delete(code);
  }
  snapshot(user) {
    this.sweep();
    const rooms = [...this.rooms.values()].filter(r => r.users.includes(user)).sort((a, b) => (b.messages.at(-1)?.at ?? b.created) - (a.messages.at(-1)?.at ?? a.created));
    return rooms.map(r => ({
      id: r.id,
      created: r.created,
      expires: r.expires,
      messages: r.messages.map(m => ({
        id: m.id,
        mine: m.sender === user,
        text: m.text,
        at: m.at
      }))
    }));
  }
}
