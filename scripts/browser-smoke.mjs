import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';
import { createAccount, openAccounts } from '../lib/accounts.mjs';
import { createSupportKey, initAccess } from '../lib/access.mjs';
import { complianceStore } from '../lib/compliance.mjs';
import { officialStore } from '../lib/official.mjs';
import { playAssets } from './play-assets.mjs';

const dir = mkdtempSync(join(tmpdir(), 'qzu-browser-'));
const database = join(dir, 'accounts.sqlite');
let child;
let browser;

try {
  const db = openAccounts(database);
  initAccess(db);
  const adminKey = createSupportKey(db);
  const reports = complianceStore(db);
  reports.report(createAccount(db).id, createAccount(db).id, 'fixture-room', 'Other', 'Browser report evidence');
  const announcements = officialStore(db);
  for (let i = 1; i <= 90; i++) {
    announcements.publish('Announcement ' + i + ' ' + 'Browser test fixture. '.repeat(25), true);
  }
  db.close();

  child = spawn(process.execPath, ['server.mjs'], {
    env: {
      ...process.env, NODE_ENV: 'test', PUBLIC_ORIGIN: '', HOST: '127.0.0.1', PORT: '0',
      QZU_DB: database, QZU_ADMIN_DIR: join(dir, 'admin'), QZU_ACCESS_REQUIRED: 'false', QZU_MOBILE_ONLY: 'false'
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
  browser = await chromium.launch({ executablePath: process.env.QZU_TEST_CHROME_PATH });

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
  await chatPage.locator('#messages').evaluate(node => { node.scrollTop = 0; });
  await call(peer, 'message', { id: roomId, text: 'New message at the bottom' }, peerToken);
  await chatPage.getByRole('button', { name: /new message/ }).waitFor();
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
  await viewer.close();
  await peer.close();
  console.log('Chat scroll anchoring, search, drafts, expiry, mutes, pins and appearance passed.');

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
  await control.getByRole('navigation').getByRole('button', { name: 'Audit', exact: true }).click();
  await control.getByRole('combobox', { name: 'Audit record type' }).selectOption('ticket');
  await control.getByRole('heading', { name: 'Added an internal note', exact: true }).waitFor();
  await control.getByRole('navigation').getByRole('button', { name: /^Reports/ }).click();
  await control.getByRole('button', { name: 'Review report', exact: true }).click();
  await control.getByText('Browser report evidence', { exact: true }).waitFor();
  await control.getByRole('button', { name: 'Claim case', exact: true }).click();
  await control.getByRole('button', { name: 'Release assignment', exact: true }).waitFor();
  await control.getByRole('textbox', { name: 'Moderation note', exact: true }).fill('Browser review completed.');
  await control.getByRole('combobox', { name: 'Moderation decision' }).selectOption('dismiss');
  await control.getByRole('button', { name: 'Resolve report', exact: true }).click();
  await control.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await control.getByText('Browser review completed.', { exact: true }).waitFor();
  await control.getByRole('navigation').getByRole('button', { name: /^Announcements/ }).click();
  await control.getByRole('heading', { name: 'Announcements', exact: true }).first().waitFor();
  await control.getByText(/^Announcement 90 /).waitFor();
  assert.equal(await control.getByText(/^Announcement 1 /).count(), 0);
  const desktopChats = control.waitForResponse(response => response.url() === origin + '/api/control/chats' && response.ok());
  await control.getByRole('navigation').getByRole('button', { name: 'Chats', exact: true }).click();
  await desktopChats;
  await control.getByRole('button', { name: 'Add contact' }).click();
  await control.getByRole('button', { name: 'Copy my code' }).waitFor();
  console.log('Control Center cases, account reference search, audit, announcements and private chat startup passed.');
} finally {
  await browser?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  }
  rmSync(dir, { recursive: true, force: true });
}
