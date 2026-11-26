import { newToken } from './accounts.mjs';

export class Unlocks {
  constructor(now = Date.now, ttl = 45_000) {
    this.now = now;
    this.ttl = ttl;
    this.tokens = new Map();
  }
  issue(id, keepUnlocked=false) {
    this.sweep();
    const token = newToken();
    this.tokens.set(token, {
      id,
      idle:keepUnlocked?12*60*60_000:this.ttl,
      expires: this.now() + (keepUnlocked?12*60*60_000:this.ttl)
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
    s.expires = this.now() + s.idle;
    return true;
  }
  setIdle(id,token,keepUnlocked){if(!this.check(id,token))return false;const s=this.tokens.get(token);s.idle=keepUnlocked?12*60*60_000:this.ttl;s.expires=this.now()+s.idle;return true;}
  revoke(id, token) {
    if (this.tokens.get(token)?.id === id) this.tokens.delete(token);
  }
  revokeAll(id) {
    for (const [token, s] of this.tokens) if (s.id === id) this.tokens.delete(token);
  }
  activeAccounts() {
    this.sweep();
    return [...new Set([...this.tokens.values()].map(session => session.id))];
  }

  sweep() {
    for (const [token, s] of this.tokens) if (s.expires <= this.now()) this.tokens.delete(token);
  }
}
