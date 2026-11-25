import test from 'node:test';
import assert from 'node:assert/strict';
import { Chats, CHAT_TTL } from '../lib/chats.mjs';

test('developer support uses a current personal code, permits replies, and expires', () => {
  let now = 1000;
  const chats = new Chats(() => now, () => 'ABC123');
  const invite = chats.newCode('user');
  const id = chats.startSupport(invite.code, 'Hello');
  chats.sendAdmin('user', 'Announcement');
  const rooms = chats.snapshot('user');
  const support = rooms.find(room => room.id === id);
  assert.equal(support.admin, true);
  assert.equal(support.readOnly, false);
  assert.equal(support.messages[0].sender, 'Admin');
  assert.equal(rooms.find(room => !room.support).readOnly, true);
  assert.throws(() => chats.send('user', rooms.find(room => !room.support).id, 'No'));
  chats.send('user', id, 'Reply');
  assert.equal(chats.supportRooms()[0].messages.at(-1).text, 'Reply');
  assert.throws(() => chats.send('outsider', id, 'No'));
  chats.supportMessage(id, 'Thanks');
  assert.equal(chats.snapshot('user').find(room => room.id === id).messages.length, 3);
  now += CHAT_TTL;
  assert.equal(chats.supportRooms().length, 0);
  assert.equal(chats.snapshot('user').length, 0);
});
