// Phone app (dist/app-site/app) on an iPhone-sized screen (390×844), Owner and Packer.
// Mock Supabase (auth, licence, team) and mock Kaspi; the REAL relay handler sits in between.
// Nothing reaches a real Supabase project or kaspi.kz: every outside request is intercepted,
// and the production project is blocked outright (the test fails if the app tries it).
//   node tools/build-app.mjs && node tests/e2e/pwa-mobile.js
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '../..');
const SHOTS = path.join(ROOT, 'tests/e2e/pwa-shots');
const SB = 'https://test-proj.supabase.co';
const PROD = /zraktrilvwrfpcbmkqwi|lfadrqgwkjdxkmolhnwi/;
const KTOKEN = 'KaspiOwnerToken_A1b2C3d4E5f6';
const OWNER_ID = '11111111-2222-4333-8444-555555555555';
const STAFF_ID = '99999999-8888-4777-8666-555555555555';
const PASS = 'склад-пароль-2026';
let n = 0;
const ok = (name) => { n++; console.log('ok', name); };

(async () => {
  const { createRelay } = await import(path.join(ROOT, 'billing/supabase/functions/kaspi-relay/handler.js'));

  // ---------- ES256 key standing in for the project's signing key ----------
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'test', alg: 'ES256' };
  delete pub.key_ops; delete pub.ext;
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const now = () => Math.floor(Date.now() / 1000);
  const paidUntil = now() + 30 * 86400;
  const accepted = new Set(); // users who ticked the offer/privacy box (accept_terms)
  let acceptCalls = 0;
  async function jwt(sub, email) {
    const head = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'test' }));
    const body = b64u(JSON.stringify({ iss: `${SB}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub, email, iat: now(), exp: now() + 3600, ksh: { pu: paidUntil, te: null, sl: 3, tsl: 3, bs: 3, tr: 'v1', tv: accepted.has(sub) ? 'v1' : null } }));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.from(`${head}.${body}`));
    return `${head}.${body}.${b64u(sig)}`;
  }

  // ---------- build a test copy of the site pointing at the mock project ----------
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pwa-'));
  fs.cpSync(path.join(ROOT, 'dist/app-site'), site, { recursive: true });
  const cfgPath = path.join(site, 'app/core/shared/billing-config.js');
  let cfg = fs.readFileSync(cfgPath, 'utf8');
  cfg = cfg.replace(/supabaseUrl: '[^']*'/, `supabaseUrl: '${SB}'`).replace(/supabaseAnonKey: '[^']*'/, "supabaseAnonKey: 'test-anon-key'").replace(/^  licenseKeys: \[[\s\S]*?\n  \],/m, `  licenseKeys: [${JSON.stringify(pub)}],`);
  fs.writeFileSync(cfgPath, cfg);
  const idx = path.join(site, 'app/index.html');
  fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('https://zraktrilvwrfpcbmkqwi.supabase.co', SB));

  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(site, p);
    if (!f.startsWith(site) || !fs.existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ORIGIN = `http://localhost:${server.address().port}`;

  // ---------- mock Kaspi (behind the real relay) ----------
  const today = Date.now() - 2 * 3600000;
  const orders = [
    { id: 'o1', code: '600001', status: 'APPROVED_BY_BANK', state: 'NEW', totalPrice: 45990, kd: false },
    { id: 'o2', code: '600002', status: 'APPROVED_BY_BANK', state: 'NEW', totalPrice: 12500, kd: false },
    { id: 'o3', code: '600003', status: 'ACCEPTED_BY_MERCHANT', state: 'KASPI_DELIVERY', totalPrice: 30000, kd: true, assembled: false },
    { id: 'o4', code: '600004', status: 'CANCELLED', state: 'ARCHIVE', totalPrice: 99999, kd: false },
  ];
  const entries = { o1: [['Наушники X', 'SKU-1', 1, 45990]], o2: [['Чехол', 'SKU-2', 5, 2500]], o3: [['Кабель USB-C', 'SKU-3', 2, 15000]], o4: [['Телевизор', 'SKU-4', 1, 99999]] };
  const kaspiCalls = [];
  const kaspi = async (url, opts) => {
    const u = new URL(url);
    kaspiCalls.push({ url, method: opts.method, token: opts.headers['X-Auth-Token'], body: opts.body });
    if (opts.headers['X-Auth-Token'] !== KTOKEN) return new Response('{"errors":[{"title":"Unauthorized"}]}', { status: 401 });
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/vnd.api+json' } });
    const m = u.pathname.match(/\/orders\/(\w+)\/entries$/);
    if (m) return json({ data: (entries[m[1]] || []).map(([name, code, q, price], i) => ({ id: `${m[1]}-${i}`, attributes: { offer: { name, code }, quantity: q, basePrice: price, totalPrice: price * q, category: { title: 'Электроника' } } })) });
    if (u.pathname.endsWith('/orders') && opts.method === 'POST') {
      const a = JSON.parse(opts.body).data;
      const o = orders.find((x) => x.id === a.id);
      if (a.attributes.status === 'ASSEMBLE') o.assembled = true;
      if (a.attributes.status === 'ACCEPTED_BY_MERCHANT') (o.status = 'ACCEPTED_BY_MERCHANT'), (o.state = 'PICKUP');
      return json({ data: { id: o.id, attributes: { status: o.status } } });
    }
    if (u.pathname.endsWith('/orders')) {
      const p = Object.fromEntries(u.searchParams);
      const ge = Number(p['filter[orders][creationDate][$ge]'] || 0);
      const le = Number(p['filter[orders][creationDate][$le]'] || Infinity);
      const list = orders.filter((o) => (p['filter[orders][code]'] ? o.code === p['filter[orders][code]'] : o.state === p['filter[orders][state]'] && today >= ge && today <= le));
      const pageSize = Number(p['page[size]'] || 100);
      return json({
        data: list.slice(0, pageSize).map((o) => ({ id: o.id, attributes: { code: o.code, status: o.status, state: o.state, totalPrice: o.totalPrice, creationDate: today, isKaspiDelivery: o.kd, assembled: !!o.assembled, approvedByBankDate: today, paymentMode: 'PAY_WITH_CREDIT', customer: { firstName: 'Асель', cellPhone: '7771234567' }, kaspiDelivery: o.kd ? { courierTransmissionPlanningDate: Date.now() + 5 * 3600000 } : undefined }, relationships: { entries: { links: { related: `https://kaspi.kz/shop/api/v2/orders/${o.id}/entries` } } } })),
        meta: { pageCount: 1, totalCount: list.length },
      });
    }
    return new Response('{}', { status: 404 });
  };
  const relay = createRelay({ env: { SUPABASE_URL: SB, RELAY_ALLOWED_ORIGINS: ORIGIN }, fetchImpl: kaspi, jwks: [pub] });
  const relayEnvelopes = [];

  // ---------- mock Supabase ----------
  let teamMode = 'ok';
  const users = { 'owner@shop.kz': OWNER_ID, 'packer@shop.kz': STAFF_ID };
  let lastEmail = null;
  const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, GET, PUT, OPTIONS', 'Access-Control-Expose-Headers': 'Retry-After, X-Relay-Error' };
  const forbidden = [];
  async function onSupabase(route) {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const reply = (status, obj) => route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: obj == null ? '' : JSON.stringify(obj) });
    if (u.pathname === '/functions/v1/kaspi-relay') {
      relayEnvelopes.push({ url: req.url(), headers: req.headers(), body: req.postData() });
      const res = await relay(new Request(req.url(), { method: 'POST', headers: req.headers(), body: req.postData() }));
      if (process.env.DEBUG && res.status >= 300) console.log('RELAY', res.status, res.headers.get('X-Relay-Error'), req.postData().slice(0, 200), req.headers().origin);
      return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    }
    if (u.pathname === '/auth/v1/otp') return (lastEmail = body.email), reply(200, {});
    if (u.pathname === '/auth/v1/verify') {
      const id = users[body.email];
      return reply(200, { access_token: await jwt(id, body.email), refresh_token: `r-${id}`, expires_in: 3600, user: { id, email: body.email } });
    }
    if (u.pathname === '/auth/v1/token') {
      const id = body.refresh_token.slice(2);
      return reply(200, { access_token: await jwt(id, ''), refresh_token: body.refresh_token, expires_in: 3600, user: { id } });
    }
    if (u.pathname === '/auth/v1/logout') return reply(204, null);
    if (u.pathname === '/auth/v1/user') return reply(200, {});
    if (u.pathname === '/rest/v1/rpc/get_license') {
      const auth = req.headers().authorization || '';
      if (auth.includes('test-anon-key')) return reply(401, { message: 'jwt' });
      return reply(200, { paid_until: new Date(paidUntil * 1000).toISOString(), trial_ends_at: null, paid_store_limit: 3, store_limit: 3, terms_version: accepted.has(OWNER_ID) ? 'v1' : null, terms_required: 'v1', terms_accepted_at: accepted.has(OWNER_ID) ? new Date().toISOString() : null, pricing: { base_stores: 3 }, email: 'owner@shop.kz', server_time: new Date().toISOString(), features: {} });
    }
    if (u.pathname === '/rest/v1/rpc/team_join' || u.pathname === '/rest/v1/rpc/team_check') {
      if (body.p_owner !== OWNER_ID) return reply(403, { message: 'not_invited', code: '42501' });
      if (teamMode === 'disabled') return reply(403, { message: 'access_disabled', code: '42501' });
      return reply(200, { id: 'm1', email: 'packer@shop.kz', name: 'Ерлан', role: 'packer', shop_ids: [], can_accept: false, status: 'active', joined: true, owner_id: OWNER_ID });
    }
    if (u.pathname === '/rest/v1/rpc/accept_terms') return acceptCalls++, accepted.add(OWNER_ID), reply(200, null);
    if (u.pathname.startsWith('/rest/v1/rpc/')) return reply(200, null); // set_my_lang, report_client_error, tracking…
    return reply(404, { message: 'mock: unknown ' + u.pathname });
  }

  const browser = await chromium.launch();
  async function phone() {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Asia/Almaty', acceptDownloads: true, serviceWorkers: 'allow' });
    await ctx.route(`${SB}/**`, onSupabase);
    await ctx.route(PROD, (r) => (forbidden.push(r.request().url()), r.abort()));
    await ctx.route(/^https:\/\/([a-z0-9-]+\.)*kaspi\.kz\//, (r) => (forbidden.push(r.request().url()), r.abort())); // must never be called directly
    await ctx.route('https://challenges.cloudflare.com/**', (r) => r.abort());
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    if (process.env.DEBUG) page.on('console', (m) => console.log('console', m.type(), m.text())), page.on('pageerror', (e) => console.log('pageerror', e.message));
    return { ctx, page, errors };
  }

  /** Layout rules on a phone: no sideways scroll, visible tap targets ≥ 44×44, bottom nav pinned. */
  async function checkLayout(page, label) {
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const small = [];
      for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]):not([type=checkbox]), [role=tab], [role=radio]')) {
        const b = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (!b.width || st.visibility === 'hidden' || st.display === 'none' || el.closest('[hidden]')) continue;
        if (el.tagName === 'A' && st.display === 'inline' && el.closest('p, label, span')) continue; // links inside a sentence (WCAG 2.5.8 inline exception)
        if (b.width < 44 || b.height < 44) small.push(`${el.tagName}.${el.className} "${(el.textContent || el.placeholder || '').trim().slice(0, 20)}" ${Math.round(b.width)}×${Math.round(b.height)}`);
      }
      const nav = document.querySelector('.bottomnav');
      const nb = nav?.getBoundingClientRect();
      return { overflow: document.scrollingElement.scrollWidth - vw, small, vw, nav: nav ? { bottom: Math.round(nb.bottom), pos: getComputedStyle(nav).position } : null };
    });
    assert.equal(r.vw, 390, label);
    assert.ok(r.overflow <= 0, `${label}: horizontal overflow ${r.overflow}px`);
    assert.deepEqual(r.small, [], `${label}: small tap targets`);
    if (r.nav) assert.ok(r.nav.pos === 'fixed' && r.nav.bottom === 844, `${label}: bottom nav ${JSON.stringify(r.nav)}`);
  }
  async function login(page, email, role) {
    await page.goto(`${ORIGIN}/app/`);
    await page.waitForSelector('[data-action=send-code]');
    await checkLayout(page, 'login');
    await page.click(`[data-role=${role}]`);
    await page.fill('input[type=email]', email);
    await page.click('[data-action=send-code]');
    await page.fill('input[name=code]', '123456');
    await page.click('[data-action=verify-code]');
  }
  /** Decrypted view of everything the app keeps on the phone (through its own storage facade). */
  const phoneData = (page) => page.evaluate(() => chrome.storage.local.get(null));
  /** What is physically in IndexedDB (ciphertext). */
  const rawIdb = (page) =>
    page.evaluate(async () => {
      const dump = async (name, stores) => {
        const db = await new Promise((ok, f) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => f(r.error); });
        const out = {};
        for (const s of stores) {
          if (!db.objectStoreNames.contains(s)) continue;
          const tx = db.transaction(s);
          const all = await new Promise((ok) => { const r = tx.objectStore(s).getAll(); r.onsuccess = () => ok(r.result); });
          const keys = await new Promise((ok) => { const r = tx.objectStore(s).getAllKeys(); r.onsuccess = () => ok(r.result); });
          out[s] = keys.map((k, i) => [k, all[i] && all[i].ct ? Array.from(all[i].ct).map((b) => String.fromCharCode(b)).join('') : all[i] instanceof CryptoKey ? `CryptoKey extractable=${all[i].extractable}` : JSON.stringify(all[i])]);
        }
        db.close();
        return out;
      };
      return { app: await dump('saudapulse-app', ['kv', 'keys']), ls: JSON.stringify(localStorage), ss: JSON.stringify(sessionStorage), cookies: document.cookie };
    });

  fs.mkdirSync(SHOTS, { recursive: true });

  /* ======================= OWNER PHONE ======================= */
  const A = await phone();
  let page = A.page;
  await login(page, 'owner@shop.kz', 'owner');
  // first sign-in: the offer and privacy policy come before anything else (same as the extension)
  await page.waitForSelector('[data-action=accept-terms]');
  assert.match(await page.textContent('body'), /Примите условия сервиса[\s\S]*Публичной оферты[\s\S]*Политикой конфиденциальности/);
  assert.equal(await page.isDisabled('[data-action=accept-terms]'), true);
  assert.equal(await page.getAttribute('.consent a >> nth=0', 'href'), '/offer');
  assert.equal(await page.getAttribute('.consent a >> nth=1', 'href'), '/privacy');
  assert.equal(await page.locator('.bottomnav').count(), 0);
  await checkLayout(page, 'consent');
  await page.screenshot({ path: path.join(SHOTS, 'owner-consent-390x844.png') });
  await page.check('[data-field=terms]');
  await page.click('[data-action=accept-terms]');
  await page.waitForSelector('.bottomnav');
  assert.equal(acceptCalls, 1);
  ok('owner: first sign-in shows «Примите условия сервиса» (offer + privacy links, button off until the box is ticked); accepted → saved on the server');
  assert.match(await page.textContent('.role-chip'), /Владелец/);
  ok('owner: e-mail code login (captcha off → no token, like the extension)');
  await page.waitForSelector('[data-action=scan-qr]');
  assert.match(await page.textContent('#content'), /Показать QR-код для телефона/);
  await checkLayout(page, 'owner start');
  await page.screenshot({ path: path.join(SHOTS, 'owner-start-390x844.png') });
  ok('owner: first screen is one big «Сканировать QR с компьютера» button with 2 short steps');

  await page.click('[data-tab=stores]');
  await page.click('summary.more__sum'); // token / file / packer are under «Другие способы»
  await page.fill('input[placeholder^="Например"]', 'Мой магазин');
  await page.fill('input[placeholder^="Токен API"]', KTOKEN);
  await page.click('[data-action=connect]');
  await page.waitForTimeout(1500); if (process.env.DEBUG) console.log('TOASTS', await page.locator('.toast').allTextContents(), forbidden, relayEnvelopes.length);
  await page.waitForSelector('text=Магазин подключён');
  await page.waitForSelector('text=Мой магазин');
  ok('owner: store connected by token (checked against Kaspi through the relay)');

  await page.click('[data-tab=home]');
  await page.click('[data-action=sync]');
  await page.waitForSelector('text=Заказы обновлены');
  await page.waitForFunction(() => /88\s?490/.test(document.querySelector('[data-kpi=revenue]')?.textContent || ''));
  const revenue = await page.textContent('[data-kpi=revenue]');
  assert.match(revenue, /88\s490\s₸/); // 45 990 + 12 500 + 30 000; the cancelled 99 999 is not revenue
  assert.match(revenue, /3 заказ/);
  assert.match(await page.textContent('[data-kpi=margin]'), /—\s*укажите себестоимость/); // no cost prices yet → never a made-up 100 %
  await checkLayout(page, 'owner home');
  await page.screenshot({ path: path.join(SHOTS, 'owner-home-390x844.png') });
  ok('owner: home at 390×844 — today revenue 88 490 ₸ (cancelled order excluded), margin, bottom nav, tap targets ≥ 44 px, no sideways scroll');

  // desktop → phone in one tap: the QR text the extension shows (cost prices + commission inside)
  const { encodeTransfer } = await import(path.join(ROOT, 'shared/qr-transfer.js'));
  const qr = await encodeTransfer({ stores: { 'api-x': { name: 'Мой магазин' } }, tokens: { 'api-x': KTOKEN }, costs: { 'SKU-1': 30000, 'SKU-2': 1000, 'SKU-3': 10000 }, profit: { defaultCommission: 10, byCategory: {} } });
  await page.click('[data-tab=stores]');
  await page.click('[data-action=scan-qr]');
  await page.waitForSelector('dialog.scanner[open]');
  await page.screenshot({ path: path.join(SHOTS, 'owner-scanner-390x844.png') });
  await page.click('dialog.scanner summary'); // headless browser has no camera: the «вставить код» fallback
  await page.fill('[data-field=qr-paste]', qr.text);
  await page.click('[data-action=qr-paste-ok]');
  await page.waitForSelector('text=Готово: магазинов 1, себестоимостей 3');
  await page.click('[data-tab=stores]');
  assert.equal(await page.locator('.list__row').count(), 1); // same token → same store (double SHA-256 store id), no duplicate
  await page.click('[data-tab=home]');
  // 88 490 − (30 000 + 5×1 000 + 2×10 000) − 10 % commission 8 849 = 24 641 → 28 %
  await page.waitForFunction(() => /28%/.test(document.querySelector('[data-kpi=margin]')?.textContent || ''));
  assert.match(await page.textContent('[data-kpi=margin]'), /28%\s*24\s641\s₸/);
  await page.screenshot({ path: path.join(SHOTS, 'owner-home-390x844.png') });
  ok('owner: one-tap QR from the computer → same store (no duplicate), cost prices → margin 28 % (24 641 ₸)');

  // the same through a password file (other way)
  const { encryptBackup } = await import(path.join(ROOT, 'shared/spbackup.js'));
  const ownerFile = path.join(os.tmpdir(), 'saudapulse-owner-test.spbackup');
  fs.writeFileSync(ownerFile, JSON.stringify(await encryptBackup({ stores: { 'api-x': { name: 'Мой магазин' } }, tokens: { 'api-x': KTOKEN }, costs: { 'SKU-1': 30000, 'SKU-2': 1000, 'SKU-3': 10000 }, profit: { defaultCommission: 10, byCategory: {} } }, 'owner-pass-123', { scope: 'owner' })));
  await page.click('[data-tab=stores]');
  await page.click('summary.more__sum');
  const fcO = page.waitForEvent('filechooser');
  await page.click('[data-action=import-owner]');
  await (await fcO).setFiles(ownerFile);
  await page.fill('dialog.sheet input[type=password]', 'owner-pass-123');
  await page.click('[data-action=passphrase-ok]');
  await page.waitForSelector('text=Перенесено магазинов: 1, себестоимостей: 3');
  assert.equal(await page.locator('.list__row').count(), 1); // same token → same store (double SHA-256 store id), no duplicate
  assert.equal(await page.locator('.list__row').count(), 1);
  fs.rmSync(ownerFile);
  ok('owner: .spbackup file with password (under «Другие способы») still works, no duplicate store');

  await page.click('[data-tab=orders]');
  await page.waitForSelector('.order');
  assert.equal(await page.locator('.order').count(), 2); // «Новые»
  await checkLayout(page, 'owner orders');
  await page.screenshot({ path: path.join(SHOTS, 'owner-orders-390x844.png') });
  await page.click('.order >> nth=0');
  await page.waitForSelector('dialog.sheet[open]');
  assert.match(await page.textContent('dialog.sheet'), /Наушники X|Чехол/);
  await page.click('dialog.sheet >> text=Закрыть');
  ok('owner: order list (new orders) and order card with its products');

  // Zero-knowledge checks on the owner phone
  assert.equal(forbidden.length, 0, `direct/production requests: ${forbidden}`);
  assert.ok(relayEnvelopes.length >= 5);
  for (const e of relayEnvelopes) {
    assert.ok(!e.url.includes(KTOKEN) && !JSON.stringify(e.headers).includes(KTOKEN), 'Kaspi token outside the POST body');
    assert.equal(JSON.parse(e.body).token, KTOKEN);
    assert.match(e.headers.authorization, /^Bearer ey/);
  }
  const raw = await rawIdb(page);
  const rawText = JSON.stringify(raw);
  for (const s of [KTOKEN, '45990', 'Наушники', 'Мой магазин', '600001', 'owner@shop.kz', 'refresh_token', 'r-1111']) assert.ok(!rawText.includes(s), `"${s}" readable in IndexedDB`);
  assert.ok(raw.app.kv.length >= 5);
  assert.match(JSON.stringify(raw.app.keys), /CryptoKey extractable=false/);
  assert.equal(raw.ls, '{}');
  assert.equal(raw.ss, '{}');
  assert.equal(raw.cookies, '');
  const data = await phoneData(page);
  assert.ok(data['ksh.apiTokens'][Object.keys(data['ksh.apiTokens'])[0]].startsWith('enc1:')); // and the token is encrypted once more inside
  ok('owner: IndexedDB holds only AES-GCM ciphertext (token, amounts, products, e-mail, session) + a non-extractable key; no localStorage/cookies; token only inside relay POST bodies');

  // service worker: app shell only
  await page.reload();
  await page.waitForSelector('.bottomnav');
  await page.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith('sp-shell-')), null, { timeout: 15000 });
  const cached = await page.evaluate(async () => {
    const out = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url);
    return out;
  });
  assert.ok(cached.length > 10);
  for (const u of cached) {
    const p = new URL(u).pathname;
    assert.ok(u.startsWith(`${ORIGIN}/app/`) && !u.includes('?') && !u.startsWith(SB), `cached: ${u}`);
    assert.ok(fs.existsSync(path.join(site, p.endsWith('/') ? p + 'index.html' : p)), `cached non-shell file: ${u}`);
  }
  ok(`service worker caches the app shell only (${cached.length} files, nothing from Supabase / relay / Kaspi)`);

  // owner makes the packer's file
  await page.click('[data-tab=stores]');
  await page.click('summary.more__sum');
  const dlP = page.waitForEvent('download');
  await page.click('[data-action=export-staff]');
  const pw = page.locator('dialog.sheet input[type=password]');
  await pw.nth(0).fill(PASS);
  await pw.nth(1).fill(PASS);
  await page.click('[data-action=passphrase-ok]');
  const dl = await dlP;
  const staffFile = path.join(os.tmpdir(), dl.suggestedFilename());
  await dl.saveAs(staffFile);
  const fileText = fs.readFileSync(staffFile, 'utf8');
  assert.match(dl.suggestedFilename(), /^saudapulse-packer-.*\.spbackup$/);
  assert.equal(JSON.parse(fileText).scope, 'staff');
  for (const s of [KTOKEN, 'Мой магазин', OWNER_ID]) assert.ok(!fileText.includes(s));
  ok('owner: «файл для упаковщика» saved, encrypted (no token / store / owner id readable)');
  assert.deepEqual(A.errors, []);

  /* ======================= PACKER PHONE ======================= */
  const P = await phone();
  page = P.page;
  await login(page, 'packer@shop.kz', 'staff');
  await page.waitForSelector('[data-action=import-staff]');
  const fcP = page.waitForEvent('filechooser');
  await page.click('[data-action=import-staff]');
  await (await fcP).setFiles(staffFile);
  await page.fill('dialog.sheet input[type=password]', PASS);
  await page.click('[data-action=passphrase-ok]');
  await page.waitForSelector('[data-tab=queue]');
  await page.waitForSelector('.order');
  assert.match(await page.textContent('.role-chip'), /Упаковщик/);
  const queueText = await page.textContent('body');
  assert.equal(await page.locator('.order').count(), 1); // o3 accepted; new ones hidden (can_accept=false)
  for (const bad of ['₸', '45 990', '30 000', '15 000', 'Выручка', 'Маржа', 'Прибыль', 'Подписка', 'себестоим', 'Асель']) assert.ok(!queueText.includes(bad), `packer sees "${bad}"`);
  await checkLayout(page, 'packer queue');
  await page.screenshot({ path: path.join(SHOTS, 'staff-queue-390x844.png') });
  ok('packer: file + passphrase + team_join → queue at 390×844 with NO money, prices, profit, billing or buyer data');

  const pdata = await phoneData(page);
  const ptext = JSON.stringify(pdata);
  for (const key of ['ksh.costs', 'ksh.license', 'ksh.snapIndex']) assert.ok(pdata[key] == null, `${key} on the packer phone`); // verifyCode() writes ksh.license = null
  for (const bad of ['totalPrice', '"amount"', '"price"', '"total"', '45990', '30000', 'paymentMode', 'deliveryCost', 'Асель', '7771234567']) assert.ok(!ptext.includes(bad), `packer phone stores ${bad}`);
  assert.match(ptext, /Кабель USB-C/);
  ok('packer phone storage (decrypted): products and quantities only — no amounts, prices, cost prices, licence or buyer data');

  await page.click('.order >> nth=0');
  await page.waitForSelector('dialog.sheet[open]');
  await checkLayout(page, 'packer order card');
  await page.screenshot({ path: path.join(SHOTS, 'staff-order-390x844.png') });
  await page.fill('dialog.sheet input[type=text]', 'SKU-3');
  await page.press('dialog.sheet input[type=text]', 'Enter');
  assert.equal(await page.isChecked('dialog.sheet input[type=checkbox]'), true);
  await page.click('[data-action=pack]');
  await page.waitForSelector('text=Заказ собран');
  const post = kaspiCalls.find((c) => c.method === 'POST' && /ASSEMBLE/.test(c.body || ''));
  assert.ok(post && JSON.parse(post.body).data.id === 'o3');
  await page.waitForFunction(() => document.querySelectorAll('.order').length === 0);
  ok('packer: scan-to-verify the line, «Собран» → Kaspi ASSEMBLE through the relay, order leaves the queue');

  await page.click('[data-tab=search]');
  await page.fill('input[type=search]', '600002');
  await page.click('[data-action=find]');
  await page.waitForSelector('dialog.sheet[open]');
  const found = await page.textContent('dialog.sheet');
  assert.match(found, /600002/);
  assert.ok(!/₸|12\s?500|2\s?500/.test(found));
  await page.click('dialog.sheet >> text=Закрыть');
  ok('packer: search by order number — card without amounts');

  // owner switches the packer off → next check wipes the phone
  teamMode = 'disabled';
  await page.reload();
  await page.waitForSelector('text=Доступ закрыт');
  const after = await rawIdb(page);
  assert.equal(after.app.kv.length, 0, 'data left after access was closed');
  assert.equal((after.app.keys || []).length, 0, 'encryption key left after access was closed');
  ok('packer switched off by the owner → phone wiped (records and encryption key)');
  assert.deepEqual(P.errors, []);
  assert.equal(forbidden.length, 0, `direct/production requests: ${forbidden}`);
  ok('no request went to kaspi.kz directly or to a production Supabase project');

  /* ======================= INSTALL ======================= */
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  {
    const { ctx, page: p2 } = await phone();
    await p2.goto(`${ORIGIN}/app/`);
    await p2.waitForSelector('[data-action=send-code]');
    assert.equal(await p2.locator('.install-bar').count(), 0); // nothing to offer until the browser says it can install
    await p2.evaluate(() => {
      const e = new Event('beforeinstallprompt');
      e.prompt = async () => { window.__prompted = true; };
      e.userChoice = Promise.resolve({ outcome: 'accepted' });
      dispatchEvent(e);
    });
    await p2.waitForSelector('.install-bar [data-action=install]');
    await checkLayout(p2, 'login + install bar');
    await p2.screenshot({ path: path.join(SHOTS, 'android-install-390x844.png') });
    await p2.click('.install-bar [data-action=install]');
    await p2.waitForFunction(() => window.__prompted === true);
    await p2.waitForFunction(() => !document.querySelector('.install-bar'));
    await ctx.close();
    ok('Android: «Установить» bar → the browser\'s own install prompt in one tap, bar gone after install');
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA, locale: 'ru-RU' });
    await ctx.route(`${SB}/**`, onSupabase);
    const p3 = await ctx.newPage();
    await p3.goto(`${ORIGIN}/app/`);
    await p3.waitForSelector('.install-bar [data-action=install]');
    await p3.click('.install-bar [data-action=install]');
    await p3.waitForSelector('dialog.sheet[open]');
    assert.match(await p3.textContent('dialog.sheet'), /Поделиться[\s\S]*На экран Домой[\s\S]*Добавить/);
    await p3.screenshot({ path: path.join(SHOTS, 'iphone-install-390x844.png') });
    await p3.click('dialog.sheet >> text=Понятно');
    await p3.click('.install-bar [aria-label="Не сейчас"]');
    await p3.waitForFunction(() => !document.querySelector('.install-bar')); // removed once saved
    await p3.reload();
    await p3.waitForSelector('[data-action=send-code]');
    assert.equal(await p3.locator('.install-bar').count(), 0); // «Не сейчас» = hidden for 7 days
    await p3.goto(`${ORIGIN}/app/?install=1`);
    await p3.waitForSelector('dialog.sheet[open]'); // from the site's button: the steps open at once
    assert.equal(new URL(p3.url()).search, '');
    await ctx.close();
    ok('iPhone: «Установить» → «Поделиться → На экран Домой → Добавить»; «Не сейчас» hides it; ?install=1 opens the steps at once');
  }
  {
    fs.writeFileSync(path.join(site, 'site-test.html'), '<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>t</title></head><body style="margin:0;font:16px system-ui"><h1 style="padding:16px">saudapulse.kz</h1><p style="padding:16px">Лендинг</p><script src="/install-button.js" defer data-store-url="https://chromewebstore.google.com/detail/saudapulse/test"></script></body></html>');
    const look = async (opts, file) => {
      const ctx = await browser.newContext(opts);
      const p = await ctx.newPage();
      await p.goto(`${ORIGIN}/site-test.html`);
      await p.waitForSelector('.spi a');
      const r = await p.evaluate(() => { const a = document.querySelector('.spi a'); const b = a.getBoundingClientRect(); return { href: a.getAttribute('href'), text: a.textContent, kind: a.dataset.spi, right: innerWidth - b.right, bottom: innerHeight - b.bottom, h: b.height, overflow: document.scrollingElement.scrollWidth - innerWidth }; });
      if (file) await p.waitForTimeout(500), await p.screenshot({ path: path.join(SHOTS, file) });
      await ctx.close();
      return r;
    };
    const desk = await look({ viewport: { width: 1440, height: 900 } }, 'site-desktop.png');
    assert.equal(desk.kind, 'desktop');
    assert.equal(desk.href, 'https://chromewebstore.google.com/detail/saudapulse/test');
    assert.match(desk.text, /Установить расширение/);
    assert.ok(desk.right < 40 && desk.bottom < 40 && desk.h >= 44, JSON.stringify(desk));
    const lap = await look({ viewport: { width: 1280, height: 720 } });
    assert.equal(lap.kind, 'desktop');
    const tab = await look({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, userAgent: IPAD_UA });
    assert.equal(tab.kind, 'tablet');
    assert.equal(tab.href, '/app/?install=1');
    assert.ok(tab.right < 40 && tab.bottom < 40, JSON.stringify(tab));
    const ph = await look({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA }, 'site-phone-390x844.png');
    assert.equal(ph.kind, 'phone');
    assert.equal(ph.href, '/app/?install=1');
    assert.ok(ph.bottom < 30 && ph.h >= 44 && ph.overflow <= 0, JSON.stringify(ph));
    ok('website: computer/laptop → «Установить расширение» bottom-right; tablet → bottom-right to the app; phone → bar at the bottom → /app/?install=1');
  }

  await browser.close();
  server.close();
  fs.rmSync(site, { recursive: true, force: true });
  fs.rmSync(staffFile, { force: true });
  console.log(`\n${n} checks passed — screenshots in tests/e2e/pwa-shots/`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
