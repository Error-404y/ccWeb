import test from 'node:test';
import assert from 'node:assert/strict';
import { Chats, CHAT_TTL, EXTENSION_TTL } from '../lib/chats.mjs';
import { openAccounts } from '../lib/accounts.mjs';

test('chat mutes are private and expire when the selected time ends', () => {
  let now=1000;
  const chats=new Chats(()=>now);
  const first=chats.connectPair('one','two');
  const other=chats.connectPair('one','three');
  assert.throws(()=>chats.setRoomMute('three',first,'hour'),{status:404});
  assert.throws(()=>chats.setRoomMute('one',first,'past week'),{status:400});
  const {mutedUntil}=chats.setRoomMute('one',first,'hour');
  assert.equal(mutedUntil,now+3600000);
  assert.equal(chats.isRoomMuted('one',first),true);
  assert.equal(chats.isRoomMuted('two',first),false);
  assert.equal(chats.isRoomMuted('one',other),false);
  assert.equal(chats.snapshot('one').find(room=>room.id===first).mutedUntil,mutedUntil);
  assert.equal(chats.snapshot('two')[0].mutedUntil,null);
  now=mutedUntil;
  assert.equal(chats.isRoomMuted('one',first),false);
  assert.equal(chats.snapshot('one').find(room=>room.id===first).mutedUntil,null);
});

test('expiry mute follows an agreed extension and can be cleared', ()=>{
  let now=1000;
  const chats=new Chats(()=>now);
  const id=chats.connectPair('one','two');
  const original=chats.setRoomMute('one',id,'expiry').mutedUntil;
  assert.equal(original,now+CHAT_TTL);
  chats.extend('one',id,'request');
  const pending=chats.snapshot('two')[0].extension;
  chats.extend('two',id,'accept',pending.id);
  now=original;
  assert.equal(chats.snapshot('one')[0].mutedUntil,original+EXTENSION_TTL);
  assert.deepEqual(chats.setRoomMute('one',id,'off'),{mutedUntil:null});
});

test('an hour mute survives a support conversation reload', ()=>{
  const db=openAccounts(':memory:');
  try{
    const chats=new Chats();
    chats.attachSupportStore(db);
    const id=chats.openMobileSupport('customer','agent',true);
    const mute=chats.setRoomMute('customer',id,'hour');
    const reloaded=new Chats();
    reloaded.attachSupportStore(db);
    assert.deepEqual(reloaded.snapshot('customer')[0].mutedUntil,mute.mutedUntil);
    assert.equal(reloaded.isRoomMuted('agent',id),false);
  }finally{db.close();}
});
