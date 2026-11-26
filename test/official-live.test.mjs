import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {officialStore} from '../lib/official.mjs';
import {versionedState} from '../lib/live.mjs';
import {Chats} from '../lib/chats.mjs';
test('official posts persist and read cursors are independent, monotonic and admin-only',()=>{
  const db=new DatabaseSync(':memory:');let channel=officialStore(db,()=>100);
  assert.throws(()=>channel.publish('Not authorized'));
  assert.throws(()=>channel.publish(' ',true));
  const first=channel.publish('Hello everyone',true).id;
  assert.equal(channel.snapshot('a').unread,true);
  assert.equal(channel.snapshot('b').posts[0].text,'Hello everyone');
  channel.mark('a',first);
  assert.equal(channel.snapshot('a').unread,false);
  assert.equal(channel.snapshot('b').unread,true);
  const second=channel.publish('Second post',true).id;
  channel.mark('a',second);channel.mark('a',first);
  assert.equal(channel.snapshot('a').seen,second);
  assert.throws(()=>channel.mark('a',second+1));
  channel=officialStore(db);assert.equal(channel.snapshot('new').posts.length,2);
  db.close();
});
test('state revision ignores clocks and changes on messages or deletion',()=>{
  const a=versionedState({now:1,rooms:[{id:'a'}],official:{unread:false}});
  assert.equal(versionedState({now:2,rooms:[{id:'a'}],official:{unread:false}},a.revision).unchanged,true);
  assert.notEqual(versionedState({now:3,rooms:[],official:{unread:false}},a.revision).revision,a.revision);
  assert.notEqual(versionedState({now:3,rooms:[{id:'a'}],official:{unread:true}},a.revision).revision,a.revision);
});
test('code lifetime choices',()=>{
  let now=100;const chats=new Chats(()=>now);
  assert.throws(()=>chats.newCode('a',60));
  assert.equal(chats.newCode('a',5).expires,now+300000);
  assert.equal(chats.newCode('a',15).expires,now+900000);
});
