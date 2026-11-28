import {createHash,randomUUID} from 'node:crypto';
import {validRoomKey} from './encryption.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export function desktopMessenger(db,chats,isAdmin,now=Date.now){
 db.exec('CREATE TABLE IF NOT EXISTS desktop_messenger(admin TEXT PRIMARY KEY,principal TEXT NOT NULL UNIQUE,identity TEXT NOT NULL,device TEXT NOT NULL UNIQUE)');
 const row=admin=>db.prepare('SELECT * FROM desktop_messenger WHERE admin=?').get(admin);
 const principal=id=>db.prepare('SELECT * FROM desktop_messenger WHERE principal=?').get(id);
 function bind(admin,record){
  if(!isAdmin(admin)||typeof record?.identity!=='string'||record.identity.length!==88)throw fail('Admin identity unavailable.',403);
  const device=createHash('sha256').update(Buffer.from(record.identity,'base64')).digest('hex');
  if(record.key!==record.identity||!validRoomKey('desktop:'+admin,device,record))throw fail('Invalid signed desktop identity.',403);
  const existing=row(admin);
  if(existing&&existing.device!==device)throw fail('This admin messenger is paired with another browser. Use that browser or reset the messenger identity.',409);
  if(!existing)db.prepare('INSERT INTO desktop_messenger VALUES(?,?,?,?)').run(admin,randomUUID(),record.identity,device);
  return {ok:true};
 }
 function requireIdentity(admin){if(!isAdmin(admin))throw fail('Admin required.',403);const p=row(admin);if(!p)throw fail('Set up desktop messenger first.',409);return p;}
 function state(admin){
  const p=requireIdentity(admin),id=p.principal;
  const inv=chats.ensureInvite(id);if(inv){const entry=chats.codes.get(inv.code);if(entry)entry.desktop=true;}
  return {invite:inv,rooms:chats.snapshot(id).filter(r=>r.encryption&&!r.admin&&!r.group&&!r.support),contacts:chats.contacts.list(id),requests:chats.connectionRequests(id).filter(r=>!r.group)};
 }
 function reset(admin){const p=requireIdentity(admin);chats.erase(p.principal);db.prepare('DELETE FROM desktop_messenger WHERE admin=?').run(admin);return {ok:true};}
 return {bind,requireIdentity,state,reset,principal,role:id=>{const p=principal(id);return p&&isAdmin(p.admin)?'admin':null;},valid:id=>{const p=principal(id);return !p||isAdmin(p.admin);},erase(admin){const p=row(admin);if(p){chats.erase(p.principal);db.prepare('DELETE FROM desktop_messenger WHERE admin=?').run(admin);}}};
}
