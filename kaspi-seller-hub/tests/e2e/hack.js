// Attempts to get the subscription for free the ways a user with DevTools could.
const { chromium } = require('playwright'); require('./offline');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const EXT = path.join(__dirname, '../billcopy');
let fails = 0; const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => fetch('http://localhost:8098/__sql', { method: 'POST', body: JSON.stringify({ sql: q }) }).then((r) => r.json());
const mock = (p, body) => fetch('http://localhost:8098' + p, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.json());
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'hackprof' + Date.now()), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  for (const x of ['a', 'b', 'c']) { const p = await ctx.newPage(); await p.goto(`file://${EXT}/demo/mc/store-${x}.html`); }
  const d = await ctx.newPage();
  const state = (force = false) => d.evaluate((f) => chrome.runtime.sendMessage({ type: 'ui:billingState', payload: { force: f } }), force);
  const store = (k, v) => d.evaluate(([k, v]) => chrome.storage.local.set({ [k]: v }), [k, v]);
  const read = (k) => d.evaluate(async (k) => (await chrome.storage.local.get(k))[k], k);
  const pack = () => d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pack', payload: { items: [{ shopId: '1001', orderId: '500000' }] } }));
  const login = async (email) => {
    await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#account`);
    await d.waitForSelector('input[type=email]');
    await d.fill('input[type=email]', email); await d.check('label.consent input'); await d.click('button:has-text("Получить код")');
    await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
    await sleep(2500);
  };

  // ---------- genuine paid account ----------
  await login('payer@example.kz');
  await sql("update accounts set paid_until = now() + interval '20 days', store_limit = 3 where email = 'payer@example.kz'");
  let lic = await state(true);
  check('0 genuine payment is picked up from a freshly signed token', lic.status === 'active' && lic.signed, lic.status);
  const genuine = await read('ksh.session');

  // ---------- subscription over (server truth) ----------
  await sql('update billing_config set grace_days = 0 where id = 1'); // hard expiry, no renewal grace
  await sql("update accounts set paid_until = now() - interval '1 day', trial_ends_at = now() - interval '40 days' where email = 'payer@example.kz'");
  lic = await state(true);
  check('1 server says expired → extension expired', lic.status === 'expired' && !lic.canUse, lic.status);
  const expiredSession = await read('ksh.session');

  // A1: edit the cached licence (paid until 2099, 50 stores, cache "fresh" forever)
  const cache = await read('ksh.license');
  cache.data.paid_until = '2099-01-01T00:00:00Z'; cache.data.store_limit = 50; cache.data.paid_store_limit = 50; cache.data.status = 'active';
  cache.fetchedAt = Date.now() + 365 * 86400000; cache.skew = 10 * 365 * 86400000;
  await store('ksh.license', cache);
  lic = await state(false);
  check('A1 edited licence cache (2099, 50 stores, future timestamp) is ignored', lic.status !== 'active' && !lic.canUse, `${lic.status} ${lic.storeLimit}`);
  cache.fetchedAt = Date.now(); cache.skew = 0; await store('ksh.license', cache);
  lic = await state(false);
  check('A1b edited licence with a normal timestamp is ignored too', !lic.canUse, lic.status);
  check('A1c worker refuses actions', (await pack())?.ok === false);

  // A2: edit the signed token's payload (paid until 2099), keep the signature
  const [h, p, sgn] = expiredSession.access_token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  payload.ksh.pu = 4070908800; payload.ksh.sl = 50;
  await store('ksh.session', { ...expiredSession, access_token: `${h}.${b64u(payload)}.${sgn}`, expires_at: Date.now() + 86400000 });
  lic = await state(false);
  check('A2 token with edited claims → rejected (bad signature)', lic.status === 'invalid' && !lic.canUse, lic.status);

  // A3: token signed with the attacker's own key
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const hh = b64u({ alg: 'ES256', typ: 'JWT', kid: 'mock-1' }), pp = b64u(payload);
  const own = crypto.sign('sha256', Buffer.from(`${hh}.${pp}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  await store('ksh.session', { ...expiredSession, access_token: `${hh}.${pp}.${own}`, expires_at: Date.now() + 86400000 });
  lic = await state(false);
  check('A3 token signed with another key → rejected', lic.status === 'invalid', lic.status);

  // A4: unsigned ("alg":"none") and HS256 with the public anon key
  await store('ksh.session', { ...expiredSession, access_token: `${b64u({ alg: 'none', typ: 'JWT' })}.${pp}.`, expires_at: Date.now() + 86400000 });
  check('A4 alg "none" → rejected', (await state(false)).status === 'invalid');
  const hs = b64u({ alg: 'HS256', typ: 'JWT' });
  const mac = crypto.createHmac('sha256', 'test-anon-key').update(`${hs}.${pp}`).digest('base64url');
  await store('ksh.session', { ...expiredSession, access_token: `${hs}.${pp}.${mac}`, expires_at: Date.now() + 86400000 });
  check('A4b HS256 signed with the public key → rejected', (await state(false)).status === 'invalid');

  // A5: replay the OLD genuine "paid" token, as if the network were blocked for days
  const oldClaims = JSON.parse(Buffer.from(genuine.access_token.split('.')[1], 'base64url').toString());
  const longAgo = Math.floor(Date.now() / 1000) - 5 * 86400;
  const replay = (await mock('/__sign', { ...oldClaims, iat: longAgo, exp: longAgo + 3600 })).jwt; // genuinely signed, 5 days old
  await store('ksh.session', { ...genuine, access_token: replay, expires_at: Date.now() + 86400000 });
  lic = await state(false);
  check('A5 genuine "paid" token kept alive by blocking the network → stops after the grace period', !lic.canUse && lic.status === 'offline', lic.status);
  const recent = Math.floor(Date.now() / 1000) - 600;
  await store('ksh.session', { ...genuine, access_token: (await mock('/__sign', { ...oldClaims, iat: recent, exp: recent + 3600 })).jwt, expires_at: Date.now() + 86400000 });
  check('A5b (control) a recent genuine token still works offline — honest users are not hurt', (await state(false)).canUse);

  // A6: clock turned back (token issued "in the future" for this computer)
  const future = Math.floor(Date.now() / 1000) + 86400;
  await store('ksh.session', { ...genuine, access_token: (await mock('/__sign', { ...oldClaims, iat: future, exp: future + 3600 })).jwt, expires_at: Date.now() + 86400000 });
  lic = await state(false);
  check('A6 computer clock turned back → blocked with a clear status', lic.status === 'clock' && !lic.canUse, lic.status);

  // A7: forged token sent to the SERVER is refused there too
  await store('ksh.session', { ...expiredSession, access_token: `${h}.${b64u(payload)}.${sgn}`, expires_at: Date.now() + 86400000 });
  lic = await state(true);
  check('A7 server refuses a forged token (logged out)', lic.status === 'loggedOut', lic.status);

  // A8: new e-mail on the same stores → no second free month
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:billingLogout' }));
  await login('fresh-email@example.kz');
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:sync' })).catch(() => {});
  lic = await state(true);
  check('A8 new e-mail on already-used stores → no trial', lic.status === 'expired' && lic.trialBlocked, `${lic.status} blocked=${lic.trialBlocked}`);
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#orders`); await sleep(1500);
  await d.keyboard.press('Escape');
  const txt = await d.locator('body').innerText();
  check('A8b the client is told why', txt.includes('Пробный период для подключённого магазина уже был использован'));
  const blocked = await sql("select trial_blocked from accounts where email = 'fresh-email@example.kz'");
  check('A8c recorded on the server', blocked[0]?.trial_blocked === true);

  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
