// Explainer video from our own pages (extension test copy + mock Kaspi): price list → photos → stock.
//   ./mock-up.sh && node explainer-video.js   → docs/media/saudapulse-ostatki-i-foto.mp4
const { chromium } = require('playwright'); require('./offline');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const EXT = __dirname + '/../apicopy';
const OUT = path.resolve(__dirname, '../../docs/media/saudapulse-ostatki-i-foto.mp4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#6250d6'];

(async () => {
  const prof = __dirname + '/videoprof';
  const vids = __dirname + '/video-raw';
  fs.rmSync(prof, { recursive: true, force: true });
  fs.rmSync(vids, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(prof, {
    headless: true, channel: 'chromium', viewport: { width: 1280, height: 760 },
    recordVideo: { dir: vids, size: { width: 1280, height: 760 } },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  // product pictures from «Kaspi's CDN»: a coloured tile with the product's name
  await ctx.route('https://resources.cdn-kaspi.kz/**', (r) => {
    const n = Number((r.request().url().match(/(\d)\.jpg/) || [0, 0])[1]);
    const name = ['Колодки', 'Фильтр', 'Свечи', 'Фильтр'][n % 4];
    r.fulfill({ status: 200, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="16" fill="${COLORS[n % 5]}"/><text x="60" y="68" font-family="Arial" font-size="18" fill="#fff" text-anchor="middle">${name}</text></svg>` });
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const d = ctx.pages()[0] || (await ctx.newPage());
  const send = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  const base = `chrome-extension://${id}/dashboard/dashboard.html`;

  /** Caption bar at the bottom of the frame. */
  const caption = async (step, text, ms = 3800) => {
    await d.evaluate(([s, t]) => {
      let el = document.getElementById('xcap');
      if (!el) {
        el = document.createElement('div');
        el.id = 'xcap';
        el.style.cssText = 'position:fixed;left:24px;right:24px;bottom:24px;z-index:99999;background:#0F172A;color:#fff;border-radius:16px;padding:16px 22px;font:600 22px/1.35 Inter,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.35);display:flex;gap:16px;align-items:center';
        document.body.append(el);
      }
      el.innerHTML = '';
      const b = document.createElement('span');
      b.textContent = s;
      b.style.cssText = 'flex:none;background:#10B981;color:#0F172A;border-radius:999px;min-width:40px;height:40px;display:grid;place-items:center;font-weight:800';
      const p = document.createElement('span');
      p.textContent = t;
      el.append(b, p);
    }, [step, text]);
    await sleep(ms);
  };
  const highlight = (sel) => d.evaluate((s) => { const e = document.querySelector(s); if (e) { e.scrollIntoView({ block: 'center' }); e.style.outline = '4px solid #10B981'; e.style.outlineOffset = '4px'; e.style.borderRadius = '12px'; } }, sel);
  // the «Подсказка» boxes and the first-launch tour are for real first visits, not for the video
  const tidy = () => d.addStyleTag({ content: '.guide, .tour, [data-card=onboarding] { display: none !important; }' }).catch(() => {});
  const go = async (route) => { await d.goto(`${base}#${route}`); await d.reload(); await tidy(); await sleep(1200); };

  await d.goto(`${base}#home`);
  await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 30000 });
  await tidy();
  await caption('★', 'SaudaPulse: остатки и фото товаров — за 1 минуту', 3000);
  const con = await send('ui:connectApi', { name: 'Автозапчасти', token: 'GOOD-TOKEN-1234' });
  const shopId = con.shopId;
  await send('ui:sync');
  await send('ui:sync');
  await go('home');
  await d.waitForSelector('[data-card=pricelist]', { timeout: 20000 });
  await highlight('[data-card=pricelist]');
  await caption('1', 'Подключили токен — заказы уже загружены. Остатки и ассортимент даёт прайс-лист из кабинета Kaspi.', 5200);
  await caption('2', 'В веб-кабинете Kaspi: Управление товарами → Прайс-лист → Скачать.', 4200);
  await d.click('[data-action=pricelist-import]');
  await tidy();
  await sleep(1500);
  await caption('3', 'Здесь: «Выгрузка товаров» → «Загрузить ассортимент» → выберите скачанный файл.', 4200);
  const offers = [['SKU-0', 'Тормозные колодки'], ['SKU-1', 'Фильтр масляный'], ['SKU-2', 'Свечи зажигания'], ['SKU-NEW', 'Фильтр салонный']].map(([sku, title]) => ({ sku, title, brand: '', price: 9000, stock: 20, warehouses: ['PP1'] }));
  await send('ui:catalogImport', { shopId, offers, merchantId: 'M1', company: 'Автозапчасти', warehouses: ['PP1'] });
  await go('catalog');
  await caption('4', 'Готово: товары, цены и остатки по складам — в SaudaPulse.', 3800);

  // photos come by themselves for sold products
  for (let i = 0; i < 40; i++) {
    const n = await sw.evaluate(async () => Object.keys((await chrome.storage.local.get('ksh.photos'))['ksh.photos'] || {}).length);
    if (n >= 3) break;
    await sleep(1000);
  }
  await go('products');
  await caption('5', 'Фото подтягиваются с Kaspi сами — после первой продажи каждого товара.', 4600);
  await go('catalog');
  await highlight('[data-card=no-photo]');
  await caption('6', 'Товар ещё не продавался? «Товары без фото» → нажмите 📦 …', 3800);
  await d.click('[data-card=no-photo] [data-photo="SKU-NEW"]');
  await d.waitForSelector('#photoDialog[open]');
  await caption('7', '… вставьте ссылку на товар с kaspi.kz — фото найдётся само.', 1500);
  await d.locator('[data-field=photo-url]').pressSequentially('https://kaspi.kz/shop/p/filtr-salonnyi-999113/', { delay: 25 });
  await d.waitForSelector('#photoDialog .photo-preview img[src*="999113"]', { timeout: 15000 }).catch(() => {});
  await sleep(2200);
  await d.click('[data-action=photo-save]');
  await sleep(1200);

  // shipping writes stock off
  const code = '800002001';
  await send('ui:accept', { items: [{ shopId, orderId: code }] });
  await go('orders');
  await caption('8', 'Собрали заказ и распечатали накладную…', 3000);
  await send('ui:pack', { items: [{ shopId, orderId: code }] });
  await sleep(2500);
  await go('catalog');
  await highlight('[data-card=stock-moves]');
  await caption('9', '… остаток уменьшился сам: 20 → 18. Kaspi получит его с прайс-листом в течение часа.', 5200);
  await caption('✓', 'Отменили заказ после сборки — товар вернётся. Возвраты добавляйте вручную после проверки.', 4800);
  await caption('✓', 'Упаковщик видит те же фото — на компьютере склада и в телефоне.', 4200);
  await d.close();
  await ctx.close();
  fs.rmSync(prof, { recursive: true, force: true });
  const webm = fs.readdirSync(vids).filter((f) => f.endsWith('.webm')).map((f) => path.join(vids, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-vf', 'fps=25,format=yuv420p', '-c:v', 'libx264', '-crf', '26', '-preset', 'veryfast', '-movflags', '+faststart', OUT]);
  fs.rmSync(vids, { recursive: true, force: true });
  console.log('video:', OUT, Math.round(fs.statSync(OUT).size / 1024), 'KB');
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
