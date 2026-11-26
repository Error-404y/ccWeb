import test from 'node:test';
import assert from 'node:assert/strict';
import { openAccounts } from '../lib/accounts.mjs';
import { contactStore, CONTACT_WARNING, TRUSTED_WARNING, CONTACT_GRACE } from '../lib/contacts.mjs';
import { Chats } from '../lib/chats.mjs';

test('trusted contacts have longer lifetime and cannot silently replace identity',()=>{
  let now=100;
  const db=openAccounts(':memory:');
  const store=contactStore(db,()=>now);
  const id=store.add('a','b','B','A');
  assert.equal(store.verify('a','b','identity-a','identity-b'),true);
  assert.equal(store.verify('a','b','identity-a','changed'),false);
  assert.equal(store.list('a')[0].peerIdentity,'identity-b');
  now+=CONTACT_WARNING;
  assert.equal(store.list('a')[0].warning,false);
  now=100+TRUSTED_WARNING;
  assert.equal(store.list('b')[0].warning,true);
  now+=CONTACT_GRACE;
  assert.equal(store.list('a').length,0);
  assert.equal(store.sweep().length,1);
  db.close();
});
test('contact preferences are private and contact removal revokes access',()=>{
  const db=openAccounts(':memory:');
  const store=contactStore(db);
  const chats=new Chats();chats.contacts=store;
  const id=store.add('a','b','B','A');
  store.update('a',id,{nickname:'Private',favorite:true,muted:true});
  assert.equal(store.list('a')[0].nickname,'Private');
  assert.equal(store.list('b')[0].nickname,'A');
  assert.equal(store.list('b')[0].favorite,false);
  assert.equal(store.list('b')[0].muted,false);
  assert.throws(()=>store.update('c',id,{nickname:'No'}));
  const room=chats.openContact('a',id);
  chats.removeContact('b',id,true);
  assert.equal(store.list('a').length,0);
  assert.throws(()=>chats.requireRoom('a',room));
  assert.equal(chats.isBlocked('a','b'),true);
  db.close();
});

test('trust reset closes the existing encrypted chat and requires new verification',()=>{
  const db=openAccounts(':memory:');
  const store=contactStore(db);
  const chats=new Chats();chats.contacts=store;chats.requireEncryptedDirect=true;
  const id=store.add('a','b','B','A');
  const roomId=chats.openContact('a',id);
  const room=chats.requireRoom('a',roomId);
  room.encryption.keys.set('a',{identity:'a-key'});
  room.encryption.keys.set('b',{identity:'b-key'});
  chats.confirmRoomKey('a',roomId);
  assert.equal(store.list('a')[0].trusted,false);
  chats.confirmRoomKey('b',roomId);
  assert.equal(store.list('a')[0].trusted,true);
  chats.updateContact('a',id,{resetTrust:true});
  assert.equal(store.list('b')[0].trusted,false);
  assert.throws(()=>chats.requireRoom('a',roomId));
  const fresh=chats.openContact('a',id);
  assert.notEqual(fresh,roomId);
  assert.equal(chats.requireRoom('a',fresh).encryption.confirmed.size,0);
  db.close();
});

test('automatic identity pinning is separate from trusted status',()=>{const db=openAccounts(':memory:');const store=contactStore(db);const id=store.add('a','b','B','A');assert.equal(store.verify('a','b','a-key','b-key',false),true);assert.equal(store.list('a')[0].trusted,false);assert.equal(store.list('a')[0].identityVerified,false);store.update('a',id,{trusted:true});assert.equal(store.list('a')[0].personallyTrusted,true);assert.equal(store.verify('a','b','a-key','changed',false),false);db.close();});
