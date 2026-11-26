import { randomUUID, randomBytes } from 'node:crypto';

export const CONTACT_WARNING = 14 * 86400000;
export const CONTACT_GRACE = 86400000;
const expiry = CONTACT_WARNING + CONTACT_GRACE;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function nickname(value = 'Contact') {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw fail('Enter a nickname (1–40 characters).');
  return value.trim();
}
export function contactStore(db, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, a_name TEXT NOT NULL, b_name TEXT NOT NULL, active_at INTEGER NOT NULL, UNIQUE(a,b)
  );
  CREATE INDEX IF NOT EXISTS contacts_a ON contacts(a);
  CREATE INDEX IF NOT EXISTS contacts_b ON contacts(b);
  CREATE INDEX IF NOT EXISTS contacts_activity ON contacts(active_at);`);
  const pair = (a,b) => [a,b].sort();
  const lookup = (a,b) => db.prepare('SELECT * FROM contacts WHERE a=? AND b=? AND active_at>?').get(...pair(a,b), now()-expiry);
  const rowFor = (user,id) => db.prepare('SELECT * FROM contacts WHERE id=? AND (a=? OR b=?) AND active_at>?').get(id,user,user,now()-expiry);
  const view = (row,user) => ({ id: row.id, nickname: row.a === user ? row.a_name : row.b_name, lastActivity: row.active_at, warningAt: row.active_at + CONTACT_WARNING, deleteAt: row.active_at + expiry, warning: now() >= row.active_at + CONTACT_WARNING });
  const count = user => db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE (a=? OR b=?) AND active_at>?').get(user,user,now()-expiry).n;
  return {
    add(from,to,fromName,toName) {
      if (from===to) throw fail('Invalid contact.');
      fromName=nickname(fromName); toName=nickname(toName);
      const existing=lookup(from,to);
      if(existing)return existing.id;
      if(count(from)>=500||count(to)>=500)throw fail('Contact limit reached.',429);
      const [a,b]=pair(from,to), id=randomUUID();
      db.prepare('DELETE FROM contacts WHERE a=? AND b=?').run(a,b);
      db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?)').run(id,a,b,a===from?fromName:toName,a===from?toName:fromName,now());
      return id;
    },
    between(user,peer) { const row=lookup(user,peer); return row?view(row,user):null; },
    list(user) { return db.prepare('SELECT * FROM contacts WHERE (a=? OR b=?) AND active_at>? ORDER BY active_at DESC').all(user,user,now()-expiry).map(row=>view(row,user)); },
    peer(user,id) { if(typeof id!=='string')throw fail('Contact unavailable.',404); const row=rowFor(user,id); if(!row)throw fail('Contact unavailable.',404); return row.a===user?row.b:row.a; },
    touch(user,peer) { db.prepare('UPDATE contacts SET active_at=? WHERE a=? AND b=? AND active_at>?').run(now(),...pair(user,peer),now()-expiry); },
    removePair(user,peer) { db.prepare('DELETE FROM contacts WHERE a=? AND b=?').run(...pair(user,peer)); },
    removeAll(user) { db.prepare('DELETE FROM contacts WHERE a=? OR b=?').run(user,user); },
    sweep() { const rows=db.prepare('SELECT a,b FROM contacts WHERE active_at<=?').all(now()-expiry); if(rows.length)db.prepare('DELETE FROM contacts WHERE active_at<=?').run(now()-expiry); return rows; }
  };
}
export function retireAccount(db, contacts, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result=db.prepare("UPDATE accounts SET device_id=NULL,token=?,login_hash=NULL,login_salt=NULL,pin_hash=NULL,pin_salt=NULL,pin_state='retired',request=NULL,request_sent=0 WHERE id=? AND pin_state!='retired'").run(randomBytes(32).toString('hex'),id);
    if(result.changes!==1)throw fail('Account unavailable.',404);
    contacts.removeAll(id);
    db.prepare('DELETE FROM blocks WHERE owner=? OR target=?').run(id,id);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
