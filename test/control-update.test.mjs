import test from 'node:test';
import assert from 'node:assert/strict';
import {openAccounts,findAccount,createAccount} from '../lib/accounts.mjs';
import {initDevices} from '../lib/devices.mjs';
import {initAccess,generatePlanKeys,redeemAccess,accessStatus,listAccessKeys,replaceUnusedKey,revokeAccessKey,applyRenewal,addMonths} from '../lib/access.mjs';
import {complianceStore} from '../lib/compliance.mjs';

test('developer keys start at activation, expire exactly, and remain single-use',()=>{
 const db=openAccounts(':memory:');initDevices(db);initAccess(db);
 const start=Date.UTC(2026,10,28),activate=start+9*86400000;
 for(const [code,until] of [['1W',activate+7*86400000],['1M',addMonths(activate,1)],['1Y',addMonths(activate,12)],['LT',null]]){
  const [k]=generatePlanKeys(db,code,1,'developer',start).keys;
  const a=redeemAccess(db,k.key,activate,'device-'+code),row=findAccount(db,a.token);
  assert.equal(row.paid_until,until);assert.equal(accessStatus(row,activate).active,true);
  if(until){assert.equal(accessStatus(row,until-1).active,true);assert.equal(accessStatus(row,until).active,false);}
  assert.equal(listAccessKeys(db,k.key)[0].account,a.id);assert.throws(()=>redeemAccess(db,k.key,activate,'second-'+code));
  assert.throws(()=>replaceUnusedKey(db,k.id));assert.throws(()=>revokeAccessKey(db,k.id,'admin','reason'));
 }
 db.close();
});

test('unused replacement invalidates old secret; renewal preserves the account',()=>{
 const db=openAccounts(':memory:');initDevices(db);initAccess(db);
 const [k]=generatePlanKeys(db,'1W').keys;const replacement=replaceUnusedKey(db,k.id);
 assert.equal(listAccessKeys(db,k.key).length,0);
 assert.throws(()=>redeemAccess(db,k.key,100,'old'));
 const a=redeemAccess(db,replacement.key,100,'new');
 const [renewal]=generatePlanKeys(db,'1M').keys;
 const old=findAccount(db,a.token).paid_until;
 assert.equal(applyRenewal(db,renewal.key,a.id,200).paidUntil,addMonths(old,1));
 assert.equal(findAccount(db,a.token).id,a.id);
 assert.deepEqual(applyRenewal(db,renewal.key,a.id,200),{paidUntil:addMonths(old,1),alreadyApplied:true});
 const [unused]=generatePlanKeys(db,'LT').keys;revokeAccessKey(db,unused.id,'admin','lost');assert.throws(()=>redeemAccess(db,unused.key,100,'unused'));
 db.close();
});

test('24 reporter-selected text messages and collaborative report history are retained',()=>{
 const db=openAccounts(':memory:');initDevices(db);initAccess(db);
 const c=complianceStore(db),a=createAccount(db,'a'),b=createAccount(db,'b');
 const context=Array.from({length:24},(_,i)=>({id:'m'+i,text:'Context '+i,at:i,sender:'Reporter',source:'reporter-submitted'}));
 const r=c.report(a.id,b.id,'room','Harassment','','m1',context,'encrypted direct');
 assert.equal(c.list()[0].context.length,24);
 assert.throws(()=>c.report(a.id,b.id,'room','Other','',null,[...context,context[0]]));
 c.collaborate(r.id,'admin-a','help','Second reviewer needed');
 assert.equal(c.list()[0].workflow,'help');assert.equal(c.list()[0].collaboration[0].actor,'admin-a');
 c.resolve(r.id,'dismiss','admin-b','reviewed');assert.equal(c.list(true)[0].workflow,'solved');
 assert.throws(()=>c.collaborate(r.id,'admin-a','help'));
 db.close();
});
