import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { openAccounts, findAccount, setLogin, verifyLogin } from '../lib/accounts.mjs';
import { initDevices, findDeviceAccount } from '../lib/devices.mjs';
import { initAccess, createSupportKey, fillSupportKeyPool, redeemAccess, releaseSupportKey } from '../lib/access.mjs';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function setup(){
  const db=openAccounts(':memory:');
  initAccess(db);initDevices(db);
  return db;
}

test('admin pool preserves existing keys and fills to exactly eight',()=>{
  const db=setup();
  try{
    const existing=createSupportKey(db,1);
    const first=fillSupportKeyPool(db,2);
    assert.equal(first.total,8);assert.equal(first.created,7);
    assert.equal(new Set([existing,...first.keys]).size,8);
    assert.equal(fillSupportKeyPool(db,3).created,0);
    assert.throws(()=>createSupportKey(db,4),/eight/i);
    const claims=[existing,...first.keys].map((key,i)=>redeemAccess(db,key,1000000000,'device-'+i));
    assert.equal(new Set(claims.map(a=>a.id)).size,8);
    for(const a of claims)assert.equal(findAccount(db,a.token).access_plan,'admin');
    assert.throws(()=>redeemAccess(db,existing,1000000001,'other-device'),/unavailable/i);
    assert.throws(()=>releaseSupportKey(db,'unknown'),/unavailable/i);
  }finally{db.close();}
});

test('logout releases only its slot and revokes old device, token and PIN',()=>{
  const db=setup();
  try{
    const [key,second]=fillSupportKeyPool(db).keys;
    const first=redeemAccess(db,key,10,'device-one');
    const other=redeemAccess(db,second,10,'device-two');
    assert.equal(setLogin(db,first.id,'123456'),true);
    assert.equal(verifyLogin(db,first.id,'123456'),'ok');
    assert.throws(()=>redeemAccess(db,key,11,'device-three'),/unavailable/i);
    assert.throws(()=>redeemAccess(db,second,11,'device-one'),/already registered/i);
    releaseSupportKey(db,first.id);
    assert.equal(findDeviceAccount(db,'device-one'),null);
    assert.equal(findAccount(db,first.token),null);
    assert.equal(verifyLogin(db,first.id,'123456'),'unavailable');
    assert.throws(()=>releaseSupportKey(db,first.id),/unavailable/i);
    assert.equal(findDeviceAccount(db,'device-two').id,other.id);
    assert.throws(()=>redeemAccess(db,second,12,'device-four'),/unavailable/i);
    const next=redeemAccess(db,key,12,'device-three');
    assert.equal(next.id,first.id);
    assert.notEqual(next.token,first.token);
    assert.equal(verifyLogin(db,next.id,'123456'),'unavailable');
    assert.equal(setLogin(db,next.id,'654321'),true);
    assert.equal(verifyLogin(db,next.id,'654321'),'ok');
  }finally{db.close();}
});

test('startup never requests PIN before session response and visual readiness',async()=>{
  const start=app.indexOf('async function getSession()');
  const end=app.indexOf('\nfunction lock(',start);
  assert.ok(start>=0&&end>start);
  const events=[];
  let session,ready;
  const sessionPromise=new Promise(resolve=>{session=resolve;});
  const readyPromise=new Promise(resolve=>{ready=resolve;});
  const ctx={authBusy:false,document:{hidden:false},unlockToken:null,authEpoch:0,sessionReady:false,needsSetup:false,isPublicCheckout:()=>false,api:()=>sessionPromise,finishBoot:()=>readyPromise,showLogin:()=>events.push('PIN')};
  const task=runInNewContext(app.slice(start,end)+'\ngetSession()',ctx);
  await Promise.resolve();
  assert.deepEqual(events,[]);
  session({needsSetup:false});
  await Promise.resolve();await Promise.resolve();
  assert.deepEqual(events,[]);
  ready();await task;
  assert.deepEqual(events,['PIN']);
});

test('voice gestures distinguish a deliberate left or up swipe from normal hold',()=>{
  const start=app.indexOf('function voiceSwipe(');
  const end=app.indexOf('\nvoiceControl.addEventListener',start);
  assert.ok(start>=0&&end>start);
  const swipe=runInNewContext(app.slice(start,end)+'\nvoiceSwipe');
  assert.equal(swipe(0,0),'hold');
  assert.equal(swipe(74,0),'hold');
  assert.equal(swipe(75,0),'cancel');
  assert.equal(swipe(0,65),'locked');
  assert.equal(swipe(100,70),'cancel');
  assert.equal(swipe(80,100),'locked');
});

test('pointer interruption cancels rather than sends; locked recording is retained',()=>{
  const start=app.indexOf('function endVoiceGesture(');
  const end=app.indexOf('\nvoiceControl.addEventListener',start);
  const events=[];
  const ctx={voiceGesture:null};
  const finish=runInNewContext(app.slice(start,end)+'\nendVoiceGesture',ctx);
  const session={cancel:()=>events.push('cancel'),send:()=>events.push('send')};
  ctx.voiceGesture={id:1,action:'hold',session};finish({pointerId:1},true);
  ctx.voiceGesture={id:2,action:'hold',session};finish({pointerId:2},false);
  ctx.voiceGesture={id:3,action:'locked',session};finish({pointerId:3},false);
  ctx.voiceGesture={id:4,action:'hold',session};finish({pointerId:9},false);
  assert.deepEqual(events,['cancel','send']);
  assert.equal(ctx.voiceGesture.id,4);
});
