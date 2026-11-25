import test from 'node:test';
import assert from 'node:assert/strict';
import { Chats, CHAT_TTL } from '../lib/chats.mjs';

test('connections require approval and blocked contacts cannot reconnect', () => {
  const chats = new Chats();
  const invite = chats.ensureInvite('a');
  assert.equal(chats.requestConnection('b', invite.code).pending, true);
  assert.equal(chats.snapshot('a').length, 0);
  const request = chats.connectionRequests('a')[0];
  assert.throws(() => chats.respondConnection('b', request.id, true));
  const id = chats.respondConnection('a', request.id, true).id;
  assert.equal(chats.snapshot('b')[0].id, id);
  chats.blockContact('a', id);
  assert.equal(chats.snapshot('b').length, 0);
  assert.throws(() => chats.requestConnection('b', chats.ensureInvite('a').code));
});

test('view-once content is withheld until opened and cannot be retrieved twice', () => {
  const chats = new Chats();
  const id = chats.connect('b', chats.newCode('a').code);
  const message = chats.send('a', id, 'Private text', null, { once: true });
  assert.equal(chats.snapshot('b')[0].messages[0].text, '');
  assert.throws(() => chats.openOnce('a', id, message));
  assert.throws(() => chats.openOnce('c', id, message));
  assert.equal(chats.openOnce('b', id, message).text, 'Private text');
  assert.equal(chats.rooms.get(id).messages[0].text, '');
  assert.throws(() => chats.openOnce('b', id, message));
});

test('temporary attachments require membership and expire with their room', () => {
  let now = 0;
  const chats = new Chats(() => now);
  const id = chats.connect('b', chats.newCode('a').code);
  const photo = Buffer.from('89504e470d0a1a0a', 'hex');
  const message = chats.send('a', id, '', null, { kind: 'image', mime: 'image/png', data: photo.toString('base64') });
  assert.deepEqual(chats.getMedia('b', id, message).bytes, photo);
  assert.throws(() => chats.getMedia('c', id, message));
  const once = chats.send('a', id, '', null, { kind: 'image', once: true, mime: 'image/png', data: photo.toString('base64') });
  assert.throws(() => chats.getMedia('b', id, once));
  assert.equal(chats.openOnce('b', id, once).media.data, photo.toString('base64'));
  assert.equal(chats.rooms.get(id).messages[1].media, null);
  assert.throws(() => chats.send('a', id, '', null, { kind: 'image', mime: 'image/svg+xml', data: photo.toString('base64') }));
  now = CHAT_TTL;
  assert.throws(() => chats.getMedia('b', id, message));
});

test('editing, reactions and presence are restricted and temporary', () => {
  let now = 0;
  const chats = new Chats(() => now);
  const id = chats.connect('b', chats.newCode('a').code);
  const message = chats.send('a', id, 'Before');
  assert.throws(() => chats.edit('b', id, message, 'No'));
  chats.edit('a', id, message, 'After');
  assert.equal(chats.snapshot('b')[0].messages[0].edited, true);
  assert.throws(() => chats.react('b', id, message, '🙂'));
  chats.react('b', id, message, '👍');
  assert.equal(chats.snapshot('a')[0].messages[0].reactions[0].count, 1);
  chats.react('b', id, message, '👍');
  assert.deepEqual(chats.snapshot('a')[0].messages[0].reactions, []);
  chats.markPresent('b');
  assert.equal(chats.snapshot('a')[0].activeCount, 1);
  now = 6001;
  assert.equal(chats.snapshot('a')[0].activeCount, 0);
  now = 60001;
  assert.throws(() => chats.edit('a', id, message, 'Late'));
});
