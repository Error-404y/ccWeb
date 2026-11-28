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
 now+=7*86400000;t.sweep();assert.equal(t.view(a.id,'customer').messages.length,0);assert.ok(!t.list('customer').some(x=>x.id===a.id));assert.equal(t.list('admin',true,true)[0].id,a.id);assert.equal(t.count(),1);
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

test('multiple sellers, transfer, immediate removal and permanent archive',()=>{
 const db=setup();try{
 const admins=new Set(['a','b']), sellers=new Set(['s1','s2']);let now=start;
 const t=userTickets(db,{now:()=>now,isAdmin:id=>admins.has(id),isSeller:id=>sellers.has(id)});
 const {id}=t.open('owner','Other','Hello',randomUUID());t.adminAction(id,'a','accept');
 t.adminAction(id,'a','assign','s1');t.adminAction(id,'a','assign','s2');assert.deepEqual(t.view(id,'a',true).sellers,['s1','s2']);
 assert.ok(t.list('s2').some(x=>x.id===id));t.adminAction(id,'a','remove','s1');assert.throws(()=>t.view(id,'s1'));assert.equal(t.list('s1').length,0);assert.throws(()=>t.send(id,'s1',false,'bad',randomUUID()));
 t.adminAction(id,'a','transfer','b');assert.throws(()=>t.send(id,'a',true,'bad',randomUUID()));t.send(id,'b',true,'ok',randomUUID());
 assert.throws(()=>t.adminAction(id,'b','delete'));t.adminAction(id,'b','close');assert.equal(t.list('owner').length,0);assert.equal(t.list('s2').length,0);assert.deepEqual(t.view(id,'s2').messages,[]);
 now+=365*86400000;t.sweep();assert.equal(t.list('b',true,true).length,1);assert.throws(()=>t.adminAction(id,'s2','delete'));t.adminAction(id,'b','delete');assert.equal(t.list('b',true,true).length,0);
 }finally{db.close();}
});

test('seller directory reveals only public profile fields; rotating codes invalidates prior code',()=>{
 const db=setup();try{
 const s=sellerStore(db),chats=new Chats();chats.sellerInvites=s;
 const a=redeemAccess(db,s.generateKey('admin').key,start,'seller-one').id,b=redeemAccess(db,s.generateKey('admin').key,start,'seller-two').id;
 s.rename(b,'Example seller');s.verify(b,true,'admin');assert.throws(()=>s.rename(b,'qzu-Support'));assert.throws(()=>s.directory('stranger'));
 assert.deepEqual(s.directory(a),[{id:b,name:'Example seller',verified:true}]);
 const old=s.ensureCode(b,chats);const next=s.rotate(b,chats,'admin');assert.notEqual(next.code,old.code);assert.ok(!chats.codes.has(old.code));assert.ok(s.reserved(old.code));assert.throws(()=>chats.requestConnection(a,old.code));
 db.prepare('UPDATE accounts SET access_revoked=1 WHERE id=?').run(b);s.sync(chats);assert.deepEqual(s.directory(a),[]);assert.throws(()=>s.rename(b,'No'));assert.throws(()=>s.rotate(b,chats,'admin'));
 }finally{db.close();}
});
test('admin starts encrypted direct chat without request, user starts pending request, fixed name and no block',()=>{
 const db=setup();try{
 const c=new Chats();c.contacts=contactStore(db);c.profileRole=id=>id==='admin'?'admin':null;
 const code=c.ensureInvite('user').code;const first=c.requestConnection('admin',code);assert.ok(first.id);assert.equal(c.connectionRequests('user').length,0);assert.ok(c.rooms.get(first.id).encryption);assert.equal(c.requestConnection('admin',code).id,first.id);
 const contact=c.contacts.between('user','admin');assert.equal(contact.nickname,'qzu-Support');
 c.updateContact('user',contact.id,{nickname:'changed'});assert.equal(c.contacts.between('user','admin').nickname,'qzu-Support');
 assert.throws(()=>c.blockContact('user',first.id));assert.throws(()=>c.removeContact('user',contact.id,true));
 const adminCode=c.ensureInvite('admin').code;assert.deepEqual(c.requestConnection('other',adminCode),{pending:true});const req=c.connectionRequests('admin').find(x=>x.incoming);assert.ok(req);
 const accepted=c.respondConnection('admin',req.id,true);assert.ok(c.rooms.get(accepted.id).encryption);assert.equal(c.contacts.between('other','admin').nickname,'qzu-Support');
 }finally{db.close();}
});
test('legacy ticket seller migration preserves membership and never resurrects removed sellers',()=>{
 const db=setup();try{
 const options={isAdmin:id=>id==='admin',isSeller:id=>id==='seller'};
 const t=userTickets(db,options);const {id}=t.open('owner','Other','hello',randomUUID());t.adminAction(id,'admin','accept');
 db.prepare('UPDATE user_tickets SET seller=? WHERE id=?').run('seller',id);
 const migrated=userTickets(db,options);assert.equal(migrated.view(id,'seller').mine,'seller');migrated.adminAction(id,'admin','remove','seller');
 const restarted=userTickets(db,options);assert.throws(()=>restarted.view(id,'seller'));assert.deepEqual(restarted.view(id,'admin',true).sellers,[]);
 }finally{db.close();}
});

