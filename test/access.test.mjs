import test from 'node:test';
import assert from 'node:assert/strict';
import { openAccounts, findAccount } from '../lib/accounts.mjs';
import { initAccess, createInvoice, invoiceStatus, redeemAccess, reconcile, complimentary, accessStatus, applyRenewal, addMonths, ADDRESS, PLANS } from '../lib/access.mjs';

function setup() {
  const db = openAccounts(':memory:');
  initAccess(db);
  return db;
}

function payment(invoice, confirmations, txid = 'a'.repeat(64), time = 10_000) {
  return { category: 'receive', address: ADDRESS, txid, vout: 0, amount: Number(invoice.amount), confirmations, timereceived: time / 1000 };
}

test('pricing and one-time redemption after three confirmations', () => {
  const db = setup();
  const now = 10_000;
  const invoice = createInvoice(db, 'monthly', 100, null, now);
  assert.equal(invoice.euro, '19.99');
  assert.equal(PLANS.monthly.months, 5);
  assert.equal(PLANS.renewal.cents, 299);
  assert.throws(() => redeemAccess(db, invoice.key, now));
  reconcile(db, [payment(invoice, 2)], now);
  assert.equal(invoiceStatus(db, invoice.key, now).state, 'detected');
  assert.throws(() => redeemAccess(db, invoice.key, now));
  reconcile(db, [payment(invoice, 3)], now);
  const account = redeemAccess(db, invoice.key, now);
  const stored = findAccount(db, account.token);
  assert.equal(stored.months_paid, 5);
  assert.equal(stored.paid_until, addMonths(now, 5));
  assert.throws(() => redeemAccess(db, invoice.key, now));
  db.close();
});

test('unique amounts, wrong destination and late payment', () => {
  const db = setup();
  const first = createInvoice(db, 'monthly', 100, null, 10_000);
  const second = createInvoice(db, 'monthly', 100, null, 10_000);
  assert.notEqual(first.amount, second.amount);
  reconcile(db, [{ ...payment(first, 3), address: 'other' }]);
  assert.equal(invoiceStatus(db, first.key, 10_000).state, 'pending');
  reconcile(db, [payment(first, 3, 'b'.repeat(64), first.expires + 1000)]);
  assert.equal(invoiceStatus(db, first.key, first.expires + 1000).state, 'late');
  assert.throws(() => redeemAccess(db, first.key));
  db.close();
});

test('renewals are account-bound and add one month once', () => {
  const db = setup();
  const now = 10_000;
  const first = createInvoice(db, 'monthly', 100, null, now);
  reconcile(db, [payment(first, 3)]);
  const account = redeemAccess(db, first.key, now);
  const renewal = createInvoice(db, 'renewal', 100, account.id, now);
  reconcile(db, [payment(renewal, 3, 'c'.repeat(64))]);
  assert.throws(() => applyRenewal(db, renewal.key, 'other', now));
  const result = applyRenewal(db, renewal.key, account.id, now);
  assert.equal(result.paidUntil, addMonths(addMonths(now, 5), 1));
  assert.throws(() => applyRenewal(db, renewal.key, account.id, now));
  assert.equal(accessStatus(findAccount(db, account.token), result.paidUntil).active, false);
  db.close();
});

test('developer access keys are complimentary and single use', () => {
  const db = setup();
  const [key] = complimentary(db, 1);
  const account = redeemAccess(db, key);
  assert.equal(accessStatus(findAccount(db, account.token)).active, true);
  assert.throws(() => redeemAccess(db, key));
  db.close();
});
