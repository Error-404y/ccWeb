import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('HTML and SVG IDs are unique', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('send arrow identifies the button, not the SVG symbol', () => {
  assert.match(html, /<button id="send"[^>]*type="button"/);
  assert.match(html, /<symbol id="sendIcon"/);
  assert.match(html, /<use href="#sendIcon"\/>/);
  assert.ok(app.includes("$(\'send\').addEventListener(\'click\', sendMessage)"));
});

test('key redemption uses neutral wording without exposing admin key types', () => {
  assert.ok(app.includes("button('Redeem Key', () => showKeyEntry(false)"));
  assert.ok(app.includes("input.placeholder = 'Use Access-Key'"));
  assert.ok(app.includes("showCheckout('Use Access-Key'"));
  assert.ok(!app.includes('Access or admin key'));
});

test('Help provides concise notes and an actionable support inbox', () => {
  assert.match(html, /<ul class="support-help-notes">\s*<li>Contact Support for assistance\.<\/li>\s*<li>Support manages chat retention and deletion\.<\/li>\s*<\/ul>/);
  assert.ok(app.includes("supportRequestsLink').hidden = !state.supportAgent"));
  assert.match(html, /id="supportRequestsLink"[^>]*hidden/);
  assert.ok(app.includes("api('support/respond',{id:request.id,action})"));
  assert.ok(app.includes("api('support/open',{})"));
  assert.ok(app.includes("show('Support inbox', controls)"));
  assert.ok(app.includes("Support is currently unavailable."));
  assert.ok(!app.includes("if (!unlockToken || !state.supportAvailable) return;"));
});

test('official channel exposes an admin composer and unread indicator',()=>{
  assert.match(html,/id="officialUnread"[^>]*hidden/);
  assert.match(html,/id="officialComposer"[^>]*hidden/);
  assert.ok(app.includes("officialComposer').hidden=!state.supportAgent"));
  assert.ok(app.includes("api('official/publish',{text})"));
});