test('automatic desktop verification preserves signed key validation and does not mark manual trust',()=>{
 const db=setup();try{
 const c=new Chats(()=>start);c.contacts=contactStore(db,()=>start);c.requireEncryptedDirect=true;
 const a=signer(),b=signer(),bad=signer();
 const id=c.connectPair('admin','customer');c.rooms.get(id).contactId=c.contacts.add('admin','customer','Contact','qzu-Support');
 assert.throws(()=>c.publishRoomKey('admin',id,a.device,bad.record(id)));
 c.publishRoomKey('admin',id,a.device,a.record(id));
 assert.throws(()=>c.confirmRoomKey('admin',id,'0'.repeat(64),true));
 c.publishRoomKey('customer',id,b.device,b.record(id));
 const records=[a.record(id),b.record(id)];const code=createHash('sha256').update(JSON.stringify(['qzu-safety-v1',id,...records.map(r=>JSON.stringify([r.identity,r.key])).sort()])).digest('hex').toUpperCase();
 assert.throws(()=>c.confirmRoomKey('admin',id,'0'.repeat(64),true));
 assert.throws(()=>c.confirmRoomKey('stranger',id,code,true));
 c.confirmRoomKey('admin',id,code,true);c.confirmRoomKey('customer',id,code,true);
 assert.equal(c.contacts.between('admin','customer').identityVerified,false);
 assert.equal(c.contacts.between('admin','customer').peerIdentity,b.pub);
 const cipher={v:2,iv:Buffer.alloc(12,1).toString('base64'),data:Buffer.alloc(20,2).toString('base64')};
 c.sendEncrypted('admin',id,cipher);assert.equal(c.rooms.get(id).messages[0].text,'');
 assert.throws(()=>c.publishRoomKey('customer',id,bad.device,bad.record(id)));
 }finally{db.close();}
});
test('accepted and pending legacy deletion requests appear only in assigned admin inbox and survive restart',()=>{
 const db=setup();try{
 let c=new Chats(()=>start);c.attachSupportStore(db);
 const accepted=c.openMobileSupport('customer','admin',true),pending=c.openMobileSupport('other','admin');
 c.remove('customer',accepted);c.remove('customer',accepted);c.remove('other',pending);
 assert.equal(c.supportRequests('admin',true).length,0); // Deletion requests must not appear as new connection requests.
 assert.deepEqual(new Set(c.supportDeletions('admin',true).map(x=>x.id)),new Set([accepted,pending]));
 assert.equal(c.supportDeletions('another-admin',true).length,0);assert.throws(()=>c.supportDeletions('admin'));
 assert.throws(()=>c.approveSupportDeletion('another-admin',accepted,true));assert.throws(()=>c.approveSupportDeletion('admin',accepted,false));
 c=new Chats(()=>start);c.attachSupportStore(db);assert.equal(c.supportDeletions('admin',true).length,2);
 c.approveSupportDeletion('admin',accepted,true);c.approveSupportDeletion('admin',pending,true);assert.equal(c.supportDeletions('admin',true).length,0);assert.equal(db.prepare('SELECT count(*) n FROM mobile_support_rooms').get().n,0);
 }finally{db.close();}
});
test('desktop automatic verification and support deletion endpoints remain behind authenticated control routes',()=>{
 const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8'),desktop=readFileSync(new URL('../public/desktop-messenger.js',import.meta.url),'utf8'),control=readFileSync(new URL('../public/control.js',import.meta.url),'utf8');
 const gate=server.indexOf("app.use('/api/control',(req,res,next)=>");
 for(const path of ['/api/control/support/delete','/api/control/chats/delete','/api/control/chats/confirm'])assert.ok(server.indexOf("app.post('"+path+"'")>gate);
 assert.ok(desktop.includes("api('chats/confirm',{id,code:established.code})"));assert.ok(!desktop.includes('Confirm safety code'));assert.ok(control.includes('Approve deletion'));
});

