import test from 'node:test';
import assert from 'node:assert/strict';
import { openAccounts, findAccount } from '../lib/accounts.mjs';
import { initAccess, createInvoice, invoiceStatus, redeemAccess, submitPayment, approvePayment, rejectPayment, complimentary, accessStatus, applyRenewal, addMonths } from '../lib/access.mjs';

function setup() {
  const db = openAccounts(':memory:');
  initAccess(db);
  return db;
}

test('only manual approval reveals a single-use key', () => {
  const db = setup();
  const now = 10000;
  const order = createInvoice(db, 'monthly', null, now);
  assert.equal(order.euro, '19.99');
  assert.equal(order.activationKey, null);
  assert.throws(() => approvePayment(db, order.id));
  assert.throws(() => redeemAccess(db, order.orderKey));
  const submitted = submitPayment(db, order.orderKey, 'a'.repeat(64), now);
  assert.equal(submitted.reviewUntil, now + 1800000);
  assert.equal(invoiceStatus(db, order.orderKey, now + 1800001).activationKey, null);
  approvePayment(db, order.id);
  const { activationKey } = invoiceStatus(db, order.orderKey, now);
  assert.match(activationKey, /^QZU-[A-F0-9]{48}$/);
  assert.throws(() => redeemAccess(db, order.orderKey));
  const account = redeemAccess(db, activationKey, now);
  assert.equal(findAccount(db, account.token).paid_until, addMonths(now, 5));
  assert.throws(() => redeemAccess(db, activationKey));
  assert.equal(invoiceStatus(db, order.orderKey, now).activationKey, null);
  db.close();
});

test('duplicate transaction IDs cannot be submitted or approved twice', () => {
  const db = setup();
  const first = createInvoice(db, 'monthly');
  const second = createInvoice(db, 'monthly');
  submitPayment(db, first.orderKey, 'a'.repeat(64));
  assert.throws(() => submitPayment(db, second.orderKey, 'A'.repeat(64)));
  rejectPayment(db, first.id);
  assert.throws(() => approvePayment(db, first.id));
  assert.equal(invoiceStatus(db, first.orderKey).activationKey, null);
  db.close();
});

test('renewal requires approval and is bound to its account', () => {
  const db = setup();
  const now = 10000;
  const order = createInvoice(db, 'monthly', null, now);
  submitPayment(db, order.orderKey, 'a'.repeat(64), now);
  approvePayment(db, order.id);
  const account = redeemAccess(db, invoiceStatus(db, order.orderKey).activationKey, now);
  const renewal = createInvoice(db, 'renewal', account.id, now);
  assert.equal(renewal.euro, '2.99');
  submitPayment(db, renewal.orderKey, 'b'.repeat(64), now);
  approvePayment(db, renewal.id);
  const { activationKey } = invoiceStatus(db, renewal.orderKey);
  assert.throws(() => applyRenewal(db, activationKey, 'other', now));
  const result = applyRenewal(db, activationKey, account.id, now);
  assert.equal(result.paidUntil, addMonths(addMonths(now, 5), 1));
  assert.throws(() => applyRenewal(db, activationKey, account.id, now));
  db.close();
});

test('complimentary keys still grant lifetime access', () => {
  const db = setup();
  const [key] = complimentary(db, 1);
  const account = redeemAccess(db, key);
  assert.equal(accessStatus(findAccount(db, account.token)).active, true);
  assert.throws(() => redeemAccess(db, key));
  db.close();
});
