import { createPublicKey, verify, createHash } from 'node:crypto';

const TTL = 90_000;
const PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

export function initDevices(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(accounts)').all().map(row => row.name));
  if (!columns.has('device_id')) db.exec('ALTER TABLE accounts ADD COLUMN device_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS account_device ON accounts(device_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS device_profiles (
    account TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, platform TEXT,
    model TEXT, os_version TEXT, app_version TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
  )`);
}

export function findDeviceAccount(db, id) {
  return db.prepare('SELECT * FROM accounts WHERE device_id=?').get(id) || null;
}

export function deviceProfiles(db, now = Date.now) {
  const find = db.prepare(`SELECT a.device_id, a.pin_state, d.platform, d.model, d.os_version,
    d.app_version, d.first_seen, d.last_seen FROM accounts a
    LEFT JOIN device_profiles d ON d.account=a.id AND d.fingerprint=a.device_id WHERE a.id=?`);
  const observe = db.prepare(`INSERT INTO device_profiles(account,fingerprint,platform,model,os_version,app_version,first_seen,last_seen)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account) DO UPDATE SET
    platform=COALESCE(excluded.platform,CASE WHEN fingerprint=excluded.fingerprint THEN platform END),
    model=COALESCE(excluded.model,CASE WHEN fingerprint=excluded.fingerprint THEN model END),
    os_version=COALESCE(excluded.os_version,CASE WHEN fingerprint=excluded.fingerprint THEN os_version END),
    app_version=COALESCE(excluded.app_version,CASE WHEN fingerprint=excluded.fingerprint THEN app_version END),
    first_seen=CASE WHEN fingerprint=excluded.fingerprint THEN first_seen ELSE excluded.first_seen END,
    fingerprint=excluded.fingerprint,last_seen=excluded.last_seen`);
  const clean = (value, limit) => typeof value === 'string' && value.length <= limit &&
    !/[\p{Cc}\p{Cf}]/u.test(value) ? value.trim() || null : null;
  const erase = db.prepare('DELETE FROM device_profiles WHERE account=?');
  function update(account, fingerprint, platform, details = {}) {
    if (!fingerprint || account.device_id !== fingerprint) return false;
    const timestamp = now();
    observe.run(account.id, fingerprint, ['android', 'ios'].includes(platform) ? platform : null,
      clean(details.model, 80), clean(details.osVersion, 40), clean(details.appVersion, 32), timestamp, timestamp);
    return true;
  }
  function get(id) {
    const row = find.get(id);
    if (!row) return null;
    return {platform: row.device_id ? row.platform : row.pin_state === 'retired' ? null : 'web',
      model: row.model, osVersion: row.os_version, appVersion: row.app_version, fingerprint: row.device_id,
      registeredAt: row.first_seen, lastSeenAt: row.last_seen,
      source: row.model || row.os_version ? 'app-reported' : row.last_seen ? 'signed-session' : null};
  }
  return {update, get, erase: id => erase.run(id)};
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
