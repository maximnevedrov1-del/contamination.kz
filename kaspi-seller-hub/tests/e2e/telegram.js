// The seller's Telegram bot (billing/supabase/functions/telegram-bot/bot.js) against the real SQL
// (mock Supabase :8098) and a mock Telegram API: link by a one-time /start token, morning digest
// at 09:00 with the template and inline buttons, a deadline alert with the seller's token, care
// message, a blocked bot (403) recorded and skipped, secrets checked on every route.
const path = require('path');
const http = require('http');
const { Client } = require('pg');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const SUPA = 'http://localhost:8098';
const BOT_KEY = 'bot-key-0123456789abcdef0123456789abcdef';

(async () => {
  const { handle, format } = await import(path.join(__dirname, '../../billing/supabase/functions/telegram-bot/bot.js'));
  const db = new Client({ host: '/tmp', port: 5499, user: 'postgres', database: 'billing' });
  await db.connect();
  const q = async (sql, a) => (await db.query(sql, a)).rows;
  // Telegram mock: records messages; chat 999 has blocked the bot
  const sent = [];
  const tgSrv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const body = JSON.parse(b || '{}'); sent.push({ method: req.url.split('/').pop(), token: req.url.split('/')[1], ...body });
    if (body.chat_id === 999) { res.writeHead(403); return res.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' })); }
    res.end(JSON.stringify({ ok: true, result: {} }));
  }); }).listen(8095);
  const env = { SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: 'test-anon-key', BOT_TOKEN: '123:abc', BOT_KEY, WEBHOOK_SECRET: 'webhook-secret-0123456789', TELEGRAM_API: 'http://localhost:8095' };
  const call = (route, body, headers = {}) => handle(new Request(`${SUPA}/functions/v1/telegram-bot/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env).then(async (r) => ({ status: r.status, body: await r.json() }));
  const login = async (email) => {
    await fetch(`${SUPA}/auth/v1/otp`, { method: 'POST', headers: { apikey: 'test-anon-key', 'content-type': 'application/json' }, body: JSON.stringify({ email, create_user: true }) });
    const s = await (await fetch(`${SUPA}/auth/v1/verify`, { method: 'POST', headers: { apikey: 'test-anon-key', 'content-type': 'application/json' }, body: JSON.stringify({ type: 'email', email, token: '123456' }) })).json();
    return s.access_token;
  };
  const rpc = async (token, fn, args = {}) => { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: 'test-anon-key', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

  // owner sets the bot up (admin page does this)
  await q("update ops_settings set bot_key_hash = encode(sha256(convert_to($1, 'utf8')), 'hex')", [BOT_KEY]);
  await q("update billing_config set bot_username = 'SellerHubBot', app_url = 'https://sellerhub.example.kz', support_url = 'https://t.me/sellerhub_support'");

  // a paying seller
  const tok = await login('alisher@example.kz');
  await rpc(tok, 'accept_terms');
  await q("update accounts set paid_until = now() + interval '20 days' where email = 'alisher@example.kz'");
  await rpc(tok, 'digest_report', { p_day: new Date(Date.now() + 5 * 3600000 - 86400000).toISOString().slice(0, 10), p_stats: { orders: 24, sum: 412000, shipped: 22, at_risk: [{ code: '777001', shop: 'Магазин А', minutes: 40 }, { code: '777002', shop: 'Магазин Б', minutes: -10 }], shops: ['Магазин А', 'Магазин Б'] } });

  // 1. «Подключить Telegram» → /start <token>
  const link = await rpc(tok, 'tg_link_create');
  const token = link.url.split('=')[1];
  check('1 link to the bot with a one-time token', /^https:\/\/t\.me\/SellerHubBot\?start=[0-9a-f]{64}$/.test(link.url), link.url);
  const bad = await call('webhook', { message: { chat: { id: 4242, type: 'private' }, from: { first_name: 'Алишер' }, text: `/start ${token}` } }, { 'x-telegram-bot-api-secret-token': 'wrong-secret-0123456789' });
  check('1 webhook without the secret refused', bad.status === 401 && sent.length === 0);
  await call('webhook', { message: { chat: { id: 4242, type: 'private' }, from: { first_name: 'Алишер' }, text: `/start ${token}` } }, { 'x-telegram-bot-api-secret-token': env.WEBHOOK_SECRET });
  check('1 confirmation names the stores', /Уведомления успешно подключены для магазинов Магазин А, Магазин Б!/.test(sent[0]?.text || ''), sent[0]?.text);
  check('1 bot token only in the URL path', sent[0]?.token === 'bot123:abc');
  check('1 database: chat linked with the name', (await q("select chat_id, tg_name from tg_links"))[0]?.tg_name === 'Алишер');
  await call('webhook', { message: { chat: { id: 5555, type: 'private' }, from: { first_name: 'Чужой' }, text: `/start ${token}` } }, { 'x-telegram-bot-api-secret-token': env.WEBHOOK_SECRET });
  check('1 the same link again → «ссылка устарела»', /Ссылка устарела/.test(sent[1]?.text || '') && (await q('select count(*)::int n from tg_links'))[0].n === 1);

  // 2. 09:00: morning digest
  const noKey = await call('run', {}, { 'x-bot-key': 'x'.repeat(40) });
  check('2 run without the bot key refused', noKey.status === 401);
  sent.length = 0;
  const run1 = await call('run', {}, { 'x-bot-key': BOT_KEY });
  const m = sent.find((x) => x.chat_id === 4242);
  check('2 digest sent', run1.body.sent >= 1 && !!m, JSON.stringify(run1.body));
  check('2 template: greeting, orders and sum, shipped, at risk', /☀️ Доброе утро, Алишер!/.test(m?.text) && /📦 Заказов оформлено: 24 \(на сумму 412 000 ₸\)/.test(m?.text) && /🚚 Успешно отправлено: 22/.test(m?.text) && /⚠️ Требуют внимания: 2 заказа — .*№777001 \(Магазин А\)/.test(m?.text), m?.text);
  const kb = m?.reply_markup?.inline_keyboard?.[0] || [];
  check('2 inline buttons: orders (deep link) and support', kb[0]?.text === '📦 Посмотреть заказы' && kb[0]?.url === 'https://sellerhub.example.kz/open#orders' && kb[1]?.text === '💬 Поддержка' && kb[1]?.url === 'https://t.me/sellerhub_support', JSON.stringify(kb));
  sent.length = 0;
  await call('run', {}, { 'x-bot-key': BOT_KEY });
  check('2 not sent twice the same day', !sent.some((x) => /Доброе утро/.test(x.text)));

  // 3. deadline alert with the seller's token
  const noAuth = await call('alert', { code: '777003', shop: 'Магазин А', minutes: 15 });
  check('3 alert without a seller token refused', noAuth.status === 401);
  sent.length = 0;
  const a1 = await call('alert', { code: '777003', shop: 'Магазин А', minutes: 15 }, { authorization: `Bearer ${tok}` });
  check('3 alert text', a1.body.sent && sent[0]?.text === '🚨 Внимание! Заказ №777003 в магазине Магазин А под угрозой просрочки. Осталось 15 минут до отмены!', sent[0]?.text);
  const a2 = await call('alert', { code: '777003', shop: 'Магазин А', minutes: 5 }, { authorization: `Bearer ${tok}` });
  check('3 one alert per order', a2.body.sent === false && sent.length === 1);
  await rpc(tok, 'tg_settings', { p_digest: null, p_alerts: false });
  const a3 = await call('alert', { code: '777004', shop: 'Магазин А', minutes: 15 }, { authorization: `Bearer ${tok}` });
  check('3 alerts switched off by the seller → nothing sent', a3.body.sent === false && sent.length === 1);
  await rpc(tok, 'tg_settings', { p_digest: null, p_alerts: true });

  // 4. care message after 6 days; a seller who blocked the bot
  await q("insert into user_progress (user_id, last_active_at) select id, now() - interval '7 days' from auth.users where email = 'alisher@example.kz' on conflict (user_id) do update set last_active_at = excluded.last_active_at");
  const tok2 = await login('blocked@example.kz');
  await rpc(tok2, 'accept_terms');
  await q("update accounts set paid_until = now() + interval '20 days' where email = 'blocked@example.kz'");
  await q("insert into user_progress (user_id, last_active_at) select id, now() - interval '8 days' from auth.users where email = 'blocked@example.kz'");
  const link2 = await rpc(tok2, 'tg_link_create');
  await call('webhook', { message: { chat: { id: 999, type: 'private' }, from: { first_name: 'Б' }, text: `/start ${link2.url.split('=')[1]}` } }, { 'x-telegram-bot-api-secret-token': env.WEBHOOK_SECRET });
  sent.length = 0;
  const run2 = await call('run', {}, { 'x-bot-key': BOT_KEY });
  check('4 care: «мы заметили, что вы пару дней не заходили»', sent.some((x) => x.chat_id === 4242 && /Алишер, мы заметили, что вы пару дней не заходили в кабинет/.test(x.text)), JSON.stringify(sent.map((x) => x.text)));
  check('4 blocked bot: run goes on, counted as blocked', run2.body.blocked === 1, JSON.stringify(run2.body));
  const bl = (await q("select l.blocked_at, s.error from tg_links l join tg_sent s using (user_id) where l.chat_id = 999"))[0];
  check('4 blocked recorded with the Telegram error', bl?.blocked_at && /blocked by the user/.test(bl.error || ''), JSON.stringify(bl));
  sent.length = 0;
  await q("delete from tg_sent where kind = 'care'");
  await call('run', {}, { 'x-bot-key': BOT_KEY });
  check('4 nothing more to the blocked chat', !sent.some((x) => x.chat_id === 999));
  // the seller unblocks and kicks again via my_chat_member, /stop
  await call('webhook', { message: { chat: { id: 4242, type: 'private' }, text: '/stop' } }, { 'x-telegram-bot-api-secret-token': env.WEBHOOK_SECRET });
  check('4 /stop unlinks', (await q('select count(*)::int n from tg_links where chat_id = 4242'))[0].n === 0);

  // 5. texts of the other messages
  check('5 grace text', /Кабинет работает ещё 3 дня/.test(format({ kind: 'grace', data: { days_left: 3 } })));
  check('5 win-back 60 text', /скидкой 50 % на первый месяц.*магазины сохранены в архиве/.test(format({ kind: 'winback60', data: { pct: 50 } })));
  check('5 digest when Chrome was closed early says how fresh', /По данным на 18:00/.test(format({ kind: 'morning', data: { day: '2026-11-17', as_of: '2026-11-17T13:00:00Z', stats: { orders: 1, sum: 1000, shipped: 0, at_risk: [] } } })));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  tgSrv.close(); await db.end();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.stack); process.exit(1); });
