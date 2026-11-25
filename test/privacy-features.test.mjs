import test from 'node:test';
import assert from 'node:assert/strict';
import { Chats } from '../lib/chats.mjs';
import { sendFeedback } from '../lib/discord.mjs';
import { handleAdminCommand } from '../lib/admin.mjs';

test('invisible mode suppresses presence, typing and new read receipts', () => {
  const chats = new Chats();
  const id = chats.connect('b', chats.newCode('a').code);
  const message = chats.send('a', id, 'Hello');
  chats.markPresent('b');
  chats.setTyping('b', id, true);
  chats.markPresent('b', true);
  chats.setTyping('b', id, true, true);
  chats.acknowledge('b', [{ id, read: [message] }], true);
  const room = chats.snapshot('a')[0];
  assert.equal(room.activeCount, 0);
  assert.deepEqual(room.typing, []);
  assert.equal(room.messages[0].status, 'delivered');
});

test('unsend removes content and quoted text for both participants', () => {
  const chats = new Chats();
  const id = chats.connect('b', chats.newCode('a').code);
  const message = chats.send('a', id, 'Original');
  chats.send('b', id, 'Reply', message);
  assert.throws(() => chats.unsend('b', id, message));
  chats.unsend('a', id, message);
  for (const user of ['a', 'b']) {
    const room = chats.snapshot(user)[0];
    assert.equal(room.messages[0].deleted, true);
    assert.equal(room.messages[0].text, '');
    assert.equal(room.messages[1].reply.text, 'This message was deleted.');
  }
});

test('feedback sends only explicitly submitted text and disables mentions', async () => {
  let payload;
  await sendFeedback('Example feedback', 'https://discord.com/api/webhooks/123/test_token', async (url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true };
  });
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.embeds[0].description, 'Example feedback');
  assert.deepEqual(Object.keys(payload).sort(), ['allowed_mentions', 'embeds']);
  await assert.rejects(sendFeedback('Example', 'https://example.org/api/webhooks/123/test_token'));
});

test('announcements go to unlocked accounts via verified Admin chat', () => {
  const chats = new Chats();
  const result = handleAdminCommand(null, chats, { action: 'announce', message: 'Maintenance' }, { activeAccounts: () => ['a', 'b'] });
  assert.equal(result.delivered, 2);
  assert.equal(chats.snapshot('a')[0].admin, true);
  assert.equal(chats.snapshot('b')[0].messages[0].text, 'Announcement\nMaintenance');
  assert.equal(chats.snapshot('c').length, 0);
});
