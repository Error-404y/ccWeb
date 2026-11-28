import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { digest, createAccount, newToken, setLogin, validPin } from './accounts.mjs';

export const ADDRESS = 'ltc1q5uwq0dgv020znrw6x6njgl90vqf7385kelegef';
export const PLANS = { monthly: { cents: 1999, months: 5 }, renewal: { cents: 299, months: 1 } };
export const CONTROL_PLANS = Object.freeze({week:{cents:199},month:{cents:599},year:{cents:6999},lifetime:{cents:7999}});
export const PLAN_CODES = Object.freeze({'1W':'week','1M':'month','1Y':'year','LT':'lifetime'});
const timedPlans = new Set(['monthly','week','month','year']);
export function planEnd(plan,now){
  if(plan==='week')return now+7*86400000;
  if(plan==='month'||plan==='renewal')return addMonths(now,1);
  if(plan==='year')return addMonths(now,12);
  if(plan==='monthly')return addMonths(now,5);
  if(plan==='lifetime')return null;
  throw fail('Invalid access plan.');
}
const WINDOW = 30 * 60_000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const key = () => 'QZU-' + randomBytes(24).toString('hex').toUpperCase();
export const validKey = value => typeof value === 'string' && /^QZU-[A-F0-9]{48}$/.test(value);
export const validAdminKey = value => typeof value === 'string' && /^QZU-ADMIN-[A-F0-9]{48}$/.test(value);
const orderKey = () => 'QZO-' + randomBytes(24).toString('hex').toUpperCase();
const validOrder = value => typeof value === 'string' && /^QZO-[A-F0-9]{48}$/.test(value);

export function addMonths(time, count) {
  const date = new Date(time);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}

export function accessStatus(account, now = Date.now()) {
  const plan = account.access_plan || 'legacy';
  return { plan, paidUntil: account.paid_until || null, monthsPaid: account.months_paid || 0, active: !account.access_revoked && (!timedPlans.has(plan) || account.paid_until > now) };
}

