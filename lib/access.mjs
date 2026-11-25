import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { digest, createAccount } from './accounts.mjs';

export const ADDRESS = 'ltc1q5uwq0dgv020znrw6x6njgl90vqf7385kelegef';
export const PLANS = { lifetime: { cents: 1999, months: 0 }, monthly: { cents: 1495, months: 5 }, renewal: { cents: 299, months: 1 } };
const WINDOW = 30 * 60_000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const key = () => 'QZU-' + randomBytes(24).toString('hex').toUpperCase();
export const validKey = value => typeof value === 'string' && /^QZU-[A-F0-9]{48}$/.test(value);
const amount = sats => (sats / 100_000_000).toFixed(8);

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
}

export function createInvoice(db, plan, eurRate, account = null, now = Date.now()) {
  const config = PLANS[plan];
  if (!config || (plan === 'renewal') !== Boolean(account) || !Number.isFinite(eurRate) || eurRate <= 0) throw fail('Checkout unavailable.', 503);
  if (account && db.prepare("SELECT id FROM access_invoices WHERE account=? AND state IN ('pending','detected') AND expires>?").get(account, now)) throw fail('An active renewal invoice already exists.');
  const base = Math.ceil(config.cents * 1_000_000 / eurRate);
  let sats;
  for (let i = 0; i < 5000; i++) {
    const candidate = base + randomInt(1, 1000);
    if (!db.prepare('SELECT id FROM access_invoices WHERE sats=?').get(candidate)) { sats = candidate; break; }
  }
  if (!sats || !Number.isSafeInteger(sats)) throw fail('Checkout busy.', 503);
  const secret = key(), id = randomUUID();
  db.prepare('INSERT INTO access_invoices(id,secret,plan,account,sats,eur_cents,created,expires) VALUES(?,?,?,?,?,?,?,?)').run(id, digest(secret), plan, account, sats, config.cents, now, now + WINDOW);
  return { key: secret, ...invoiceStatus(db, secret, now) };
}

export function invoiceRow(db, secret) {
  if (!validKey(secret)) throw fail('Invalid access key.');
  const row = db.prepare('SELECT * FROM access_invoices WHERE secret=?').get(digest(secret));
  if (!row) throw fail('Access key unavailable.', 404);
  return row;
}

export function invoiceStatus(db, secret, now = Date.now()) {
  const row = invoiceRow(db, secret);
  return { id: row.id, plan: row.plan, address: ADDRESS, amount: row.sats === null ? null : amount(row.sats), euro: (row.eur_cents / 100).toFixed(2), expires: row.expires, state: row.state === 'pending' && row.expires <= now ? 'expired' : row.state, confirmations: row.confirmations, redeemed: Boolean(row.redeemed), required: 3 };
}

export function complimentary(db, count, now = Date.now()) {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw fail('Choose 1–100 keys.');
  return Array.from({ length: count }, () => {
    const secret = key();
    db.prepare("INSERT INTO access_invoices(id,secret,plan,eur_cents,created,expires,state,notified) VALUES(?,?,?,?,?,?,'confirmed',1)").run(randomUUID(), digest(secret), 'lifetime', 0, now, now);
    return secret;
  });
}

export function redeemAccess(db, secret, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = invoiceRow(db, secret);
    if (row.state !== 'confirmed' || row.redeemed || row.account || row.plan === 'renewal') throw fail('Access key is not available.');
    const account = createAccount(db);
    db.prepare('UPDATE accounts SET access_plan=?,paid_until=?,months_paid=? WHERE id=?').run(row.plan, row.plan === 'monthly' ? addMonths(now, 5) : null, row.plan === 'monthly' ? 5 : 0, account.id);
    db.prepare('UPDATE access_invoices SET redeemed=? WHERE id=?').run(now || 1, row.id);
    db.exec('COMMIT');
    return account;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function applyRenewal(db, secret, account, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = invoiceRow(db, secret);
    if (row.account !== account || row.plan !== 'renewal' || row.state !== 'confirmed' || row.redeemed) throw fail('Renewal unavailable.');
    const current = db.prepare('SELECT * FROM accounts WHERE id=?').get(account);
    if (!current || current.access_plan !== 'monthly') throw fail('Renewal unavailable.');
    const paid = addMonths(Math.max(now, current.paid_until || 0), 1);
    db.prepare('UPDATE accounts SET paid_until=?,months_paid=months_paid+1 WHERE id=?').run(paid, account);
    db.prepare('UPDATE access_invoices SET redeemed=? WHERE id=?').run(now || 1, row.id);
    db.exec('COMMIT');
    return { paidUntil: paid };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function rpc(method, params = [], fetcher = fetch) {
  const url = new URL(process.env.QZU_LTC_RPC_URL || 'http://127.0.0.1:9332');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password) throw fail('Local Litecoin RPC required.', 503);
  const user = process.env.QZU_LTC_RPC_USER, password = process.env.QZU_LTC_RPC_PASSWORD;
  if (!user || !password) throw fail('Litecoin payment service not configured.', 503);
  const response = await fetcher(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: 'Basic ' + Buffer.from(user + ':' + password).toString('base64'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'qzu', method, params })
  });
  if (!response.ok) throw fail('Payment verification unavailable.', 503);
  const body = await response.json();
  if (body.error) throw fail('Payment verification unavailable.', 503);
  return body.result;
}

