import { newToken } from './accounts.mjs';

export class Unlocks {
  constructor(now = Date.now, ttl = 45_000) {
    this.now = now;
    this.ttl = ttl;
    this.tokens = new Map();
  }
  issue(id) {
    this.sweep();
    const token = newToken();
    this.tokens.set(token, {
      id,
      expires: this.now() + this.ttl
    });
    return token;
  }
  check(id, token) {
    const s = this.tokens.get(token);
    if (!s || s.id !== id) return false;
    if (s.expires <= this.now()) {
      this.tokens.delete(token);
      return false;
    }
    s.expires = this.now() + this.ttl;
    return true;
  }
  revoke(id, token) {
    if (this.tokens.get(token)?.id === id) this.tokens.delete(token);
  }
  revokeAll(id) {
    for (const [token, s] of this.tokens) if (s.id === id) this.tokens.delete(token);
  }
  sweep() {
    for (const [token, s] of this.tokens) if (s.expires <= this.now()) this.tokens.delete(token);
  }
}
