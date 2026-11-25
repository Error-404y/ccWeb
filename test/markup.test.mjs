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
