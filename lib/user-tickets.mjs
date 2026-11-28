import {randomUUID} from 'node:crypto';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const DAY=86400000;
export function userTickets(db,{now=Date.now,isSeller=()=>false,isAdmin=()=>false,role=()=>null}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS user_tickets(id TEXT PRIMARY KEY,owner TEXT NOT NULL,topic TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,closed INTEGER,admin TEXT,seller TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS user_ticket_active ON user_tickets(owner) WHERE closed IS NULL;
 CREATE TABLE IF NOT EXISTS user_ticket_messages(id TEXT PRIMARY KEY,ticket TEXT NOT NULL,actor TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL,request_id TEXT NOT NULL,UNIQUE(ticket,actor,request_id));
 CREATE TABLE IF NOT EXISTS user_ticket_sellers(ticket TEXT NOT NULL, seller TEXT NOT NULL, PRIMARY KEY(ticket,seller));
 INSERT OR IGNORE INTO user_ticket_sellers SELECT id,seller FROM user_tickets WHERE seller IS NOT NULL;`);
 // Clear the legacy column so a removed assignment cannot be resurrected at startup.
 db.prepare('UPDATE user_tickets SET seller=NULL WHERE seller IS NOT NULL').run();
 const assignedSellers=id=>db.prepare('SELECT seller FROM user_ticket_sellers WHERE ticket=? ORDER BY seller').all(id).map(r=>r.seller);
 const audit=(actor,action,id)=>db.prepare('INSERT INTO access_audit(actor,action,account,at,reason) VALUES(?,?,?,?,?)').run(actor,action,null,now(),id);
 const get=id=>{const t=db.prepare('SELECT * FROM user_tickets WHERE id=?').get(typeof id==='string'?id:'');if(!t)throw fail('Ticket unavailable.',404);return t;};
 function permission(t,actor,admin){if(admin&&isAdmin(actor))return 'admin';if(t.owner===actor)return 'customer';if(assignedSellers(t.id).includes(actor)&&isSeller(actor))return 'seller';throw fail('Ticket unavailable.',404);}
 const active=t=>{if(t.closed!==null)throw fail('Ticket is closed.',409);};
 const touch=t=>db.prepare('UPDATE user_tickets SET updated=? WHERE id=?').run(now(),t.id);
 function sweep(){
  db.exec('BEGIN IMMEDIATE');try{const where='closed IS NULL AND updated<=?';db.prepare('DELETE FROM user_ticket_sellers WHERE ticket IN (SELECT id FROM user_tickets WHERE '+where+')').run(now()-90*DAY);db.prepare('DELETE FROM user_ticket_messages WHERE ticket IN (SELECT id FROM user_tickets WHERE '+where+')').run(now()-90*DAY);db.prepare('DELETE FROM user_tickets WHERE '+where).run(now()-90*DAY);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 }
 function view(id,actor,admin=false){
  const t=get(id),mine=permission(t,actor,admin);
  const members=assignedSellers(id);
  const messages=t.closed!==null&&!admin?[]:db.prepare('SELECT id,actor,kind,text,at FROM user_ticket_messages WHERE ticket=? ORDER BY at,rowid').all(id).map(m=>({id:m.id,kind:m.kind,text:m.text,at:m.at,mine:m.actor===actor,role:m.kind==='admin'?'admin':m.kind==='seller'&&role(m.actor)==='verified-seller'?'verified-seller':m.kind==='seller'?'seller':m.kind==='system'?'system':'customer'}));
  return {id:t.id,topic:t.topic,created:t.created,updated:t.updated,closed:t.closed,assigned:Boolean(t.admin),seller:admin?members[0]||null:Boolean(members.length),sellers:admin?members:undefined,owner:admin?t.owner:undefined,canReply:t.closed===null&&(mine!=='admin'||t.admin===actor),mine,messages};
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
  const id=randomUUID(),t=now();db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO user_tickets(id,owner,topic,created,updated) VALUES(?,?,?,?,?)').run(id,owner,topic,t,t);db.prepare('INSERT INTO user_ticket_messages VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,owner,'customer',text.trim(),t,requestId);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return view(id,owner);
 }
 function adminAction(id,actor,action,seller=null,code=null){
  const t=get(id);if(!isAdmin(actor))throw fail('Admin required.',403);
  if(action==='delete'){if(t.closed===null)throw fail('Close this ticket first.',409);db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM user_ticket_messages WHERE ticket=?').run(id);db.prepare('DELETE FROM user_ticket_sellers WHERE ticket=?').run(id);db.prepare('DELETE FROM user_tickets WHERE id=?').run(id);audit(actor,'user-ticket-delete',id);db.exec('COMMIT');return {ok:true};}catch(e){db.exec('ROLLBACK');throw e;}}
  active(t);
  if(action==='accept'){if(t.admin&&t.admin!==actor)throw fail('Already assigned.',409);db.prepare('UPDATE user_tickets SET admin=?,updated=? WHERE id=?').run(actor,now(),id);}
  else{
   if(t.admin!==actor)throw fail('Accept this ticket first.',409);
   db.exec('BEGIN IMMEDIATE');try{
    if(action==='assign'){if(assignedSellers(id).includes(seller)&&isSeller(seller)){db.exec('COMMIT');return view(id,actor,true);}if(!isSeller(seller)||seller===t.owner)throw fail('Seller unavailable.',404);db.prepare('INSERT INTO user_ticket_sellers(ticket,seller) VALUES(?,?)').run(id,seller);db.prepare('INSERT INTO user_ticket_messages VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,actor,'system','Seller has joined the ticket.',now(),randomUUID());}
    else if(action==='remove'){if(!assignedSellers(id).includes(seller))throw fail('Seller unavailable.',404);db.prepare('DELETE FROM user_ticket_sellers WHERE ticket=? AND seller=?').run(id,seller);db.prepare('INSERT INTO user_ticket_messages VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,actor,'system','Seller has left the ticket.',now(),randomUUID());}
    else if(action==='transfer'){if(!isAdmin(seller)||seller===actor)throw fail('Administrator unavailable.',404);db.prepare('UPDATE user_tickets SET admin=? WHERE id=?').run(seller,id);}
    else if(action==='share'){if(!isSeller(seller)||seller===t.owner||typeof code!=='string'||!/^[A-Z0-9]{6}$/.test(code))throw fail('Seller unavailable.',404);db.prepare('INSERT INTO user_ticket_messages VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,actor,'admin','Seller connection code: '+code,now(),randomUUID());}
    else if(action==='close')db.prepare('UPDATE user_tickets SET closed=? WHERE id=?').run(now()||1,id);
    else throw fail('Invalid ticket action.');
    touch(t);audit(actor,'user-ticket-'+action,id);db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
  }
  return view(id,actor,true);
 }
 function list(actor,admin=false,archived=false){
  if(admin&&!isAdmin(actor))throw fail('Admin required.',403);
  const rows=admin?db.prepare('SELECT id FROM user_tickets WHERE closed IS '+(archived?'NOT NULL':'NULL')+' ORDER BY updated DESC LIMIT 200').all():db.prepare('SELECT id FROM user_tickets WHERE closed IS NULL AND (owner=? OR id IN (SELECT ticket FROM user_ticket_sellers WHERE seller=?)) ORDER BY updated DESC LIMIT 100').all(actor,actor);
  return rows.filter(({id})=>admin||get(id).owner===actor||isSeller(actor)).map(({id})=>{const t=get(id);const access=permission(t,actor,admin);return {id,topic:t.topic,updated:t.updated,created:t.created,closed:t.closed,assigned:Boolean(t.admin),mine:access,owner:admin?t.owner:undefined,seller:admin?assignedSellers(id)[0]||null:Boolean(assignedSellers(id).length),sellers:admin?assignedSellers(id):undefined};});
 }
 function erase(id){db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM user_ticket_messages WHERE ticket IN (SELECT id FROM user_tickets WHERE owner=?) OR actor=?').run(id,id);db.prepare('DELETE FROM user_ticket_sellers WHERE seller=? OR ticket IN (SELECT id FROM user_tickets WHERE owner=?)').run(id,id);db.prepare('DELETE FROM user_tickets WHERE owner=?').run(id);db.prepare('UPDATE user_tickets SET admin=NULL WHERE admin=?').run(id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 return {open,view,send,adminAction,list,sweep,erase,recipients(id){const t=get(id);return [...new Set([t.owner,t.admin,...assignedSellers(id).filter(isSeller)].filter(Boolean))];},count(){return db.prepare('SELECT count(*) n FROM user_tickets WHERE closed IS NULL').get().n;}};
}
