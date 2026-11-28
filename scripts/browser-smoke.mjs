import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';
import { openAccounts } from '../lib/accounts.mjs';
import { createSupportKey, initAccess } from '../lib/access.mjs';
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
    await page.context().close();
    console.log('Messenger navigation and announcement receipts passed at ' + viewport.width + 'px.');
  }

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
  await control.getByRole('navigation').getByRole('button', { name: /^Announcements/ }).click();
  await control.getByRole('heading', { name: 'Announcements', exact: true }).first().waitFor();
  await control.getByText(/^Announcement 90 /).waitFor();
  assert.equal(await control.getByText(/^Announcement 1 /).count(), 0);
  const desktopChats = control.waitForResponse(response => response.url() === origin + '/api/control/chats' && response.ok());
  await control.getByRole('navigation').getByRole('button', { name: 'Chats', exact: true }).click();
  await desktopChats;
  await control.getByRole('button', { name: 'Add contact' }).click();
  await control.getByRole('button', { name: 'Copy my code' }).waitFor();
  console.log('Control Center sign-in, announcement pagination and private chat startup passed.');
} finally {
  await browser?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  }
  rmSync(dir, { recursive: true, force: true });
}
