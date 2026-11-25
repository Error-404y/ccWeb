import { createPublicKey, verify, createHash } from 'node:crypto';

const TTL = 90_000;
const PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

export function initDevices(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(accounts)').all().map(row => row.name));
  if (!columns.has('device_id')) db.exec('ALTER TABLE accounts ADD COLUMN device_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS account_device ON accounts(device_id)');
}

export function findDeviceAccount(db, id) {
  return db.prepare('SELECT * FROM accounts WHERE device_id=?').get(id) || null;
}

export function deviceVerifier(now = Date.now) {
  const seen = new Map();
  function sweep() {
    for (const [key, until] of seen) if (until <= now()) seen.delete(key);
  }
  function authenticate({ publicKey, signature, timestamp, nonce, method, path, body = '', unlock = '' }) {
    if (typeof publicKey !== 'string' || !/^[A-Za-z0-9+/]{87}=$/.test(publicKey) || typeof signature !== 'string' || !/^[A-Za-z0-9+/=]{80,108}$/.test(signature) || typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) return null;
    const time = Number(timestamp);
    if (Math.abs(now() - time) > TTL) return null;
    const bytes = Buffer.from(publicKey, 'base64');
    if (bytes.length !== 65 || bytes[0] !== 4 || bytes.toString('base64') !== publicKey) return null;
    const id = createHash('sha256').update(bytes).digest('hex');
    const replay = id + ':' + nonce;
    if (seen.has(replay)) return null;
    if (seen.size >= 100_000) { sweep(); if (seen.size >= 100_000) return null; }
    const message = JSON.stringify(['qzu-device-v1', method, path, timestamp, nonce, unlock, body]);
    try {
      const key = createPublicKey({ key: Buffer.concat([PREFIX, bytes]), format: 'der', type: 'spki' });
      if (!verify('sha256', Buffer.from(message), key, Buffer.from(signature, 'base64'))) return null;
    } catch { return null; }
    seen.set(replay, time + TTL + 1);
    return id;
  }
  return { authenticate, sweep };
}
