import test from 'node:test';
import assert from 'node:assert/strict';
import { Chats, CHAT_TTL } from '../lib/chats.mjs';
import { openAccounts, createAccount, issuePin, requestReset } from '../lib/accounts.mjs';
import { handleAdminCommand } from '../lib/admin.mjs';

test('Admin messages are private, read-only and expire without renewal', () => {
  let now = 0;
  const chats = new Chats(() => now);
  const id = chats.sendAdmin('a', 'Hello');

  assert.equal(chats.snapshot('a')[0].admin, true);
  assert.equal(chats.snapshot('a')[0].messages[0].mine, false);
  assert.equal(chats.snapshot('b').length, 0);
  assert.throws(() => chats.send('a', id, 'Reply'), /cannot write/);
  assert.throws(() => chats.send('b', id, 'Fake admin'), /unavailable/);
  assert.throws(() => chats.remove('a', id), /read-only/);

  now = CHAT_TTL - 1;
  assert.equal(chats.sendAdmin('a', 'Second message'), id);
  now = CHAT_TTL;
  assert.equal(chats.snapshot('a').length, 0);
});

test('Developer reset sends an Admin message only to the requesting user', () => {
  const db = openAccounts(':memory:');
  const chats = new Chats();
  const first = createAccount(db);
  const other = createAccount(db);

  issuePin(db, first.id, '123456');
  const reference = requestReset(db, first.id);

  assert.deepEqual(handleAdminCommand(db, chats, { action: 'reset', reference }), { ok: true });
  assert.match(chats.snapshot(first.id)[0].messages[0].text, /emg.exe has been reset!/);
  assert.equal(chats.snapshot(other.id).length, 0);
  assert.throws(() => handleAdminCommand(db, chats, { action: 'reset', reference }), /not found/);
  assert.equal(issuePin(db, first.id, '654321'), '654321');

  handleAdminCommand(db, chats, { action: 'message', account: other.id, message: 'Hello' });
  assert.equal(chats.snapshot(other.id)[0].messages[0].text, 'Hello');

  chats.erase(first.id);
  assert.equal(chats.snapshot(first.id).length, 0);
  assert.equal(chats.snapshot(other.id).length, 1);

  db.close();
});
