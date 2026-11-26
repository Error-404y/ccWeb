import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { digest, createAccount, setLogin, validPin } from './accounts.mjs';

export const ADDRESS = 'ltc1q5uwq0dgv020znrw6x6njgl90vqf7385kelegef';
export const PLANS = { monthly: { cents: 1999, months: 5 }, renewal: { cents: 299, months: 1 } };
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
  return { plan, paidUntil: account.paid_until || null, monthsPaid: account.months_paid || 0, active: plan !== 'monthly' || account.paid_until > now };
}

export function initAccess(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(accounts)').all().map(row => row.name));
  for (const [name, definition] of Object.entries({ access_plan: "TEXT NOT NULL DEFAULT 'legacy'", paid_until: 'INTEGER', months_paid: 'INTEGER NOT NULL DEFAULT 0' })) {
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
  for (const [name, definition] of Object.entries({ submitted: 'INTEGER', activation_hash: 'TEXT', activation_key: 'TEXT', redeemed_device: 'TEXT', redeemed_account: 'TEXT' })) {
    if (!fields.has(name)) db.exec('ALTER TABLE access_invoices ADD COLUMN ' + name + ' ' + definition);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS access_activation_hash ON access_invoices(activation_hash)');
  db.exec('CREATE TABLE IF NOT EXISTS support_keys (hash TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL, redeemed INTEGER, account TEXT)');
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
  const activationKey = approved && validOrder(secret) ? row.activation_key : approved && validKey(secret) ? secret : null;
  return {
    id: row.id, plan: row.plan, address: ADDRESS, euro: (row.eur_cents / 100).toFixed(2),
    state: row.state, submitted: row.submitted || null, reviewUntil: row.submitted ? row.submitted + WINDOW : null,
    redeemed: Boolean(row.redeemed), activationKey, now
  };
}

export function submitPayment(db, secret, txid, now = Date.now()) {
  if (!validOrder(secret) || typeof txid !== 'string' || !/^[a-f0-9]{64}$/i.test(txid)) throw fail('Enter a valid Litecoin transaction ID.');
  const row = invoiceRow(db, secret);
  if (row.state !== 'pending') throw fail('This order has already been submitted.');
  txid = txid.toLowerCase();
  if (db.prepare('SELECT id FROM access_invoices WHERE lower(txid)=? AND id<>?').get(txid, row.id)) throw fail('Transaction already submitted.');
  db.prepare("UPDATE access_invoices SET state='submitted',txid=?,submitted=? WHERE id=?").run(txid, now || 1, row.id);
  return invoiceStatus(db, secret, now);
}

export function approvePayment(db, id) {
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

export function createSupportKey(db, now = Date.now()) {
  const secret='QZU-ADMIN-'+randomBytes(24).toString('hex').toUpperCase();
  db.exec('BEGIN IMMEDIATE');
  try {
    if(db.prepare("SELECT id FROM accounts WHERE access_plan='admin' AND pin_state!='retired'").get())throw fail('A support account already exists.');
    db.prepare('DELETE FROM support_keys WHERE redeemed IS NULL').run();
    db.prepare('INSERT INTO support_keys(hash,created,expires) VALUES(?,?,?)').run(digest(secret),now,now+86400000);
    db.exec('COMMIT');
    return secret;
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export function redeemSupportKey(db,secret,now,deviceId) {
  if(!deviceId||!validAdminKey(secret))throw fail('Registered mobile device required.',403);
  db.exec('BEGIN IMMEDIATE');
  try {
    const row=db.prepare('SELECT * FROM support_keys WHERE hash=? AND redeemed IS NULL AND expires>?').get(digest(secret),now);
    if(!row||db.prepare("SELECT id FROM accounts WHERE access_plan='admin' AND pin_state!='retired'").get())throw fail('Admin key unavailable.');
    const account=createAccount(db,deviceId);
    db.prepare("UPDATE accounts SET access_plan='admin' WHERE id=?").run(account.id);
    db.prepare('UPDATE support_keys SET redeemed=?,account=? WHERE hash=?').run(now||1,account.id,digest(secret));
    db.exec('COMMIT');
    return account;
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
    db.prepare('UPDATE accounts SET access_plan=?,paid_until=?,months_paid=? WHERE id=?').run(row.plan, row.plan === 'monthly' ? addMonths(now, 5) : null, row.plan === 'monthly' ? 5 : 0, account.id);
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
    if (row.account !== account || row.plan !== 'renewal' || row.state !== 'confirmed' || row.redeemed) throw fail('Renewal unavailable.');
    const current = db.prepare('SELECT * FROM accounts WHERE id=?').get(account);
    if (!current || current.access_plan !== 'monthly') throw fail('Renewal unavailable.');
    const paid = addMonths(Math.max(now, current.paid_until || 0), 1);
    db.prepare('UPDATE accounts SET paid_until=?,months_paid=months_paid+1 WHERE id=?').run(paid, account);
    db.prepare('UPDATE access_invoices SET redeemed=?,activation_key=NULL WHERE id=?').run(now || 1, row.id);
    db.exec('COMMIT');
    return { paidUntil: paid };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
