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

test('media shortcuts and text-free launch screen are wired',()=>{assert.match(html,/id="cameraShortcut"/);assert.match(html,/id="voiceShortcut"/);assert.ok(app.includes("$('cameraShortcut').addEventListener"));assert.ok(app.includes("voiceControl.addEventListener('pointerdown'"));assert.doesNotMatch(html,/SYSTEM BOOT|Approved design direction|COMMUNICATION \/ REDEFINED/);});

test('startup defers authentication and background lock is optional',()=>{assert.match(html,/id="backgroundPin"/);assert.ok(app.includes('await finishBoot();'));assert.ok(app.includes('setTimeout(resolve,5000)'));assert.ok(app.includes("if (bootPending || document.hidden || unlockToken || !sessionReady) return;"));assert.ok(app.includes("api('login/background-lock'"));assert.ok(app.includes("room.encryption.offline||room.encryption.peerConfirmed"));});

test('iOS local notification test reports native scheduling status and timeout',()=>{assert.ok(app.includes('result?.scheduled'));assert.ok(app.includes('Native notification test timed out'));assert.ok(app.includes('Local test scheduled for 5 seconds'));});

test('motion update respects reduced motion and exposes outgoing queue and real QR lifetime',()=>{
 const css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
 assert.match(html,/id="inviteProgress"/);assert.match(html,/id="connectionState"/);assert.match(html,/id="manageOutbox"/);
 assert.match(css,/ignitionGlow/);assert.match(css,/prefers-reduced-motion:reduce/);assert.ok(app.includes("motion(row,'motion-message')"));
 assert.ok(app.includes('outbox.set(requestId,{room:id,payload,binding:'));assert.ok(app.includes('outbox.clear()'));
 assert.ok(app.includes("window.addEventListener('offline', () => {\n  markDisconnected();"));
});
test('Android notification setup prompts once by default without an in-app opt-out',()=>{
 assert.ok(app.includes('registerPrivatePush(false,shouldPromptPush())'));
 assert.ok(app.includes("localStorage.removeItem('qzu-push-opt-out')"));assert.ok(!app.includes("button('Turn off'"));
 assert.ok(app.includes("localStorage.setItem('qzu-push-permission-requested','1')"));
});

test('encrypted view-once uses dedicated endpoints and never queues as ordinary text',()=>{assert.ok(app.includes("api('encryption/once/send',{id,cipher})"));assert.ok(app.includes("encrypted?'encryption/once/open':'message/open'"));assert.ok(app.includes("message.once || message.deleted || !encryptionReady(room)"));assert.ok(app.includes("once?'encryption/once/send':'encryption/message'"));assert.ok(app.includes("if(draft?.once)setOnceMode(true)"));});
