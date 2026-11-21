// Landing page check: phone / tablet / desktop, dark mode, keyboard only, no horizontal scroll,
// all images load, no page errors. Serves dist/site (node tools/build-site.mjs first).
//   node tests/site/sitecheck.js
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../../dist/site');
const OUT = path.join(__dirname, 'shots');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.gif': 'image/gif', '.txt': 'text/plain' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': TYPES['.html'] }); return res.end(fs.readFileSync(path.join(ROOT, '404.html'))); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
}).listen(8131);
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  for (const [name, vp, scheme] of [['desktop', { width: 1440, height: 900 }, 'light'], ['tablet', { width: 820, height: 1180 }, 'light'], ['phone', { width: 390, height: 844 }, 'light'], ['phone-dark', { width: 390, height: 844 }, 'dark'], ['desktop-dark', { width: 1440, height: 900 }, 'dark']]) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: name.startsWith('desktop') ? 1 : 2, colorScheme: scheme, hasTouch: name.startsWith('phone') || name === 'tablet' });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('requestfailed', (r) => errs.push('failed ' + r.url()));
    const t0 = Date.now();
    await p.goto('http://localhost:8131/', { waitUntil: 'load' });
    const loadMs = Date.now() - t0;
    // scroll through the page so every «appear on scroll» block runs
    const h = await p.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < h; y += vp.height / 2) { await p.evaluate((y) => scrollTo(0, y), y); await p.waitForTimeout(120); }
    await p.waitForTimeout(700);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`${name}: no horizontal scroll`, overflow <= 0, `${overflow}px`);
    const hiddenReveal = await p.$$eval('.reveal', (els) => els.filter((e) => getComputedStyle(e).opacity !== '1').length);
    check(`${name}: every block appeared`, hiddenReveal === 0, `${hiddenReveal} still hidden`);
    const broken = await p.$$eval('img', (imgs) => imgs.filter((i) => i.offsetParent && !(i.complete && i.naturalWidth)).map((i) => i.src));
    check(`${name}: images load`, broken.length === 0, broken.join(' '));
    check(`${name}: no errors`, errs.length === 0, errs.join(' | '));
    if (name.startsWith('phone')) check(`${name}: sticky call-to-action after the first screen`, await p.locator('.mcta.is-on').isVisible());
    await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(OUT, `${name}-top.png`) });
    await p.screenshot({ path: path.join(OUT, `${name}-full.png`), fullPage: true });
    console.log(`INFO ${name}: load ${loadMs} ms, page ${h}px`);
    await ctx.close();
  }

  // keyboard only
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto('http://localhost:8131/');
  await p.keyboard.press('Tab');
  check('keyboard: first Tab = «skip to content»', (await p.evaluate(() => document.activeElement.className)) === 'skip');
  const seen = [];
  for (let i = 0; i < 40; i++) {
    await p.keyboard.press('Tab');
    const el = await p.evaluate(() => { const a = document.activeElement; const r = a.getBoundingClientRect(); const s = getComputedStyle(a); return { tag: a.tagName, text: (a.innerText || '').trim().slice(0, 30), visible: r.width > 0 && r.height > 0, outline: s.outlineStyle !== 'none' || s.boxShadow !== 'none' }; });
    seen.push(el);
  }
  // the end of the page hands focus back to the browser (BODY): that is not a page element
  const onPage = seen.filter((e) => e.tag !== 'BODY');
  check('keyboard: every focused element is visible with a focus ring', onPage.length > 15 && onPage.every((e) => e.visible && e.outline), JSON.stringify(onPage.filter((e) => !e.visible || !e.outline)));
  check('keyboard: reaches FAQ questions', seen.some((e) => e.tag === 'SUMMARY'));
  await p.locator('summary').first().focus(); await p.keyboard.press('Enter');
  check('keyboard: Enter opens a FAQ answer', await p.locator('details').first().evaluate((d) => d.open));
  // 404, robots
  const r404 = await p.goto('http://localhost:8131/no-such-page');
  check('404 page with a way home', r404.status() === 404 && (await p.locator('a[href="/"]').count()) >= 1);
  const robots = await (await fetch('http://localhost:8131/robots.txt')).text();
  check('robots.txt allows indexing', /Allow: \//.test(robots));
  await p.goto('http://localhost:8131/');
  const meta = await p.evaluate(() => ({ title: document.title, desc: document.querySelector('meta[name=description]')?.content, ld: !!JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent).offers, h1: document.querySelectorAll('h1').length }));
  check('title, description, JSON-LD, one h1', meta.title.length > 20 && meta.desc.length > 80 && meta.ld && meta.h1 === 1, JSON.stringify(meta));
  const legal = await p.goto('http://localhost:8131/legal/terms.html');
  check('offer / privacy page published with the site', legal.status() === 200);
  // reduced motion: everything visible without scrolling effects
  const rm = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const q = await rm.newPage();
  await q.goto('http://localhost:8131/'); await q.waitForTimeout(300);
  check('reduced motion: blocks visible, no tilt', (await q.$$eval('.reveal', (els) => els.every((e) => getComputedStyle(e).opacity === '1'))) && (await q.locator('[data-tilt]').evaluate((e) => getComputedStyle(e).transform)) === 'none');
  await b.close();
  srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