let quote = null;
export async function liveRate(fetcher = fetch) {
  if (quote && Date.now() - quote.at < 60_000) return quote.rate;
  const apiKey = process.env.QZU_COINGECKO_KEY;
  if (!apiKey) throw fail('Exchange-rate service not configured.', 503);
  const res = await fetcher('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=eur&include_last_updated_at=true', {
    headers: { 'x-cg-demo-api-key': apiKey }, signal: AbortSignal.timeout(5000), redirect: 'error'
  });
  if (!res.ok) throw fail('Exchange-rate service unavailable.', 503);
  const body = await res.json();
  const rate = body.litecoin?.eur, updated = body.litecoin?.last_updated_at;
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(updated) || Math.abs(Date.now() - updated * 1000) > 10 * 60_000) throw fail('Exchange rate unavailable.', 503);
  quote = { rate, at: Date.now() };
  return rate;
}

export async function checkNode(call = rpc) {
  const info = await call('getblockchaininfo');
  const wallet = await call('getaddressinfo', [ADDRESS]);
  if (info.chain !== 'main' || info.initialblockdownload || info.blocks < info.headers || !wallet.iswatchonly || wallet.ismine) throw fail('Watch-only Litecoin wallet not ready.', 503);
}

export function reconcile(db, transactions, now = Date.now()) {
  for (const tx of transactions) {
    if (tx.category !== 'receive' || tx.address !== ADDRESS || !/^[a-f0-9]{64}$/i.test(tx.txid || '') || !Number.isInteger(tx.vout) || tx.vout < 0 || !Number.isFinite(tx.amount) || !Number.isInteger(tx.confirmations) || tx.confirmations < 0 || !Number.isFinite(tx.timereceived)) continue;
    const sats = Math.round(tx.amount * 100_000_000);
    const row = db.prepare("SELECT * FROM access_invoices WHERE sats=? AND state IN ('pending','detected','late')").get(sats);
    if (!row || tx.timereceived * 1000 < Math.floor(row.created / 1000) * 1000) continue;
    if (row.txid && (row.txid !== tx.txid || row.vout !== tx.vout)) continue;
    if (db.prepare('SELECT id FROM access_invoices WHERE txid=? AND vout=? AND id<>?').get(tx.txid, tx.vout, row.id)) continue;
    const late = tx.timereceived * 1000 > row.expires;
    const state = late ? 'late' : tx.confirmations >= 3 ? 'confirmed' : 'detected';
    db.prepare('UPDATE access_invoices SET state=?,txid=?,vout=?,confirmations=? WHERE id=?').run(state, tx.txid, tx.vout, tx.confirmations, row.id);
  }
}

let scanning = false;
export async function scanPayments(db, call = rpc) {
  if (scanning) return;
  scanning = true;
  try {
    await checkNode(call);
    const oldest = db.prepare("SELECT MIN(created) AS oldest FROM access_invoices WHERE state IN ('pending','detected','late') AND sats IS NOT NULL").get().oldest;
    if (oldest === null) return;
    for (let skip = 0; skip < 100_000; skip += 500) {
      const entries = await call('listtransactions', ['*', 500, skip, true]);
      if (!Array.isArray(entries)) throw fail('Payment verification unavailable.', 503);
      reconcile(db, entries);
      if (entries.length < 500 || entries.every(tx => Number.isFinite(tx.timereceived) && tx.timereceived * 1000 < oldest - 1000)) break;
    }
  } finally {
    scanning = false;
  }
}

export function reviewLate(db, id) {
  const result = db.prepare("UPDATE access_invoices SET state='confirmed' WHERE id=? AND state='late' AND confirmations>=3").run(id);
  if (!result.changes) throw fail('No confirmed late payment.');
}
