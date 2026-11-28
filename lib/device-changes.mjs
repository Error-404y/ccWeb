import { randomUUID } from 'node:crypto';
import { describeDeviceModel } from './device-models.mjs';

export const DEVICE_CHANGE_RETENTION = 90 * 86400000;
const historyLimit = 100;
const validId = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
const unavailable = () => Object.assign(Error('Device change unavailable.'), { status:404 });

export function initDeviceChanges(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_device_changes (
    id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    changed_at INTEGER NOT NULL, previous_fingerprint TEXT NOT NULL, current_fingerprint TEXT NOT NULL,
    previous_platform TEXT, previous_model TEXT, previous_os_version TEXT, previous_app_version TEXT, previous_seen INTEGER,
    reviewed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS account_device_changes_history ON account_device_changes(account,changed_at DESC);
  CREATE INDEX IF NOT EXISTS account_device_changes_pending ON account_device_changes(account,changed_at) WHERE reviewed_at IS NULL;
  CREATE INDEX IF NOT EXISTS account_device_changes_retention ON account_device_changes(reviewed_at) WHERE reviewed_at IS NOT NULL`);
}

export function recordDeviceChange(db, account, previous, current, at) {
  if (!previous || previous === current) return;
  const profile = db.prepare(`SELECT platform,model,os_version,app_version,last_seen FROM device_profiles
    WHERE account=? AND fingerprint=?`).get(account,previous);
  db.prepare(`INSERT INTO account_device_changes(id,account,changed_at,previous_fingerprint,current_fingerprint,
    previous_platform,previous_model,previous_os_version,previous_app_version,previous_seen)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),account,at,previous,current,
      profile?.platform??null,profile?.model??null,profile?.os_version??null,profile?.app_version??null,profile?.last_seen??null);
  db.prepare(`DELETE FROM account_device_changes WHERE account=? AND id IN (
    SELECT id FROM account_device_changes WHERE account=?
    ORDER BY reviewed_at IS NOT NULL,changed_at DESC,rowid DESC LIMIT -1 OFFSET ?)`).run(account,account,historyLimit);
}

export function deviceChanges(db, now = Date.now) {
  const rows = db.prepare(`SELECT * FROM account_device_changes WHERE account=? AND (reviewed_at IS NULL OR reviewed_at>?)
    ORDER BY reviewed_at IS NOT NULL,changed_at DESC,rowid DESC LIMIT ?`);
  const mark = db.prepare(`UPDATE account_device_changes SET reviewed_at=?
    WHERE account=? AND id=? AND reviewed_at IS NULL`);
  const reviewed = db.prepare(`SELECT 1 FROM account_device_changes
    WHERE account=? AND id=? AND reviewed_at>?`);
  const removeExpired = db.prepare('DELETE FROM account_device_changes WHERE reviewed_at<=?');

  function history(account) {
    return rows.all(account,now()-DEVICE_CHANGE_RETENTION,historyLimit).map(row=>({
      id:row.id, changedAt:row.changed_at, previousFingerprint:row.previous_fingerprint,
      currentFingerprint:row.current_fingerprint, reviewedAt:row.reviewed_at,
      previousDevice:row.previous_seen===null?null:{
        platform:row.previous_platform, ...describeDeviceModel(row.previous_platform,row.previous_model),
        osVersion:row.previous_os_version, appVersion:row.previous_app_version, lastSeenAt:row.previous_seen
      }
    }));
  }

  function review(account, id, audit) {
    if (!validId(account)||!validId(id)) throw unavailable();
    const at = now(), parameters = [account.toLowerCase(),id.toLowerCase()];
    db.exec('BEGIN IMMEDIATE');
    try {
      if (mark.run(at,...parameters).changes) audit();
      else if (!reviewed.get(...parameters,at-DEVICE_CHANGE_RETENTION)) throw unavailable();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {history,review,sweep:()=>removeExpired.run(now()-DEVICE_CHANGE_RETENTION)};
}
