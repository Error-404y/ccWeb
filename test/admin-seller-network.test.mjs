import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,sign,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {openAccounts,createAccount,digest} from '../lib/accounts.mjs';
import {initDevices} from '../lib/devices.mjs';
import {initAccess,redeemAccess,accessStatus,createSupportKey} from '../lib/access.mjs';
import {createControlSessions} from '../lib/control.mjs';
import {sellerStore,SELLER_TTL} from '../lib/sellers.mjs';
import {userTickets} from '../lib/user-tickets.mjs';
import {desktopMessenger} from '../lib/desktop-messenger.mjs';
import {Chats} from '../lib/chats.mjs';
import {contactStore} from '../lib/contacts.mjs';
import {officialStore} from '../lib/official.mjs';
import {complianceStore} from '../lib/compliance.mjs';
const start=Date.UTC(2026,10,28);
function setup(){const db=openAccounts(':memory:');initDevices(db);initAccess(db);complianceStore(db);return db;}
function signer(){const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const j=pair.publicKey.export({format:'jwk'});const pub=Buffer.concat([Buffer.from([4]),Buffer.from(j.x,'base64url'),Buffer.from(j.y,'base64url')]).toString('base64');return {pub,device:createHash('sha256').update(Buffer.from(pub,'base64')).digest('hex'),record(room,key=pub){return {identity:pub,key,signature:sign('sha256',Buffer.from(JSON.stringify(['qzu-room-key-v1',room,key])),pair.privateKey).toString('base64')};}};}
test('seller activation is mobile-only, single-use, permanent and separate from admin keys',()=>{
 const db=setup();try{
 let now=start;const codes=['AAAAAA','BBBBBB','CCCCCC'],s=sellerStore(db,{now:()=>now,generate:()=>codes.shift()}),chats=new Chats(()=>now);chats.sellerInvites=s;
 const {key}=s.generateKey('admin');assert.match(key,/^QZU-SELLER-[A-F0-9]{48}$/);
 assert.equal(db.prepare('SELECT hash FROM seller_keys').get().hash,digest(key));
 assert.throws(()=>redeemAccess(db,key,now));assert.throws(()=>createControlSessions(db,()=>now).login(key,''));
 const a=redeemAccess(db,key,now,'seller-device');assert.throws(()=>redeemAccess(db,key,now,'different-device'));
 assert.equal(db.prepare('SELECT access_plan FROM accounts WHERE id=?').get(a.id).access_plan,'seller');
 assert.equal(accessStatus(db.prepare('SELECT * FROM accounts WHERE id=?').get(a.id),now+100*SELLER_TTL).active,true);
 assert.equal(s.role(a.id),null);s.verify(a.id,true,'admin');assert.equal(s.role(a.id),'verified-seller');s.verify(a.id,false,'admin');assert.equal(s.role(a.id),null);
 const first=chats.ensureInvite(a.id);assert.deepEqual(first,{code:'AAAAAA',expires:start+SELLER_TTL});
 assert.deepEqual(chats.newCode(a.id,5),first);
 const afterRestart=new Chats(()=>now);afterRestart.sellerInvites=s;s.sync(afterRestart);assert.deepEqual(afterRestart.ensureInvite(a.id),first);
 now+=SELLER_TTL;const next=afterRestart.ensureInvite(a.id);assert.equal(next.code,'BBBBBB');assert.throws(()=>afterRestart.requestConnection('user','AAAAAA'));assert.equal(s.list(afterRestart)[0].code,'BBBBBB');assert.ok(s.reserved('AAAAAA'));
 db.prepare('UPDATE accounts SET access_revoked=1 WHERE id=?').run(a.id);s.sync(afterRestart);assert.equal(afterRestart.codes.has(next.code),false);assert.equal(s.list(afterRestart)[0].code,null);
 }finally{db.close();}
});
test('tickets are one per customer, admin first, seller restricted to assigned ticket, and archive read-only',()=>{
 const db=setup();try{
 let now=start;const s=sellerStore(db,{now:()=>now});const seller=redeemAccess(db,s.generateKey('admin').key,now,'seller-device').id;
 const t=userTickets(db,{now:()=>now,isAdmin:id=>id==='admin'||id==='other-admin',isSeller:id=>s.isActive(id),role:id=>s.role(id)});
 const a=t.open('customer','Request a Seller','Hello',randomUUID());assert.equal(t.open('customer','Other','Duplicate',randomUUID()).id,a.id);assert.equal(t.count(),1);
 assert.throws(()=>t.view(a.id,seller));assert.throws(()=>t.view(a.id,'stranger'));assert.throws(()=>t.adminAction(a.id,seller,'accept'));
 assert.throws(()=>t.send(a.id,'admin',true,'Before acceptance',randomUUID()));
 t.adminAction(a.id,'admin','accept');assert.throws(()=>t.adminAction(a.id,'other-admin','accept'));assert.throws(()=>t.adminAction(a.id,'other-admin','assign',seller));
 t.adminAction(a.id,'admin','assign',seller);assert.equal(t.view(a.id,seller).mine,'seller');
 const requestId=randomUUID();t.send(a.id,seller,false,'Hello customer',requestId);t.send(a.id,seller,false,'Hello customer',requestId);
 assert.equal(t.view(a.id,'customer').messages.filter(m=>m.text==='Hello customer').length,1);
 s.verify(seller,true,'admin');assert.equal(t.view(a.id,'customer').messages.at(-1).role,'verified-seller');s.verify(seller,false,'admin');assert.equal(t.view(a.id,'customer').messages.at(-1).role,'seller');
 t.adminAction(a.id,'admin','share',seller,'ABC234');assert.equal(t.view(a.id,'customer').messages.at(-1).text,'Seller connection code: ABC234');
 t.adminAction(a.id,'admin','close');assert.equal(t.count(),0);assert.equal(t.list('admin',true,true)[0].id,a.id);assert.throws(()=>t.send(a.id,'customer',false,'closed',randomUUID()));
 assert.notEqual(t.open('customer','Other','Another request',randomUUID()).id,a.id);
 now+=7*86400000;t.sweep();assert.throws(()=>t.view(a.id,'customer'));assert.equal(t.count(),1);
 }finally{db.close();}
});
test('announcement deletion removes record for every reader without placeholder, and requires admin',()=>{
 const db=setup();try{const o=officialStore(db,()=>start);const a=o.publish('First',true),b=o.publish('Second',true);assert.throws(()=>o.remove(a.id,false));o.remove(a.id,true);assert.equal(o.snapshot('customer').posts.length,1);assert.equal(o.snapshot('customer').posts[0].id,b.id);assert.equal(o.snapshot('other').deletedRevision,1);assert.equal(o.history(b.id).posts.length,0);o.remove(a.id,true);assert.equal(o.snapshot('customer').deletedRevision,1);}finally{db.close();}
});
test('desktop admin uses distinct signed identity; direct room remains encrypted, other accounts cannot access it',()=>{
 const db=setup();try{
 const chats=new Chats(()=>start);chats.contacts=contactStore(db,()=>start);
 const admin=createAccount(db,'native-device');const browser=signer(),mobile=signer();const user=createAccount(db,mobile.device);let authorized=true;
 const d=desktopMessenger(db,chats,id=>id===admin.id&&authorized,()=>start);chats.desktopPrincipal=id=>Boolean(d.principal(id));chats.validParticipant=id=>d.valid(id);chats.profileRole=id=>d.role(id);
 assert.throws(()=>d.bind(user.id,browser.record('desktop:'+user.id)));d.bind(admin.id,browser.record('desktop:'+admin.id));
 assert.throws(()=>d.bind(admin.id,signer().record('desktop:'+admin.id)));
 const p=d.requireIdentity(admin.id);assert.notEqual(p.principal,admin.id);const code=d.state(admin.id).invite.code;
 chats.requestConnection(user.id,code);const req=d.state(admin.id).requests[0];const {id}=chats.respondConnection(p.principal,req.id,true);
 assert.ok(chats.rooms.get(id).encryption);assert.throws(()=>chats.send(p.principal,id,'plaintext'));
 assert.throws(()=>chats.requireRoom(admin.id,id));assert.throws(()=>chats.requireRoom('stranger',id));
 assert.throws(()=>chats.publishRoomKey(p.principal,id,p.device,mobile.record(id)));
 chats.publishRoomKey(p.principal,id,p.device,browser.record(id));chats.publishRoomKey(user.id,id,mobile.device,mobile.record(id));
 const records=[browser.record(id),mobile.record(id)];const safety=createHash('sha256').update(JSON.stringify(['qzu-safety-v1',id,...records.map(r=>JSON.stringify([r.identity,r.key])).sort()])).digest('hex').toUpperCase();
 chats.confirmRoomKey(p.principal,id,safety);chats.confirmRoomKey(user.id,id,safety);
 const cipher={v:2,iv:Buffer.alloc(12,1).toString('base64'),data:Buffer.alloc(20,2).toString('base64')};
 chats.sendEncrypted(p.principal,id,cipher,'text');assert.equal(chats.rooms.get(id).messages[0].text,'');assert.deepEqual(chats.snapshot(user.id)[0].messages[0].cipher,cipher);assert.equal(chats.snapshot(user.id)[0].peerRole,'admin');
 authorized=false;assert.throws(()=>d.state(admin.id));assert.throws(()=>chats.requireRoom(user.id,id));
 }finally{db.close();}
});
test('new desktop routes sit behind admin auth; mobile ticket UI is integrated',()=>{
 const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8'),app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const gate=server.indexOf("app.use('/api/control',(req,res,next)=>");
 for(const path of ['/api/control/sellers','/api/control/chats','/api/control/tickets','/api/control/announcements'])assert.ok(server.indexOf("app.get('"+path+"'")>gate);
 assert.ok(html.includes('data-tab="tickets"'));assert.ok(app.includes('QZU-SELLER-'));assert.ok(app.includes('deletedRevision'));
});
