import {randomBytes,randomUUID,randomInt} from 'node:crypto';
import {createAccount,digest} from './accounts.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export const SELLER_TTL=28*86400000;
export const validSellerKey=value=>typeof value==='string'&&/^QZU-SELLER-[A-F0-9]{48}$/.test(value);
const alphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const randomCode=()=>Array.from({length:6},()=>alphabet[randomInt(alphabet.length)]).join('');
export function initSellers(db){
 db.exec(`CREATE TABLE IF NOT EXISTS seller_keys(id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,created INTEGER NOT NULL,redeemed INTEGER,account TEXT UNIQUE);
 CREATE TABLE IF NOT EXISTS seller_profiles(account TEXT PRIMARY KEY,created INTEGER NOT NULL,verified INTEGER NOT NULL DEFAULT 0,code TEXT UNIQUE,rotates INTEGER);
 CREATE TABLE IF NOT EXISTS seller_retired_codes(code TEXT PRIMARY KEY,until INTEGER NOT NULL);`);
}
export function redeemSellerKey(db,secret,now,deviceId){
 if(!deviceId||!validSellerKey(secret))throw fail('Registered mobile device required.',403);
 db.exec('BEGIN IMMEDIATE');try{
  if(db.prepare('SELECT id FROM accounts WHERE device_id=?').get(deviceId))throw fail('Device already registered.',409);
  const row=db.prepare('SELECT id FROM seller_keys WHERE hash=? AND redeemed IS NULL').get(digest(secret));
  if(!row)throw fail('Seller key unavailable.',409);
  const a=createAccount(db,deviceId);
  db.prepare("UPDATE accounts SET access_plan='seller' WHERE id=?").run(a.id);
  db.prepare('INSERT INTO seller_profiles(account,created) VALUES(?,?)').run(a.id,now);
  db.prepare('UPDATE seller_keys SET redeemed=?,account=? WHERE id=?').run(now||1,a.id,row.id);
  db.exec('COMMIT');return a;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
export function sellerStore(db,{now=Date.now,generate=randomCode}={}){
 initSellers(db);
 const available=id=>db.prepare("SELECT p.*,a.access_revoked,a.suspended,a.suspended_until,a.pin_state,a.device_id FROM seller_profiles p JOIN accounts a ON a.id=p.account WHERE p.account=? AND a.access_plan='seller'").get(id);
 const active=p=>Boolean(p&&p.device_id&&p.pin_state!=='retired'&&!p.access_revoked&&(!p.suspended||(p.suspended_until&&p.suspended_until<=now())));
 const audit=(actor,action,id)=>db.prepare("INSERT INTO access_audit(actor,action,account,at,reason) VALUES(?,?,?,?,?)").run(actor,action,id,now(),'Seller management');
 function generateKey(actor){
  if(db.prepare('SELECT count(*) n FROM seller_keys WHERE redeemed IS NULL').get().n>=100)throw fail('Unused seller key limit reached.',429);
  const key='QZU-SELLER-'+randomBytes(24).toString('hex').toUpperCase(),id=randomUUID();
  db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO seller_keys(id,hash,created) VALUES(?,?,?)').run(id,digest(key),now());audit(actor,'seller-key-generate',null);db.exec('COMMIT');return {key,id};}catch(e){db.exec('ROLLBACK');throw e;}
 }
 function ensureCode(id,chats){
  const p=available(id);if(!active(p))return null;
  if(p.code&&p.rotates>now()){const existing=chats.codes.get(p.code);if(existing&&existing.user!==id)throw fail('Connection code collision.',503);chats.codes.set(p.code,{user:id,expires:p.rotates,seller:true});return {code:p.code,expires:p.rotates};}
  const old=p.code,t=now();
  db.prepare('DELETE FROM seller_retired_codes WHERE until<=?').run(t);
  let code;for(let i=0;i<100;i++){const c=generate();if(/^[A-Z0-9]{6}$/.test(c)&&c!==old&&!chats.codes.has(c)&&!chats.retiredCodes.has(c)&&!db.prepare('SELECT 1 FROM seller_profiles WHERE code=?').get(c)&&!db.prepare('SELECT 1 FROM seller_retired_codes WHERE code=?').get(c)){code=c;break;}}
  if(!code)throw fail('Connection code unavailable.',503);
  const expires=t+SELLER_TTL;
  db.exec('BEGIN IMMEDIATE');try{if(old)db.prepare('INSERT OR REPLACE INTO seller_retired_codes(code,until) VALUES(?,?)').run(old,t+SELLER_TTL);db.prepare('UPDATE seller_profiles SET code=?,rotates=? WHERE account=?').run(code,expires,id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  if(old){chats.codes.delete(old);chats.retiredCodes.set(old,t+SELLER_TTL);}
  chats.codes.set(code,{user:id,expires,seller:true});return {code,expires};
 }
 function sync(chats){
  for(const [code,inv] of chats.codes)if(inv.seller&&!active(available(inv.user)))chats.codes.delete(code);
  for(const {code,until} of db.prepare('SELECT code,until FROM seller_retired_codes WHERE until>?').all(now()))chats.retiredCodes.set(code,until);
  for(const {account} of db.prepare('SELECT account FROM seller_profiles').all())ensureCode(account,chats);
 }
 function verify(id,value,actor){
  if(typeof value!=='boolean'||!available(id))throw fail('Seller unavailable.',404);
  db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE seller_profiles SET verified=? WHERE account=?').run(Number(value),id);audit(actor,value?'seller-verify':'seller-unverify',id);db.exec('COMMIT');return {ok:true};}catch(e){db.exec('ROLLBACK');throw e;}
 }
 return {generateKey,ensureCode,sync,verify,isActive:id=>active(available(id)),isSeller:id=>Boolean(available(id)),reserved(code){return Boolean(db.prepare('SELECT 1 FROM seller_profiles WHERE code=? UNION SELECT 1 FROM seller_retired_codes WHERE code=? AND until>?').get(code,code,now()));},role(id){const a=db.prepare('SELECT access_plan,access_revoked,suspended,suspended_until FROM accounts WHERE id=?').get(id),p=available(id);return a?.access_plan==='admin'&&!a.access_revoked&&(!a.suspended||a.suspended_until&&a.suspended_until<=now())?'admin':active(p)&&p.verified?'verified-seller':null;},list(chats){sync(chats);return db.prepare('SELECT account,created,verified,code,rotates FROM seller_profiles ORDER BY created DESC').all().map(p=>({...p,active:active(available(p.account)),code:active(available(p.account))?p.code:null}));},erase(id,chats){const p=available(id);if(p?.code){chats.codes.delete(p.code);chats.retiredCodes.set(p.code,now()+SELLER_TTL);db.prepare('INSERT OR REPLACE INTO seller_retired_codes(code,until) VALUES(?,?)').run(p.code,now()+SELLER_TTL);}db.prepare('UPDATE seller_keys SET account=NULL WHERE account=?').run(id);db.prepare('DELETE FROM seller_profiles WHERE account=?').run(id);}};
}
