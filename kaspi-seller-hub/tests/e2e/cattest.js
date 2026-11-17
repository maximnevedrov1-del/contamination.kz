// "Выгрузка товаров" end to end: real extension UI → mock Kaspi Content API + mock Supabase
// Storage (real RLS policies). 3 stores connected by API token; a product is put on sale in
// 2 of them; cards go only to those 2; price lists are uploaded and readable by URL.
const { chromium } = require('playwright');
const path = require('path');
const EXT = path.join(__dirname, '../billcopy');
const FIX = path.join(__dirname, '../fixtures');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => fetch('http://localhost:8098/__sql', { method: 'POST', body: JSON.stringify({ sql: q }) }).then((r) => r.json());
const apiLog = async () => (await fetch('http://localhost:8099/__log')).json();
const supaLog = async () => (await fetch('http://localhost:8098/__log')).json();

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'catprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage();
  d.on('pageerror', (e) => errs.push(e.message));
  d.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push('[console] ' + m.text()));
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  const toasts = () => d.$$eval('.toast', (t) => t.map((x) => x.innerText));
  const clearToasts = () => d.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  const feedRow = (shop) => d.locator(`.feed[data-shop="${shop}"]`);

  // login
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#account`);
  await d.waitForSelector('input[type=email]');
  await d.fill('input[type=email]', 'cat@example.kz'); await d.check('label.consent input'); await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  await d.waitForSelector('.badge:has-text("Пробный период")', { timeout: 15000 });

  // 3 stores by API token
  for (const [name, tok] of [['Магазин А', 'GOOD-TOKEN-A'], ['Магазин Б', 'GOOD-TOKEN-B'], ['Магазин В', 'GOOD-TOKEN-C']]) {
    await d.click('#connectStoreBtn'); await d.fill('#connectName', name); await d.fill('#connectToken', tok); await d.click('#connectSubmit');
    await d.waitForFunction(() => !document.getElementById('connectDialog').open, null, { timeout: 30000 });
    await sleep(800);
  }
  const stores = Object.values((await msg('ui:getState')).settings.stores);
  const S = Object.fromEntries(stores.map((s) => [s.name, s.id]));
  check('0 three API stores connected', stores.length === 3 && S['Магазин А'] && S['Магазин Б'] && S['Магазин В'], stores.map((s) => s.name).join(', '));
  const [A, B, C] = [S['Магазин А'], S['Магазин Б'], S['Магазин В']];

  // 1. section
  await d.click('a[data-route=catalog]'); await sleep(1200);
  check('1 nav item «Выгрузка товаров»', (await d.locator('a[data-route=catalog]').innerText()).includes('Выгрузка товаров'));
  check('1 empty catalog + warning about price lists', (await d.locator('#view').innerText()).includes('Товаров пока нет') && (await d.locator('.banner--warn').innerText()).includes('снимает с продажи'));
  check('1 one price-list block per store', (await d.locator('.feed').count()) === 3);

  // 2. import the current assortment of store A from the Kaspi Excel price list
  await feedRow(A).locator('input[type=file]').setInputFiles(path.join(FIX, 'pricelist.xlsx'));
  await d.waitForSelector('#confirmDialog[open]');
  check('2 import asks for confirmation with count + store', (await d.locator('#confirmDialog').innerText()).includes('3 товаров') && (await d.locator('#confirmDialog').innerText()).includes('Магазин А'));
  await d.click('#confirmDialog button[value=ok]'); await sleep(1500);
  check('2 «Готово: новых товаров 3»', (await toasts()).some((t) => t.includes('новых товаров 3')));
  const rows = await d.$$eval('.catalog-table tbody tr', (trs) => trs.map((tr) => tr.dataset.sku));
  check('2 table shows imported products', ['BP100', 'FLT-7', 'SP & 3'].every((s) => rows.includes(s)), rows.join(','));
  const bpCells = await d.$$eval('.catalog-table tbody tr[data-sku="BP100"] td', (tds) => tds.map((t) => t.innerText));
  check('2 on sale in store A only', bpCells[5].includes('в продаже') && bpCells[6].includes('—') && bpCells[7].includes('—'), bpCells.slice(5).join(' | '));

  // 3. store A price list: settings + confirm → uploaded → readable by URL without a key
  await feedRow(A).locator('label.catalog-field', { hasText: 'merchantid' }).locator('input').fill('30123456');
  await feedRow(A).locator('label.catalog-field', { hasText: 'компании' }).locator('input').fill('ТОО "Ромашка"');
  await feedRow(A).locator('label.catalog-field', { hasText: 'складов' }).locator('input').fill('PP1, PP2');
  await feedRow(A).locator('label.feed__confirm input').check();
  await clearToasts();
  await feedRow(A).locator('button:has-text("Сохранить")').click(); await sleep(2000);
  const urlA = (await feedRow(A).locator('.feed__url code').innerText().catch(() => '')).trim();
  check('3 price list uploaded, URL shown', /\/storage\/v1\/object\/public\/pricelists\/[0-9a-f-]{36}\/shop-[a-z0-9]+\.xml$/.test(urlA), urlA);
  check('3 status «работает: 3 товара»', (await feedRow(A).locator('.badge').first().innerText()).includes('работает: 3'));
  const xmlA = await (await fetch(urlA)).text();
  check('3 Kaspi can read it without any key', xmlA.includes('<merchantid>30123456</merchantid>') && xmlA.includes('sku="BP100"') && xmlA.includes('sku="SP &amp; 3"') && (xmlA.match(/storeId="PP2"/g) || []).length === 3, xmlA.slice(0, 120));
  check('3 store B / C price lists not uploaded (not confirmed)', !(await supaLog()).some((e) => e.upload && !e.upload.includes(urlA.split('/').slice(-2).join('/'))));

  // 4. new product with a Kaspi card → stores A and C (not B)
  await d.click('button[data-action=new]'); await d.waitForSelector('#productDialog[open]');
  const fld = (label) => d.locator('#productDialog label.catalog-field', { hasText: label }).locator('input, textarea').first();
  await fld('Артикул').fill('NB48');
  await fld('Название').fill('Тетрадь 48 листов');
  await fld('Бренд').fill('Erich Krause');
  await fld('Цена').fill('1200');
  await fld('Остаток').fill('10');
  check('4 all stores pre-selected', await d.locator('#productDialog .store-picker__all input').isChecked());
  await d.locator(`#productDialog .store-picker input[data-shop="${B}"]`).uncheck();
  check('4 «Все магазины» unticked after removing one', !(await d.locator('#productDialog .store-picker__all input').isChecked()));
  await d.waitForFunction(() => document.querySelectorAll('#catalogCategories option').length > 0, null, { timeout: 10000 });
  const catIn = d.locator('#productDialog input[list=catalogCategories]');
  await catIn.fill('Тетради'); await catIn.dispatchEvent('change');
  await d.waitForSelector('#productDialog .catalog-attrs label', { timeout: 10000 });
  const attrLabels = await d.$$eval('#productDialog .catalog-attrs label > span', (s) => s.map((x) => x.innerText));
  check('4 attribute form from Kaspi (mandatory marked)', attrLabels.some((l) => l.startsWith('cover') && l.includes('*')) && attrLabels.some((l) => l.startsWith('number of sheets')), attrLabels.join(' | '));
  const attr = (name) => d.locator('#productDialog .catalog-attrs label', { hasText: name }).locator('input, select').first();
  await attr('cover').focus(); await sleep(600);
  check('4 enum values loaded from Kaspi', (await d.$$eval('#productDialog .catalog-attrs datalist option', (o) => o.map((x) => x.value))).includes('мягкая'));
  await attr('cover').fill('мягкая'); await attr('cover').dispatchEvent('change');
  await attr('fields').selectOption('true');
  await attr('number of sheets').fill('48'); await attr('number of sheets').dispatchEvent('change');
  await fld('Фото').fill('https://resources.cdn-kaspi.kz/img/m/p/h44/h88/63854412398622.jpg');
  await fld('Описание').fill('Тетрадь в клетку');
  check('4 «Создать карточку» on by default (API stores exist)', await d.locator('#productDialog .catalog-section label.check input').last().isChecked());
  await d.screenshot({ path: path.join(__dirname, 'cat-product.png') });
  await clearToasts();
  await d.click('#productDialog button[data-action=publish]'); await sleep(2500);
  const t4 = await toasts();
  check('4 «добавлен в прайс-листы 2 магазинов» + «Карточка отправлена»', t4.some((x) => x.includes('2 магазинов')) && t4.some((x) => x.includes('Карточка отправлена')), JSON.stringify(t4));
  const imps = (await apiLog()).filter((e) => e.cardImport);
  check('4 cards sent with the tokens of A and C only', imps.length === 2 && imps.map((e) => e.token).sort().join() === 'GOOD-TOKEN-A,GOOD-TOKEN-C', imps.map((e) => e.token).join());
  const it = imps[0]?.items?.[0] || {};
  check('4 card body as Kaspi documents (text/plain, sku/title/brand/category/attributes/images)', imps[0]?.contentType?.startsWith('text/plain') && it.sku === 'NB48' && it.category === 'Master - Exercise notebooks' && it.images[0].url.startsWith('https://') && it.attributes.some((a) => a.code.endsWith('*cover') && a.value === 'мягкая') && it.attributes.some((a) => a.code.endsWith('*fields') && a.value === true) && it.attributes.some((a) => a.code.endsWith('*number of sheets') && a.value === 48), JSON.stringify(it).slice(0, 300));
  const nb = await d.$$eval('.catalog-table tbody tr[data-sku="NB48"] td', (tds) => tds.map((t) => t.innerText));
  check('4 table: A + C on sale, B not; card «на проверке»', nb[5].includes('в продаже') && nb[5].includes('на проверке') && nb[6].trim() === '—' && nb[7].includes('в продаже'), nb.slice(5).join(' | '));

  // 5. price list A re-uploaded with the new product (batched ~3 s)
  await sleep(4500);
  const xmlA2 = await (await fetch(urlA)).text();
  check('5 store A price list now has NB48 with stock 10', /<offer sku="NB48">[\s\S]*?stockCount="10"[\s\S]*?<price>1200<\/price>/.test(xmlA2));

  // 6. Kaspi finished checking the cards
  await d.click('button:has-text("Проверить карточки")'); await sleep(2000);
  const nb2 = await d.$$eval('.catalog-table tbody tr[data-sku="NB48"] td', (tds) => tds.map((t) => t.innerText));
  check('6 card status «готова» in A and C', nb2[5].includes('готова') && nb2[7].includes('готова'), nb2.slice(5).join(' | '));

  // 7. bulk: take NB48 off sale in store A only
  await d.locator('.catalog-table tbody tr[data-sku="NB48"] input[type=checkbox]').check();
  await d.click('button:has-text("Снять с продажи")'); await d.waitForSelector('#productDialog[open]');
  await d.locator('#productDialog .store-picker__all input').uncheck();
  await d.locator(`#productDialog .store-picker input[data-shop="${A}"]`).check();
  await d.click('#productDialog button[data-action=bulk]'); await sleep(4500);
  const nb3 = await d.$$eval('.catalog-table tbody tr[data-sku="NB48"] td', (tds) => tds.map((t) => t.innerText));
  check('7 NB48: off in A, still on in C', !nb3[5].includes('в продаже') && nb3[7].includes('в продаже'), nb3.slice(5).join(' | '));
  const xmlA3 = await (await fetch(urlA)).text();
  check('7 store A price list no longer lists NB48 (other products stay)', !xmlA3.includes('NB48') && xmlA3.includes('BP100'));

  // 8. validation in the form
  await d.click('button[data-action=new]'); await d.waitForSelector('#productDialog[open]');
  await clearToasts();
  await fld('Артикул').fill('плохой артикул');
  await d.click('#productDialog button[data-action=publish]'); await sleep(500);
  check('8 bad sku / empty fields → clear error, nothing sent', (await toasts()).some((x) => x.includes('Артикул') && x.includes('Название')) && (await apiLog()).filter((e) => e.cardImport).length === 2);
  await d.keyboard.press('Escape');

  // 9. security: another client's feed cannot be overwritten through the extension's server
  const denied = (await supaLog()).filter((e) => e.uploadDenied).length;
  check('9 no upload was refused for the owner', denied === 0);

  // 9b. guard: the whole assortment deleted by mistake → price list held, not emptied
  const allSkus = (await msg('ui:catalogState')).products.map((p) => p.sku);
  const before = (await (await fetch(urlA)).text()).match(/<offer /g)?.length || 0;
  await msg('ui:catalogDelete', { skus: allSkus }); await sleep(4500);
  const xmlHeld = await (await fetch(urlA)).text();
  check('9b price list NOT emptied after deleting everything', (xmlHeld.match(/<offer /g)?.length || 0) === before && before > 0, `before ${before}`);
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#catalog`); await sleep(1500);
  check('9b store A shows the «not updated» warning with counts', (await feedRow(A).locator('.feed__drop').innerText().catch(() => '')).includes(`${before}`));
  await clearToasts();
  await feedRow(A).locator('button[data-action=allow-drop]').click();
  await d.click('#confirmDialog button[value=ok]'); await sleep(2500);
  const xmlEmpty = await (await fetch(urlA)).text();
  check('9b after explicit confirmation the empty price list is uploaded', !/<offer /.test(xmlEmpty) && (await feedRow(A).locator('.feed__drop').count()) === 0);
  const rep = await msg('ui:diagnostics');
  check('9b support report: plain text, no tokens', rep?.ok && rep.text.includes('Kaspi Seller Hub') && !/GOOD-TOKEN/.test(rep.text), rep?.text?.slice(0, 200));

  // 10. subscription over → publishing refused by the worker
  await sql("update accounts set trial_ends_at = now() - interval '1 minute' where email = 'cat@example.kz'");
  await msg('ui:billingState', { force: true });
  const pub = await msg('ui:catalogPublish', { skus: ['BP100'], shopIds: [B], on: true });
  check('10 expired: publishing refused', pub?.error === 'subscriptionRequired', JSON.stringify(pub));

  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
