import test from 'node:test';
import assert from 'node:assert/strict';
import {openAccounts,createAccount} from '../lib/accounts.mjs';
import {describeDeviceModel} from '../lib/device-models.mjs';
import {deviceProfiles,initDevices} from '../lib/devices.mjs';
import {deviceChanges} from '../lib/device-changes.mjs';
import {createSupportKey,initAccess,redeemAccess,releaseSupportKey} from '../lib/access.mjs';

test('Apple marketing names distinguish model identifiers from hardware names',()=>{
  assert.deepEqual(describeDeviceModel('ios','iPhone16,2'),{model:'iPhone 15 Pro Max',modelIdentifier:'iPhone16,2'});
  assert.deepEqual(describeDeviceModel('ios','iPhone17,2'),{model:'iPhone 16 Pro Max',modelIdentifier:'iPhone17,2'});
  assert.deepEqual(describeDeviceModel('ios','iPhone999,1'),{model:'iPhone',modelIdentifier:'iPhone999,1'});
  assert.deepEqual(describeDeviceModel('ios','arm64'),{model:'iOS Simulator'});
  assert.deepEqual(describeDeviceModel('android','Google Pixel 10 Pro'),{model:'Google Pixel 10 Pro'});
});

test('registration, successful sign-in and signed device updates are distinct',()=>{
  const db=openAccounts(':memory:');
  try{
    initDevices(db);
    const fingerprint='a'.repeat(64), id=createAccount(db,fingerprint).id;
    const account={id,device_id:fingerprint};
    let time=1000;
    const profiles=deviceProfiles(db,()=>time);
    profiles.register(id,fingerprint,'ios');
    time=1500;
    profiles.update(account,fingerprint,'ios',{},{signedIn:true});
    time=2000;
    profiles.update(account,fingerprint,'ios',{model:'iPhone16,2',osVersion:'27.0',appVersion:'0.17.12'});
    assert.deepEqual(profiles.get(id),{platform:'ios',model:'iPhone 15 Pro Max',modelIdentifier:'iPhone16,2',
      osVersion:'27.0',appVersion:'0.17.12',fingerprint,registeredAt:1000,firstSeenAt:1000,
      lastSeenAt:2000,lastSignedInAt:1500,source:'app-reported'});

    const legacy=createAccount(db,'b'.repeat(64)).id;
    profiles.update({id:legacy,device_id:'b'.repeat(64)},'b'.repeat(64),'android',{model:'Google Pixel'});
    assert.equal(profiles.get(legacy).registeredAt,null);
    assert.equal(profiles.get(legacy).firstSeenAt,2000);
  }finally{db.close();}
});

test('reuse of a staff slot flags a distinct rebind, and same key reuse stays clear',()=>{
  const db=openAccounts(':memory:');
  try{
    initDevices(db);initAccess(db);
    let time=100;
    const profiles=deviceProfiles(db,()=>time), changes=deviceChanges(db,()=>time);
    const first='a'.repeat(64), second='b'.repeat(64);
    const key=createSupportKey(db,time);
    const {id}=redeemAccess(db,key,time,first);
    profiles.register(id,first,'ios');
    profiles.update({id,device_id:first},first,'ios',{model:'iPhone16,2'});
    assert.deepEqual(changes.history(id),[]);
    releaseSupportKey(db,id);
    assert.equal(profiles.get(id).fingerprint,null);
    assert.equal(profiles.get(id).model,null);
    time=200;
    assert.equal(redeemAccess(db,key,time,first).id,id);
    profiles.register(id,first,'ios');
    assert.deepEqual(changes.history(id),[]);
    releaseSupportKey(db,id);
    time=300;
    assert.equal(redeemAccess(db,key,time,second).id,id);
    profiles.register(id,second,'android');
    assert.equal(profiles.get(id).registeredAt,300);
    const [event]=changes.history(id);
    assert.equal(event.previousFingerprint,first);
    assert.equal(event.currentFingerprint,second);
    assert.equal(event.previousDevice.model,'iPhone 15 Pro Max');
    assert.equal(event.reviewedAt,null);
  }finally{db.close();}
});
