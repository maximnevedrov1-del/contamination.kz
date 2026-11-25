// Extension «Настройки → Перенести на телефон»: owner file made in the real worker opens with the
// phone app's code (shared/spbackup.js); the page never holds the plain token; a packer's file
// carries no cost prices. Uses the API test copy (tests/apicopy, mock Kaspi on :8099).
//   ./mock-up.sh && node phonecard.js
const { chromium } = require('playwright'); require('./offline');
const path = require('node:path');
const fs = require('node:fs');
const EXT = __dirname + '/../apicopy';
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, i); };
(async () => {
  const { decryptBackup } = await import(path.join(__dirname, '../../shared/spbackup.js'));
  const prof = __dirname + '/phoneprof';
  fs.rmSync(prof, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(prof, { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, acceptDownloads: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage();
  d.on('pageerror', (e) => errs.push(e.message));
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#settings`);
  await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 30000 });
  const res = await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:connectApi', payload: { name: 'Тест', token: 'GOOD-TOKEN-1234' } }));
  check('store connected (mock Kaspi)', res?.ok, JSON.stringify(res));
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:saveCost', payload: { sku: 'SKU-X', cost: 777 } }));
  await d.reload();
  await d.waitForSelector('[data-card=phone]');
  check('card «Перенести на телефон» in Settings', /Перенести на телефон/.test(await d.textContent('[data-card=phone]')));
  // one tap: «Показать QR-код для телефона» → the code is readable by the phone's reader
  await d.click('[data-action=sp-qr]');
  await d.waitForSelector('dialog[data-dialog=qr] canvas[aria-label]');
  const img = await d.evaluate(() => {
    const c = [...document.querySelectorAll('dialog[data-dialog=qr] canvas')].sort((a, b) => b.width - a.width)[0];
    return { w: c.width, h: c.height, px: Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data) };
  });
  const jsQR = require('../../app/vendor/jsQR.js');
  const { decodeTransfer } = await import(path.join(__dirname, '../../shared/qr-transfer.js'));
  const read = jsQR(Uint8ClampedArray.from(img.px), img.w, img.h)?.data || '';
  const qrPayload = await decodeTransfer(read).catch((e) => ({ error: e.code }));
  check('QR on screen → phone reader gets the store token + cost price', Object.values(qrPayload.tokens || {})[0] === 'GOOD-TOKEN-1234' && qrPayload.costs?.['SKU-X'] === 777, JSON.stringify(qrPayload).slice(0, 120));
  check('QR dialog: steps + countdown', /saudapulse\.kz\/app[\s\S]*Сканировать QR[\s\S]*Код действует ещё \d+ с/.test(await d.textContent('dialog[data-dialog=qr]')));
  check('plain token not in the page while the QR is shown', !(await d.content()).includes('GOOD-TOKEN'));
  await d.screenshot({ path: __dirname + '/phone-qr.png' });
  await d.click('dialog[data-dialog=qr] .btn--primary');
  await d.click('[data-card=phone] summary');
  await d.click('[data-action=sp-export-owner]');
  await d.fill('[data-field=sp-pass]', 'short');
  await d.fill('[data-field=sp-pass2]', 'short');
  await d.click('[data-action=sp-pass-ok]');
  check('weak passphrase refused in the dialog', /не короче 12/.test(await d.textContent('dialog[open]')));
  await d.fill('[data-field=sp-pass]', 'desktop-to-phone-1');
  await d.fill('[data-field=sp-pass2]', 'desktop-to-phone-1');
  const dlP = d.waitForEvent('download');
  await d.click('[data-action=sp-pass-ok]');
  if (process.env.DEBUG) { await d.waitForTimeout(3000); console.log('TOASTS', await d.locator('.toast').allTextContents()); }
  const dl = await dlP;
  const file = fs.readFileSync(await dl.path(), 'utf8');
  check('file name', /^saudapulse-owner-\d{4}-\d{2}-\d{2}\.spbackup$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  check('file is ciphertext (no token, store name, cost)', !/GOOD-TOKEN|Тест|SKU-X|777/.test(file));
  const { payload } = await decryptBackup(file, 'desktop-to-phone-1', { expectScope: 'owner' });
  check('phone app code opens it: token + cost price inside', Object.values(payload.tokens)[0] === 'GOOD-TOKEN-1234' && payload.costs['SKU-X'] === 777, JSON.stringify(Object.keys(payload)));
  const html = await d.content();
  check('plain token never in the page', !html.includes('GOOD-TOKEN'));
  const staff = await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:spbackupExport', payload: { scope: 'staff', passphrase: 'desktop-to-phone-1' } }));
  check('packer file needs a signed-in owner (developer mode: none)', staff?.ok === false && staff.error === 'backupNoOwner', JSON.stringify(staff));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await d.screenshot({ path: __dirname + '/phone-card.png', fullPage: false, clip: await d.locator('[data-card=phone]').boundingBox() });
  await ctx.close();
  fs.rmSync(prof, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
