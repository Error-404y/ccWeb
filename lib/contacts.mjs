import { randomUUID, randomBytes } from 'node:crypto';

export const CONTACT_WARNING = 14 * 86400000;
export const CONTACT_GRACE = 86400000;
export const TRUSTED_WARNING = 30 * 86400000;
const trusted = row => Boolean(row.a_trusted || row.b_trusted || (row.a_verified && row.b_verified));
const warning = row => trusted(row) ? TRUSTED_WARNING : CONTACT_WARNING;
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
  db.exec("CREATE TABLE IF NOT EXISTS contact_deletions(id TEXT PRIMARY KEY,contact TEXT NOT NULL,requester TEXT NOT NULL,admin TEXT NOT NULL,kind TEXT NOT NULL,room TEXT,at INTEGER NOT NULL,UNIQUE(contact,kind,room)); CREATE INDEX IF NOT EXISTS contact_deletions_admin ON contact_deletions(admin)");
  const columns = new Set(db.prepare('PRAGMA table_info(contacts)').all().map(row=>row.name));
  for (const [name,type] of Object.entries({a_identity:'TEXT',b_identity:'TEXT',a_trusted:'INTEGER NOT NULL DEFAULT 0',b_trusted:'INTEGER NOT NULL DEFAULT 0',a_verified:'INTEGER NOT NULL DEFAULT 0',b_verified:'INTEGER NOT NULL DEFAULT 0',a_favorite:'INTEGER NOT NULL DEFAULT 0',b_favorite:'INTEGER NOT NULL DEFAULT 0',a_muted:'INTEGER NOT NULL DEFAULT 0',b_muted:'INTEGER NOT NULL DEFAULT 0'})) if(!columns.has(name)) db.exec('ALTER TABLE contacts ADD COLUMN '+name+' '+type);
  if(!columns.has('a_verified'))db.exec('UPDATE contacts SET a_verified=1,b_verified=1 WHERE a_identity IS NOT NULL AND b_identity IS NOT NULL');
  const live = '(active_at + CASE WHEN a_trusted=1 OR b_trusted=1 OR (a_verified=1 AND b_verified=1) THEN '+TRUSTED_WARNING+' ELSE '+CONTACT_WARNING+' END + '+CONTACT_GRACE+' > ?)';
  const pair = (a,b) => [a,b].sort();
  const lookup = (a,b) => db.prepare('SELECT * FROM contacts WHERE a=? AND b=? AND '+live).get(...pair(a,b), now());
  const rowFor = (user,id) => db.prepare('SELECT * FROM contacts WHERE id=? AND (a=? OR b=?) AND '+live).get(id,user,user,now());
  const view = (row,user) => ({ id: row.id, nickname: row.a === user ? row.a_name : row.b_name, favorite: Boolean(row.a===user?row.a_favorite:row.b_favorite), muted: Boolean(row.a===user?row.a_muted:row.b_muted), trusted: trusted(row), personallyTrusted:Boolean(row.a===user?row.a_trusted:row.b_trusted),identityVerified:Boolean(row.a_verified&&row.b_verified), peerIdentity: row.a===user?row.b_identity:row.a_identity, lastActivity: row.active_at, warningAt: row.active_at + warning(row), deleteAt: row.active_at + warning(row) + CONTACT_GRACE, warning: now() >= row.active_at + warning(row) });
  const count = user => db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE (a=? OR b=?) AND '+live).get(user,user,now()).n;
  return {
    add(from,to,fromName,toName) {
      if (from===to) throw fail('Invalid contact.');
      fromName=nickname(fromName); toName=nickname(toName);
      const existing=lookup(from,to);
      if(existing)return existing.id;
      if(count(from)>=500||count(to)>=500)throw fail('Contact limit reached.',429);
      const [a,b]=pair(from,to), id=randomUUID();
      db.prepare('DELETE FROM contacts WHERE a=? AND b=?').run(a,b);
      db.prepare('INSERT INTO contacts(id,a,b,a_name,b_name,active_at) VALUES(?,?,?,?,?,?)').run(id,a,b,a===from?fromName:toName,a===from?toName:fromName,now());
      return id;
    },
    between(user,peer) { const row=lookup(user,peer); return row?view(row,user):null; },
    list(user) { return db.prepare('SELECT * FROM contacts WHERE (a=? OR b=?) AND '+live+' ORDER BY active_at DESC').all(user,user,now()).map(row=>view(row,user)).sort((a,b)=>Number(b.favorite)-Number(a.favorite)||b.lastActivity-a.lastActivity); },
    peer(user,id) { if(typeof id!=='string')throw fail('Contact unavailable.',404); const row=rowFor(user,id); if(!row)throw fail('Contact unavailable.',404); return row.a===user?row.b:row.a; },
    touch(user,peer) { db.prepare('UPDATE contacts SET active_at=? WHERE a=? AND b=? AND '+live).run(now(),...pair(user,peer),now()); },
    verify(user,peer,own,other,manual=true) {
      const row=lookup(user,peer);
      if(!row||typeof own!=='string'||typeof other!=='string')return false;
      const a=row.a===user?own:other,b=row.a===user?other:own;
      if((row.a_identity&&row.a_identity!==a)||(row.b_identity&&row.b_identity!==b))return false;
      db.prepare('UPDATE contacts SET a_identity=?,b_identity=? WHERE id=?').run(a,b,row.id);
      if(manual)db.prepare('UPDATE contacts SET a_verified=1,b_verified=1 WHERE id=?').run(row.id);
      return true;
    },
    update(user,id,changes) {
      if(typeof id!=='string')throw fail('Contact unavailable.',404);
      const row=rowFor(user,id);
      if(!row)throw fail('Contact unavailable.',404);
      const side=row.a===user?'a':'b';
      if(changes.nickname!==undefined)db.prepare('UPDATE contacts SET '+side+'_name=? WHERE id=?').run(nickname(changes.nickname),id);
      for(const field of ['favorite','muted','trusted'])if(typeof changes[field]==='boolean')db.prepare('UPDATE contacts SET '+side+'_'+field+'=? WHERE id=?').run(Number(changes[field]),id);
      if(changes.resetTrust===true)db.prepare('UPDATE contacts SET a_identity=NULL,b_identity=NULL,a_verified=0,b_verified=0 WHERE id=?').run(id);
      return {ok:true};
    },
    requestDeletion(user,id,kind,room=null){
      const row=rowFor(user,id);if(!row||!['contact','chat'].includes(kind)||(kind==='chat'&&!room))throw fail('Contact unavailable.',404);
      const admin=row.a===user?row.b:row.a,scope=kind==='contact'?'':room;
      const existing=db.prepare('SELECT id FROM contact_deletions WHERE contact=? AND kind=? AND room=? AND requester=?').get(id,kind,scope,user);
      if(existing)return {requested:true,requestId:existing.id,duplicate:true};
      const requestId=randomUUID();db.prepare('INSERT INTO contact_deletions VALUES(?,?,?,?,?,?,?)').run(requestId,id,user,admin,kind,scope,now());return {requested:true,requestId};
    },
    deletionRequests(admin){return db.prepare('SELECT d.* FROM contact_deletions d JOIN contacts c ON c.id=d.contact WHERE d.admin=? ORDER BY d.at DESC').all(admin).filter(d=>rowFor(admin,d.contact));},
    finishDeletion(admin,id){db.prepare('DELETE FROM contact_deletions WHERE admin=? AND id=?').run(admin,id);},
    removePair(user,peer) { const args=pair(user,peer);db.prepare('DELETE FROM contact_deletions WHERE contact IN (SELECT id FROM contacts WHERE a=? AND b=?)').run(...args);db.prepare('DELETE FROM contacts WHERE a=? AND b=?').run(...args); },
    removeAll(user) { db.prepare('DELETE FROM contact_deletions WHERE requester=? OR admin=?').run(user,user);db.prepare('DELETE FROM contacts WHERE a=? OR b=?').run(user,user); },
    sweep() { const rows=db.prepare('SELECT a,b FROM contacts WHERE NOT '+live).all(now()); if(rows.length)db.prepare('DELETE FROM contacts WHERE NOT '+live).run(now());db.prepare('DELETE FROM contact_deletions WHERE contact NOT IN (SELECT id FROM contacts)').run(); return rows; }
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
