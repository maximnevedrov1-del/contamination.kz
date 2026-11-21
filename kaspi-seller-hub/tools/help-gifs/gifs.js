// Records the how-to GIF frames: real clicks in the real UI on demo data (mock Kaspi API).
// Each frame = screenshot with a caption bar and a click marker; assembled by gifs.py.
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const EXT = path.join(__dirname, '../apicopy');
const OUT = path.join(__dirname, '../gif-frames');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VP = { width: 1120, height: 700 };

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'gifprof' + Date.now()), { headless: true, channel: 'chromium', viewport: VP, deviceScaleFactor: 1, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const d = await ctx.newPage();
  const go = async (r) => { await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#${r}`); await sleep(1300); };
  await go('home');
  // guides and tour are not part of these clips
  await d.evaluate(() => { ['home', 'orders', 'returns', 'refusals', 'payments', 'analytics', 'products', 'catalog', 'chat', 'settings', 'account'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });

  let scene = null, n = 0, meta = [];
  const start = (name) => { scene = name; n = 0; meta = []; fs.mkdirSync(path.join(OUT, name), { recursive: true }); };
  const end = () => fs.writeFileSync(path.join(OUT, scene, 'frames.json'), JSON.stringify(meta));
  /** Screenshot with a caption (and a click marker on `target`). */
  const frame = async (caption, { target = null, ms = 1600 } = {}) => {
    const box = target ? await target.boundingBox() : null;
    await d.evaluate(([text, b]) => {
      const host = document.querySelector('dialog[open]') || document.body; // modal dialogs sit above the page
      const cap = document.createElement('div');
      cap.className = '__gif';
      cap.textContent = text;
      cap.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;max-width:86%;padding:10px 18px;border-radius:10px;background:#111;color:#fff;font:600 17px/1.35 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);text-align:center';
      host.append(cap);
      if (b) {
        const dot = document.createElement('div');
        dot.className = '__gif';
        dot.style.cssText = `position:fixed;left:${b.x + b.width / 2 - 17}px;top:${b.y + b.height / 2 - 17}px;width:34px;height:34px;border-radius:50%;background:rgba(227,73,72,.35);border:3px solid #e34948;z-index:99999;pointer-events:none`;
        host.append(dot);
      }
    }, [caption, box]);
    await sleep(120);
    const file = `${String(++n).padStart(2, '0')}.png`;
    await d.screenshot({ path: path.join(OUT, scene, file) });
    meta.push({ file, ms });
    await d.evaluate(() => document.querySelectorAll('.__gif').forEach((e) => e.remove()));
  };
  /** Frame showing where to click, then the click itself. */
  const click = async (locator, caption, opts) => { await locator.scrollIntoViewIfNeeded(); await frame(caption, { target: locator, ...opts }); await locator.click(); await sleep(700); };
  const type = async (locator, text) => { await locator.click(); await locator.pressSequentially(text, { delay: 5 }); await sleep(150); };

  // ---------- 1. connect a store ----------
  start('connect');
  await frame('Подключаем магазин Kaspi', { ms: 1400 });
  await click(d.locator('#connectStoreBtn'), '1. Нажмите «+ Подключить магазин»');
  await type(d.locator('#connectName'), 'Автозапчасти');
  await frame('2. Введите название магазина', { target: d.locator('#connectName') });
  await type(d.locator('#connectToken'), 'GOOD-TOKEN-1234');
  await frame('3. Вставьте токен API из кабинета Kaspi', { target: d.locator('#connectToken'), ms: 2200 });
  await click(d.locator('#connectSubmit'), '4. Нажмите «Подключить»');
  await d.waitForFunction(() => !document.getElementById('connectDialog').open, null, { timeout: 30000 });
  await sleep(5000); await go('home');
  await frame('Готово: заказы магазина уже на Главной', { ms: 2800 });
  end();

  // ---------- 2. accept an order ----------
  start('orders');
  await click(d.locator('a[data-route=orders]'), '1. Откройте «Заказы»');
  await sleep(800);
  await click(d.locator('.tabs .tab', { hasText: 'Горящие' }), '2. Вкладка «Горящие» — заказы, у которых истекает срок');
  const row = d.locator('#view tbody tr', { hasText: '800002001' });
  await click(row.locator('button.link'), '3. Нажмите на номер заказа');
  await d.waitForSelector('#orderDialog[open]');
  await frame('В карточке — товары, срок, сумма и оплата', { ms: 2600 });
  await click(d.locator('#orderDialog button', { hasText: /^Принять$/ }), '4. Нажмите «Принять»');
  await d.waitForSelector('#confirmDialog[open]');
  await click(d.locator('#confirmDialog button[value=ok]'), '5. Подтвердите действие');
  await sleep(2500);
  await frame('Заказ принят — статус обновился', { ms: 2800 });
  end();

  // ---------- 3. cost price → profit ----------
  start('products');
  await d.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await click(d.locator('a[data-route=products]'), '1. Откройте «Себестоимость»');
  await sleep(800);
  const comm = d.locator('#view input[type=number]').first();
  await type(comm, '12'); await comm.dispatchEvent('change'); await sleep(500);
  await frame('2. Укажите комиссию Kaspi, %', { target: d.locator('#view input[type=number]').first() });
  const costs = d.locator('#view table.data tbody tr input');
  const cnt = await costs.count();
  for (let i = 0; i < cnt; i++) { const c = d.locator('#view table.data tbody tr input').nth(i); await c.fill(String([4200, 1500, 9800][i % 3])); await c.dispatchEvent('change'); await sleep(400); }
  await frame('3. Впишите себестоимость одной штуки у каждого товара', { target: d.locator('#view table.data tbody tr input').first(), ms: 2400 });
  await frame('Прибыль и маржа посчитались сразу', { ms: 2600 });
  await click(d.locator('a[data-route=orders]'), '4. Вернитесь в «Заказы»');
  await sleep(900);
  await frame('Теперь прибыль видна по каждому заказу', { ms: 3000 });
  end();

  // ---------- 4. put a product on sale in the chosen stores ----------
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:connectApi', payload: { shopId: null, name: 'Автозапчасти Астана', token: 'GOOD-TOKEN-B' } }));
  await sleep(4000); await go('home');
  start('catalog');
  await click(d.locator('a[data-route=catalog]'), '1. Откройте «Выгрузка товаров»');
  await sleep(1200);
  await click(d.locator('button[data-action=new]'), '2. Нажмите «+ Добавить товар»');
  await d.waitForSelector('#productDialog[open]');
  const fld = (label) => d.locator('#productDialog label.catalog-field', { hasText: label }).locator('input, textarea').first();
  await type(fld('Артикул'), 'BP100'); await type(fld('Название'), 'Колодки тормозные передние'); await type(fld('Бренд'), 'Chery'); await type(fld('Цена'), '15000'); await fld('Остаток').fill('8');
  await frame('3. Заполните артикул, название, цену и остаток', { target: fld('Цена'), ms: 2600 });
  const picker = d.locator('#productDialog .store-picker');
  await picker.scrollIntoViewIfNeeded();
  await frame('4. Отметьте магазины: все или только нужные', { target: d.locator('#productDialog .store-picker__all input'), ms: 2800 });
  await d.locator('#productDialog .catalog-section label.check input').last().uncheck().catch(() => {});
  await click(d.locator('#productDialog button[data-action=publish]'), '5. Нажмите «Выложить в выбранные магазины»');
  await sleep(1800);
  await frame('Товар добавлен в прайс-листы обоих магазинов', { ms: 3000 });
  end();

  // ---------- 5. backup ----------
  start('settings');
  await d.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await click(d.locator('a[data-route=settings]'), '1. Откройте «Настройки»');
  await sleep(900);
  const save = d.locator('button[data-action=backup-save]');
  await save.scrollIntoViewIfNeeded(); await sleep(300);
  await frame('2. Найдите блок «Резервная копия»', { ms: 2000 });
  const dl = d.waitForEvent('download').catch(() => null);
  await click(save, '3. Нажмите «Сохранить копию в файл»');
  await dl; await sleep(600);
  await frame('Файл с себестоимостью, каталогом и настройками сохранён', { ms: 3000 });
  end();

  await ctx.close();
  console.log('frames:', fs.readdirSync(OUT).map((s) => `${s}=${fs.readdirSync(path.join(OUT, s)).length - 1}`).join(' '));
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