test('structured audit captures only safe identifiers and preserves actor, source and outcome',async()=>{
 const {adminAudit}=await import('../lib/admin-audit.mjs');const db=setup();try{
 const audit=adminAudit(db,()=>start),actor=randomUUID(),target=randomUUID(),related=randomUUID();
 audit.record(actor,'mobile','tickets/action','ticket',target,related,'assign');
 audit.record(actor,'desktop','keys/generate','key','QZU-SECRET',null,'private text','rejected');
 const items=audit.list();assert.equal(items.length,2);assert.equal(items[0].target,null);assert.equal(items[0].detail,null);assert.equal(items[0].outcome,'rejected');
 assert.equal(items[1].actor,actor);assert.equal(items[1].source,'mobile');assert.equal(items[1].target,target);assert.equal(items[1].related,related);
 assert.equal(audit.list({q:target}).length,1);assert.equal(audit.list({before:items[0].id}).length,1);
 assert.throws(()=>audit.list({before:0}));
 }finally{db.close();}
});
test('native control requires signed device, unlocked admin and cannot use desktop encryption identity',()=>{
 const source=readFileSync(new URL('../server.mjs',import.meta.url),'utf8'),app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const gate=source.slice(source.indexOf("app.use('/api/control',(req,res,next)=>"),source.indexOf("app.post('/api/control/logout'"));
 assert.ok(gate.includes("req.account.access_plan!=='admin'"));assert.ok(gate.includes('unlocks.check'));assert.ok(gate.includes('isTicketAdmin'));assert.ok(gate.includes('Use your native messenger.'));
 assert.ok(app.includes("api('control/'+path,data,true)"));
});
test('ticket creator and actual message actor are visible to admins, not customer or seller',()=>{
 const db=setup();try{
 const t=userTickets(db,{isAdmin:id=>id==='admin'});const {id}=t.open('customer','Other','test',randomUUID());t.adminAction(id,'admin','accept');t.send(id,'admin',true,'hello',randomUUID());
 const a=t.view(id,'admin',true),c=t.view(id,'customer');assert.equal(a.owner,'customer');assert.equal(a.admin,'admin');assert.equal(a.messages[0].actor,'customer');assert.equal(a.messages[1].actor,'admin');assert.equal(c.admin,undefined);assert.equal(c.messages[1].actor,undefined);
 assert.equal(db.prepare("SELECT count(*) n FROM access_audit WHERE action IN ('user-ticket-create','user-ticket-accept')").get().n,2);
 }finally{db.close();}
});

