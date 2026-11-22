// Support without the owner at the computer: notice for every client, questions with the report
// attached, answers back in the extension, API health counts, Telegram digest (tools/ops-alert.mjs).
// Uses ../billcopy (mock Supabase on :8098 with the REAL 001+002+003 SQL, mock Kaspi on :8099).
const { chromium } = require('playwright'); require('./offline');
const path = require('path');
const http = require('http');
const { Client } = require('pg');
const EXT = path.join(__dirname, '../billcopy');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = new Client({ host: '/tmp', port: 5499, user: 'postgres', database: 'billing' });
  await db.connect();
  const q = async (sql, a) => (await db.query(sql, a)).rows;
  await fetch('http://localhost:8099/__down?on=0');
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'supprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const url = (r) => `chrome-extension://${id}/dashboard/dashboard.html#${r}`;

  // 1. owner publishes a notice in the admin page
  const a = await ctx.newPage(); a.on('pageerror', (e) => errs.push('[admin] ' + e.message));
  a.on('dialog', (dlg) => dlg.accept(dlg.type() === 'prompt' ? 'Мой шаблон' : undefined));
  await a.goto(`file://${EXT}/billing/admin/index.html`);
  await a.fill('#url', 'http://localhost:8098'); await a.fill('#key', 'test-anon-key'); await a.click('#saveConn');
  await a.fill('#email', 'owner@example.kz'); await a.click('#sendCode'); await a.waitForSelector('#codeRow:not([hidden])');
  await a.fill('#code', '123456'); await a.click('#verify');
  await a.waitForSelector('#app:not([hidden])', { timeout: 15000 }); await sleep(800);
  await a.click('[data-tab=status]'); await a.waitForSelector('[data-action=status-publish]');
  await a.selectOption('#panel select >> nth=0', 'warn');
  await a.fill('#panel input[maxlength="300"]', 'Kaspi отвечает с ошибками, чиним');
  await a.click('[data-action=status-publish]'); await sleep(800);
  check('1 notice stored', (await q('select level, message from service_status'))[0]?.message === 'Kaspi отвечает с ошибками, чиним');

  // 2. seller opens the extension (not signed in yet): the notice is already there
  const d = await ctx.newPage(); d.on('pageerror', (e) => errs.push(e.message));
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  await d.goto(url('help'));
  await d.evaluate(() => { ['home', 'orders', 'settings', 'account', 'help'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  await d.reload(); await sleep(1500);
  check('2 notice banner for everyone, even before login', (await d.locator('[data-banner=service]').innerText().catch(() => '')).includes('Kaspi отвечает с ошибками'));
  check('2 not signed in: no question form', (await d.locator('[data-field=ticketText]').count()) === 0);

  // seller signs in and connects a store (API calls → health counts)
  await d.goto(url('account')); await d.reload();
  await d.waitForSelector('input[type=email]');
  await d.fill('input[type=email]', 'seller@example.kz'); await d.check('label.consent input'); await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  await d.waitForSelector('.badge:has-text("Пробный период")', { timeout: 15000 });
  await msg('ui:connectApi', { shopId: null, name: 'Магазин А', token: 'GOOD-TOKEN-1234' }); await sleep(4000);

  // 3. a question from «Помощь» with the report
  await d.goto(url('help')); await d.reload(); await sleep(1500);
  const short = await msg('ui:ticketSend', { topic: 'print', message: 'а' });
  check('3 too short refused', short?.error === 'ticketTooShort', JSON.stringify(short));
  await d.selectOption('[data-field=ticketTopic]', 'print');
  await d.fill('[data-field=ticketText]', 'Принтер печатает накладную на весь лист A4');
  await d.click('[data-action=ticket-send]'); await sleep(1500);
  const t = (await q("select * from support_tickets where email='seller@example.kz'"))[0];
  check('3 question stored with topic and the technical report', t?.topic === 'print' && /Версия/.test(t?.report || ''), JSON.stringify(t)?.slice(0, 300));
  check('3 report has no token and no buyer data', t && !/GOOD-TOKEN|SECRET NAME|7000000000/.test(t.report));
  check('3 listed under «Мои вопросы» as waiting', (await d.locator('[data-block=tickets]').innerText().catch(() => '')).includes('Ждёт ответа'));

  // 4. owner answers with a template
  await a.click('[data-tab=tickets]'); await a.waitForSelector(`[data-ticket="${t.id}"]`);
  const box = a.locator(`[data-ticket="${t.id}"]`);
  check('4 admin sees e-mail, text and the report', (await box.innerText()).includes('seller@example.kz') && (await box.innerText()).includes('весь лист A4') && (await box.locator('details pre').count()) === 1);
  check('4 open-questions counter on the tab', (await a.locator('#ticketCount').innerText()) === '1');
  await box.locator('select').selectOption({ label: 'Принтер' });
  check('4 template fills the answer', (await box.locator('textarea').inputValue()).includes('Пробная печать'));
  await box.locator('[data-action=reply]').click(); await sleep(1000);
  check('4 answer stored', (await q('select status, reply from support_tickets where id=$1', [t.id]))[0]?.status === 'answered');

  // 5. the 15-minute alarm: health counts are sent, the answer is fetched
  await sw.evaluate(() => chrome.alarms.create('ksh-health', { when: Date.now() + 100 })); await sleep(2500);
  const hrow = (await q("select ok, fail, kinds from api_health h join auth.users u on u.id = h.user_id where u.email='seller@example.kz'"))[0];
  check('5 API counts reached the server (only numbers)', hrow && hrow.ok > 0, JSON.stringify(hrow));
  const stored = await d.evaluate(async () => (await chrome.storage.local.get('ksh.tickets'))['ksh.tickets']);
  check('5 answer fetched by the alarm', stored?.list?.[0]?.unread === true && /Пробная печать/.test(stored.list[0].reply || ''), JSON.stringify(stored)?.slice(0, 200));
  await d.goto(url('home')); await d.reload(); await sleep(1500);
  check('5 home: «Поддержка ответила»', (await d.locator('.todo').innerText().catch(() => '')).includes('Поддержка ответила'));
  check('5 menu badge on «Помощь»', (await d.locator('[data-count=help]').innerText()) === '1');

  // 6. seller reads and closes
  await d.goto(url('help')); await sleep(1500);
  const det = d.locator(`[data-ticket="${t.id}"]`);
  check('6 answer shown and opened', (await det.innerText()).includes('Пробная печать') && (await det.getAttribute('open')) !== null);
  await sleep(1000);
  check('6 marked read on the server', (await q('select seen_at from support_tickets where id=$1', [t.id]))[0]?.seen_at != null);
  await det.locator('[data-action=ticket-close]').click(); await sleep(1000);
  check('6 «Вопрос решён» closes it', (await q('select status from support_tickets where id=$1', [t.id]))[0]?.status === 'closed');
  check('6 badge gone', (await d.locator('[data-count=help]').innerText()) === '');

  // 7. Kaspi down → failures counted by kind
  await fetch('http://localhost:8099/__down?on=1');
  await msg('ui:sync'); await sleep(9000);
  await sw.evaluate(() => chrome.alarms.create('ksh-health', { when: Date.now() + 100 })); await sleep(2500);
  await fetch('http://localhost:8099/__down?on=0');
  const h2 = (await q("select fail, kinds from api_health h join auth.users u on u.id = h.user_id where u.email='seller@example.kz'"))[0];
  check('7 Kaspi 502 counted as «server»', h2?.kinds?.server > 0, JSON.stringify(h2));

  // 8. admin: health table, Telegram key, digest → Telegram
  await a.click('[data-tab=status]'); await a.waitForSelector('[data-action=ops-key]');
  check('8 admin sees Kaspi in the health table', (await a.locator('tr[data-market=kaspi]').count()) === 1);
  await a.click('[data-action=ops-key]'); await a.waitForSelector('[data-field=ops-key]');
  const key = await a.locator('[data-field=ops-key]').innerText();
  check('8 key shown once, only its hash stored', /^[0-9a-f]{64}$/.test(key) && (await q('select key_hash from ops_settings'))[0]?.key_hash !== key);
  // two more sellers fail at the same time (other computers)
  await q("insert into auth.users (id, email) values ('f0000000-0000-0000-0000-000000000001', 'x1@example.kz'), ('f0000000-0000-0000-0000-000000000002', 'x2@example.kz')");
  await q("insert into api_health (bucket, user_id, market, ok, fail, kinds) values (date_trunc('hour', now()), 'f0000000-0000-0000-0000-000000000001', 'kaspi', 0, 9, '{\"server\": 9}'), (date_trunc('hour', now()), 'f0000000-0000-0000-0000-000000000002', 'kaspi', 1, 7, '{\"network\": 7}')");
  await q("update api_health set ok = 1 where user_id = (select id from auth.users where email='seller@example.kz')");
  const sent = [];
  const tg = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { sent.push({ url: req.url, body: JSON.parse(b) }); res.end('{"ok":true}'); }); }).listen(8097);
  const { run } = await import(path.join(__dirname, '../../tools/ops-alert.mjs'));
  const env = { SUPABASE_URL: 'http://localhost:8098', SUPABASE_ANON_KEY: 'test-anon-key', SUPABASE_SERVICE_ROLE_KEY: 'test-anon-key', OPS_KEY: key, TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42', TELEGRAM_API: 'http://localhost:8097' };
  await q('update ops_settings set last_digest_at = now() - interval \'1 hour\'');
  await run(env, () => {});
  const text = sent[0]?.body?.text || '';
  check('8 Telegram: outage alert', /СБОЙ Kaspi: ошибки у 3 из 3/.test(text), text);
  check('8 Telegram: new question counted, no client e-mails', /Новых вопросов: 1/.test(text) && !/@/.test(text), text);
  check('8 bot token only in the URL path, chat id passed', sent[0]?.url === '/bot123:abc/sendMessage' && sent[0]?.body?.chat_id === '42');
  await run(env, () => {});
  check('8 no repeated message 10 minutes later', sent.length === 1, String(sent.length));
  const bad = await run({ ...env, OPS_KEY: 'x'.repeat(64) }, () => {}).catch((e) => e.message);
  check('8 wrong key refused', /bad_key/.test(bad), bad);
  tg.close();

  // 9. notice removed → banner gone
  await a.click('[data-tab=status]'); await a.waitForSelector('[data-action=status-clear]');
  await a.click('[data-action=status-clear]'); await sleep(800);
  await d.evaluate(() => chrome.storage.session.remove('ksh.serviceStatus'));
  await d.reload(); await sleep(1500);
  check('9 notice removed → no banner', (await d.locator('[data-banner=service]').count()) === 0);
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await db.end();
  await ctx.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
