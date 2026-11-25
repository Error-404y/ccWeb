import test from 'node:test';
import assert from 'node:assert/strict';
import { Chats, CHAT_TTL, INVITE_TTL } from '../lib/chats.mjs';

test('group invites, member scope, replies, typing and receipts', () => {
  let now = 0;
  const codes = ['ABC234', 'DEF567', 'GHI789'];
  const chats = new Chats(() => now, () => codes.shift());
  const id = chats.createGroup('a');
  const invite = chats.groupInvite('a', id);
  assert.equal(chats.connect('b', invite.code), id);
  assert.equal(chats.connect('c', invite.code), id);
  assert.equal(chats.snapshot('b')[0].memberCount, 3);
  assert.throws(() => chats.groupInvite('b', id));
  assert.throws(() => chats.send('x', id, 'not allowed'));
  const message = chats.send('a', id, 'hello');
  assert.equal(chats.snapshot('a')[0].messages[0].status, 'sent');
  chats.acknowledge('b', [{ id, delivered: [message], read: [] }]);
  chats.acknowledge('c', [{ id, delivered: [message], read: [] }]);
  assert.equal(chats.snapshot('a')[0].messages[0].status, 'delivered');
  chats.acknowledge('b', [{ id, read: [message] }]);
  chats.acknowledge('c', [{ id, read: [message] }]);
  assert.equal(chats.snapshot('a')[0].messages[0].status, 'read');
  chats.setTyping('b', id, true);
  assert.deepEqual(chats.snapshot('a')[0].typing, ['Member 2']);
  now = 4501;
  assert.deepEqual(chats.snapshot('a')[0].typing, []);
  chats.send('b', id, 'reply', message);
  assert.equal(chats.snapshot('c')[0].messages[1].reply.text, 'hello');
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
  chats.remove('b', id);
  assert.equal(chats.snapshot('b').length, 0);
  assert.equal(chats.snapshot('a').length, 1);
});
