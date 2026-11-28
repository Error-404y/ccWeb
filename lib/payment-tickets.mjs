import {randomUUID} from 'node:crypto';
import {invoiceStatus} from './access.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const DAY=86400000;
export function initPaymentTickets(db){
 const fields=new Set(db.prepare('PRAGMA table_info(access_invoices)').all().map(r=>r.name));
 if(!fields.has('ticket_required'))db.exec('ALTER TABLE access_invoices ADD COLUMN ticket_required INTEGER NOT NULL DEFAULT 0');
 if(!fields.has('ticket_released'))db.exec('ALTER TABLE access_invoices ADD COLUMN ticket_released INTEGER');
 db.exec(`CREATE TABLE IF NOT EXISTS payment_tickets(invoice TEXT PRIMARY KEY,created INTEGER NOT NULL,updated INTEGER NOT NULL,closed INTEGER);
 CREATE TABLE IF NOT EXISTS payment_ticket_messages(id TEXT PRIMARY KEY,invoice TEXT NOT NULL,actor TEXT NOT NULL,at INTEGER NOT NULL,text TEXT NOT NULL,proof BLOB,request_id TEXT NOT NULL,UNIQUE(invoice,actor,request_id));
 CREATE INDEX IF NOT EXISTS payment_ticket_messages_invoice ON payment_ticket_messages(invoice,at);
 CREATE INDEX IF NOT EXISTS payment_tickets_updated ON payment_tickets(updated);`);
}
function cleanProof(value){
 if(value==null)return null;
 if(typeof value!=='string'||value.length>2800000||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw fail('Invalid proof image.');
 const bytes=Buffer.from(value,'base64');
 if(bytes.length>2*1024*1024||bytes.length<45||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw fail('Choose a PNG proof image under 2 MB.');
 const parts=[bytes.subarray(0,8)];let pos=8,header=false,data=false,ended=false;
 while(pos+12<=bytes.length){
  const size=bytes.readUInt32BE(pos),end=pos+size+12,type=bytes.toString('ascii',pos+4,pos+8);if(end>bytes.length)throw fail('Invalid PNG.');
  if(!header&&type!=='IHDR')throw fail('Invalid PNG.');
  if(type==='IHDR'){if(header||size!==13)throw fail('Invalid PNG.');const w=bytes.readUInt32BE(pos+8),h=bytes.readUInt32BE(pos+12);if(!w||!h||w>2048||h>2048)throw fail('Proof dimensions too large.');header=true;}
  if(type==='IDAT')data=true;
  if(['IHDR','PLTE','IDAT','IEND','tRNS'].includes(type))parts.push(bytes.subarray(pos,end));
  else if(!/^[a-z]/.test(type))throw fail('Unsupported PNG.');
  pos=end;if(type==='IEND'){if(size!==0)throw fail('Invalid PNG.');ended=true;break;}
 }
 if(!header||!data||!ended)throw fail('Invalid PNG.');
 return Buffer.concat(parts);
}
export function paymentTickets(db,now=Date.now){
 function row(id){const r=db.prepare('SELECT * FROM access_invoices WHERE id=?').get(id);if(!r||!r.coin)throw fail('Payment order unavailable.',404);return r;}
 function ticket(id){const t=db.prepare('SELECT * FROM payment_tickets WHERE invoice=?').get(id);if(!t)throw fail('Ticket unavailable.',404);return t;}
 function sweep(){db.exec('BEGIN IMMEDIATE');try{
  db.prepare('DELETE FROM payment_ticket_messages WHERE invoice IN (SELECT invoice FROM payment_tickets WHERE (closed IS NOT NULL AND closed<?) OR updated<?)').run(now()-7*DAY,now()-90*DAY);
  db.prepare('DELETE FROM payment_tickets WHERE (closed IS NOT NULL AND closed<?) OR updated<?').run(now()-7*DAY,now()-90*DAY);
  db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 function open(id){const r=row(id);if(r.redeemed||['rejected','cancelled','revoked'].includes(r.state))throw fail('This order is closed.',409);
  const existing=db.prepare('SELECT * FROM payment_tickets WHERE invoice=?').get(id);if(existing)return existing;
  if(now()>r.expires+7*DAY&&r.state==='pending')throw fail('Contact support with your original order reference.',409);
  db.prepare('INSERT OR IGNORE INTO payment_tickets(invoice,created,updated) VALUES(?,?,?)').run(id,now(),now());return ticket(id);
 }
 function view(id,customerSecret=null){
  const t=ticket(id),r=row(id);
  return {id,created:t.created,updated:t.updated,closed:Boolean(t.closed||r.redeemed),plan:r.plan,coin:r.coin,usd:(r.usd_cents/100).toFixed(2),amount:(r.amount_atomic/10**(r.coin==='SOL'?9:8)).toFixed(r.coin==='SOL'?9:8),state:r.state,txid:r.txid,confirmations:r.confirmations,released:Boolean(r.ticket_released),redeemed:Boolean(r.redeemed),activationKey:customerSecret&&r.ticket_released&&!r.redeemed?invoiceStatus(db,customerSecret,now()).activationKey:null,messages:db.prepare('SELECT id,actor,at,text,CASE WHEN proof IS NULL THEN 0 ELSE 1 END AS hasProof FROM payment_ticket_messages WHERE invoice=? ORDER BY at,rowid LIMIT 200').all(id)};
 }
 function send(id,actor,{text='',proof=null,requestId}={}){
  const t=ticket(id),r=row(id);
  if(t.closed||r.redeemed||r.state==='cancelled')throw fail('Ticket closed.',409);
  if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(requestId)||typeof text!=='string'||text.length>2000)throw fail('Invalid message.');
  if(db.prepare('SELECT id FROM payment_ticket_messages WHERE invoice=? AND actor=? AND request_id=?').get(id,actor,requestId))return {ok:true};
  const image=cleanProof(proof);if(!text.trim()&&!image)throw fail('Enter a message or attach proof.');
  if(actor!=='customer'&&image)throw fail('Proof uploads are customer-only.');
  if(db.prepare('SELECT count(*) n FROM payment_ticket_messages WHERE invoice=?').get(id).n>=200)throw fail('Ticket message limit reached.',429);
  if(image&&(db.prepare('SELECT count(*) n FROM payment_ticket_messages WHERE invoice=? AND proof IS NOT NULL').get(id).n>=5||db.prepare('SELECT COALESCE(sum(length(proof)),0) n FROM payment_ticket_messages').get().n+image.length>50*1024*1024))throw fail('Proof upload limit reached.',429);
  db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO payment_ticket_messages(id,invoice,actor,at,text,proof,request_id) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,actor,now(),text.trim(),image,requestId);db.prepare('UPDATE payment_tickets SET updated=? WHERE invoice=?').run(now(),id);db.exec('COMMIT');return {ok:true};}catch(e){db.exec('ROLLBACK');throw e;}
 }
 function release(id,actor){
  const t=ticket(id),r=row(id);
  if(t.closed||r.redeemed||r.state!=='confirmed'||!r.verified_at||!r.txid)throw fail('Blockchain verification is required before releasing the key.',409);
  if(r.ticket_released)return {ok:true};
  db.exec('BEGIN IMMEDIATE');try{
   db.prepare('UPDATE access_invoices SET ticket_released=? WHERE id=? AND ticket_released IS NULL').run(now()||1,id);
   db.prepare('INSERT INTO access_audit(actor,action,key_id,account,at,reason) VALUES(?,?,?,?,?,?)').run(actor,'release-payment-key',id,r.account,now(),'Verified blockchain payment');
   db.prepare('UPDATE payment_tickets SET updated=? WHERE invoice=?').run(now(),id);db.exec('COMMIT');return {ok:true};
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 function close(id,actor){const t=ticket(id),r=row(id);if(t.closed)return {ok:true};if(!r.redeemed&&!r.ticket_released)throw fail('Resolve payment before closing this ticket.',409);db.prepare('UPDATE payment_tickets SET closed=?,updated=? WHERE invoice=?').run(now()||1,now(),id);return {ok:true};}
 return {sweep,open,view,send,release,close,proof(id,message){ticket(id);return db.prepare('SELECT proof FROM payment_ticket_messages WHERE invoice=? AND id=? AND proof IS NOT NULL').get(id,message)?.proof||null;},list(){return db.prepare("SELECT t.invoice AS id,t.updated,t.closed,i.plan,i.coin,i.usd_cents,i.state,i.ticket_released,i.redeemed,i.txid,i.confirmations FROM payment_tickets t JOIN access_invoices i ON i.id=t.invoice ORDER BY CASE WHEN t.closed IS NULL AND i.redeemed IS NULL THEN 0 ELSE 1 END,t.updated DESC LIMIT 100").all();}};
}
