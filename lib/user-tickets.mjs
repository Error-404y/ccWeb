import {randomUUID} from 'node:crypto';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const DAY=86400000;
const CLOSED_RETENTION=7*DAY;
export function userTickets(db,{now=Date.now,isSeller=()=>false,isAdmin=()=>false,role=()=>null,name=()=>null}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS user_tickets(id TEXT PRIMARY KEY,owner TEXT NOT NULL,topic TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,closed INTEGER,admin TEXT,seller TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS user_ticket_active ON user_tickets(owner) WHERE closed IS NULL;
 CREATE INDEX IF NOT EXISTS user_tickets_closed ON user_tickets(closed,updated);
 CREATE TABLE IF NOT EXISTS user_ticket_messages(id TEXT PRIMARY KEY,ticket TEXT NOT NULL,actor TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL,request_id TEXT NOT NULL,UNIQUE(ticket,actor,request_id));
 CREATE TABLE IF NOT EXISTS user_ticket_sellers(ticket TEXT NOT NULL, seller TEXT NOT NULL, PRIMARY KEY(ticket,seller));
`);
 db.exec('BEGIN IMMEDIATE');try{db.exec('INSERT OR IGNORE INTO user_ticket_sellers SELECT id,seller FROM user_tickets WHERE seller IS NOT NULL; UPDATE user_tickets SET seller=NULL WHERE seller IS NOT NULL; COMMIT;');}catch(e){db.exec('ROLLBACK');throw e;}
 const assignedSellers=id=>db.prepare('SELECT seller FROM user_ticket_sellers WHERE ticket=? ORDER BY seller').all(id).map(r=>r.seller);
 const audit=(actor,action,id,target=null)=>db.prepare('INSERT INTO access_audit(actor,action,account,at,reason) VALUES(?,?,?,?,?)').run(actor,action,target,now(),id);
 const get=id=>{const t=db.prepare('SELECT * FROM user_tickets WHERE id=?').get(typeof id==='string'?id:'');if(!t)throw fail('Ticket unavailable.',404);return t;};
 function permission(t,actor,admin){if(admin&&isAdmin(actor))return 'admin';if(t.owner===actor)return 'customer';if(assignedSellers(t.id).includes(actor)&&isSeller(actor))return 'seller';throw fail('Ticket unavailable.',404);}
 const active=t=>{if(t.closed!==null)throw fail('Ticket is closed.',409);};
 const touch=t=>db.prepare('UPDATE user_tickets SET updated=? WHERE id=?').run(now(),t.id);
 const assigneeAvailable=t=>Boolean(t.admin&&isAdmin(t.admin));
 const closedCutoff=()=>now()-CLOSED_RETENTION;
 function sweep(){
  const inactive='closed IS NULL AND updated<=?';
  const cutoff=now()-90*DAY,closed=closedCutoff();
  const expired='SELECT id FROM user_tickets WHERE closed<=? OR ('+inactive+')';
  db.exec('BEGIN IMMEDIATE');
  try{
   db.prepare('DELETE FROM user_ticket_sellers WHERE ticket IN ('+expired+')').run(closed,cutoff);
   db.prepare('DELETE FROM user_ticket_messages WHERE ticket IN ('+expired+')').run(closed,cutoff);
   db.prepare('DELETE FROM user_tickets WHERE '+inactive).run(cutoff);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 function view(id,actor,admin=false){
  const t=get(id),mine=permission(t,actor,admin);
  const open=t.closed===null, transcriptExpired=!open&&t.closed<=closedCutoff();
  const members=transcriptExpired?[]:assignedSellers(id);
  const messages=!open&&(!admin||transcriptExpired)?[]:db.prepare('SELECT id,actor,kind,text,at FROM user_ticket_messages WHERE ticket=? ORDER BY at,rowid').all(id).map(m=>({id:m.id,kind:m.kind,text:m.text,at:m.at,actor:admin?m.actor:undefined,name:m.kind==='seller'?name(m.actor)||'Seller':undefined,mine:m.actor===actor,role:m.kind==='admin'?'admin':m.kind==='seller'&&role(m.actor)==='verified-seller'?'verified-seller':m.kind==='seller'?'seller':m.kind==='system'?'system':'customer'}));
  const assigned=open?assigneeAvailable(t):Boolean(t.admin);
  return {id:t.id,topic:t.topic,created:t.created,updated:t.updated,closed:t.closed,assigned,seller:admin?members[0]||null:Boolean(members.length),sellers:admin?members:undefined,owner:admin?t.owner:undefined,admin:admin?t.admin:undefined,claimable:admin?open&&!assigned:undefined,transcriptExpired:admin?transcriptExpired:undefined,canReply:open&&(mine!=='admin'||t.admin===actor),mine,messages};
 }
 function send(id,actor,admin,text,requestId){
  const t=get(id),kind=permission(t,actor,admin);active(t);
  if(kind==='admin'&&t.admin!==actor)throw fail('Accept this ticket first.',409);
  if(typeof text!=='string'||!text.trim()||text.length>2000||typeof requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(requestId))throw fail('Invalid message.');
  if(db.prepare('SELECT 1 FROM user_ticket_messages WHERE ticket=? AND actor=? AND request_id=?').get(id,actor,requestId))return view(id,actor,admin);
  if(db.prepare('SELECT count(*) n FROM user_ticket_messages WHERE ticket=?').get(id).n>=500)throw fail('Ticket message limit reached.',429);
  db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO user_ticket_messages VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,actor,kind,text.trim(),now(),requestId);touch(t);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return view(id,actor,admin);
 }
 function open(owner,topic,text,requestId){
  if(!['General question','Request a Seller','Account issue','Other'].includes(topic)||typeof text!=='string'||!text.trim()||text.length>2000||typeof requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(requestId))throw fail('Choose a topic and write a message.');
  const existing=db.prepare('SELECT id FROM user_tickets WHERE owner=? AND closed IS NULL').get(owner);if(existing)return view(existing.id,owner);
  if(db.prepare('SELECT count(*) n FROM user_tickets WHERE owner=? AND created>?').get(owner,now()-DAY).n>=5)throw fail('Daily ticket limit reached.',429);
  const id=randomUUID(),t=now();db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO user_tickets(id,owner,topic,created,updated) VALUES(?,?,?,?,?)').run(id,owner,topic,t,t);db.prepare('INSERT INTO user_ticket_messages VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,owner,'customer',text.trim(),t,requestId);audit(owner,'user-ticket-create',id,owner);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return view(id,owner);
 }
 function adminAction(id,actor,action,seller=null,code=null){
  if(!isAdmin(actor))throw fail('Admin required.',403);
  if(action==='accept'){
   db.exec('BEGIN IMMEDIATE');
   try{
    const t=get(id);active(t);
    if(t.admin!==actor){
     if(assigneeAvailable(t))throw fail('Already assigned.',409);
     db.prepare('UPDATE user_tickets SET admin=?,updated=? WHERE id=?').run(actor,now(),id);
     audit(actor,t.admin?'user-ticket-reclaim':'user-ticket-accept',id,t.admin||t.owner);
    }
    db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
   return view(id,actor,true);
  }
  const t=get(id);
  if(action==='delete'){if(t.closed===null)throw fail('Close this ticket first.',409);db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM user_ticket_messages WHERE ticket=?').run(id);db.prepare('DELETE FROM user_ticket_sellers WHERE ticket=?').run(id);db.prepare('DELETE FROM user_tickets WHERE id=?').run(id);audit(actor,'user-ticket-delete',id);db.exec('COMMIT');return {ok:true};}catch(e){db.exec('ROLLBACK');throw e;}}
  active(t);
  {
   if(t.admin!==actor)throw fail('Accept this ticket first.',409);
   db.exec('BEGIN IMMEDIATE');try{
    if(action==='assign'){if(assignedSellers(id).includes(seller)&&isSeller(seller)){db.exec('COMMIT');return view(id,actor,true);}if(!isSeller(seller)||seller===t.owner)throw fail('Seller unavailable.',404);db.prepare('INSERT INTO user_ticket_sellers(ticket,seller) VALUES(?,?)').run(id,seller);db.prepare('INSERT INTO user_ticket_messages VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,actor,'system','Seller has joined the ticket.',now(),randomUUID());}
    else if(action==='remove'){if(!assignedSellers(id).includes(seller))throw fail('Seller unavailable.',404);db.prepare('DELETE FROM user_ticket_sellers WHERE ticket=? AND seller=?').run(id,seller);db.prepare('INSERT INTO user_ticket_messages VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,actor,'system','Seller has left the ticket.',now(),randomUUID());}
    else if(action==='transfer'){if(!isAdmin(seller)||seller===actor)throw fail('Administrator unavailable.',404);db.prepare('UPDATE user_tickets SET admin=? WHERE id=?').run(seller,id);}
    else if(action==='share'){if(!isSeller(seller)||seller===t.owner||typeof code!=='string'||!/^[A-Z0-9]{6}$/.test(code))throw fail('Seller unavailable.',404);db.prepare('INSERT INTO user_ticket_messages VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,actor,'admin','Seller connection code: '+code,now(),randomUUID());}
    else if(action==='close')db.prepare('UPDATE user_tickets SET closed=? WHERE id=?').run(now()||1,id);
    else throw fail('Invalid ticket action.');
    touch(t);audit(actor,'user-ticket-'+action,id,seller||t.owner);db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
  }
  return view(id,actor,true);
 }
 function list(actor,admin=false,archived=false,scope='all'){
  if(admin&&!isAdmin(actor))throw fail('Admin required.',403);
  if(!['all','claim','mine'].includes(scope))throw fail('Invalid ticket queue.');
  const rows=admin
   ? archived
     ? db.prepare('SELECT * FROM user_tickets WHERE closed IS NOT NULL ORDER BY closed DESC,id LIMIT 200').all()
     : db.prepare('SELECT * FROM user_tickets WHERE closed IS NULL ORDER BY updated DESC,id').all()
   : db.prepare('SELECT * FROM user_tickets WHERE closed IS NULL AND (owner=? OR id IN (SELECT ticket FROM user_ticket_sellers WHERE seller=?)) ORDER BY updated DESC LIMIT 100').all(actor,actor);
  const available=new Map();
  const entries=rows.filter(t=>admin||t.owner===actor||isSeller(actor)).map(t=>{
   if(!available.has(t.admin))available.set(t.admin,assigneeAvailable(t));
   const assigned=t.closed!==null?Boolean(t.admin):available.get(t.admin);
   return {t,assigned,claimable:t.closed===null&&!assigned};
  });
  if(admin&&!archived){
   const priority=entry=>entry.claimable?0:entry.t.admin===actor?1:2;
   entries.sort((a,b)=>priority(a)-priority(b)||(a.claimable&&b.claimable?a.t.created-b.t.created:0));
  }
  return entries.filter(e=>!admin||archived||scope==='all'||(scope==='claim'?e.claimable:e.assigned&&e.t.admin===actor)).slice(0,admin?200:100).map(({t,assigned,claimable})=>{
   const members=t.closed!==null&&t.closed<=closedCutoff()?[]:assignedSellers(t.id);
   return {id:t.id,topic:t.topic,updated:t.updated,created:t.created,closed:t.closed,assigned,mine:admin?'admin':t.owner===actor?'customer':'seller',owner:admin?t.owner:undefined,admin:admin?t.admin:undefined,claimable:admin?claimable:undefined,seller:admin?members[0]||null:Boolean(members.length),sellers:admin?members:undefined};
  });
 }
 function workload(actor){
  const counts={userTickets:0,claimableTickets:0,assignedTickets:0};
  for(const row of db.prepare('SELECT admin,count(*) AS total FROM user_tickets WHERE closed IS NULL GROUP BY admin').all()){
   counts.userTickets+=row.total;
   if(!assigneeAvailable(row))counts.claimableTickets+=row.total;
   else if(row.admin===actor)counts.assignedTickets+=row.total;
  }
  return counts;
 }
 function erase(id){db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM user_ticket_messages WHERE ticket IN (SELECT id FROM user_tickets WHERE owner=?) OR actor=?').run(id,id);db.prepare('DELETE FROM user_ticket_sellers WHERE seller=? OR ticket IN (SELECT id FROM user_tickets WHERE owner=?)').run(id,id);db.prepare('DELETE FROM user_tickets WHERE owner=?').run(id);db.prepare('UPDATE user_tickets SET admin=NULL WHERE admin=?').run(id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 return {open,view,send,adminAction,list,sweep,erase,workload,completions(actor){return db.prepare('SELECT id FROM user_tickets WHERE closed IS NOT NULL AND closed>? AND (owner=? OR id IN (SELECT ticket FROM user_ticket_sellers WHERE seller=?)) ORDER BY closed DESC LIMIT 100').all(now()-DAY,actor,actor).map(r=>r.id);},recipients(id){const t=get(id);return [...new Set([t.owner,assigneeAvailable(t)?t.admin:null,...assignedSellers(id).filter(isSeller)].filter(Boolean))];},count(){return db.prepare('SELECT count(*) n FROM user_tickets WHERE closed IS NULL').get().n;}};
}
