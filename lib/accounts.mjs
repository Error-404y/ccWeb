import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes,randomInt,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
const pinHash = (pin,salt) => scryptSync(pin,salt,32).toString('hex');
export function openAccounts(path=process.env.QZU_DB||'data/accounts.sqlite') {
  if(path!==':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const db=new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts(
      id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE,
      pin_hash TEXT, pin_salt TEXT, pin_state TEXT NOT NULL DEFAULT 'new',
      request TEXT UNIQUE, failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
    )`);
  return db;
}
export function createAccount(db) {
  const id=randomUUID(), token=newToken();
  db.prepare('INSERT INTO accounts(id,token) VALUES(?,?)').run(id,digest(token));
  return {id,token};
}
export function findAccount(db,token) {
  if(typeof token!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.prepare('SELECT * FROM accounts WHERE token=?').get(digest(token))||null;
}
export function issuePin(db,id) {
  const pin=String(randomInt(1_000_000)).padStart(6,'0'), salt=randomBytes(16).toString('hex');
  const result=db.prepare("UPDATE accounts SET pin_hash=?,pin_salt=?,pin_state='active',request=NULL,failures=0,locked_until=0 WHERE id=? AND pin_state IN ('new','approved')").run(pinHash(pin,salt),salt,id);
  return result.changes===1?pin:null;
}
export function usePin(db,id,pin,now=Date.now()) {
  const a=db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if(!a||a.pin_state!=='active') return 'unavailable';
  if(a.locked_until>now) return 'locked';
  if(typeof pin!=='string'||! /^\d{6}$/.test(pin)) return 'invalid';
  if(!timingSafeEqual(Buffer.from(a.pin_hash,'hex'),Buffer.from(pinHash(pin,a.pin_salt),'hex'))) {
    const failures=a.failures+1;
    db.prepare('UPDATE accounts SET failures=?,locked_until=? WHERE id=?').run(failures>=5?0:failures,failures>=5?now+15*60_000:0,id);
    return 'invalid';
  }
  db.prepare("UPDATE accounts SET pin_hash=NULL,pin_salt=NULL,pin_state='used',request=NULL,failures=0,locked_until=0 WHERE id=?").run(id);
  return 'ok';
}
export function requestReset(db,id) {
  const a=db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if(a.request) return a.request;
  if(!['active','used'].includes(a.pin_state)) return null;
  const ref=randomBytes(9).toString('hex').toUpperCase();
  db.prepare('UPDATE accounts SET request=? WHERE id=?').run(ref,id);
  return ref;
}
export function approveReset(db,ref) {
  return db.prepare("UPDATE accounts SET pin_state='approved',pin_hash=NULL,pin_salt=NULL,request=NULL,failures=0,locked_until=0 WHERE request=?").run(ref).changes===1;
}
