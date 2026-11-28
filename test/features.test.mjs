import test from 'node:test';
import assert from 'node:assert/strict';
import { Chats, CHAT_TTL, INVITE_TTL } from '../lib/chats.mjs';
import {DatabaseSync} from 'node:sqlite';

test('group invites, member scope, replies, typing and receipts', () => {
  let now = 0;
  const codes = ['ABC234', 'DEF567', 'GHI789'];
  const chats = new Chats(() => now, () => codes.shift());
  const id = chats.createGroup('a');
  const invite = chats.groupInvite('a', id);
  assert.deepEqual(chats.requestConnection('b',invite.code,'User.Name'),{pending:true});
  assert.deepEqual(chats.snapshot('b'),[]);
  const request=chats.connectionRequests('a')[0].id;
  assert.throws(()=>chats.respondConnection('c',request,true),{status:404});
  assert.equal(chats.respondConnection('a',request,true).id,id);
  assert.equal(chats.snapshot('a')[0].messages[0].text,'User.Name has joined the group.');
  chats.connect('c',invite.code);
  chats.respondConnection('a',chats.connectionRequests('a')[0].id,true);
  assert.equal(chats.snapshot('b')[0].memberCount, 3);
  assert.throws(() => chats.groupInvite('b', id));
  assert.throws(() => chats.send('x', id, 'not allowed'));
  const message = chats.send('a', id, 'hello');
  assert.equal(chats.snapshot('a')[0].messages.find(m=>m.id===message).status, 'sent');
  chats.acknowledge('b', [{ id, delivered: [message], read: [] }]);
  chats.acknowledge('c', [{ id, delivered: [message], read: [] }]);
  assert.equal(chats.snapshot('a')[0].messages.find(m=>m.id===message).status, 'delivered');
  chats.acknowledge('b', [{ id, read: [message] }]);
  chats.acknowledge('c', [{ id, read: [message] }]);
  assert.equal(chats.snapshot('a')[0].messages.find(m=>m.id===message).status, 'read');
  chats.setTyping('b', id, true);
  assert.deepEqual(chats.snapshot('a')[0].typing, ['User.Name']);
  now = 4501;
  assert.deepEqual(chats.snapshot('a')[0].typing, []);
  chats.send('b', id, 'reply', message);
  assert.equal(chats.snapshot('c')[0].messages.at(-1).reply.text, 'hello');
  assert.throws(() => chats.send('b', id, 'bad', 'unknown'));
  now = INVITE_TTL;
  assert.throws(() => chats.connect('x', invite.code));
  now = CHAT_TTL;
  assert.equal(chats.snapshot('a').length, 0);
});

test('group member can leave without removing other members', () => {
  const chats = new Chats();
  const id = chats.createGroup('a');
  chats.connect('b', chats.groupInvite('a', id).code);
  chats.respondConnection('a',chats.connectionRequests('a')[0].id,true);
  chats.remove('b', id);
  assert.equal(chats.snapshot('b').length, 0);
  assert.equal(chats.snapshot('a').length, 1);
});

test('group and message timers work independently across restarts and staff joining is visible',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    let now=1;
    let chats=new Chats(()=>now);
    chats.attachSupportStore(db);
    const id=chats.createGroup('owner','Workshop');
    assert.throws(()=>chats.groupTimers('outside',id,{groupTimer:'never',chatTimer:'1h'}),{status:404});
    chats.groupTimers('owner',id,{groupTimer:'never',chatTimer:'1h'});
    chats.joinGroup('staff',id,null,true);
    chats.joinGroup('staff',id,null,true);
    assert.equal(chats.snapshot('owner')[0].messages.length,1);
    assert.match(chats.snapshot('owner')[0].messages[0].text,/qzu\. Staff has joined/);
    chats.send('staff',id,'Hello from staff');
    chats=new Chats(()=>now);
    chats.attachSupportStore(db);
    assert.deepEqual(chats.groups('staff').map(row=>[row.name,row.joined,row.persistent]),[['Workshop',true,true]]);
    assert.equal(chats.snapshot('staff')[0].messages.at(-1).text,'Hello from staff');
    now+=3600000;
    assert.equal(chats.snapshot('owner')[0].messages.length,0);
    chats.groupTimers('owner',id,{groupTimer:'1h',chatTimer:'never'});
    chats.send('owner',id,'Last message');
    now+=3600000;
    assert.equal(chats.groups('staff').length,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM group_rooms').get().n,0);
  }finally{db.close();}
});
