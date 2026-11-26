import test from 'node:test';
import assert from 'node:assert/strict';
import { Chats, CHAT_TTL } from '../lib/chats.mjs';
import { openAccounts } from '../lib/accounts.mjs';
import { initActivity, recordActivity, listActivity } from '../lib/activity.mjs';
test('timed message is withheld, opens once on a fixed timer, and expires for both', () => {
  let now = 100000;
  const c = new Chats(() => now);
  const id = c.connectPair('a','b');
  const m = c.send('a',id,'secret',null,{burnSeconds:5});
  assert.equal(c.snapshot('b')[0].messages[0].text,'');
  assert.throws(() => c.openBurn('a',id,m));
  assert.throws(() => c.openBurn('x',id,m));
  assert.throws(() => c.send('a',id,'quote',m));
  const at = c.openBurn('b',id,m).burnAt;
  assert.equal(c.snapshot('b')[0].messages[0].text,'secret');
  now += 1000;
  assert.equal(c.openBurn('b',id,m).burnAt,at);
  now += 4000;
  for (const user of ['a','b']) { const m = c.snapshot(user)[0].messages[0]; assert.equal(m.text,''); assert.equal(m.deleted,true); }
});
test('extension requires other member consent and is limited to once', () => {
  const c = new Chats(() => 100000);
  const id = c.connectPair('a','b');
  const expires = c.snapshot('a')[0].expires;
  c.extend('a',id,'request');
  const request = c.snapshot('b')[0].extension.id;
  assert.throws(() => c.extend('a',id,'accept',request));
  assert.throws(() => c.extend('x',id,'accept',request));
  c.extend('b',id,'accept',request);
  assert.equal(c.snapshot('a')[0].expires,expires+30*60_000);
  assert.throws(() => c.extend('a',id,'request'));
});
test('activity is bounded and isolated by account', () => {
  const db = openAccounts(':memory:');
  initActivity(db);
  for(let i=0;i<60;i++) recordActivity(db,'a','Unlock successful',100000+i);
  recordActivity(db,'b','Unlock rejected',100100);
  assert.equal(listActivity(db,'a',100100).length,50);
  assert.equal(listActivity(db,'b',100100).length,1);
  assert.equal(listActivity(db,'a',100100+31*86400000).length,0);
  db.close();
});