export function initAccess(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(accounts)').all().map(row => row.name));
  for (const [name, definition] of Object.entries({ access_plan: "TEXT NOT NULL DEFAULT 'legacy'", paid_until: 'INTEGER', months_paid: 'INTEGER NOT NULL DEFAULT 0', access_revoked: 'INTEGER NOT NULL DEFAULT 0' })) {
    if (!columns.has(name)) db.exec('ALTER TABLE accounts ADD COLUMN ' + name + ' ' + definition);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS access_invoices (
    id TEXT PRIMARY KEY, secret TEXT NOT NULL UNIQUE, plan TEXT NOT NULL,
    account TEXT, sats INTEGER UNIQUE, eur_cents INTEGER NOT NULL,
    created INTEGER NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    txid TEXT, vout INTEGER, confirmations INTEGER NOT NULL DEFAULT 0,
    redeemed INTEGER, notified INTEGER NOT NULL DEFAULT 0,
    UNIQUE(txid,vout)
  )`);
  const fields = new Set(db.prepare('PRAGMA table_info(access_invoices)').all().map(row => row.name));
  for (const [name, definition] of Object.entries({ submitted: 'INTEGER', activation_hash: 'TEXT', activation_key: 'TEXT', redeemed_device: 'TEXT', redeemed_account: 'TEXT', generated: 'INTEGER NOT NULL DEFAULT 0', fingerprint: 'TEXT' })) {
    if (!fields.has(name)) db.exec('ALTER TABLE access_invoices ADD COLUMN ' + name + ' ' + definition);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS access_activation_hash ON access_invoices(activation_hash)');
  db.exec('CREATE TABLE IF NOT EXISTS access_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT,action TEXT NOT NULL,key_id TEXT,account TEXT,at INTEGER NOT NULL,reason TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS access_audit_key ON access_audit(key_id)');
  db.exec('CREATE INDEX IF NOT EXISTS access_redeemed_account ON access_invoices(redeemed_account)');
  db.exec('CREATE TABLE IF NOT EXISTS support_keys (hash TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL, redeemed INTEGER, account TEXT)');
  db.prepare('UPDATE support_keys SET expires=? WHERE redeemed IS NULL OR account IS NOT NULL').run(Number.MAX_SAFE_INTEGER);
}

export function createInvoice(db, plan, account = null, now = Date.now()) {
  const config = PLANS[plan];
  if (!config || (plan === 'renewal') !== Boolean(account)) throw fail('Checkout unavailable.');
  if (account && db.prepare("SELECT id FROM access_invoices WHERE account=? AND redeemed IS NULL AND state IN ('submitted','confirmed')").get(account)) throw fail('An active renewal is awaiting review or redemption.');
  const secret = orderKey(), id = randomUUID();
  db.prepare('INSERT INTO access_invoices(id,secret,plan,account,eur_cents,created,expires) VALUES(?,?,?,?,?,?,?)').run(id, digest(secret), plan, account, config.cents, now, now + WINDOW);
  return { orderKey: secret, ...invoiceStatus(db, secret, now) };
}

export function invoiceRow(db, secret) {
  if (!validOrder(secret) && !validKey(secret)) throw fail('Invalid reference or key.');
  const hash = digest(secret);
  const row = db.prepare('SELECT * FROM access_invoices WHERE secret=? OR activation_hash=?').get(hash, hash);
  if (!row) throw fail('Order unavailable.', 404);
  return row;
}

export function invoiceStatus(db, secret, now = Date.now()) {
  const row = invoiceRow(db, secret);
  const approved = row.state === 'confirmed' && !row.redeemed;
  let activationKey = approved && validOrder(secret) ? row.activation_key : approved && validKey(secret) ? secret : null;
  if(approved&&row.coin&&row.verified_at&&validOrder(secret)){
    activationKey='QZU-'+digest('qzu:crypto-activation:v1:'+secret).slice(0,48).toUpperCase();
    db.prepare("UPDATE access_invoices SET activation_hash=?,fingerprint=? WHERE id=? AND redeemed IS NULL AND state='confirmed'").run(digest(activationKey),activationKey.slice(-8),row.id);
  }
  return {
    id: row.id, plan: row.plan, address: row.wallet||ADDRESS, euro: (row.eur_cents / 100).toFixed(2),
    coin:row.coin||null,usd:row.usd_cents==null?null:(row.usd_cents/100).toFixed(2),amount:row.amount_atomic==null?null:(row.amount_atomic/10**(row.coin==='SOL'?9:8)).toFixed(row.coin==='SOL'?9:8),expires:row.expires,confirmations:row.confirmations,
    state: row.coin&&row.state==='pending'&&row.expires<=now?'expired':row.state, submitted: row.submitted || null, reviewUntil: row.submitted ? row.submitted + WINDOW : null,
    redeemed: Boolean(row.redeemed), activationKey, now
  };
}

export function submitPayment(db, secret, txid, now = Date.now()) {
  if (!validOrder(secret)) throw fail('Invalid order.');
  const row=invoiceRow(db,secret);
  if(typeof txid!=='string'||!(row.coin==='SOL'?/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(txid):/^[a-f0-9]{64}$/i.test(txid)))throw fail('Enter a valid transaction ID for this network.');
  if(row.state!=='pending'&&!(row.coin&&row.state==='submitted'))throw fail('This order has already been submitted.');
  if(row.coin&&now>row.expires+7*86400000)throw fail('Order expired. Contact support.');
  if(row.coin!=='SOL')txid=txid.toLowerCase();
  if(!row.coin&&db.prepare('SELECT id FROM access_invoices WHERE lower(txid)=? AND id<>?').get(txid,row.id))throw fail('Transaction already submitted.');
  db.prepare("UPDATE access_invoices SET state='submitted',txid=?,submitted=? WHERE id=?").run(txid,now||1,row.id);
  return invoiceStatus(db,secret,now);
}

export function approvePayment(db, id) {
  const row=db.prepare('SELECT * FROM access_invoices WHERE id=?').get(id);
  if(row?.coin)throw fail('New cryptocurrency invoices require independent blockchain verification.',409);
  const activation = key();
  const result = db.prepare("UPDATE access_invoices SET state='confirmed',activation_hash=?,activation_key=? WHERE id=? AND state='submitted' AND redeemed IS NULL AND txid IS NOT NULL").run(digest(activation), activation, id);
  if (!result.changes) throw fail('No submitted payment awaiting approval.');
}

export function rejectPayment(db, id) {
  const result = db.prepare("UPDATE access_invoices SET state='rejected' WHERE id=? AND state='submitted'").run(id);
  if (!result.changes) throw fail('No submitted payment awaiting review.');
}

export function complimentary(db, count, now = Date.now()) {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw fail('Choose 1–100 keys.');
  return Array.from({ length: count }, () => {
    const secret = key();
    db.prepare("INSERT INTO access_invoices(id,secret,plan,eur_cents,created,expires,state,notified) VALUES(?,?,?,?,?,?,'confirmed',1)").run(randomUUID(), digest(secret), 'lifetime', 0, now, now);
    return secret;
  });
}

export const ADMIN_KEY_LIMIT=8;
function supportKeyCount(db){return db.prepare('SELECT COUNT(*) AS n FROM support_keys WHERE redeemed IS NULL OR account IS NOT NULL').get().n;}
function insertSupportKey(db,now){
  const secret='QZU-ADMIN-'+randomBytes(24).toString('hex').toUpperCase();
  db.prepare('INSERT INTO support_keys(hash,created,expires) VALUES(?,?,?)').run(digest(secret),now,Number.MAX_SAFE_INTEGER);
  return secret;
}
export function createSupportKey(db, now=Date.now()){
  db.exec('BEGIN IMMEDIATE');
  try{
    if(supportKeyCount(db)>=ADMIN_KEY_LIMIT)throw fail('All eight admin key slots already exist.',409);
    const secret=insertSupportKey(db,now);db.exec('COMMIT');return secret;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function fillSupportKeyPool(db,now=Date.now()){
  db.exec('BEGIN IMMEDIATE');
  try{
    const count=supportKeyCount(db);
    if(count>ADMIN_KEY_LIMIT)throw fail('Existing admin key count exceeds eight; review manually.',409);
    const keys=Array.from({length:ADMIN_KEY_LIMIT-count},()=>insertSupportKey(db,now));
    db.exec('COMMIT');return {total:ADMIN_KEY_LIMIT,created:keys.length,keys};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function redeemSupportKey(db,secret,now,deviceId){
  if(!deviceId||!validAdminKey(secret))throw fail('Registered mobile device required.',403);
  db.exec('BEGIN IMMEDIATE');
  try{
    if(db.prepare('SELECT id FROM accounts WHERE device_id=?').get(deviceId))throw fail('Device already registered.',409);
    const row=db.prepare('SELECT * FROM support_keys WHERE hash=? AND redeemed IS NULL').get(digest(secret));
    if(!row)throw fail('Admin key unavailable.',409);
    let account;
    if(row.account){
      const token=newToken();
      const claim=db.prepare("UPDATE accounts SET device_id=?,token=?,pin_state='new' WHERE id=? AND access_plan='admin' AND device_id IS NULL AND pin_state='retired'").run(deviceId,digest(token),row.account);
      if(claim.changes!==1)throw fail('Admin key unavailable.',409);
      account={id:row.account,token};
    }else{
      account=createAccount(db,deviceId);
      db.prepare("UPDATE accounts SET access_plan='admin' WHERE id=?").run(account.id);
    }
    if(db.prepare('UPDATE support_keys SET redeemed=?,account=? WHERE hash=? AND redeemed IS NULL').run(now||1,account.id,digest(secret)).changes!==1)throw fail('Admin key unavailable.',409);
    db.exec('COMMIT');return account;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
// Call only after the authenticated owner has had their private rooms and sessions cleared.
export function releaseSupportKey(db,id){
  db.exec('BEGIN IMMEDIATE');
  try{
    const row=db.prepare("SELECT hash FROM support_keys WHERE account=? AND redeemed IS NOT NULL").get(id);
    if(!row)throw fail('Admin key unavailable.',409);
    const result=db.prepare("UPDATE accounts SET device_id=NULL,token=?,login_hash=NULL,login_salt=NULL,login_failures=0,login_locked_until=0,pin_hash=NULL,pin_salt=NULL,pin_state='retired',request=NULL,request_sent=0,failures=0,locked_until=0,invisible=0 WHERE id=? AND access_plan='admin' AND device_id IS NOT NULL").run(digest(newToken()),id);
    if(result.changes!==1)throw fail('Admin session unavailable.',409);
    db.prepare('UPDATE support_keys SET redeemed=NULL WHERE hash=?').run(row.hash);
    db.exec('COMMIT');return {ok:true};
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export const validReviewKey = value => typeof value==='string' && /^QZU-REVIEW-[A-F0-9]{40}$/.test(value);
export function redeemReviewAccess(db,secret,deviceId,config={}){
  if(!deviceId||!validReviewKey(secret)||!validReviewKey(config.key)||!validPin(config.pin)||!timingSafeEqual(Buffer.from(digest(secret),'hex'),Buffer.from(digest(config.key),'hex')))throw fail('Access key is not available.',403);
  db.exec('BEGIN IMMEDIATE');
  try{
    if(db.prepare('SELECT id FROM accounts WHERE device_id=?').get(deviceId))throw fail('Device already registered.',409);
    const account=createAccount(db,deviceId);
    db.prepare("UPDATE accounts SET access_plan='lifetime' WHERE id=?").run(account.id);
    if(!setLogin(db,account.id,config.pin))throw Error('Unable to initialize access.');
    db.exec('COMMIT');return account;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function redeemAccess(db, secret, now = Date.now(), deviceId = null) {
  if(validAdminKey(secret))return redeemSupportKey(db,secret,now,deviceId);
  if (!validKey(secret)) throw fail('Activation key required.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = invoiceRow(db, secret);
    if (row.state !== 'confirmed' || row.redeemed || row.account || row.plan === 'renewal') throw fail('Access key is not available.');
    const account = createAccount(db, deviceId);
    db.prepare('UPDATE accounts SET access_plan=?,paid_until=?,months_paid=? WHERE id=?').run(row.plan, planEnd(row.plan,now), row.plan === 'monthly' ? 5 : row.plan === 'month' ? 1 : row.plan === 'year' ? 12 : 0, account.id);
    db.prepare('UPDATE access_invoices SET redeemed=?,activation_key=NULL,redeemed_device=?,redeemed_account=? WHERE id=?').run(now || 1, deviceId, account.id, row.id);
    db.exec('COMMIT');
    return account;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function applyRenewal(db, secret, account, now = Date.now()) {
  if (!validKey(secret)) throw fail('Activation key required.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = invoiceRow(db, secret);
    const generated = row.generated===1 && Object.hasOwn(CONTROL_PLANS,row.plan) && !row.account;
    const paidCrypto=Boolean(row.coin&&row.verified_at&&row.account===account&&Object.hasOwn(CONTROL_PLANS,row.plan));
    if (row.state !== 'confirmed' || row.redeemed || (!generated && !paidCrypto && (row.account !== account || row.plan !== 'renewal'))) throw fail('Renewal unavailable.');
    const current = db.prepare('SELECT * FROM accounts WHERE id=?').get(account);
    if (!current || !timedPlans.has(current.access_plan) || current.access_revoked) throw fail('Renewal unavailable.');
    const next=generated||paidCrypto?row.plan:current.access_plan;
    const paid=planEnd(generated||paidCrypto?row.plan:'renewal',Math.max(now,current.paid_until||0));
    const months=row.plan==='year'?12:row.plan==='month'||row.plan==='renewal'?1:0;
    db.prepare('UPDATE accounts SET access_plan=?,paid_until=?,months_paid=months_paid+? WHERE id=?').run(next,paid,months,account);
    db.prepare('UPDATE access_invoices SET redeemed=?,activation_key=NULL,redeemed_account=? WHERE id=?').run(now||1,account,row.id);
    db.exec('COMMIT');
    return { paidUntil: paid };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function auditAccess(db,actor,action,id,account,reason,now){
  db.prepare('INSERT INTO access_audit(actor,action,key_id,account,at,reason) VALUES(?,?,?,?,?,?)').run(actor,action,id,account,now,reason);
}
export function generatePlanKeys(db,code,count=1,actor='developer',now=Date.now()){
  const plan=PLAN_CODES[String(code).toUpperCase()];
  if(!plan||!Number.isInteger(count)||count<1||count>100)throw fail('Choose 1W, 1M, 1Y or LT and 1–100 keys.');
  db.exec('BEGIN IMMEDIATE');
  try{
    const keys=Array.from({length:count},()=>{
      const secret=key(),id=randomUUID(),fingerprint=secret.slice(-8);
      db.prepare("INSERT INTO access_invoices(id,secret,plan,eur_cents,created,expires,state,notified,generated,fingerprint) VALUES(?,?,?,?,?,?,'confirmed',1,1,?)").run(id,digest(secret),plan,0,now,Number.MAX_SAFE_INTEGER,fingerprint);
      auditAccess(db,actor,'generate',id,null,'Developer-issued '+plan,now);
      return {id,key:secret,plan,priceUSD:(CONTROL_PLANS[plan].cents/100).toFixed(2),status:'unused'};
    });
    db.exec('COMMIT');return {keys};
  }catch(e){db.exec('ROLLBACK');throw e;}
}
export function listAccessKeys(db,query=''){
  if(typeof query!=='string'||query.length>128)throw fail('Invalid search.');
  const term=query.trim(),hash=validKey(term.toUpperCase())?digest(term.toUpperCase()):null;
  return db.prepare("SELECT id,plan,state,created,redeemed,redeemed_account AS account,fingerprint,generated FROM access_invoices WHERE (state='confirmed' OR state='revoked') AND (?='' OR id=? OR redeemed_account=? OR fingerprint=? OR secret=? OR activation_hash=?) ORDER BY created DESC LIMIT 100").all(term,term,term,term.toUpperCase(),hash,hash);
}
export function replaceUnusedKey(db,id,actor='developer',now=Date.now()){
  const secret=key();
  db.exec('BEGIN IMMEDIATE');
  try{
    const row=db.prepare("SELECT id FROM access_invoices WHERE id=? AND generated=1 AND state='confirmed' AND redeemed IS NULL AND account IS NULL").get(id);
    if(!row)throw fail('Only unused developer-issued keys can be replaced.',409);
    db.prepare('UPDATE access_invoices SET secret=?,activation_hash=NULL,activation_key=NULL,fingerprint=? WHERE id=?').run(digest(secret),secret.slice(-8),id);
    auditAccess(db,actor,'replace',id,null,'Unused key replacement',now);
    db.exec('COMMIT');return {id,key:secret};
  }catch(e){db.exec('ROLLBACK');throw e;}
}
export function revokeAccessKey(db,id,actor='developer',reason='',now=Date.now()){
  if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw fail('A reason is required.');
  db.exec('BEGIN IMMEDIATE');
  try{
    const row=db.prepare("SELECT * FROM access_invoices WHERE id=? AND state='confirmed' AND generated=1").get(id);
    if(!row)throw fail('Developer-issued key unavailable.',404);
    // Revoking an already redeemed key must not revoke subsequent purchased access.
    if(row.redeemed)throw fail('Redeemed keys require a separate account moderation action.',409);
    db.prepare("UPDATE access_invoices SET state='revoked',activation_key=NULL WHERE id=?").run(id);
    auditAccess(db,actor,'revoke',id,null,reason.trim(),now);
    db.exec('COMMIT');return {ok:true};
  }catch(e){db.exec('ROLLBACK');throw e;}
}
