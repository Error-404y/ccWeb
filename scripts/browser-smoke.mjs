import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { chromium } from 'playwright-core';
import { createAccount, openAccounts, setLogin } from '../lib/accounts.mjs';
import { createSupportKey, generatePlanKeys, initAccess } from '../lib/access.mjs';
import { complianceStore } from '../lib/compliance.mjs';
import { contactStore } from '../lib/contacts.mjs';
import { initControl, issueRecovery, recoverAccount } from '../lib/control.mjs';
import { deviceProfiles, initDevices } from '../lib/devices.mjs';
import { officialStore } from '../lib/official.mjs';
import { redeemSellerKey, sellerStore } from '../lib/sellers.mjs';
import { playAssets } from './play-assets.mjs';

const dir = mkdtempSync(join(tmpdir(), 'qzu-browser-'));
const database = join(dir, 'accounts.sqlite');
let child;
let browser;

try {
  const db = openAccounts(database);
  initAccess(db);
  initDevices(db);
  initControl(db);
  const adminKey = createSupportKey(db);
  const sellerKeys = generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const {x,y} = sellerKeys.publicKey.export({format:'jwk'});
  const sellerPublicBytes = Buffer.concat([Buffer.from([4]),Buffer.from(x,'base64url'),Buffer.from(y,'base64url')]);
  const sellerDeviceId = createHash('sha256').update(sellerPublicBytes).digest('hex');
  const {key:sellerAccess} = sellerStore(db).generateKey('browser-fixture');
  const sellerFixture = redeemSellerKey(db,sellerAccess,Date.now(),sellerDeviceId);
  const buyerFixture = createAccount(db);
  contactStore(db).add(buyerFixture.id,sellerFixture.id,'Studio seller','Buyer');
  const reports = complianceStore(db);
  const deviceFingerprint='a'.repeat(64), previousFingerprint='d'.repeat(64);
  const reported=createAccount(db,previousFingerprint), reporter=createAccount(db);
  const reportedPin='867249';
  assert.ok(setLogin(db,reported.id,reportedPin));
  const devices=deviceProfiles(db);
  devices.update({id:reported.id,device_id:previousFingerprint},previousFingerprint,'ios',{model:'iPhone16,2',osVersion:'26.0',appVersion:'0.17.9'});
  const {recoveryCode}=issueRecovery(db,reported.id,reportedPin);
  recoverAccount(db,recoveryCode,reportedPin,deviceFingerprint);
  devices.update({id:reported.id,device_id:deviceFingerprint},deviceFingerprint,'ios',{model:'iPhone15,4',osVersion:'26.1',appVersion:'0.17.9'});
  const messageId='15090c60-1d0f-45c8-b945-9d98b7ed231d';
  const now=Date.now();
  const evidenceImage=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aI2kAAAAASUVORK5CYII=','base64');
  reports.report(reporter.id,reported.id,'fixture-room','Other','Browser report evidence',messageId,[
   {id:messageId,sender:'Reported account',at:now,reported:true,text:'Submitted snapshot message',source:'reporter-submitted'},
   {id:'075418d4-7597-4da6-a482-94d50dced9d1',sender:'Reporter',at:now-1000,reported:false,text:'Earlier context',source:'reporter-submitted'}
  ],'encrypted direct',{messageId,kind:'image',mime:'image/png',body:evidenceImage,source:'reporter-submitted',at:now});
  generatePlanKeys(db,'1M',100,'browser-fixture',now-1000);
  const [used,individualKey]=generatePlanKeys(db,'LT',2,'browser-fixture',now).keys;
  const keyAccount=createAccount(db),individualAccount=createAccount(db);
  const redeemFixture=db.prepare('UPDATE access_invoices SET redeemed=?,redeemed_account=? WHERE id=?');
  redeemFixture.run(now,keyAccount.id,used.id);
  redeemFixture.run(now,individualAccount.id,individualKey.id);
  const announcements = officialStore(db);
  for (let i = 1; i <= 90; i++) {
    announcements.publish('Announcement ' + i + ' ' + 'Browser test fixture. '.repeat(25), true);
  }
  db.close();

  child = spawn(process.execPath, ['server.mjs'], {
    env: {
      ...process.env, NODE_ENV: 'test', PUBLIC_ORIGIN: '', HOST: '127.0.0.1', PORT: '0',
      QZU_DB: database, QZU_RELEASE_DIR: dir, QZU_ADMIN_DIR: join(dir, 'admin'), QZU_ACCESS_REQUIRED: 'false', QZU_MOBILE_ONLY: 'false'
    },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const port = await new Promise((resolve, reject) => {
    const output = createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error('Server startup timed out.')), 10000);
    child.once('error', reject);
    child.once('exit', code => reject(new Error('Server exited with code ' + code)));
    child.once('exit', () => clearTimeout(timer));
    output.on('line', line => {
      const match = line.match(/^qzu\. listening on (\d+)$/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const origin = 'http://127.0.0.1:' + port;
  browser = await chromium.launch({
    executablePath: process.env.QZU_TEST_CHROME_PATH,
    channel: process.env.QZU_TEST_CHROME_PATH ? undefined : 'chromium',
    args: ['--use-fake-device-for-media-stream']
  });

  const download=await browser.newPage({viewport:{width:390,height:844},isMobile:true});
  await download.goto(origin+'/download');
  await download.getByText('Download unavailable.',{exact:true}).waitFor();
  assert.equal(await download.getByRole('link',{name:'Download for Android'}).count(),0);
  const release=JSON.parse(readFileSync(new URL('../package.json',import.meta.url))).version;
  writeFileSync(join(dir,'qzu-'+release+'.apk'),'APK fixture');
  await download.reload();
  const downloadLink=download.getByRole('link',{name:'Download for Android'});
  await downloadLink.waitFor();
  assert.equal(await downloadLink.getAttribute('href'),'/downloads/qzu-'+release+'.apk');
  assert.equal(await (await download.request.get(origin+'/downloads/qzu-'+release+'.apk')).text(),'APK fixture');
  await download.getByText('Already using qzu.?',{exact:true}).waitFor();
  await download.context().close();

  let ticketCustomer;
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, hasTouch: viewport.width < 500, isMobile: viewport.width < 500 });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    const pin = page.locator('dialog input');
    await pin.first().waitFor();
    for (const field of await pin.all()) await field.fill('684219');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('dialog input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await page.locator('#bottomNav [data-tab=connect]').click();
    await page.locator('#qrImage').waitFor();
    await page.locator('#bottomNav [data-tab=tickets]').click();
    await page.getByRole('heading', { name: 'Create a Ticket' }).waitFor();
    if (viewport.width > 500) {
      ticketCustomer = page;
      await page.getByPlaceholder('What do you need?').fill('Browser smoke ticket');
      await page.getByRole('button', { name: 'Create Ticket' }).click();
      await page.getByText('Browser smoke ticket', { exact: true }).waitFor();
    }
    await page.locator('#bottomNav [data-tab=chat]').click();
    await page.locator('#officialUnread').waitFor();
    await page.locator('#qzuInfoOpen').click();
    await page.waitForFunction(() => {
      const badge = document.getElementById('officialUnread');
      const remaining = Number(badge.textContent);
      return !badge.hidden && remaining > 0 && remaining < 90;
    });
    if (viewport.width < 500) await page.locator('#qzuInfoBack').click();
    await page.locator('#bottomNav [data-tab=settings]').click();
    await page.locator('#updateCenter').click();
    await page.getByText(/^Web release /).waitFor();
    assert.deepEqual(errors, []);
    if(page===ticketCustomer)await page.locator('#modalClose').click();
    else await page.context().close();
    console.log('Messenger navigation and announcement receipts passed at ' + viewport.width + 'px.');
  }

  const chatPage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  chatPage.setDefaultTimeout(10000);
  const peer = await browser.newContext();
  const headers = token => ({ 'X-QZU': '1', ...(token ? { 'X-QZU-Unlock': token } : {}) });
  const call = async (context, path, data, token) => {
    const result = await context.request.fetch(origin + '/api/' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: headers(token), data
    });
    assert.equal(result.status(), 200, path);
    return result.json();
  };
  await chatPage.goto(origin);
  const loginFields = chatPage.locator('dialog input');
  await loginFields.first().waitFor();
  for (const field of await loginFields.all()) await field.fill('683219');
  const signedIn = chatPage.waitForResponse(response => response.url() === origin + '/api/login/setup');
  await chatPage.getByRole('button', { name: 'Create', exact: true }).click();
  const { token: viewerToken } = await (await signedIn).json();
  await chatPage.locator('dialog input[type=checkbox]').check();
  await chatPage.getByRole('button', { name: 'Accept and continue' }).click();
  const viewer = chatPage.context();
  await call(peer, 'session', {});
  const { token: peerToken } = await call(peer, 'login/setup', { pin: '123769' });
  await call(peer, 'terms/accept', { version: 1 }, peerToken);
  const { invite } = await call(viewer, 'state', undefined, viewerToken);
  await call(peer, 'connect', { code: invite.code, nickname: 'Viewer' }, peerToken);
  const { requests } = await call(viewer, 'state', undefined, viewerToken);
  const { id: roomId } = await call(viewer, 'connection/respond', { id: requests[0].id, accept: true, nickname: 'Chat Peer' }, viewerToken);
  await chatPage.evaluate(() => refresh());
  const contact = chatPage.locator('#contacts .contact').filter({ hasText: 'Chat Peer' });
  await contact.click();
  for (let i = 0; i < 17; i++) {
    await call(peer, 'message', { id: roomId, text: 'History ' + i + ' ' + 'Sample message content. '.repeat(8) }, peerToken);
  }
  await chatPage.locator('#messages').getByText(/^History 16 /).waitFor();
  assert.equal(await chatPage.locator('#messages .date-divider').first().textContent(), 'Today');
  await chatPage.locator('#messages').evaluate(node => { node.scrollTop = 0; });
  await call(peer, 'message', { id: roomId, text: 'New message at the bottom' }, peerToken);
  await chatPage.getByRole('button', { name: /new message/ }).waitFor();
  assert.equal(await chatPage.locator('#messages .unread-divider').count(), 1);
  assert.equal(await chatPage.locator('#messages').evaluate(node => node.scrollTop), 0);
  await chatPage.getByRole('button', { name: /new message/ }).click();
  await chatPage.waitForFunction(() => document.getElementById('messages').scrollTop > 0);
  await chatPage.locator('#expiryDetails').click();
  await chatPage.getByRole('heading', { name: 'Chat expiry' }).waitFor();
  await chatPage.locator('#modalClose').click();
  await chatPage.locator('#chatOptions').click();
  await chatPage.getByRole('button', { name: 'Mute notifications' }).click();
  await chatPage.getByRole('button', { name: 'Mute for 1 hour' }).click();
  await chatPage.locator('#threadName .contact-muted').waitFor();
  await chatPage.locator('#chatOptions').click();
  await chatPage.getByRole('button', { name: 'Pin contact' }).click();
  await chatPage.locator('#threadName [aria-label="Pinned contact"]').waitFor();
  await chatPage.locator('#messages').getByText('New message at the bottom', {exact:true}).click({button:'right'});
  await chatPage.getByRole('button', {name:'Reply', exact:true}).click();
  assert.match(await chatPage.locator('#replyComposer').innerText(), /Replying to Chat Peer\s+New message at the bottom/);
  await chatPage.locator('#cancelReply').click();
  await chatPage.locator('#attachmentMenu').click();
  const photoChooser = chatPage.waitForEvent('filechooser');
  await chatPage.getByRole('button', {name:'Gallery', exact:true}).click();
  await (await photoChooser).setFiles(join(process.cwd(),'public/wallpapers/mist-paper.webp'));
  await chatPage.getByRole('heading', {name:'Photo preview', exact:true}).waitFor();
  await chatPage.getByRole('img', {name:'Photo preview'}).waitFor();
  await chatPage.getByRole('combobox', {name:'Crop'}).selectOption({label:'Square'});
  await chatPage.getByRole('button', {name:'Rotate right', exact:true}).click();
  await chatPage.getByRole('button', {name:'Enable view once', exact:true}).last().click();
  await chatPage.getByRole('button', {name:'Send once', exact:true}).click();
  await chatPage.getByRole('button', {name:'Photo, unopened', exact:true}).waitFor();
  await viewer.grantPermissions(['microphone'], {origin});
  const voicePreview = chatPage.locator('#voicePreview');
  async function recordVoicePreview() {
    await chatPage.locator('#attachmentMenu').click();
    await chatPage.getByRole('button', {name:'Voice message', exact:true}).click();
    await chatPage.locator('.voice-gesture-status').filter({hasText:/Recording · 0:(?!00)\d{2}/}).waitFor();
    await chatPage.getByRole('button', {name:'Preview', exact:true}).click();
    await voicePreview.getByRole('heading', {name:'Voice message preview'}).waitFor();
  }
  await recordVoicePreview();
  assert.equal(await voicePreview.getByRole('combobox', {name:'Playback speed'}).inputValue(), '1');
  await voicePreview.getByRole('button', {name:'Discard', exact:true}).click();
  assert.equal(await voicePreview.isVisible(), false);
  await recordVoicePreview();
  await voicePreview.getByRole('button', {name:'Send recording', exact:true}).click();
  await chatPage.getByRole('button', {name:'Play voice message', exact:true}).waitFor();

  let releaseSend;
  const allowSend = new Promise(resolve => { releaseSend=resolve; });
  const sendAttempts=[];
  let permitDelivery=false;
  await chatPage.route(origin+'/api/message',async route=>{
    const payload=route.request().postDataJSON();
    if(!payload?.text?.startsWith('Offline queue'))return route.continue();
    sendAttempts.push(payload);
    if(sendAttempts.length===1)await allowSend;
    if(!permitDelivery)return route.fulfill({status:503,json:{error:'Temporary send failure.'}});
    return route.continue();
  });
  await viewer.setOffline(true);
  await chatPage.locator('#connectionState').getByText('Waiting for connection',{exact:true}).waitFor();
  for (const text of ['Offline queue first','Offline queue second']) {
    await chatPage.locator('#message').fill(text);
    await chatPage.getByRole('button',{name:'Send',exact:true}).click();
    await chatPage.locator('.pending-row').filter({hasText:text}).getByText('Waiting for connection',{exact:true}).waitFor();
  }
  assert.equal(sendAttempts.length,0);
  await viewer.setOffline(false);
  const firstPending=chatPage.locator('.pending-row').filter({hasText:'Offline queue first'});
  await firstPending.getByText('Sending',{exact:true}).waitFor();
  releaseSend();
  await firstPending.getByText('Failed',{exact:true}).waitFor({timeout:14000});
  await firstPending.getByText('Temporary send failure.',{exact:true}).waitFor();
  assert.equal(sendAttempts.length,3);
  assert.ok(sendAttempts.every(attempt=>attempt.text==='Offline queue first'&&attempt.requestId===sendAttempts[0].requestId));
  permitDelivery=true;
  await firstPending.getByRole('button',{name:'Retry message'}).click();
  await chatPage.locator('.message-row:not(.pending-row)').getByText('Offline queue second',{exact:true}).waitFor();
  const delivered=(await call(peer,'state',undefined,peerToken)).rooms.find(room=>room.id===roomId);
  assert.deepEqual(delivered.messages.filter(message=>message.text.startsWith('Offline queue')).map(message=>message.text),['Offline queue first','Offline queue second']);
  assert.equal(sendAttempts[3].requestId,sendAttempts[0].requestId);
  assert.notEqual(sendAttempts[4].requestId,sendAttempts[3].requestId);
  await chatPage.unroute(origin+'/api/message');

  await chatPage.locator('#message').fill('Local draft');
  await chatPage.locator('#backToChats').click();
  await contact.getByText('Draft', { exact: true }).waitFor();
  await chatPage.getByRole('searchbox').fill('Unknown');
  await chatPage.getByText('No matching chats').waitFor();
  await chatPage.getByRole('searchbox').fill('Chat Peer');
  await contact.waitFor();
  await chatPage.locator('#bottomNav [data-tab=settings]').click();
  await chatPage.getByRole('link', { name: 'Appearance' }).click();
  await chatPage.locator('#chatTextSize').click();
  await chatPage.getByRole('combobox', { name: 'Message text size' }).selectOption('large');
  assert.equal(await chatPage.locator('html').getAttribute('data-chat-text-size'),'large');
  await chatPage.locator('#modalClose').click();
  await chatPage.locator('#appearancePresets').click();
  await chatPage.getByRole('button', { name: /Graphite/ }).click();
  assert.equal(await chatPage.locator('html').getAttribute('data-chat-background'),'grid');
  await chatPage.locator('#modalClose').click();
  await chatPage.locator('#chatBackground').click();
  for (const [name,choice] of [['Obsidian Contours','obsidian'],['Ember Folds','ember'],['Mist Paper','mist']]) {
    const background = chatPage.getByRole('button', {name, exact:true});
    await background.click();
    assert.equal(await background.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await chatPage.evaluate(() => [
      document.documentElement.dataset.chatBackground,
      localStorage.getItem('qzu-chat-background')
    ]), [choice,choice]);
  }
  await chatPage.getByRole('button', {name:'Done', exact:true}).click();
  assert.equal(await chatPage.locator('#chatBackgroundLabel').textContent(), 'Mist Paper');
  await chatPage.locator('#bottomNav [data-tab=connect]').click();
  await chatPage.getByText('More connection options',{exact:true}).click();
  await chatPage.locator('#createGroup').click();
  await chatPage.getByLabel('Group name',{exact:true}).fill('Workshop group');
  await chatPage.getByLabel('Group description (optional)',{exact:true}).fill('Bring a piece to share.');
  await chatPage.getByRole('dialog').getByRole('button',{name:'Create group',exact:true}).click();
  const ownerInvite=chatPage.getByRole('dialog');
  await ownerInvite.getByRole('button',{name:'Close invites',exact:true}).waitFor();
  const groupCode=await ownerInvite.locator('.pin-display').textContent();
  const {id:groupFixture}=(await call(viewer,'state',undefined,viewerToken)).rooms.find(room=>room.groupName==='Workshop group');
  const applicant=await peer.newPage();
  applicant.setDefaultTimeout(10000);
  await applicant.goto(origin+'/connect');
  await applicant.getByLabel('Login PIN',{exact:true}).fill('123769');
  const applicantLogin=applicant.waitForResponse(response=>response.url()===origin+'/api/login/unlock');
  await applicant.getByRole('button',{name:'Unlock',exact:true}).click();
  const {token:applicantToken}=await (await applicantLogin).json();
  await applicant.getByLabel('Enter code',{exact:true}).fill(groupCode);
  await applicant.getByRole('button',{name:'Add',exact:true}).click();
  await applicant.getByRole('dialog').getByText('Bring a piece to share.',{exact:true}).waitFor();
  assert.equal((await call(viewer,'state',undefined,viewerToken)).requests.some(request=>request.group),false);
  await applicant.getByRole('textbox',{name:'Your name in the group',exact:true}).fill('User.Name');
  await applicant.getByRole('button',{name:'Send request',exact:true}).click();
  await applicant.getByRole('heading',{name:'Request sent',exact:true}).waitFor();
  assert.equal((await call(peer,'state',undefined,applicantToken)).rooms.some(room=>room.id===groupFixture),false);
  await ownerInvite.getByRole('button',{name:'Close invites',exact:true}).click();
  await ownerInvite.getByText(/Invites are closed/).waitFor();
  for(const path of ['connect/preview','connect']){
    const expired=await peer.request.post(origin+'/api/'+path,{headers:headers(applicantToken),data:{code:groupCode}});
    assert.equal(expired.status(),404);
  }
  const groupRequest=(await call(viewer,'state',undefined,viewerToken)).requests.find(request=>request.group);
  await call(viewer,'connection/respond',{id:groupRequest.id,accept:true},viewerToken);
  await ownerInvite.getByRole('button',{name:'Create new code',exact:true}).click();
  await ownerInvite.getByRole('button',{name:'Close invites',exact:true}).waitFor();
  assert.notEqual(await ownerInvite.locator('.pin-display').textContent(),groupCode);
  await ownerInvite.getByRole('button',{name:'Close',exact:true}).last().click();
  await chatPage.evaluate(()=>refresh());
  await chatPage.locator('#messages').getByText('User.Name has joined the group.',{exact:true}).waitFor();
  await chatPage.locator('#chatOptions').click();
  await chatPage.getByRole('button',{name:'Group settings',exact:true}).click();
  await chatPage.getByLabel('Group description',{exact:true}).fill('Monthly workshop');
  await chatPage.getByLabel('Who can post',{exact:true}).selectOption('admins');
  await chatPage.getByRole('button',{name:'Save settings',exact:true}).click();
  const workshop=(await call(viewer,'state',undefined,viewerToken)).rooms.find(room=>room.id===groupFixture);
  assert.equal(workshop.groupDescription,'Monthly workshop');
  assert.equal(workshop.groupPosting,'admins');
  await applicant.locator('#modalClose').click();
  await applicant.evaluate(()=>refresh());
  await applicant.locator('#contacts').getByText('Workshop group',{exact:true}).click();
  await applicant.getByText('Only the group owner and qzu. admins can post.',{exact:true}).waitFor();
  assert.equal(await applicant.locator('#composer').isVisible(),false);
  await chatPage.locator('#chatOptions').click();
  await chatPage.getByRole('button',{name:'Group deletion timers',exact:true}).click();
  await chatPage.getByRole('combobox',{name:'Delete group after',exact:true}).selectOption('never');
  await chatPage.getByRole('button',{name:'Save timers',exact:true}).click();
  await chatPage.getByText('No expiry',{exact:true}).waitFor();
  await viewer.close();
  await peer.close();
  console.log('Chat scroll anchoring, reply, media previews, ordered offline retries, drafts and appearance passed.');

  const play = await browser.newPage({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce'
  });
  play.setDefaultTimeout(8000);
  const playOrigin = 'https://play.qzu.test';
  const playScript = playAssets(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));
  let activation;
  await play.addInitScript(origin => {
    window.QZU_API_ORIGIN = origin;
    window.QZU_DISTRIBUTION = 'google-play';
    window.Capacitor = {
      isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => true,
      registerPlugin: () => ({
        sign: async () => ({ publicKey: 'fixture', signature: 'fixture' }),
        addListener: async () => {}, haptic: async () => {}
      })
    };
  }, playOrigin);
  await play.route(playOrigin + '/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/session') {
      activation = route.request().postDataJSON().accessKey;
      await route.fulfill({ json: activation ? { needsSetup: true } : { accessRequired: true } });
    } else if (path === '/app.js') {
      await route.fulfill({ contentType: 'text/javascript', body: playScript });
    } else {
      const response = await route.fetch({ url: origin + path });
      await route.fulfill({ response });
    }
  });
  await play.goto(playOrigin);
  await play.getByRole('button', { name: 'Redeem Key', exact: true }).click();
  const sellerKey = 'QZU-SELLER-' + 'A'.repeat(48);
  await play.getByRole('textbox', { name: 'Access key', exact: true }).fill(sellerKey);
  await play.getByRole('button', { name: 'Continue', exact: true }).click();
  await play.getByRole('heading', { name: 'Create login PIN' }).waitFor();
  assert.equal(activation, sellerKey);
  await play.context().close();
  console.log('Packaged Google Play client accepts seller activation keys.');

  const direct=await browser.newPage({viewport:{width:390,height:844},isMobile:true,reducedMotion:'reduce'});
  const directOrigin='https://direct.qzu.test';
  await direct.addInitScript(origin=>{
    window.QZU_API_ORIGIN=origin;
    window.QZU_APP_VERSION='0.17.15';
    window.QZU_DISTRIBUTION='direct';
    window.Capacitor={
      isNativePlatform:()=>true,getPlatform:()=>'android',isPluginAvailable:()=>true,
      registerPlugin:()=>({
        sign:async()=>({publicKey:'fixture',signature:'fixture'}),
        addListener:async(name,listener)=>{if(name==='pushNotificationActionPerformed')window.tapUpdate=listener;},
        openUpdate:async({url})=>{window.openedUpdate=url;}
      })
    };
  },directOrigin);
  await direct.route(directOrigin+'/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/session')await route.fulfill({json:{accessRequired:true}});
    else if(path==='/api/version')await route.fulfill({json:{latest:'0.17.16',downloads:{android:directOrigin+'/download'}}});
    else await route.fulfill({response:await route.fetch({url:origin+path})});
  });
  await direct.goto(directOrigin);
  await direct.locator('dialog .pay-shell').waitFor({timeout:8000});
  await direct.evaluate(()=>{
    unlockToken='fixture-unlock';
    modalLocked=false;
    accessDue=false;
    closeModal();
    deferUpdate('0.17.16');
    window.tapUpdate({notification:{data:{kind:'app-update',version:'0.17.16'}}});
  });
  await direct.getByRole('heading',{name:'Update qzu.?',exact:true}).waitFor({timeout:8000});
  await direct.getByRole('button',{name:'Update now',exact:true}).click();
  assert.equal(await direct.evaluate(()=>window.openedUpdate),directOrigin+'/download');
  await direct.context().close();
  console.log('Android release notification opens the download page.');

  let sellerUnlock = '';
  function sellerDeviceHeaders(method, path, body, unlock) {
    const timestamp = String(Date.now()), nonce = randomBytes(16).toString('hex');
    const envelope = JSON.stringify(['qzu-device-v1',method,path,timestamp,nonce,unlock,body]);
    return {'x-qzu-device':sellerPublicBytes.toString('base64'),
      'x-qzu-signature':sign('sha256',Buffer.from(envelope),sellerKeys.privateKey).toString('base64'),
      'x-qzu-time':timestamp,'x-qzu-nonce':nonce};
  }
  async function sellerRequest(path, data, expected=200) {
    const method=data===undefined?'GET':'POST';
    const body = JSON.stringify(data);
    const headers = {'Content-Type':'application/json','X-QZU':'1','X-QZU-Unlock':sellerUnlock,
      ...sellerDeviceHeaders(method,path,body||'',sellerUnlock)};
    const response = await fetch(origin + path,{method,body,headers});
    assert.equal(response.status,expected,path);
    const value = await response.json();
    if (value.token) sellerUnlock=value.token;
    return value;
  }
  await sellerRequest('/api/login/setup',{pin:'143258'});
  await sellerRequest('/api/terms/accept',{version:1});
  await sellerRequest('/api/sellers/profile',{name:'Studio seller'});
  const shopStaff=await browser.newContext({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    extraHTTPHeaders:{'X-QZU':'1','sec-ch-ua-platform':'"macOS"'}});
  assert.equal((await shopStaff.request.post(origin+'/api/control/login',{data:{key:adminKey,pin:''}})).status(),200);
  async function publishShop(name) {
    const result=await shopStaff.request.get(origin+'/api/control/shop-reviews');
    assert.equal(result.status(),200);
    const pending=(await result.json()).items.find(item=>item.name===name);
    assert.ok(pending,name+' is pending review');
    assert.equal((await shopStaff.request.post(origin+'/api/control/shop-reviews/review',{data:{id:pending.id,approve:true}})).status(),200);
  }
  const publishedItem = {id:randomUUID(),name:'Studio print',quantity:0,price:'12.50',currency:'CHF',fulfillment:'both',published:true};
  const draftItem = {...publishedItem,id:randomUUID(),name:'Private draft',quantity:4,fulfillment:'pickup',published:false};
  await sellerRequest('/api/sellers/catalog/manage',publishedItem);
  await publishShop('Studio print');
  await sellerRequest('/api/sellers/catalog/manage',draftItem);
  const shopOwner = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  shopOwner.setDefaultTimeout(10000);
  await shopOwner.route(origin+'/api/**',route=>{
    const request=route.request(), url=new URL(request.url()), headers=request.headers();
    return route.continue({headers:{...headers,
      ...sellerDeviceHeaders(request.method(),url.pathname+url.search,request.postData()||'',headers['x-qzu-unlock']||'')}});
  });
  await shopOwner.goto(origin+'/settings');
  await shopOwner.getByLabel('Login PIN',{exact:true}).fill('143258');
  await shopOwner.getByRole('button',{name:'Unlock',exact:true}).click();
  await shopOwner.getByRole('link',{name:'Shop',exact:true}).click();
  await shopOwner.getByRole('heading',{name:'Shop',exact:true}).waitFor();
  const draftsPanel = shopOwner.getByRole('table',{name:'Private drafts',exact:true});
  const listingsPanel = shopOwner.getByRole('table',{name:'Items for sale',exact:true});
  await draftsPanel.getByText('Private draft',{exact:true}).waitFor();
  await listingsPanel.getByText('Studio print',{exact:true}).waitFor();
  await shopOwner.getByRole('button',{name:'Add item',exact:true}).click();
  await shopOwner.getByLabel('Item name',{exact:true}).fill('Desk print');
  await shopOwner.getByRole('button',{name:'Save draft',exact:true}).click();
  await draftsPanel.getByText('Desk print',{exact:true}).waitFor();
  await draftsPanel.getByRole('button',{name:'Edit Desk print',exact:true}).click();
  await shopOwner.getByLabel('Price per item',{exact:true}).fill('9.50');
  await shopOwner.getByLabel('How buyers receive it',{exact:true}).selectOption('delivery');
  await shopOwner.getByLabel('Description (optional)',{exact:true}).fill('Printed on matte paper');
  await shopOwner.getByRole('button',{name:'Preview listing',exact:true}).click();
  await shopOwner.getByRole('heading',{name:'Buyer preview',exact:true}).waitFor();
  const preview=shopOwner.getByRole('dialog').getByRole('table');
  await preview.getByText('Printed on matte paper',{exact:true}).waitFor();
  await preview.getByText(/9[.,]50/).waitFor();
  await preview.getByText('Delivery',{exact:true}).waitFor();
  assert.equal((await (await shopStaff.request.get(origin+'/api/control/shop-reviews')).json()).items.length,0);
  await shopOwner.getByRole('button',{name:'Back to editing',exact:true}).click();
  assert.equal(await shopOwner.getByLabel('Description (optional)',{exact:true}).inputValue(),'Printed on matte paper');
  await shopOwner.getByRole('button',{name:'Submit for review',exact:true}).click();
  await shopOwner.getByRole('heading',{name:'Waiting for review',exact:true}).waitFor();
  assert.equal(await listingsPanel.getByText('Desk print',{exact:true}).count(),0);
  await publishShop('Desk print');
  await shopOwner.getByRole('button',{name:'Refresh listings',exact:true}).click();
  await listingsPanel.getByText('Desk print',{exact:true}).waitFor();
  assert.equal(await draftsPanel.getByText('Desk print',{exact:true}).count(),0);
  await listingsPanel.getByRole('button',{name:'Edit Desk print',exact:true}).click();
  await shopOwner.getByLabel('Quantity',{exact:true}).fill('2');
  await shopOwner.getByLabel('Price per item',{exact:true}).fill('11.50');
  await shopOwner.getByLabel('Description (optional)',{exact:true}).fill('Printed on textured paper');
  await shopOwner.getByRole('button',{name:'Submit for review',exact:true}).click();
  await shopOwner.getByRole('heading',{name:'Waiting for review',exact:true}).waitFor();
  const reviewPage=await shopStaff.newPage();
  reviewPage.setDefaultTimeout(8000);
  await reviewPage.goto(origin+'/control');
  await reviewPage.getByRole('navigation').getByRole('button',{name:/^Shop reviews/}).click();
  const comparison=reviewPage.getByRole('table',{name:'Changes to published listing',exact:true});
  await comparison.getByText('Printed on matte paper',{exact:true}).waitFor();
  await comparison.getByText('Printed on textured paper',{exact:true}).waitFor();
  await comparison.getByText(/9[.,]50/).waitFor();
  await comparison.getByText(/11[.,]50/).waitFor();
  assert.deepEqual(await comparison.getByRole('row',{name:'Quantity 1 2'}).getByRole('cell').allTextContents(),['1','2']);
  assert.equal(await comparison.getByRole('rowheader',{name:'Fulfillment',exact:true}).count(),0);
  await reviewPage.getByRole('button',{name:'Return to seller',exact:true}).click();
  await reviewPage.getByRole('textbox',{name:'Note to seller (optional)',exact:true}).fill('Please clarify pickup details.');
  await reviewPage.getByRole('button',{name:'Return listing',exact:true}).click();
  await reviewPage.getByText('No listings waiting for review.',{exact:true}).waitFor();
  await shopOwner.getByRole('button',{name:'Refresh listings',exact:true}).click();
  const returned=shopOwner.locator('.seller-shop-section').filter({has:shopOwner.getByRole('heading',{name:'Returned for edits',exact:true})});
  await returned.getByText('Staff left a note',{exact:true}).waitFor();
  await returned.getByRole('button',{name:'Edit Desk print',exact:true}).click();
  await shopOwner.getByRole('dialog').getByText('Please clarify pickup details.',{exact:true}).waitFor();
  await shopOwner.getByRole('button',{name:'Submit for review',exact:true}).click();
  await shopOwner.getByRole('heading',{name:'Waiting for review',exact:true}).waitFor();
  await reviewPage.reload();
  await reviewPage.getByRole('navigation').getByRole('button',{name:/^Shop reviews/}).click();
  await reviewPage.getByRole('button',{name:'Publish listing',exact:true}).click();
  await reviewPage.getByRole('dialog').getByRole('button',{name:'Confirm',exact:true}).click();
  await reviewPage.getByText('No listings waiting for review.',{exact:true}).waitFor();
  await reviewPage.close();
  const {id:sellerGroup}=await sellerRequest('/api/group/create',{name:'Print workshop'});
  const {code:sellerGroupCode}=await sellerRequest('/api/group/invite',{id:sellerGroup});
  await shopOwner.locator('#bottomNav [data-tab=chat]').click();
  await shopOwner.evaluate(()=>refresh());
  await shopOwner.locator('#contacts').getByText('Print workshop',{exact:true}).click();
  await shopOwner.locator('#chatOptions').click();
  await shopOwner.getByRole('button',{name:'Group settings',exact:true}).click();
  await shopOwner.getByLabel('Link my shop',{exact:true}).check();
  await shopOwner.getByRole('button',{name:'Save settings',exact:true}).click();
  await shopOwner.getByRole('button',{name:'Open seller shop',exact:true}).waitFor();
  assert.equal((await shopStaff.request.post(origin+'/api/control/sellers/verify',{data:{id:sellerFixture.id,verified:true}})).status(),200);
  await sellerRequest('/api/group/shop/share',{id:sellerGroup,itemId:draftItem.id},404);
  await shopOwner.getByRole('button',{name:'Open seller shop',exact:true}).click();
  await shopOwner.getByRole('button',{name:'Share Studio print to group',exact:true}).click();
  await shopOwner.locator('#messages .message-listing').getByText('Studio print',{exact:true}).waitFor();

  const buyer = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  buyer.setDefaultTimeout(10000);
  await buyer.context().addCookies([{name:'qzu',value:buyerFixture.token,url:origin,httpOnly:true}]);
  await buyer.goto(origin);
  await buyer.locator('dialog input').first().waitFor();
  for (const field of await buyer.locator('dialog input').all()) await field.fill('682491');
  const buyerSignIn = buyer.waitForResponse(response => response.url() === origin + '/api/login/setup');
  await buyer.getByRole('button',{name:'Create',exact:true}).click();
  const {token:buyerToken} = await (await buyerSignIn).json();
  await buyer.locator('dialog input[type=checkbox]').check();
  await buyer.getByRole('button',{name:'Accept and continue'}).click();
  await buyer.locator('#contacts .contact').filter({hasText:'Studio seller'}).click();
  await buyer.getByRole('button',{name:'Open seller profile',exact:true}).waitFor();
  await buyer.locator('#message').fill('Hello! I have a question.');
  await buyer.getByRole('button',{name:/Open seller shop.*Seller updated/}).click();
  await buyer.getByRole('button',{name:'Open seller shop',exact:true}).waitFor();
  const sellerDialog = buyer.locator('dialog:has(.seller-catalog)');
  await sellerDialog.getByText('Studio print',{exact:true}).waitFor();
  await sellerDialog.getByText('Desk print',{exact:true}).waitFor();
  await sellerDialog.getByText('Printed on textured paper',{exact:true}).waitFor();
  assert.equal(await sellerDialog.getByText('Private draft',{exact:true}).count(),0);
  await sellerDialog.getByText(/pickup.*delivery/i).waitFor();
  await sellerDialog.getByRole('button',{name:'Notify me when Studio print is back in stock',exact:true}).click();
  await sellerDialog.getByRole('button',{name:'Cancel stock alert for Studio print',exact:true}).waitFor();
  await sellerDialog.getByRole('button',{name:'Ask about Studio print',exact:true}).click();
  await buyer.waitForFunction(() => document.getElementById('message').value.includes('Studio print'));
  assert.match(await buyer.locator('#message').inputValue(), /Hello! I have a question\.[\s\S]*Studio print[\s\S]*(?:CHF[\s\S]*12[.,]50|12[.,]50[\s\S]*CHF)/);
  assert.equal(await buyer.locator('#messages').getByText(/Studio print/).count(),0);
  await sellerRequest('/api/sellers/catalog/manage',{...publishedItem,quantity:4});
  await publishShop('Studio print');
  const stock = await call(buyer.context(),'sellers/catalog/alerts',undefined,buyerToken);
  assert.equal(stock.alerts.length,1);
  assert.ok(stock.alerts[0].triggeredAt);
  await buyer.getByRole('button',{name:'Seller stock alert',exact:true}).click();
  await buyer.locator('dialog').getByText('Studio print',{exact:true}).waitFor();
  await buyer.locator('#modalClose').click();
  await sellerRequest('/api/sellers/catalog/manage',{...publishedItem,quantity:6});
  await publishShop('Studio print');
  const updatedStock = await call(buyer.context(),'sellers/catalog/alerts',undefined,buyerToken);
  assert.deepEqual(updatedStock.alerts.map(({triggeredAt})=>triggeredAt),[stock.alerts[0].triggeredAt]);
  await buyer.locator('#backToChats').click();
  await buyer.locator('#bottomNav [data-tab=settings]').click();
  assert.equal(await buyer.getByRole('link',{name:'Shop',exact:true}).count(),0);
  await buyer.evaluate(()=>navigate('/settings/shop'));
  await buyer.getByRole('heading',{name:'Settings',exact:true}).waitFor();
  assert.equal(await buyer.getByRole('heading',{name:'Shop',exact:true}).count(),0);
  await buyer.getByRole('link',{name:'Notifications',exact:true}).click();
  await buyer.getByRole('button',{name:/Seller stock alerts/}).click();
  await buyer.locator('dialog').getByText('Studio print',{exact:true}).waitFor();
  const visitor=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  visitor.setDefaultTimeout(10000);
  await visitor.goto(origin);
  await visitor.locator('dialog input').first().waitFor();
  for(const field of await visitor.locator('dialog input').all())await field.fill('951786');
  const visitorLogin=visitor.waitForResponse(response=>response.url()===origin+'/api/login/setup');
  await visitor.getByRole('button',{name:'Create',exact:true}).click();
  const {token:visitorToken}=await (await visitorLogin).json();
  await visitor.locator('dialog input[type=checkbox]').check();
  await visitor.getByRole('button',{name:'Accept and continue'}).click();
  const visitorContext=visitor.context();
  const linkedShop='group/shop/'+sellerGroup;
  assert.equal((await visitorContext.request.get(origin+'/api/'+linkedShop,{headers:headers(visitorToken)})).status(),404);
  assert.equal((await call(visitorContext,'connect',{code:sellerGroupCode,nickname:'Print fan'},visitorToken)).pending,true);
  const sellerJoin=(await sellerRequest('/api/state')).requests.find(request=>request.group&&request.incoming);
  await sellerRequest('/api/connection/respond',{id:sellerJoin.id,accept:true});
  await sellerRequest('/api/message',{id:sellerGroup,text:'Welcome to the workshop'});
  await visitor.evaluate(()=>refresh());
  await visitor.locator('#contacts').getByText('Print workshop',{exact:true}).click();
  await visitor.locator('#messages .message-row').filter({hasText:'Welcome to the workshop'}).getByRole('img',{name:'Verified Seller',exact:true}).waitFor();
  const sharedListing=visitor.locator('#messages .message-listing');
  await sharedListing.getByText('Studio print',{exact:true}).waitFor();
  await sharedListing.getByText(/12[.,]50/).waitFor();
  await sharedListing.getByRole('button',{name:'View item',exact:true}).click();
  const groupShop=visitor.locator('dialog:has(.seller-catalog)');
  await groupShop.getByText('Studio print',{exact:true}).waitFor();
  assert.equal(await groupShop.getByText('Desk print',{exact:true}).count(),0);
  await groupShop.getByRole('button',{name:'View full shop',exact:true}).click();
  await groupShop.getByText('Desk print',{exact:true}).waitFor();
  assert.equal(await groupShop.getByText('Private draft',{exact:true}).count(),0);
  await groupShop.getByRole('button',{name:'Message seller',exact:true}).waitFor();
  await visitor.locator('#modalClose').click();
  await shopOwner.evaluate(()=>navigate('/settings/shop'));
  await shopOwner.getByRole('button',{name:'Pause shop',exact:true}).click();
  await shopOwner.getByText('Shop paused',{exact:true}).waitFor();
  await shopOwner.getByRole('table',{name:'Items for sale',exact:true}).getByText('Studio print',{exact:true}).waitFor();
  await sharedListing.getByText('Item unavailable',{exact:true}).waitFor();
  await visitor.getByRole('button',{name:'Open seller shop',exact:true}).click();
  await groupShop.getByText('Temporarily unavailable',{exact:true}).waitFor();
  assert.equal(await groupShop.getByText('Studio print',{exact:true}).count(),0);
  const buyerContact=(await call(buyer.context(),'state',undefined,buyerToken)).contacts.find(row=>row.peerSeller);
  const pausedView=await call(buyer.context(),'sellers/catalog/contact/'+buyerContact.id,undefined,buyerToken);
  assert.equal(pausedView.paused,true);
  assert.deepEqual(pausedView.items,[]);
  await visitor.locator('#modalClose').click();
  await shopOwner.getByRole('button',{name:'Reopen shop',exact:true}).click();
  await shopOwner.getByText('Shop open',{exact:true}).waitFor();
  await sharedListing.getByRole('button',{name:'View item',exact:true}).click();
  await groupShop.getByRole('button',{name:'Message seller',exact:true}).click();
  await visitor.getByRole('heading',{name:'Request sent',exact:true}).waitFor();
  assert.ok((await sellerRequest('/api/state')).requests.find(request=>!request.group&&request.incoming));
  await sellerRequest('/api/group/settings',{id:sellerGroup,description:'',posting:'everyone',shopLinked:false});
  assert.equal((await visitorContext.request.get(origin+'/api/'+linkedShop,{headers:headers(visitorToken)})).status(),404);
  await visitorContext.close();
  await shopOwner.context().close();
  await buyer.context().close();
  await shopStaff.close();
  console.log('Seller Shop workspace, publishing, buyer discovery, inquiry drafts and stock alerts passed.');

  const control = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'sec-ch-ua-platform': '"macOS"' }
  });
  control.setDefaultTimeout(8000);
  await control.goto(origin + '/control');
  await control.getByLabel('Admin key', { exact: true }).fill(adminKey);
  await control.getByRole('button', { name: 'Sign in securely' }).click();
  await control.getByRole('heading', { name: 'Overview', exact: true }).first().waitFor();
  await control.getByRole('navigation').getByRole('button',{name:'Groups',exact:true}).click();
  await control.getByText('Workshop group',{exact:true}).waitFor();
  assert.equal((await control.context().request.get(origin+'/api/control/groups/'+groupFixture)).status(),404);
  await control.locator('.cc-card').filter({hasText:'Workshop group'}).getByRole('button',{name:'Join as staff',exact:true}).click();
  await control.getByRole('dialog').getByRole('button',{name:'Confirm',exact:true}).click();
  await control.getByText('qzu. Staff has joined the group.',{exact:true}).waitFor();
  await control.getByRole('img',{name:'Verified Admin',exact:true}).waitFor();
  await control.getByLabel('Group message',{exact:true}).fill('Posting as verified staff');
  await control.getByRole('button',{name:'Send message',exact:true}).click();
  await control.getByText('Posting as verified staff',{exact:true}).waitFor();
  await control.getByRole('navigation').getByRole('button',{name:'Overview',exact:true}).click();
  await control.getByRole('heading', { name: 'Account and payment totals' }).waitFor();
  await control.getByText('Verified USD revenue', { exact: true }).waitFor();
  await control.getByRole('button', { name: /^Unassigned tickets/ }).click();
  await control.getByRole('heading', { name: /^General question/ }).waitFor();
  await control.getByRole('button', { name: 'Open ticket', exact: true }).click();
  await control.getByText('Browser smoke ticket', { exact: true }).waitFor();
  const caseId = await control.locator('.cc-case-sidebar .cc-record-id code').textContent();
  await control.getByRole('textbox', { name: 'Internal case note' }).fill('Browser smoke note');
  await control.getByRole('button', { name: 'Save note', exact: true }).click();
  await control.getByText('Browser smoke note', { exact: true }).waitFor();
  await control.getByRole('button', { name: 'Accept ticket', exact: true }).click();
  await control.getByRole('textbox', { name: 'Ticket reply', exact: true }).fill('Reply from qzu-Support');
  await control.getByRole('button', { name: 'Send reply', exact: true }).click();
  await control.getByText('Reply from qzu-Support', { exact: true }).waitFor();
  await ticketCustomer.bringToFront();
  await ticketCustomer.getByRole('button', { name: 'New ticket reply', exact: true }).click();
  await ticketCustomer.getByText('Reply from qzu-Support', { exact: true }).waitFor();
  await ticketCustomer.locator('#navTicketUnread').waitFor({state:'hidden'});
  assert.equal(await ticketCustomer.getByText('Browser smoke note', {exact:true}).count(),0);
  await ticketCustomer.context().close();
  await control.bringToFront();
  await control.getByRole('button', { name: 'Open account', exact: true }).click();
  await control.getByRole('heading', { name: 'Related cases', exact: true }).waitFor();
  await control.getByRole('button', { name: 'Open case', exact: true }).waitFor();
  await control.getByRole('textbox', { name: 'Find an account or reference' }).fill(caseId);
  await control.getByRole('button', { name: 'Find account', exact: true }).click();
  await control.getByRole('heading', { name: 'Account directory', exact: true }).waitFor();
  await control.getByRole('button', { name: 'Open account', exact: true }).waitFor();
  await control.getByRole('textbox', { name: 'Find an account or reference' }).fill(reported.id);
  await control.getByRole('button', { name: 'Find account', exact: true }).click();
  const flaggedRow=control.locator('.cc-work-row').filter({has:control.getByRole('heading',{name:reported.id,exact:true})});
  await flaggedRow.getByText('Alarm',{exact:true}).waitFor();
  await control.getByRole('navigation').getByRole('button', { name: 'Audit', exact: true }).click();
  await control.getByRole('combobox', { name: 'Audit record type' }).selectOption('ticket');
  await control.getByRole('heading', { name: 'Added an internal note', exact: true }).waitFor();
  await control.getByRole('navigation').getByRole('button', { name: /^Reports/ }).click();
  await control.getByRole('button', { name: 'Review report', exact: true }).click();
  await control.getByText('Browser report evidence', { exact: true }).waitFor();
  assert.equal(await control.getByText('Submitted snapshot message', { exact: true }).count(), 0);
  await control.getByRole('button', { name: 'Open reported account', exact: true }).click();
  const registeredDevice=control.locator('.cc-card').filter({has:control.getByRole('heading',{name:'Registered device',exact:true})});
  await registeredDevice.getByText('iPhone 15', { exact: true }).waitFor();
  await registeredDevice.getByText('iPhone15,4', { exact: true }).waitFor();
  await registeredDevice.getByText(deviceFingerprint, { exact: true }).waitFor();
  const deviceChange=control.locator('.cc-device-change');
  await deviceChange.getByText('iPhone 15 Pro Max',{exact:true}).waitFor();
  await deviceChange.getByText(previousFingerprint,{exact:true}).waitFor();
  await deviceChange.getByText(deviceFingerprint,{exact:true}).waitFor();
  await control.setViewportSize({width:390,height:844});
  assert.equal(await control.evaluate(()=>document.documentElement.scrollWidth),390);
  await deviceChange.getByRole('button',{name:'Mark reviewed',exact:true}).click();
  await deviceChange.locator('.cc-status').getByText('Reviewed',{exact:true}).waitFor();
  await control.getByText('Reviewed a device change',{exact:true}).waitFor();
  assert.equal(await control.locator('.cc-record-panel').getByText('Alarm',{exact:true}).count(),0);
  await control.setViewportSize({width:1440,height:900});
  await control.getByRole('button', { name: 'Back', exact: true }).click();
  await control.getByRole('button', { name: 'View reported chat', exact: true }).click();
  const snapshotMessages = control.locator('.cc-report-message');
  await snapshotMessages.nth(1).getByText('Submitted snapshot message', { exact: true }).waitFor();
  await snapshotMessages.first().getByText('Earlier context', { exact: true }).waitFor();
  await snapshotMessages.nth(1).getByText('Reported message', { exact: true }).waitFor();
  await control.getByRole('button', { name: 'View submitted attachment', exact: true }).click();
  await control.getByRole('img', { name: 'Submitted report evidence' }).waitFor();
  await control.getByRole('button', { name: 'Back to report', exact: true }).click();
  await control.getByText('Viewed reported chat', { exact: true }).waitFor();
  await control.getByText('Viewed report attachment', { exact: true }).waitFor();
  const reportUser=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  reportUser.setDefaultTimeout(10000);
  await reportUser.context().addCookies([{name:'qzu',value:reporter.token,url:origin,httpOnly:true}]);
  await reportUser.goto(origin);
  await reportUser.locator('dialog input').first().waitFor();
  for(const field of await reportUser.locator('dialog input').all())await field.fill('468291');
  await reportUser.getByRole('button',{name:'Create',exact:true}).click();
  await reportUser.locator('dialog input[type=checkbox]').check();
  await reportUser.getByRole('button',{name:'Accept and continue'}).click();
  await reportUser.locator('#bottomNav [data-tab=settings]').click();
  await reportUser.getByRole('link',{name:'Help & Support',exact:true}).click();
  await reportUser.getByRole('button',{name:'My reports',exact:true}).click();
  await reportUser.getByRole('button',{name:/^Other/}).click();
  const reportStep=reportUser.locator('.my-report-step[aria-current=step]');
  await reportStep.getByText('Received',{exact:true}).waitFor();
  await control.bringToFront();
  await control.getByRole('button', { name: 'Claim case', exact: true }).click();
  await control.getByRole('button', { name: 'Release assignment', exact: true }).waitFor();
  await control.getByRole('textbox',{name:'Evidence to request'}).fill('Which message should we focus on?');
  await control.getByRole('button',{name:'Request evidence',exact:true}).click();
  await control.getByText('Waiting for the reporter',{exact:true}).waitFor();
  await reportUser.bringToFront();
  await reportUser.getByRole('button',{name:'Refresh',exact:true}).click();
  await reportStep.getByText('In review',{exact:true}).waitFor();
  await reportUser.getByText('Which message should we focus on?',{exact:true}).waitFor();
  assert.equal(await reportUser.getByText('Submitted snapshot message',{exact:true}).count(),0);
  await reportUser.getByRole('textbox',{name:'Additional evidence'}).fill('Focus on the second message.');
  await reportUser.getByRole('button',{name:'Send evidence',exact:true}).click();
  await reportUser.getByText('Evidence sent.',{exact:true}).waitFor();
  await control.bringToFront();
  await control.getByRole('navigation').getByRole('button',{name:/^Reports/}).click();
  await control.getByText(/Evidence submitted/).waitFor();
  await control.getByRole('button',{name:'Review report',exact:true}).click();
  await control.getByText('Focus on the second message.',{exact:true}).waitFor();
  await control.getByRole('textbox', { name: 'Moderation note', exact: true }).fill('Browser review completed.');
  await control.getByRole('combobox', { name: 'Moderation decision' }).selectOption('dismiss');
  await control.getByRole('button', { name: 'Resolve report', exact: true }).click();
  await control.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await control.getByText('Browser review completed.', { exact: true }).waitFor();
  await reportUser.bringToFront();
  await reportUser.getByRole('button',{name:'Refresh',exact:true}).click();
  await reportStep.getByText('Closed',{exact:true}).waitFor();
  assert.equal(await reportUser.getByText('Browser review completed.',{exact:true}).count(),0);
  await reportUser.context().close();
  await control.bringToFront();
  await control.getByRole('navigation').getByRole('button', { name: 'Keys', exact: true }).click();
  await control.getByRole('table', { name: 'Access key results' }).waitFor();
  await control.getByRole('button', { name: 'Next page', exact: true }).click();
  await control.getByText('Page 2', { exact: true }).waitFor();
  await control.getByRole('button', { name: 'Filter redeemed', exact: true }).click();
  await control.getByRole('button', { name: 'View key '+used.id, exact: true }).click();
  await control.getByText(used.id, { exact: true }).waitFor();
  await control.getByText(keyAccount.id, { exact: true }).waitFor();
  assert.equal(await control.getByRole('button',{name:'Reveal key',exact:true}).count(),0);
  await control.getByRole('button', { name: 'Back to keys', exact: true }).click();
  await control.getByRole('button', {name:'View key '+individualKey.id,exact:true}).click();
  await control.getByRole('button', {name:'Delete key and account',exact:true}).click();
  const accountRemoval=control.getByRole('dialog');
  await accountRemoval.getByText(new RegExp(individualAccount.id)).waitFor();
  await accountRemoval.getByRole('button',{name:'Cancel',exact:true}).click();
  await control.getByText(individualAccount.id,{exact:true}).waitFor();
  await control.getByRole('button', {name:'Delete key and account',exact:true}).click();
  await accountRemoval.getByRole('button',{name:'Confirm',exact:true}).click();
  await control.getByText('Key and linked account deleted',{exact:true}).waitFor();
  assert.equal(await control.evaluate(async id=>(await fetch('/api/control/accounts/'+id)).status,individualAccount.id),404);
  await control.getByRole('button', { name: 'View key '+used.id, exact: true }).click();
  await control.getByRole('button', { name: 'Back to keys', exact: true }).click();
  await control.setViewportSize({width:390,height:844});
  await control.getByRole('table', { name: 'Access key results' }).waitFor();
  assert.equal(await control.evaluate(() => document.documentElement.scrollWidth), 390);
  await control.setViewportSize({width:1440,height:900});
  await control.getByText('Key maintenance', { exact: true }).click();
  await control.getByRole('button', { name: 'Remove all used keys', exact: true }).click();
  const purge=control.getByRole('dialog', {name:'Remove used keys and linked accounts'});
  const confirmPurge=purge.getByRole('button', {name:'Remove used keys and accounts',exact:true});
  const confirmation=purge.getByRole('textbox', {name:'Confirmation phrase'});
  await confirmation.fill('REMOVE');
  assert.equal(await confirmPurge.isEnabled(), false);
  await confirmation.fill('REMOVE USED KEYS AND ACCOUNTS');
  await confirmPurge.click();
  await control.getByText('No matching keys.', {exact:true}).waitFor();
  await control.getByRole('button', {name:'Generate keys',exact:true}).click();
  const newKeys=control.getByRole('dialog', {name:'New access keys'});
  await newKeys.getByRole('button', {name:'Copy key',exact:true}).waitFor();
  const generatedKey=await newKeys.locator('.cc-secret').textContent();
  const generatedKeyId=(await newKeys.getByText(/^Key ID /).textContent()).slice('Key ID '.length);
  assert.match(generatedKey,/^QZU-/);
  await newKeys.getByRole('button', {name:'Done',exact:true}).click();
  await control.getByRole('button', {name:'Filter unused',exact:true}).click();
  assert.equal(await control.getByText(generatedKey,{exact:true}).count(),0);
  await control.getByRole('button', {name:'View key '+generatedKeyId,exact:true}).click();
  const revealKey=control.getByRole('button',{name:'Reveal key',exact:true});
  await control.getByText(generatedKey,{exact:true}).waitFor();
  await control.getByRole('button',{name:'Copy key',exact:true}).waitFor();
  await control.getByRole('button',{name:'Hide key',exact:true}).click();
  assert.equal(await control.getByText(generatedKey,{exact:true}).count(),0);
  await revealKey.click();
  await control.getByText(generatedKey,{exact:true}).waitFor();
  await control.getByRole('button',{name:'Back to keys',exact:true}).click();
  await control.getByRole('table',{name:'Access key results'}).waitFor();
  assert.equal(await control.getByText(generatedKey,{exact:true}).count(),0);
  await control.getByRole('button',{name:'View key '+generatedKeyId,exact:true}).click();
  await control.getByRole('button',{name:'Delete key',exact:true}).click();
  await control.getByRole('dialog').getByRole('button',{name:'Confirm',exact:true}).click();
  await control.getByText('Key deleted',{exact:true}).waitFor();
  await control.getByRole('table',{name:'Access key results'}).waitFor();
  assert.equal(await control.getByRole('button',{name:'View key '+generatedKeyId,exact:true}).count(),0);
  await control.getByRole('navigation').getByRole('button', { name: 'Sellers', exact: true }).click();
  await control.getByRole('heading', { name: /^Studio seller/ }).waitFor();
  await control.getByRole('button', { name: 'Change display name', exact: true }).click();
  const sellerNameDialog = control.getByRole('dialog',{name:'Change seller display name'});
  await sellerNameDialog.getByText(sellerFixture.id,{exact:true}).waitFor();
  const sellerNameField = sellerNameDialog.getByRole('textbox',{name:'Public display name'});
  assert.equal(await sellerNameField.inputValue(),'Studio seller');
  await sellerNameField.fill('ABC123');
  await sellerNameDialog.getByRole('button',{name:'Save name',exact:true}).click();
  await sellerNameDialog.getByText('Seller display names need at least 4 letters.',{exact:true}).waitFor();
  await sellerNameField.fill('Birch Workshop');
  await sellerNameDialog.getByRole('button',{name:'Save name',exact:true}).click();
  await control.getByRole('heading',{name:/^Birch Workshop/}).waitFor();
  await control.getByRole('navigation').getByRole('button', { name: 'Audit', exact: true }).click();
  await control.getByRole('combobox', { name: 'Audit record type' }).selectOption('seller');
  await control.getByRole('heading', { name: 'Changed seller display name', exact: true }).first().waitFor();
  await control.getByRole('navigation').getByRole('button', { name: /^Announcements/ }).click();
  await control.getByRole('heading', { name: 'Announcements', exact: true }).first().waitFor();
  await control.getByText(/^Announcement 90 /).waitFor();
  assert.equal(await control.getByText(/^Announcement 1 /).count(), 0);
  const desktopChats = control.waitForResponse(response => response.url() === origin + '/api/control/chats' && response.ok());
  await control.getByRole('navigation').getByRole('button', { name: 'Chats', exact: true }).click();
  await desktopChats;
  await control.getByRole('button', { name: 'Add contact' }).click();
  await control.getByRole('button', { name: 'Copy my code' }).waitFor();
  console.log('Control Center cases, reporter follow-ups, audited snapshots, device details, keys, seller names, totals and private chat startup passed.');
} finally {
  await browser?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  }
  rmSync(dir, { recursive: true, force: true });
}