test('mobile chat header includes the authoritative admin and seller verification badge alongside the name',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
 assert.match(html,/<div class="thread-name-line"><button id="profileName"[^>]*><span id="threadName">Chat<\/span><\/button><svg id="threadBadge"[^>]*hidden>/);
 assert.equal((html.match(/id="threadBadge"/g)||[]).length,1);
 assert.ok(app.includes("$('threadBadge').toggleAttribute('hidden',!(current?.peerRole==='admin'||current?.peerRole==='verified-seller'"));assert.ok(!app.includes("$('threadBadge').hidden ="));
 assert.ok(css.includes('#threadBadge:not([hidden])'));assert.ok(css.includes('#threadBadge[hidden]'));
});
test('desktop saved contacts use authenticated role and name without relying on editable nicknames',()=>{
 const db=setup();try{
 const chats=new Chats(()=>start);chats.contacts=contactStore(db,()=>start);
 const admin=createAccount(db),customer=createAccount(db),verified=createAccount(db),browser=signer();
 const d=desktopMessenger(db,chats,id=>id===admin.id,()=>start);
 d.bind(admin.id,browser.record('desktop:'+admin.id));const p=d.requireIdentity(admin.id);
 chats.profileRole=id=>id===verified.id?'verified-seller':d.role(id);
 chats.profileName=id=>id===verified.id?'Example seller':null;
 chats.contacts.add(p.principal,customer.id,'qzu-Support','Contact');
 chats.contacts.add(p.principal,verified.id,'Seller nickname','Contact');
 const contacts=d.state(admin.id).contacts;
 assert.equal(contacts.find(c=>c.nickname==='qzu-Support').peerRole,null);
 const seller=contacts.find(c=>c.nickname==='Seller nickname');assert.equal(seller.peerRole,'verified-seller');assert.equal(seller.peerName,'Example seller');
 }finally{db.close();}
});
test('desktop messenger retains encrypted send and view-once routes with contact search, add and chat header',()=>{
 const js=readFileSync(new URL('../public/desktop-messenger.js',import.meta.url),'utf8'),css=readFileSync(new URL('../public/control.css',import.meta.url),'utf8');
 for(const feature of ["Search contacts","+ Add contact","Saved contacts","Connection request","cc-chat-verified","scrollPositions","cc-chat-composer","QzuCrypto.encrypt(context,text)","api('chats/once/send'","api('chats/confirm'","Contact identity changed"])assert.ok(js.includes(feature),feature);
 assert.doesNotThrow(()=>new Function(js));assert.ok(css.includes('.cc-chat-verified.seller'));assert.ok(css.includes('.cc-chat-composer'));
});

test('ordinary contact deletion removes both contact entries and shared chats but chat deletion preserves contacts',()=>{
 const db=setup();try{
 const c=new Chats(()=>start);c.contacts=contactStore(db,()=>start);
 const id=c.contacts.add('a','b','B','A'),room=c.openContact('a',id);
 c.remove('a',room);assert.equal(c.rooms.has(room),false);assert.equal(c.contacts.list('b').length,1);
 const next=c.openContact('b',id);c.removeContact('a',id);assert.equal(c.contacts.list('a').length,0);assert.equal(c.contacts.list('b').length,0);assert.equal(c.rooms.has(next),false);
 }finally{db.close();}
});
test('customer deletion requests for admin contacts are scoped, idempotent, persistent and approval-only',()=>{
 const db=setup();try{
 const c=new Chats(()=>start);c.contacts=contactStore(db,()=>start);c.profileRole=id=>['admin','other-admin'].includes(id)?'admin':null;
 const id=c.contacts.add('customer','admin','qzu-Support','Customer'),room=c.openContact('customer',id);
 const a=c.remove('customer',room);assert.equal(a.requested,true);assert.equal(c.rooms.has(room),true);
 assert.equal(c.remove('customer',room).requestId,a.requestId);
 const b=c.removeContact('customer',id);assert.equal(b.requested,true);assert.equal(c.contacts.list('customer').length,1);
 assert.equal(c.directDeletionRequests('admin').length,2);assert.equal(c.directDeletionRequests('other-admin').length,0);
 assert.throws(()=>c.approveDirectDeletion('other-admin',a.requestId));assert.throws(()=>c.approveDirectDeletion('customer',b.requestId));
 c.approveDirectDeletion('admin',a.requestId);assert.equal(c.rooms.has(room),false);assert.equal(c.contacts.list('customer').length,1);
 const restarted=new Chats(()=>start);restarted.contacts=contactStore(db,()=>start);restarted.profileRole=c.profileRole;
 assert.equal(restarted.directDeletionRequests('admin')[0].id,b.requestId);
 restarted.approveDirectDeletion('admin',b.requestId);assert.equal(restarted.contacts.list('customer').length,0);assert.equal(restarted.contacts.list('admin').length,0);
 const next=restarted.contacts.add('customer','admin','qzu-Support','Customer');restarted.removeContact('admin',next);assert.equal(restarted.contacts.list('customer').length,0);
 }finally{db.close();}
});
test('ticket creation defaults to centered form and desktop supports distinct contact deletion',()=>{
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8'),desktop=readFileSync(new URL('../public/desktop-messenger.js',import.meta.url),'utf8');
 assert.ok(app.includes("if(!state.supportAgent&&!items.length){ticketLast='[]';renderNewUserTicket(true);return;}"));
 assert.ok(css.includes('.user-ticket-content>.user-ticket-form{margin-block:auto'));
 assert.ok(desktop.includes("api('chats/contact/delete',{id,confirmed:true})"));
 assert.doesNotThrow(()=>new Function(desktop));
});

