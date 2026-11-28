import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {playAssets} from '../scripts/play-assets.mjs';
test('Play packaging removes external checkout and APK update code',()=>{const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');const play=playAssets(source);assert.doesNotThrow(()=>new Function(play));assert.ok(source.includes('function showPlanCheckout'));assert.ok(!play.includes('function showPlanCheckout'));assert.ok(!play.includes('access/methods'));assert.ok(play.includes('showAccountRecovery'));assert.ok(!play.includes('release.downloads'));assert.ok(play.includes('QZU-REVIEW-'));assert.ok(play.includes("api('account/delete'"));assert.ok(play.includes("api('report'"));});
test('Play activates a seller using the shared key form', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const play = playAssets(source);
  assert.equal(play.split('function showKeyEntry(').length, 2);
  const form = play.slice(play.indexOf('function showKeyEntry('), play.indexOf('async function finishRenewal('));
  const {runInNewContext} = await import('node:vm');
  const input = {setAttribute() {}};
  const calls = [];
  const context = {
    playBuild:true, checkoutEpoch:1, sessionReady:false, needsSetup:false,
    modal:{dataset:{checkout:'public'}}, el:() => input,
    button:(_, click) => ({click}), showRenewal() {}, showAccess() {},
    forgetInvoice() {}, stopCheckout() {}, showLogin() {},
    dialogError(error) { calls.push(error.message); },
    async api(path, body) { calls.push([path, body.accessKey]); return {needsSetup:true}; }
  };
  context.showCheckout = (label, [, submit]) => Object.assign(context, {label, submit});
  runInNewContext(form + '\nshowKeyEntry(false);', context);
  assert.equal(context.label, 'Access key');
  const key = 'QZU-SELLER-' + 'AB'.repeat(24);
  assert.equal(input.maxLength, key.length);
  input.value = 'QZO-' + 'AB'.repeat(24);
  await context.submit.click();
  input.value = key.toLowerCase();
  await context.submit.click();
  assert.deepEqual(calls, ['Enter a valid access key.', ['session', key]]);
  assert.equal(context.needsSetup, true);
});
