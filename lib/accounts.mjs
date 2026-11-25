import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
const pinHash = (pin, salt) => scryptSync(pin, salt, 32).toString('hex');

export function openAccounts(path = process.env.QZU_DB || 'data/accounts.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), {
    recursive: true,
    mode: 0o700
  });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts(
      id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE,
      pin_hash TEXT, pin_salt TEXT, pin_state TEXT NOT NULL DEFAULT 'new',
      request TEXT UNIQUE, failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
    )`);
  const columns = new Set(db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name));
  for (const [name, definition] of Object.entries({
    login_hash: 'TEXT',
    login_salt: 'TEXT',
    login_failures: 'INTEGER NOT NULL DEFAULT 0',
    login_locked_until: 'INTEGER NOT NULL DEFAULT 0',
    request_sent: 'INTEGER NOT NULL DEFAULT 0'
  })) if (!columns.has(name)) db.exec('ALTER TABLE accounts ADD COLUMN ' + name + ' ' + definition);
  return db;
}

export function createAccount(db) {
  const id = randomUUID(), token = newToken();
  db.prepare('INSERT INTO accounts(id,token) VALUES(?,?)').run(id, digest(token));
  return {
    id,
    token
  };
}

export function findAccount(db, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.prepare('SELECT * FROM accounts WHERE token=?').get(digest(token)) || null;
}
export const validPin = pin => typeof pin === 'string' && /^\d{6}$/.test(pin);

export function issuePin(db, id, pin) {
  if (!validPin(pin)) return null;
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if (account?.login_hash && timingSafeEqual(Buffer.from(account.login_hash, 'hex'), Buffer.from(pinHash(pin, account.login_salt), 'hex'))) return null;
  const salt = randomBytes(16).toString('hex');
  const result = db.prepare("UPDATE accounts SET pin_hash=?,pin_salt=?,pin_state='active',request=NULL,request_sent=0,failures=0,locked_until=0 WHERE id=? AND pin_state IN ('new','approved')").run(pinHash(pin, salt), salt, id);
  return result.changes === 1 ? pin: null;
}

export function usePin(db, id, pin, now = Date.now()) {
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if (!a || a.pin_state !== 'active') return 'unavailable';
  if (a.locked_until > now) return 'locked';
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) return 'invalid';
  if (!timingSafeEqual(Buffer.from(a.pin_hash, 'hex'), Buffer.from(pinHash(pin, a.pin_salt), 'hex'))) {
    const failures = a.failures + 1;
    db.prepare('UPDATE accounts SET failures=?,locked_until=? WHERE id=?').run(failures >= 5 ? 0: failures, failures >= 5 ? now + 15 * 60_000: 0, id);
    return 'invalid';
  }
  db.prepare("UPDATE accounts SET pin_hash=NULL,pin_salt=NULL,pin_state='used',request=NULL,request_sent=0,failures=0,locked_until=0 WHERE id=?").run(id);
  return 'ok';
}

export function requestReset(db, id) {
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if (a.request) return a.request;
  if (!['active', 'used'].includes(a.pin_state)) return null;
  const ref = randomBytes(9).toString('hex').toUpperCase();
  db.prepare('UPDATE accounts SET request=?,request_sent=0 WHERE id=?').run(ref, id);
  return ref;
}

export function approveReset(db, ref) {
  return db.prepare("UPDATE accounts SET pin_state='approved',pin_hash=NULL,pin_salt=NULL,request=NULL,request_sent=0,failures=0,locked_until=0 WHERE request=?").run(ref).changes === 1;
}

export function setLogin(db, id, pin) {
  if (!validPin(pin)) return false;
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if (a?.pin_hash && timingSafeEqual(Buffer.from(a.pin_hash, 'hex'), Buffer.from(pinHash(pin, a.pin_salt), 'hex'))) return false;
  const salt = randomBytes(16).toString('hex');
  return db.prepare('UPDATE accounts SET login_hash=?,login_salt=?,login_failures=0,login_locked_until=0 WHERE id=? AND login_hash IS NULL').run(pinHash(pin, salt), salt, id).changes === 1;
}

export function verifyLogin(db, id, pin, now = Date.now()) {
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if (!a?.login_hash) return 'unavailable';
  if (a.login_locked_until > now) return 'locked';
  if (!validPin(pin)) return 'invalid';
  if (!timingSafeEqual(Buffer.from(a.login_hash, 'hex'), Buffer.from(pinHash(pin, a.login_salt), 'hex'))) {
    const failures = a.login_failures + 1;
    db.prepare('UPDATE accounts SET login_failures=?,login_locked_until=? WHERE id=?').run(failures >= 5 ? 0: failures, failures >= 5 ? now + 15 * 60_000: 0, id);
    return 'invalid';
  }
  db.prepare('UPDATE accounts SET login_failures=0,login_locked_until=0 WHERE id=?').run(id);
  return 'ok';
}

export function changeLogin(db, id, current, next) {
  const result = verifyLogin(db, id, current);
  if (result !== 'ok') return result;
  if (!validPin(next)) return 'invalid';
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if (a.pin_hash && timingSafeEqual(Buffer.from(a.pin_hash, 'hex'), Buffer.from(pinHash(next, a.pin_salt), 'hex'))) return 'same-emergency';
  const salt = randomBytes(16).toString('hex');
  db.prepare('UPDATE accounts SET login_hash=?,login_salt=? WHERE id=?').run(pinHash(next, salt), salt, id);
  return 'ok';
}

export function markRequestSent(db, ref) {
  db.prepare('UPDATE accounts SET request_sent=1 WHERE request=?').run(ref);
}
