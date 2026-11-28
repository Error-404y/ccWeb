import {randomBytes,timingSafeEqual} from 'node:crypto';
import {digest,newToken,verifyLogin,createAccount} from './accounts.mjs';
import {accessStatus,planEnd,PLAN_CODES,validAdminKey,listAccessKeys,generatePlanKeys,replaceUnusedKey,revokeAccessKey} from './access.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const reasonOf=reason=>{if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw fail('A reason is required.');return reason.trim();};
const code=prefix=>prefix+randomBytes(24).toString('hex').toUpperCase();
const validRecovery=value=>typeof value==='string'&&/^QZU-REC-[A-F0-9]{48}$/.test(value);
export function initControl(db){
 const fields=new Set(db.prepare('PRAGMA table_info(accounts)').all().map(x=>x.name));
 if(!fields.has('recovery_hash'))db.exec('ALTER TABLE accounts ADD COLUMN recovery_hash TEXT');
 if(!fields.has('recovery_created'))db.exec('ALTER TABLE accounts ADD COLUMN recovery_created INTEGER');
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS account_recovery_hash ON accounts(recovery_hash)');
}
function audit(db,actor,action,account,reason,now=Date.now()){
 db.prepare('INSERT INTO access_audit(actor,action,account,at,reason) VALUES(?,?,?,?,?)').run(actor,action,account,now,reason);
}
export function issueRecovery(db,id,pin,now=Date.now()){
 const a=db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
 if(!a||a.access_plan==='admin'||!a.device_id||a.suspended||a.access_revoked||verifyLogin(db,id,pin,now)!=='ok')throw fail('Account verification failed.',403);
 const secret=code('QZU-REC-');
 db.prepare('UPDATE accounts SET recovery_hash=?,recovery_created=? WHERE id=?').run(digest(secret),now,id);
 return {recoveryCode:secret};
}
export function recoverAccount(db,secret,pin,deviceId,now=Date.now()){
 if(!deviceId||!validRecovery(secret))throw fail('Recovery verification failed.',403);
 const a=db.prepare("SELECT * FROM accounts WHERE recovery_hash=? AND access_plan<>'admin'").get(digest(secret));
 if(!a||a.suspended||a.access_revoked||a.pin_state==='retired'||verifyLogin(db,a.id,pin,now)!=='ok')throw fail('Recovery verification failed.',403);
 db.exec('BEGIN IMMEDIATE');
 try{
  if(db.prepare('SELECT id FROM accounts WHERE device_id=?').get(deviceId))throw fail('This device already has an account.',409);
  if(db.prepare('SELECT 1 FROM suspended_devices WHERE device_id=? AND until>?').get(deviceId,now))throw fail('Device unavailable.',403);
  const token=newToken(),result=db.prepare('UPDATE accounts SET device_id=?,token=?,recovery_hash=NULL,recovery_created=NULL WHERE id=? AND recovery_hash=?').run(deviceId,digest(token),a.id,digest(secret));
  if(result.changes!==1)throw fail('Recovery code is unavailable.',409);
  audit(db,a.id,'recover-device',a.id,'Verified recovery code and existing PIN',now);
  db.exec('COMMIT');return {id:a.id,oldDevice:a.device_id};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
// Desktop classification is a usability policy, not proof of hardware identity.
export function desktopControlAllowed(userAgent='',mobileHint='',platform=''){
 if(typeof userAgent!=='string'||mobileHint==='?1'||/Android|iPhone|iPad|iPod|Mobile|Windows Phone|Tablet|Silk/i.test(userAgent))return false;
 if(platform&& !/^"(Windows|macOS)"$/i.test(platform))return false;
 return /Windows NT|Macintosh/i.test(userAgent);
}
export function createControlSessions(db,now=Date.now){
 const sessions=new Map();
 const unavailable=()=>fail('Admin key or PIN unavailable.',403);
 function slot(hash){
  return db.prepare('SELECT k.account,k.redeemed,k.expires,a.id,a.access_plan,a.device_id,a.pin_state,a.access_revoked,a.suspended,a.suspended_until,a.login_hash FROM support_keys k LEFT JOIN accounts a ON a.id=k.account WHERE k.hash=?').get(hash);
 }
 function authorized(row){
  if(!row||row.expires<=now())return false;
  if(!row.account)return row.redeemed===null;
  if(row.id!==row.account||row.access_plan!=='admin'||row.access_revoked||(row.suspended&&(!row.suspended_until||row.suspended_until>now())))return false;
  return row.redeemed===null?(!row.device_id&&row.pin_state==='retired'):Boolean(row.device_id&&row.pin_state!=='retired'&&row.login_hash);
 }
 function sweep(){for(const [k,v] of sessions)if(v.expires<=now()||v.hard<=now())sessions.delete(k);}
 function validSession(s){const row=slot(s.hash);return authorized(row)&&row.id===s.id&&row.redeemed===s.redeemed&&row.device_id===s.device;}
 function revokeAccount(id){for(const [k,v] of sessions)if(v.id===id)sessions.delete(k);}
 return {
  login(secret,pin){
   sweep();if(!validAdminKey(secret))throw unavailable();
   const hash=digest(secret);let row=slot(hash);
   if(!authorized(row))throw unavailable();
   if(row.redeemed!==null&&verifyLogin(db,row.id,pin,now())!=='ok')throw unavailable();
   if(!row.account){
    db.exec('BEGIN IMMEDIATE');try{
     const account=createAccount(db);
     db.prepare("UPDATE accounts SET access_plan='admin',pin_state='retired' WHERE id=?").run(account.id);
     if(db.prepare('UPDATE support_keys SET account=? WHERE hash=? AND account IS NULL AND redeemed IS NULL').run(account.id,hash).changes!==1)throw unavailable();
     db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    row=slot(hash);
   }
   if(!authorized(row))throw unavailable();
   revokeAccount(row.id);const token=newToken();
   sessions.set(digest(token),{id:row.id,hash,redeemed:row.redeemed,device:row.device_id,expires:now()+15*60000,hard:now()+8*3600000});
   audit(db,row.id,'desktop-admin-login',row.id,'Admin key login',now());
   return {token,id:row.id};
  },
  check(token){sweep();if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;const k=digest(token),s=sessions.get(k);if(!s)return null;if(!validSession(s)){sessions.delete(k);return null;}s.expires=now()+15*60000;return {id:s.id,access_plan:'admin'};},
  revoke(token){if(typeof token==='string')sessions.delete(digest(token));},
  activeDesktopIds(){sweep();return [...sessions.values()].filter(validSession).map(s=>s.id);},
  revokeAccount
 };
}
export function controlOverview(db,now=Date.now()){
 const accounts=db.prepare('SELECT access_plan,paid_until,access_revoked,suspended,suspended_until FROM accounts').all();
 const count=sql=>Number(db.prepare(sql).get().n);
 return {accounts:accounts.length,active:accounts.filter(a=>accessStatus(a,now).active&&(!a.suspended||(a.suspended_until&&a.suspended_until<=now))).length,admins:accounts.filter(a=>a.access_plan==='admin').length,keys:count("SELECT count(*) n FROM access_invoices WHERE state='confirmed' AND redeemed IS NULL"),reports:count('SELECT count(*) n FROM abuse_reports WHERE resolved IS NULL'),feedback:count("SELECT count(*) n FROM feedback_inbox WHERE workflow<>'solved'"),payments:count("SELECT count(*) n FROM access_invoices WHERE state='submitted'"),revenue:Number(db.prepare("SELECT COALESCE(sum(usd_cents),0) n FROM access_invoices WHERE state='confirmed' AND verified_at IS NOT NULL").get().n)};
}
export function controlAccounts(db,query='',after=''){
 if(typeof query!=='string'||query.length>128||typeof after!=='string'||after.length>128)throw fail('Invalid search.');
 const term=query.trim();const rows=db.prepare("SELECT a.id,a.access_plan,a.paid_until,a.months_paid,a.access_revoked,a.suspended,a.suspended_until,a.restricted_until,a.recovery_created,(SELECT max(at) FROM security_activity WHERE owner=a.id) AS last_activity,(SELECT count(*) FROM abuse_reports WHERE target=a.id) AS reports,(SELECT id FROM access_invoices WHERE redeemed_account=a.id ORDER BY redeemed DESC LIMIT 1) AS key_id FROM accounts a WHERE a.id>? AND (?='' OR a.id=? OR EXISTS(SELECT 1 FROM access_invoices i WHERE i.redeemed_account=a.id AND (i.id=? OR i.fingerprint=? OR i.secret=? OR i.activation_hash=?))) ORDER BY a.id LIMIT 100").all(after,term,term,term,term.toUpperCase(),digest(term.toUpperCase()),digest(term.toUpperCase()));
 return rows.map(a=>({...a,access:accessStatus(a)}));
}
export function accountAction(db,id,actor,action,reason,plan,now=Date.now()){
 reason=reasonOf(reason);const a=db.prepare('SELECT * FROM accounts WHERE id=?').get(id);if(!a||a.access_plan==='admin')throw fail('Account unavailable.',404);
 db.exec('BEGIN IMMEDIATE');try{
  if(action==='extend'){const next=PLAN_CODES[String(plan).toUpperCase()];if(!next||a.access_plan==='lifetime'||a.access_plan==='legacy'||a.access_revoked)throw fail('Account not eligible for extension.');const end=planEnd(next,Math.max(now,a.paid_until||0));db.prepare('UPDATE accounts SET access_plan=?,paid_until=? WHERE id=?').run(next,end,id);}
  else if(action==='revoke')db.prepare('UPDATE accounts SET access_revoked=1,recovery_hash=NULL,recovery_created=NULL WHERE id=?').run(id);
  else if(action==='restore')db.prepare('UPDATE accounts SET access_revoked=0 WHERE id=?').run(id);
  else throw fail('Unknown account action.');
  audit(db,actor,action,id,reason,now);db.exec('COMMIT');return {ok:true};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
export function controlPayments(db){return db.prepare("SELECT id,plan,coin,usd_cents,eur_cents,amount_atomic,state,txid,confirmations,created,expires,verified_at,redeemed,redeemed_account FROM access_invoices WHERE generated=0 AND (usd_cents IS NOT NULL OR eur_cents>0) ORDER BY created DESC LIMIT 100").all();}
export function controlAudit(db){return db.prepare('SELECT id,actor,action,key_id,account,at,reason FROM access_audit ORDER BY id DESC LIMIT 100').all();}
