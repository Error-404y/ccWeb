import test from 'node:test';
import assert from 'node:assert/strict';
import { openAccounts } from '../lib/accounts.mjs';
import { initDevices } from '../lib/devices.mjs';
import { initAccess, createSupportKey, redeemAccess, complimentary } from '../lib/access.mjs';
import { Chats, CHAT_TTL } from '../lib/chats.mjs';

test('support key is separate, device bound, single use and expires',()=>{
  const db=openAccounts(':memory:');initDevices(db);initAccess(db);
  const first=createSupportKey(db,100);
  const key=createSupportKey(db,100);
  assert.throws(()=>redeemAccess(db,first,101,'first-device'));
  assert.throws(()=>redeemAccess(db,key,86400100,'expired'));
  assert.throws(()=>redeemAccess(db,key,101));
  const admin=redeemAccess(db,key,101,'admin-device');
  assert.equal(db.prepare('SELECT access_plan FROM accounts WHERE id=?').get(admin.id).access_plan,'admin');
  assert.throws(()=>redeemAccess(db,key,102,'another-device'));
  assert.throws(()=>createSupportKey(db,102));
  const user=redeemAccess(db,complimentary(db,1,100)[0],101,'user-device');
  assert.equal(db.prepare('SELECT access_plan FROM accounts WHERE id=?').get(user.id).access_plan,'lifetime');
  db.close();
});
test('mobile support conversations are two-way, isolated and expire',()=>{
  let now=100;
  const chats=new Chats(()=>now);chats.requireEncryptedDirect=true;
  const id=chats.openMobileSupport('user','agent');
  assert.equal(chats.openMobileSupport('user','agent'),id);
  chats.send('user',id,'Need help');
  chats.send('agent',id,'How can I help?');
  assert.equal(chats.snapshot('user')[0].messages[1].sender,'qzu-Support');
  assert.equal(chats.snapshot('user')[0].supportAgent,false);
  assert.equal(chats.snapshot('agent')[0].supportAgent,true);
  assert.equal(chats.snapshot('agent')[0].readOnly,false);
  assert.throws(()=>chats.send('outsider',id,'No'));
  assert.equal(chats.snapshot('outsider').length,0);
  now+=CHAT_TTL;
  assert.equal(chats.snapshot('agent').length,0);
});
