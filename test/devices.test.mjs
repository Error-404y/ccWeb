import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { deviceVerifier, initDevices, findDeviceAccount } from '../lib/devices.mjs';
import { openAccounts } from '../lib/accounts.mjs';
import { initAccess, complimentary, redeemAccess } from '../lib/access.mjs';

test('device signatures bind method, path, body and unlock token; reject replay', () => {
  const now = Date.now();
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65).toString('base64');
  const verifier = deviceVerifier(() => now);
  const data = { publicKey: raw, method: 'POST', path: '/api/session', timestamp: String(now), nonce: randomBytes(16).toString('hex'), body: '{"accessKey":"example"}', unlock: '' };
  data.signature = sign('sha256', Buffer.from(JSON.stringify(['qzu-device-v1', data.method, data.path, data.timestamp, data.nonce, data.unlock, data.body])), privateKey).toString('base64');
  assert.equal(verifier.authenticate({ ...data, body: '{}' }), null);
  assert.equal(verifier.authenticate({ ...data, unlock: 'different' }), null);
  assert.match(verifier.authenticate(data), /^[a-f0-9]{64}$/);
  assert.equal(verifier.authenticate(data), null);
});

test('access key can activate one registered device only', () => {
  const db = openAccounts(':memory:');
  initAccess(db);
  initDevices(db);
  const [key, other] = complimentary(db, 2);
  const account = redeemAccess(db, key, Date.now(), 'device-a');
  assert.equal(findDeviceAccount(db, 'device-a').id, account.id);
  assert.equal(findDeviceAccount(db, 'device-b'), null);
  assert.throws(() => redeemAccess(db, key, Date.now(), 'device-b'));
  assert.throws(() => redeemAccess(db, other, Date.now(), 'device-a'));
  assert.ok(redeemAccess(db, other, Date.now(), 'device-b'));
  db.close();
});
