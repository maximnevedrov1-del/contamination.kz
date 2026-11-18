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

  // 4. waybills: an A4 sheet and a 100×150 mm label (Kaspi may give either), 300 dpi
  const shopId = await sw.evaluate(async () => Object.keys((await chrome.storage.local.get('ksh.settings'))['ksh.settings'].stores)[0]);
  const a4 = `data:application/pdf;base64,${pdf(595.28, 841.89, 'A4 WAYBILL').toString('base64')}`;
  const label = `data:application/pdf;base64,${pdf(283.46, 425.2, 'LABEL').toString('base64')}`;
  const land = `data:application/pdf;base64,${pdf(425.2, 283.46, 'LANDSCAPE').toString('base64')}`;
  await sw.evaluate(async ([shopId, a4, label, land]) => {
    const inv = [['A4-1', a4], ['LB-2', label], ['LB-3', label], ['LS-4', land], ['LB-5', label]].map(([orderId, data]) => ({ orderId, shopId, kind: 'pdf', data, ts: Date.now() }));
    await chrome.storage.local.set({ 'ksh.invoices': inv });
    await chrome.storage.session.set({ 'ksh.printQueue': inv.map((i) => ({ shopId, orderId: i.orderId })) });
  }, [shopId, a4, label, land]);
  const setPaper = (print) => d.evaluate((p) => chrome.runtime.sendMessage({ type: 'ui:saveSettings', payload: { patch: { print: p } } }), print);
  /** Open the print page; sheets with their size, cells, and the printed PDF's page sizes. */
  const printRun = async (shot) => {
    const pp = await ctx.newPage();
    await pp.addInitScript(() => (window.print = () => (window.__printed = 1)));
    await pp.goto(`chrome-extension://${id}/dashboard/print.html`); await pp.waitForTimeout(3500);
    const sheets = await pp.$$eval('.page--sheet', (els) => els.map((e) => ({ w: e.style.width, h: e.style.height, cells: e.querySelectorAll('.cell').length, imgs: [...e.querySelectorAll('img')].map((i) => [i.naturalWidth, i.naturalHeight]) })));
    const printed = await pp.evaluate(() => window.__printed === 1);
    const links = await pp.locator('.notice--links a').count();
    if (shot) await pp.screenshot({ path: path.join(__dirname, shot), fullPage: true });
    await pp.emulateMedia({ media: 'print' });
    const out = await pp.pdf({ preferCSSPageSize: true });
    const boxes = [...out.toString('latin1').matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => `${Math.round(m[1])}x${Math.round(m[2])}`);
    await pp.close();
    return { sheets, printed, links, boxes };
  };

  // 4a. «Как в накладной Kaspi»: each on its own size
  await setPaper({ paper: 'original' });
  let r = await printRun('print-sheets.png');
  check('4a original: 5 sheets, A4 first then labels', r.sheets.length === 5 && r.sheets[0].w === '210mm' && r.sheets[1].w === '100mm' && r.sheets[1].h === '150mm' && r.sheets[3].w === '150mm', JSON.stringify(r.sheets.map((x) => x.w + 'x' + x.h)));
  check('4a rendered at 300 dpi (100 mm ≈ 1181 px, A4 ≈ 2480 px)', Math.abs(r.sheets[1].imgs[0][0] - 1181) <= 2 && Math.abs(r.sheets[0].imgs[0][0] - 2480) <= 2, JSON.stringify(r.sheets.map((x) => x.imgs[0])));
  check('4a printed PDF pages: A4 and 100×150', r.boxes.includes('595x842') && r.boxes.includes('283x425') && r.boxes.includes('425x283'), r.boxes.join(' '));
  check('4a links to Kaspi originals (screen only), printing started', r.links === 5 && r.printed, `links=${r.links} printed=${r.printed}`);

  // 4b. thermal printer 100×150: every waybill on a 100×150 label, landscape one turned
  await setPaper({ paper: 'label', labelW: 100, labelH: 150 });
  r = await printRun('print-label.png');
  check('4b label printer: 5 labels of 100×150', r.sheets.length === 5 && r.sheets.every((x) => x.w === '100mm' && x.h === '150mm'), JSON.stringify(r.sheets.map((x) => x.w + 'x' + x.h)));
  check('4b landscape waybill turned to portrait', r.sheets[3].imgs[0][1] > r.sheets[3].imgs[0][0], JSON.stringify(r.sheets[3].imgs));
  check('4b printed PDF: every page 100×150', r.boxes.length === 5 && r.boxes.every((b) => b === '283x425'), r.boxes.join(' '));

  // 4c. small thermal label 58×100
  await setPaper({ paper: 'label', labelW: 58, labelH: 100 });
  r = await printRun();
  check('4c 58×100 labels', r.boxes.length === 5 && r.boxes.every((b) => b === '164x283'), r.boxes.join(' '));

  // 4d. office printer, 1 per A4
  await setPaper({ paper: 'a4' });
  r = await printRun();
  check('4d A4: 5 sheets of A4, one waybill each', r.sheets.length === 5 && r.sheets.every((x) => x.w === '210mm' && x.cells === 1) && r.boxes.every((b) => b === '595x842'), r.boxes.join(' '));

  // 4e. office printer, 4 per A4 (2×2)
  await setPaper({ paper: 'a4x4' });
  r = await printRun('print-a4x4.png');
  check('4e A4 ×4: 5 waybills on 2 sheets (4 + 1)', r.sheets.length === 2 && r.sheets[0].cells === 4 && r.sheets[1].cells === 1 && r.boxes.length === 2 && r.boxes.every((b) => b === '595x842'), JSON.stringify(r.sheets.map((x) => x.cells)) + ' ' + r.boxes.join(' '));

  // 4f. Kaspi's real layout (checked on a real waybill): a ~100×150 mm label in the top-left
  // corner of an A4 page. On a label printer the empty paper is cut off → label at full size.
  const cornerContent = '0 0 0 rg 20 420 260 30 re f 20 800 120 30 re f 200 640 60 60 re f BT /F1 18 Tf 30 760 Td (KASPI LABEL) Tj ET';
  const corner = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n4 0 obj << /Length ${cornerContent.length} >> stream\n${cornerContent}\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF`, 'latin1');
  await sw.evaluate(async ([shopId, data]) => {
    await chrome.storage.local.set({ 'ksh.invoices': [{ orderId: 'KZ-1', shopId, kind: 'pdf', data, ts: Date.now() }] });
    await chrome.storage.session.set({ 'ksh.printQueue': [{ shopId, orderId: 'KZ-1' }] });
  }, [shopId, `data:application/pdf;base64,${corner.toString('base64')}`]);
  await setPaper({ paper: 'label', labelW: 100, labelH: 150 });
  r = await printRun();
  const [cw, ch] = r.sheets[0]?.imgs[0] || [0, 0];
  // content ≈ 260×410 pt (+2 mm margins) → ≈ 1110×1730 px at 300 dpi; the whole A4 page would be 2480×3508
  check('4f label in the corner of A4: empty paper cut off, label printed at full size', cw > 1000 && cw < 1300 && ch > 1600 && ch < 1900 && r.boxes.every((b) => b === '283x425'), `${cw}×${ch} ${r.boxes.join(' ')}`);
  await setPaper({ paper: 'original' });
  r = await printRun();
  check('4f «Как в накладной Kaspi» keeps the whole A4 page', r.sheets[0]?.imgs[0]?.[0] === 2480 && r.boxes.includes('595x842'), JSON.stringify(r.sheets[0]?.imgs));

  // 5. settings: four modes, label sizes, test print
  await setPaper({ paper: 'original' });
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#settings`); await sleep(1200);
  const card = d.locator('[data-card=print]');
  check('5 four printer modes offered', (await card.locator('button[data-paper]').count()) === 4);
  await card.locator('button[data-paper=label]').click(); await sleep(700);
  await d.locator('[data-card=print] button[data-label="75x120"]').click(); await sleep(700);
  const saved = await sw.evaluate(async () => (await chrome.storage.local.get('ksh.settings'))['ksh.settings'].print);
  check('5 label printer 75×120 saved', saved?.paper === 'label' && saved.labelW === 75 && saved.labelH === 120, JSON.stringify(saved));
  await d.locator('[data-card=print] input[data-label=labelW]').fill('80'); await d.locator('[data-card=print] input[data-label=labelW]').dispatchEvent('change'); await sleep(700);
  const saved2 = await sw.evaluate(async () => (await chrome.storage.local.get('ksh.settings'))['ksh.settings'].print);
  check('5 custom label width saved', saved2?.labelW === 80, JSON.stringify(saved2));
  check('5 tips for thermal printers shown', (await d.locator('[data-card=print]').innerText()).includes('поля — «Нет»'));
  await d.locator('[data-card=print] input[data-label=labelW]').fill('75'); await d.locator('[data-card=print] input[data-label=labelW]').dispatchEvent('change'); await sleep(700);
  const [tp] = await Promise.all([ctx.waitForEvent('page'), d.locator('[data-card=print] button[data-action=print-test]').click()]);
  await tp.addInitScript(() => (window.print = () => {}));
  await tp.reload(); await tp.waitForTimeout(1200);
  const tsheet = await tp.$eval('.page--test', (e) => [e.style.width, e.style.height]);
  check('5 test print on the chosen label (75×120) with ruler and stripes', tsheet[0] === '75mm' && tsheet[1] === '120mm' && (await tp.locator('.ruler').count()) === 1 && (await tp.locator('.stripes').count()) === 1, tsheet.join('x'));
  await tp.screenshot({ path: path.join(__dirname, 'print-test.png') });
  await tp.close();
  await d.locator('[data-card=print]').screenshot({ path: path.join(__dirname, 'print-settings.png') });

  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
