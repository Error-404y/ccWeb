const labels = new Set(['PIN created','Unlock successful','Unlock rejected','Unlock temporarily blocked','Login PIN changed','Emergency PIN used']);
const retention = 30 * 86400000;
export function initActivity(db) {
  db.exec('CREATE TABLE IF NOT EXISTS security_activity (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS security_activity_owner ON security_activity(owner, id); CREATE INDEX IF NOT EXISTS security_activity_at ON security_activity(at)');
}
export function pruneActivity(db, now = Date.now()) {
  db.prepare('DELETE FROM security_activity WHERE at < ?').run(now-retention);
}
export function recordActivity(db, owner, event, now = Date.now()) {
  if (!labels.has(event)) throw new Error('Invalid activity event');
  db.prepare('INSERT INTO security_activity(owner,event,at) VALUES(?,?,?)').run(owner,event,now);
  pruneActivity(db, now);
  db.prepare('DELETE FROM security_activity WHERE owner=? AND id NOT IN (SELECT id FROM security_activity WHERE owner=? ORDER BY id DESC LIMIT 50)').run(owner,owner);
}
export function listActivity(db, owner, now = Date.now()) {
  return db.prepare('SELECT event,at FROM security_activity WHERE owner=? AND at >= ? ORDER BY id DESC LIMIT 50').all(owner,now-retention);
}