test('support opening reuses an existing encrypted contact across admin principals and never creates a legacy case',()=>{
 const db=setup();try{const c=new Chats(()=>start);c.contacts=contactStore(db,()=>start);c.profileRole=id=>['admin','desktop','other-admin'].includes(id)?'admin':null;c.adminAccount=id=>id==='desktop'?'admin':c.profileRole(id)==='admin'?id:null;
 const contact=c.contacts.add('customer','desktop','qzu-Support','Customer'),room=c.openContact('customer',contact);
 assert.equal(c.openMobileSupport('customer','admin'),room);
 assert.equal(c.supportRequests('admin',true).length,0);
 const code=c.ensureInvite('customer').code;
 assert.throws(()=>c.requestConnection('admin',code),/already connected/);
 const other=c.requestConnection('other-admin',code);assert.ok(other.id);
 assert.equal(c.snapshot('customer').find(r=>r.id===room).peerAdmin,'admin');
 assert.equal(c.snapshot('customer').find(r=>r.id===other.id).peerAdmin,'other-admin');
 c.remove('desktop',room,true);assert.equal(c.supportRequests('admin',true).length,0);
 const reopened=c.openMobileSupport('customer','admin');assert.notEqual(reopened,room);assert.equal(c.rooms.get(reopened).support,undefined);
 }finally{db.close();}
});
test('legacy deletion never reopens a solved case and contact deletion clears only linked admin conversations',()=>{
 const db=setup();try{const c=new Chats(()=>start);c.contacts=contactStore(db,()=>start);c.attachSupportStore(db);c.profileRole=id=>['admin','desktop','other-admin'].includes(id)?'admin':null;c.adminAccount=id=>id==='desktop'?'admin':c.profileRole(id)==='admin'?id:null;
 const legacy=c.openMobileSupport('customer','admin',true);c.send('admin',legacy,'old message');c.finishSupport('admin',legacy,'solve');
 c.remove('customer',legacy);assert.equal(c.rooms.get(legacy).supportStatus,'solved');assert.equal(c.supportRequests('admin',true).length,0);
 c.requestSupportContactDeletion('customer',legacy);assert.equal(c.supportDeletions('admin',true)[0].kind,'contact');
 const contact=c.contacts.add('customer','desktop','qzu-Support','Customer'),direct=c.openContact('customer',contact);
 const otherContact=c.contacts.add('customer','other-admin','qzu-Support','Customer'),other=c.openContact('customer',otherContact);
 assert.throws(()=>c.deleteSupportContact('other-admin',legacy,true));
 c.approveSupportDeletion('admin',legacy,true);assert.equal(c.rooms.has(legacy),false);assert.equal(c.rooms.has(direct),false);assert.equal(c.rooms.has(other),true);assert.equal(c.contacts.list('customer').length,1);
 }finally{db.close();}
});
test('support inbox has separate detail navigation and admin logo is used in mobile and desktop chats',()=>{
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),control=readFileSync(new URL('../public/control.js',import.meta.url),'utf8'),desktop=readFileSync(new URL('../public/desktop-messenger.js',import.meta.url),'utf8');
 assert.ok(app.includes("adminGroups=new Map()"));assert.ok(app.includes("Other conversation history"));assert.ok(app.includes("current?.peerRole==='admin'||current?.support&&!current?.supportAgent ? '#supportAvatar'"));
 assert.ok(control.includes("Back to inbox"));assert.ok(control.includes("support/delete-contact"));assert.ok(desktop.includes("cc-chat-admin-avatar"));assert.doesNotThrow(()=>new Function(control));assert.doesNotThrow(()=>new Function(desktop));
});
