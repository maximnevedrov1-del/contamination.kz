// Learning in the interface: page guides, «?» button, help list, tour (desktop + phone).
const { chromium } = require('playwright');
const path = require('path');
const EXT = path.join(__dirname, '../apicopy');
let fails = 0; const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = async (vp, label) => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'learnprof' + Date.now() + label), { headless: true, channel: 'chromium', viewport: vp, deviceScaleFactor: 2, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2]; const errs = [];
  const d = await ctx.newPage(); d.on('pageerror', (e) => errs.push(e.message));
  const go = async (r) => { await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#${r}`); await sleep(1200); };
  await go('home');
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:connectApi', payload: { shopId: null, name: 'Автозапчасти', token: 'GOOD-TOKEN-1234' } }));
  await sleep(4000);
  if (label === 'desktop') {
    await go('orders');
    const g = d.locator('#view > .guide');
    check('1 first visit: guide card on top with numbered steps', (await g.count()) === 1 && (await g.locator('h2').innerText()).includes('Заказы') && (await g.locator('ol li').count()) === 4);
    check('1 the orders table is still there under it', (await d.locator('#view table.data tbody tr').count()) > 5);
    await d.screenshot({ path: path.join(__dirname, 'learn-guide.png') });
    await g.locator('button[data-action=gif]').click(); await d.waitForSelector('#gifDialog[open]');
    const img = await d.evaluate(async () => { const i = document.querySelector('#gifDialog img'); await i.decode().catch(() => {}); return { w: i.naturalWidth, h: i.naturalHeight, shown: i.getBoundingClientRect().width }; });
    check('1b «Показать на примере» opens the recording (GIF loads, fits the window)', img.w === 840 && img.h === 525 && img.shown > 300 && img.shown <= 900 && (await d.locator('#gifDialog h2').innerText()).includes('принять заказ'), JSON.stringify(img));
    await d.screenshot({ path: path.join(__dirname, 'learn-gif.png') });
    await d.click('#gifDialog button:has-text("Закрыть")'); await sleep(200);
    await g.locator('button:has-text("Понятно")').click(); await sleep(300);
    check('1 «Понятно» hides it', (await d.locator('#view > .guide').count()) === 0);
    await d.reload(); await sleep(1500);
    check('1 stays hidden after reload', (await d.locator('#view > .guide').count()) === 0);
    await d.click('#guideBtn'); await sleep(300);
    check('2 «?» shows the guide again', (await d.locator('#view > .guide').count()) === 1);
    await d.click('#guideBtn'); await sleep(300);
    check('2 «?» again hides it', (await d.locator('#view > .guide').count()) === 0);
    await go('catalog');
    check('3 another section has its own guide (5 steps, the price-list warning first)', (await d.locator('#view > .guide ol li').count()) === 5 && (await d.locator('#view > .guide ol li').first().innerText()).includes('Загрузить ассортимент'));
    for (const r of ['home', 'returns', 'refusals', 'payments', 'analytics', 'products', 'chat', 'settings', 'account']) { await go(r); if ((await d.locator('#view > .guide ol li').count()) < 3) check(`3 guide for ${r}`, false); }
    check('3 every section shows a guide of 3+ steps', true);
    await go('help');
    check('4 help lists 11 guides + «Пройти обучение»', (await d.locator('details[data-guide]').count()) === 11 && (await d.locator('button[data-action=tour]').count()) === 1);
    check('4 no guide card on the help page itself; «?» there is harmless', (await d.locator('#view > .guide').count()) === 0);
    const gifs = await d.evaluate(async () => Promise.all(['connect', 'orders', 'products', 'catalog', 'settings'].map(async (n) => { const r = await fetch(chrome.runtime.getURL(`help/${n}.gif`)); return r.ok && (await r.blob()).size > 50000; })));
    check('4 five recordings bundled; help offers them', gifs.every(Boolean) && (await d.locator('details[data-guide] button[data-action=gif]').count()) === 5, JSON.stringify(gifs));
    await d.locator('details[data-guide=account] summary').click();
    check('4 a guide opens in place', (await d.locator('details[data-guide=account] ol li').first().isVisible()));
    // kazakh
    await go('settings'); await d.click('button:has-text("Қазақша")'); await sleep(500); await go('help');
    check('5 guides translated to Kazakh', (await d.locator('details[data-guide=orders] summary').innerText()).includes('Тапсырыстар'));
    await go('settings'); await d.click('button:has-text("Русский")'); await sleep(500);
  }
  // tour
  await go('help');
  check(`6 ${label}: tour does not start by itself under automation`, (await d.locator('.tour').count()) === 0);
  await d.click('button[data-action=tour]'); await sleep(700);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const title = await d.locator('.tour__title').innerText();
    const targets = await d.locator('.tour-target').count();
    const box = await d.locator('.tour').boundingBox();
    const tb = await d.locator('.tour-target').boundingBox();
    const inView = box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1;
    const overlap = tb && !(box.x >= tb.x + tb.width || box.x + box.width <= tb.x || box.y >= tb.y + tb.height || box.y + box.height <= tb.y);
    const visible = tb && tb.x >= 0 && tb.x + tb.width <= vp.width + 1;
    seen.push({ title, ok: targets === 1 && inView && !overlap && visible, why: `targets=${targets} inView=${inView} overlap=${overlap} visible=${!!visible}` });
    if (i === 0) await d.screenshot({ path: path.join(__dirname, `learn-tour-${label}.png`) });
    await d.click('.tour [data-tour=next]'); await sleep(450);
  }
  check(`6 ${label}: 6 steps, each highlights one visible control, card on screen and not over it`, seen.length === 6 && seen.every((s) => s.ok), seen.filter((s) => !s.ok).map((s) => `${s.title}: ${s.why}`).join(' | '));
  check(`6 ${label}: order of steps`, seen.map((s) => s.title).join(' > ') === 'Начните здесь > Главная > Заказы > Выгрузка товаров > Подсказка на каждой странице > Помощь', seen.map((s) => s.title).join(' > '));
  check(`6 ${label}: «Готово» closes it and removes the highlight`, (await d.locator('.tour').count()) === 0 && (await d.locator('.tour-target').count()) === 0 && (await d.evaluate(() => localStorage.getItem('ksh.tourDone'))) === '1' && !(await d.evaluate(() => document.body.classList.contains('nav-open'))));
  await go('help'); await d.click('button[data-action=tour]'); await sleep(600); await d.click('.tour [data-tour=skip]'); await sleep(300);
  check(`6 ${label}: «Пропустить» closes at once`, (await d.locator('.tour').count()) === 0);
  check(`no page errors (${label})`, errs.length === 0, errs.join(' | '));
  await ctx.close();
};
(async () => {
  await run({ width: 1440, height: 900 }, 'desktop');
  await run({ width: 390, height: 844 }, 'phone');
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
