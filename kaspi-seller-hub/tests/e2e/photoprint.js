// Product photos for picking + waybill printing at the waybill's own paper size.
// Uses ../apicopy (API mode) and mockapi.js on :8099.
const { chromium } = require('playwright');
const path = require('path');
const EXT = path.join(__dirname, '../apicopy');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal one-page PDF of the given size in points (what Kaspi gives: A4 or a label). */
const pdf = (w, h, text) => {
  const content = `BT /F1 20 Tf 20 ${h - 40} Td (${text}) Tj ET 0 0 0 rg 20 20 ${w - 40} 30 re f`;
  return Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF`, 'latin1');
};
// 4×4 red PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'photoprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage();
  d.on('pageerror', (e) => errs.push(e.message));
  d.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push('[console] ' + m.text()));
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#home`); await sleep(1200);
  await d.evaluate(() => { ['home', 'orders', 'products', 'settings'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  const res = await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:connectApi', payload: { shopId: null, name: 'Автозапчасти', token: 'GOOD-TOKEN-1234' } }));
  check('store connected by API token', res?.ok, JSON.stringify(res));
  await sleep(5000);

  // 1. order card: placeholder → add a photo from a file → shown in the card
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#orders`); await sleep(2000);
  await d.locator('#view tbody tr', { hasText: '800002001' }).locator('button.link').click();
  await d.waitForSelector('#orderDialog[open]');
  const line = d.locator('#orderDialog .order__line').first();
  check('1 order line shows a photo placeholder with «+»', (await line.locator('.thumb--empty').count()) === 1 && (await line.locator('.thumb-btn__plus').count()) === 1);
  check('1 quantity shown large («× N»)', (await line.locator('.order__qty').innerText()).startsWith('×'));
  const sku = await line.locator('.thumb-btn').getAttribute('data-photo');
  await line.locator('.thumb-btn').click();
  await d.waitForSelector('#photoDialog[open]');
  // a non-Kaspi link is refused
  await d.fill('#photoDialog input[type=url]', 'https://evil.example.com/a.jpg');
  check('1 link from another site refused', await d.locator('#photoDialog .neg').isVisible());
  await d.fill('#photoDialog input[type=url]', '');
  await d.locator('#photoDialog input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });
  await sleep(500);
  check('1 chosen file previewed', (await d.locator('#photoDialog .photo-preview img').count()) === 1);
  await d.click('#photoDialog button[data-action=photo-save]'); await sleep(800);
  const src = await d.locator('#orderDialog .order__line').first().locator('img.thumb').getAttribute('src').catch(() => null);
  check('1 photo now in the order card (resized JPEG)', /^data:image\/jpeg;base64,/.test(src || ''), String(src).slice(0, 40));
  const stored = await sw.evaluate(async (k) => (await chrome.storage.local.get('ksh.photos'))['ksh.photos']?.[k], sku);
  check('1 photo stored for the SKU', stored === src);
  await d.locator('#orderDialog').screenshot({ path: path.join(__dirname, 'order-photo.png') });
  await d.keyboard.press('Escape'); await sleep(300);

  // 2. «Себестоимость» shows the same photo; a Kaspi CDN link is accepted
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#products`); await sleep(1500);
  check('2 cost-price table shows the photo', (await d.locator(`#view button[data-photo="${sku}"] img.thumb`).count()) === 1);
  const other = d.locator('#view button.thumb-btn:has(.thumb--empty)').first();
  const otherSku = await other.getAttribute('data-photo');
  await other.click(); await d.waitForSelector('#photoDialog[open]');
  await d.fill('#photoDialog input[type=url]', 'https://resources.cdn-kaspi.kz/img/m/p/h44/h88/63854412398622.jpg');
  await d.click('#photoDialog button[data-action=photo-save]'); await sleep(600);
  const stored2 = await sw.evaluate(async (k) => (await chrome.storage.local.get('ksh.photos'))['ksh.photos']?.[k], otherSku);
  check('2 Kaspi CDN link saved', stored2?.startsWith('https://resources.cdn-kaspi.kz/'), String(stored2));
  const forged = await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:setPhoto', payload: { sku: 'X', src: 'https://evil.example.com/a.jpg' } }));
  check('2 worker refuses a foreign link even if the page is bypassed', forged?.error === 'photoNotAllowed', JSON.stringify(forged));

  // 3. pick list with photos
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#orders`); await sleep(1500);
  const [pick] = await Promise.all([ctx.waitForEvent('page'), d.click('button:has-text("Сборочный лист")')]);
  await pick.addInitScript(() => (window.print = () => {}));
  await pick.reload(); await pick.waitForTimeout(1500);
  check('3 pick list shows the product photo', (await pick.locator('.pick-photo img').count()) >= 1, String(await pick.locator('.pick tbody tr').count()));
  await pick.close();

  // 4. waybills: an A4 sheet and a 100×150 mm label, printed at their own size, 300 dpi
  const shopId = await sw.evaluate(async () => Object.keys((await chrome.storage.local.get('ksh.settings'))['ksh.settings'].stores)[0]);
  const a4 = `data:application/pdf;base64,${pdf(595.28, 841.89, 'A4 WAYBILL').toString('base64')}`;
  const label = `data:application/pdf;base64,${pdf(283.46, 425.2, 'LABEL').toString('base64')}`;
  await sw.evaluate(async ([shopId, a4, label]) => {
    await chrome.storage.local.set({ 'ksh.invoices': [{ orderId: 'A4-1', shopId, kind: 'pdf', data: a4, ts: Date.now() }, { orderId: 'LB-2', shopId, kind: 'pdf', data: label, ts: Date.now() }] });
    await chrome.storage.session.set({ 'ksh.printQueue': [{ shopId, orderId: 'A4-1' }, { shopId, orderId: 'LB-2' }] });
  }, [shopId, a4, label]);
  const pp = await ctx.newPage();
  await pp.addInitScript(() => (window.print = () => (window.__printed = 1)));
  await pp.goto(`chrome-extension://${id}/dashboard/print.html`); await pp.waitForTimeout(3000);
  const sheets = await pp.$$eval('.page--sheet', (els) => els.map((e) => ({ w: e.style.width, h: e.style.height, page: e.style.getPropertyValue('page'), nat: e.querySelector('img').naturalWidth })));
  check('4 two waybills, each on its own sheet size', sheets.length === 2 && sheets[0].w === '210mm' && sheets[0].h === '297mm' && sheets[1].w === '100mm' && sheets[1].h === '150mm', JSON.stringify(sheets));
  const css = await pp.locator('#sheetSizes').textContent().catch(() => '');
  check('4 print CSS sets the paper: A4 and 100×150 mm, no margins', css.includes('size: 210mm 297mm; margin: 0') && css.includes('size: 100mm 150mm; margin: 0'), css);
  check('4 rendered at 300 dpi (100 mm label ≈ 1181 px wide)', Math.abs((sheets[1]?.nat || 0) - 1181) <= 2 && Math.abs((sheets[0]?.nat || 0) - 2480) <= 2, JSON.stringify(sheets.map((s) => s.nat)));
  check('4 «open original PDF» link for each waybill (screen only)', (await pp.locator('.orig-link a').count()) === 2);
  check('4 printing started automatically', await pp.evaluate(() => window.__printed === 1));
  await pp.screenshot({ path: path.join(__dirname, 'print-sheets.png'), fullPage: true });
  await pp.emulateMedia({ media: 'print' });
  const pdfOut = await pp.pdf({ preferCSSPageSize: true }).catch((e) => e.message);
  if (Buffer.isBuffer(pdfOut)) {
    const boxes = [...pdfOut.toString('latin1').matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => `${Math.round(m[1])}x${Math.round(m[2])}`);
    check('4 printed PDF pages: A4 then the label size', boxes.includes('595x842') && boxes.includes('283x425'), boxes.join(' '));
  }
  await pp.close();

  // 5. «Вписать в лист A4» setting → no sheet sizing
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:saveSettings', payload: { patch: { print: { paper: 'a4' } } } }));
  const p2 = await ctx.newPage();
  await p2.addInitScript(() => (window.print = () => {}));
  await p2.goto(`chrome-extension://${id}/dashboard/print.html`); await p2.waitForTimeout(3000);
  check('5 A4 mode: waybills fitted on A4 pages', (await p2.locator('.page--sheet').count()) === 0 && (await p2.locator('img.pdf-page').count()) === 2);
  await p2.close();
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#settings`); await sleep(1200);
  check('5 settings show the paper choice', (await d.locator('#view').innerText()).includes('Как в накладной Kaspi'));

  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
