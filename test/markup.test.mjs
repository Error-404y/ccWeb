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

test('admin-only settings section and feedback route',()=>{assert.match(html,/id="adminInterface" hidden/);assert.match(html,/data-settings-category="admin-feedback" hidden/);assert.ok(app.includes("$('adminInterface').hidden=!state.supportAgent"));assert.ok(!app.includes('Messages are not yet end-to-end encrypted.'));});

test('chat headers only expose actionable direct-chat encryption controls',()=>{assert.ok(app.includes('encryptionStatus.hidden = !showDirectSecurity'));assert.ok(app.includes("!showDirectSecurity ? ''"));assert.ok(!app.includes('Not end-to-end encrypted'));assert.ok(!app.includes("info('Connection security'"));assert.ok(!app.includes("['End-to-end encryption', 'Not implemented']"));assert.ok(app.includes('Transport encryption; server can access content'));});

test('privacy policy is linked in app settings',()=>{assert.match(html,/id="privacyPolicy"/);assert.ok(app.includes("new URL('/privacy',apiOrigin)"));});

test('Play build disables checkout and direct updater and exposes compliance actions',()=>{assert.match(html,/id="deleteAccount"/);assert.match(html,/id="adminReports"/);assert.match(html,/id="termsPolicy"/);assert.ok(app.includes("window.QZU_DISTRIBUTION==='google-play'"));assert.ok(app.includes("if (!native || playBuild) return null"));assert.ok(app.includes("api('report'"));assert.ok(app.includes("api('terms/accept'"));});

test('bottom navigation and profile controls exist',()=>{assert.match(html,/id="bottomNav"/);assert.match(html,/id="navUnread"/);assert.match(html,/id="profileAvatar"/);assert.ok(app.includes('attachMessageGesture'));assert.ok(!app.includes("button('Report',()=>showReport(room,{messageId:message.id}),'reply-action'"));});

test('media shortcuts and text-free launch screen are wired',()=>{assert.match(html,/id="cameraShortcut"/);assert.match(html,/id="voiceShortcut"/);assert.ok(app.includes("$('cameraShortcut').addEventListener"));assert.ok(app.includes("$('voiceShortcut').addEventListener"));assert.doesNotMatch(html,/SYSTEM BOOT|Approved design direction|COMMUNICATION \/ REDEFINED/);});

test('startup defers authentication and background lock is optional',()=>{assert.match(html,/id="backgroundPin"/);assert.ok(app.includes('if (bootPending || authBusy'));assert.ok(app.includes("event.animationName==='bootExit'"));assert.ok(app.includes("api('login/background-lock'"));assert.ok(app.includes("room.encryption.offline||room.encryption.peerConfirmed"));});
