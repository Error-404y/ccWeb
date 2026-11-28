import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {officialStore} from '../lib/official.mjs';
import {playAssets} from '../scripts/play-assets.mjs';
const source=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const window={};runInNewContext(source('public/ui-simplicity.js'),{window});
const {accessSummary,unreadCount,visibleReadCursor,attachEdgeBack}=window.QzuSimplicity;
test('entitlements are based on authoritative plan and expiration, including legacy, admin and seller plans',()=>{
 const now=1000000,h=3600000;
 for(const [p,label] of [['week','1 Week'],['month','1 Month'],['year','1 Year'],['monthly','5 Months (legacy)']]){
  const s=accessSummary({plan:p,active:true,paidUntil:now+37*h},now);assert.equal(s.plan,label);assert.equal(s.remaining,'1 day, 13 hours');
 }
 assert.equal(accessSummary({plan:'month',active:true,paidUntil:now+h},now).remaining,'1 hour');
 assert.equal(accessSummary({plan:'month',active:true,paidUntil:now+10},now).remaining,'Less than 1 hour');
 assert.equal(accessSummary({plan:'week',active:false,paidUntil:now},now).status,'Expired');
 assert.equal(accessSummary({plan:'lifetime',active:false},now).status,'Inactive');
 for(const p of ['lifetime','admin','seller','legacy'])assert.equal(accessSummary({plan:p,active:true},now).remaining,'No expiration');
 assert.equal(accessSummary(undefined,now).status,'Unknown');assert.equal(accessSummary({plan:'unknown',active:true},now).status,'Unknown');
 assert.equal(accessSummary({plan:'week',active:true,paidUntil:null},now).status,'Unknown');
});
test('all retained announcements appear in order; unread counts exclude deleted posts and respect account cursors',()=>{
 const db=new DatabaseSync(':memory:');try{
 const o=officialStore(db,()=>123);
 assert.throws(()=>o.publish('no',false));for(let i=0;i<205;i++)o.publish('Post '+i,true);
 assert.equal(o.snapshot('a').posts.length,205);assert.equal(o.snapshot('a').unreadCount,205);
 o.mark('a',200);o.remove(202,true);o.remove(2,true);
 const a=o.snapshot('a');assert.equal(a.posts.length,203);assert.equal(a.posts[0].id,1);assert.equal(a.posts.at(-1).id,205);assert.equal(a.unreadCount,4);assert.equal(unreadCount(a),4);
 assert.equal(o.snapshot('b').unreadCount,203);assert.throws(()=>o.remove(1,false));assert.throws(()=>o.mark('b',206));
 o.mark('a',205);o.mark('a',100);assert.equal(o.snapshot('a').unreadCount,0);assert.equal(o.snapshot('a').unread,false);
 assert.equal(o.history(150).posts.length,100);
 }finally{db.close();}
});
function fixture(){
 const handlers=new Map(),captured=new Set();let active='room',closed=0;
 const surface={addEventListener(type,fn){handlers.set(type,fn);},getBoundingClientRect(){return {left:10};},setPointerCapture(id){captured.add(id);},hasPointerCapture(id){return captured.has(id);},releasePointerCapture(id){captured.delete(id);}};
 attachEdgeBack(surface,{current:()=>active,close:()=>{closed++;active=null;}});
 function fire(type,overrides={}){const e={pointerId:1,isPrimary:true,button:0,pointerType:'touch',clientX:20,clientY:80,target:{closest:()=>null},cancelable:true,detail:1,stopPropagation(){this.stopped=true;},preventDefault(){this.prevented=true;},...overrides};handlers.get(type)(e);return e;}
 return {fire,closed:()=>closed,setActive:v=>active=v,surface,captured};
}
test('announcement read cursors advance only through visible posts in order',()=>{
 const posts=[1,2,4,6].map(id=>({id}));
 assert.equal(unreadCount({posts,seen:2,unreadCount:20}),20);
 assert.equal(visibleReadCursor(posts,1,post=>post.id>=4),1);
 assert.equal(visibleReadCursor(posts,1,post=>[2,6].includes(post.id)),2);
 assert.equal(visibleReadCursor(posts,2,()=>true),6);
});
test('edge swipe closes only on a completed rightward gesture and does not propagate into message reply',()=>{
 const f=fixture();assert.equal(f.fire('pointerdown').stopped,true);assert.equal(f.fire('pointermove',{clientX:85}).prevented,true);assert.equal(f.captured.has(1),true);f.fire('pointerup',{clientX:110});assert.equal(f.closed(),1);assert.equal(f.captured.size,0);
 assert.equal(f.fire('click').prevented,true);f.setActive('room2');f.fire('pointerdown');f.fire('pointerup',{clientX:120});assert.equal(f.closed(),2);
});
test('edge swipe rejects ordinary replies, vertical scroll, short and reversed swipes, controls, mouse, multi-touch and cancellations',()=>{
 for(const [down,move,up] of [
  [{clientX:80},{clientX:160},{clientX:180}],
  [{},{clientX:30,clientY:150},{clientX:150,clientY:150}],
  [{},{clientX:35},{clientX:45}],
  [{},{clientX:0},{clientX:120}],
  [{target:{closest:()=>({})}},{clientX:110},{clientX:130}],
  [{pointerType:'mouse'},{clientX:110},{clientX:130}],
  [{isPrimary:false},{clientX:110},{clientX:130}]
 ]){const f=fixture();f.fire('pointerdown',down);f.fire('pointermove',move);f.fire('pointerup',up);assert.equal(f.closed(),0);}
 for(const cancel of ['pointercancel','lostpointercapture']){const f=fixture();f.fire('pointerdown');f.fire('pointermove',{clientX:100});f.captured.clear();f.fire(cancel,{target:f.surface});f.fire('pointerup',{clientX:140});assert.equal(f.closed(),0);}
 const f=fixture();f.fire('pointerdown');f.fire('pointerdown',{pointerId:2,isPrimary:false});f.fire('pointerup',{clientX:140});assert.equal(f.closed(),0);
 const g=fixture();g.fire('pointerdown');g.setActive('other');g.fire('pointerup',{clientX:140});assert.equal(g.closed(),0);
});
test('removed settings do not leave DOM listeners behind; recovery and renew paths remain; both clients wire non-destructive navigation',()=>{
 const html=source('public/index.html'),app=source('public/app.js'),control=source('public/control.js'),desktop=source('public/desktop-messenger.js'),server=source('server.mjs');
 for(const key of ['externalDeletion','sellerDirectorySettings','officialOlder']){assert.ok(!html.includes('id="'+key+'"'));assert.ok(!app.includes("$('"+key+"')"));}
 assert.match(html,/id="officialEarlier"[^>]*hidden/);
 assert.ok(app.includes("api('account/deletion-code',{})"));assert.ok(app.includes("button('External deletion code',showDeletionCode"));assert.ok(app.includes("button('Renew access',showRenewal)"));
 assert.ok(server.includes('/api/official/history'));assert.ok(app.includes("close:()=>$('backToChats').click()"));assert.ok(desktop.includes('close:()=>choose(null)'));
 for(const s of [app,control,desktop])assert.doesNotThrow(()=>new Function(s));
});

test('Google Play retains shared access summary, ticket screens and gesture handlers without external checkout',()=>{
 const app=playAssets(source('public/app.js'));
 assert.ok(app.includes('function updateAccessDisplay()'));
 assert.ok(app.includes('function renderNewUserTicket('));
 assert.ok(app.includes('QzuSimplicity.attachEdgeBack'));
 assert.ok(app.includes("if(v.timed&&!playBuild)"));
 assert.ok(!/access\/invoice|access\/submit|access\/renew|release\.downloads/.test(app));
 assert.doesNotThrow(()=>new Function(app));
});
