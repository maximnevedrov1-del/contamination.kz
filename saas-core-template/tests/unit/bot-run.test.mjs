// Telegram bot scheduled run: results recorded in chunks, batches fetched until done, time budget.
//   node tests/unit/bot-run.test.mjs
import assert from 'node:assert/strict';
const { run, handle, format, buttons, TEXTS } = await import('../../supabase/functions/telegram-bot/bot.js');

const env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', BOT_KEY: 'k', BOT_TOKEN: 't', TELEGRAM_API: 'https://tg.test' };
const item = (n) => ({ user_id: `u${n}`, chat_id: n, kind: 'care', key: 'w1', data: { name: 'A' } });

/** Fake database: bot_jobs returns up to `batch` items not yet recorded by bot_sent. */
function fake(total, batch) {
  const sent = new Set();
  const log = { jobs: 0, sentCalls: [], messages: 0 };
  const all = Array.from({ length: total }, (_, i) => item(i));
  const f = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url.endsWith('/rpc/bot_lock')) {
      log.locks = (log.locks || 0) + 1;
      const free = !log.holder || log.holder === body.p_holder;
      if (free) log.holder = body.p_holder;
      return new Response(JSON.stringify(free), { status: 200 });
    }
    if (url.endsWith('/rpc/enqueue_retention_nudges')) { log.enqueued = (log.enqueued || 0) + 1; return new Response('0', { status: 200 }); }
    if (url.endsWith('/rpc/bot_langs')) {
      log.langCalls = (log.langCalls || 0) + 1;
      // every third user chose Kazakh in the interface
      const users = Object.fromEntries((body.p_user_ids || []).map((u) => [u, Number(u.slice(1)) % 3 === 0 ? 'kk' : 'ru']));
      return new Response(JSON.stringify({ users, chats: {}, whats_new_kk: null }), { status: 200 });
    }
    if (url.endsWith('/rpc/bot_unlock')) {
      if (log.holder === body.p_holder) log.holder = null;
      return new Response('null', { status: 200 });
    }
    if (url.endsWith('/rpc/bot_jobs')) {
      log.jobs++;
      const items = all.filter((i) => !sent.has(i.user_id)).slice(0, batch ?? Infinity);
      return new Response(JSON.stringify({ items, ...(batch ? { batch } : {}) }), { status: 200 });
    }
    if (url.endsWith('/rpc/bot_sent')) {
      log.sentCalls.push(body.p_results.length);
      body.p_results.forEach((r) => sent.add(r.user_id));
      return new Response('1', { status: 200 });
    }
    log.messages++;
    (log.texts ||= []).push({ chat: body.chat_id, text: body.text, buttons: body.reply_markup });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { f, log };
}

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await t('results are recorded every chunk, all batches are fetched', async () => {
  const { f, log } = fake(130, 60);
  const r = await run(env, f, 0, { chunk: 50 });
  assert.equal(r.sent, 130);
  assert.equal(log.messages, 130);
  assert.deepEqual(log.sentCalls, [50, 10, 50, 10, 10]);
  assert.equal(r.more, false);
  assert.equal(log.enqueued, 1, 'nudges are queued once per run');
});
await t('enqueue failure does not break the run', async () => {
  const { f: inner } = fake(3, 10);
  const f = async (url, opts) => (url.endsWith('/rpc/enqueue_retention_nudges') ? new Response('{"message":"boom"}', { status: 500 }) : inner(url, opts));
  const r = await run(env, f, 0);
  assert.equal(r.sent, 3);
});
await t('old database without batch: one pass, as before', async () => {
  const { f, log } = fake(7);
  const r = await run(env, f, 0);
  assert.equal(r.sent, 7);
  assert.equal(log.jobs, 1);
});
await t('unknown kind / hostile text: acknowledged as skipped, never starves the queue, no crash', async () => {
  const items = [
    { user_id: 'x1', chat_id: 1, kind: 'mystery', key: '1', data: {} },
    { user_id: 'x2', chat_id: 2, kind: 'care', key: 'w', data: { name: '<b>&</b> > <' } },
    { user_id: 'x3', chat_id: 3, kind: 'referral', key: '3', data: null },
  ];
  const sent = new Map(); const msgs = [];
  const f = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url.endsWith('/rpc/bot_lock')) return new Response('true', { status: 200 });
    if (url.endsWith('/rpc/bot_unlock')) return new Response('null', { status: 200 });
    if (url.endsWith('/rpc/bot_langs')) return new Response('{"users":{},"chats":{}}', { status: 200 });
    if (url.endsWith('/rpc/enqueue_retention_nudges')) return new Response('0', { status: 200 });
    if (url.endsWith('/rpc/bot_jobs')) return new Response(JSON.stringify({ items: items.filter((i) => !sent.has(i.user_id)), batch: 300 }), { status: 200 });
    if (url.endsWith('/rpc/bot_sent')) { body.p_results.forEach((r) => sent.set(r.user_id, r)); return new Response('1', { status: 200 }); }
    msgs.push(body.text);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const r = await run(env, f, 0);
  assert.equal(sent.size, 3, 'every item acknowledged');
  assert.equal(sent.get('x1').ok, false);
  assert.equal(sent.get('x1').error, 'skipped_no_text');
  assert.equal(r.more, false);
  assert.ok(msgs.every((m) => typeof m === 'string' && m.length > 0));
});

await t('time budget: stops with more:true, what was sent is recorded', async () => {
  const { f, log } = fake(100, 300);
  let clock = 0;
  const r = await run(env, f, 0, { chunk: 50, budgetMs: 10, now: () => (clock += 1) });
  assert.equal(r.more, true);
  assert.ok(r.sent > 0 && r.sent < 100);
  assert.equal(log.sentCalls.reduce((a, b) => a + b, 0), r.sent); // nothing sent without a record
});

await t('two runs at once: the second is busy, every message goes once', async () => {
  const { f, log } = fake(20, 300);
  const [a, b] = await Promise.all([run(env, f, 1), run(env, f, 1)]);
  assert.equal(a.sent + b.sent, 20);
  assert.equal(log.messages, 20);
  assert.ok(a.busy !== b.busy);
  assert.equal(log.holder, null); // freed at the end
});
await t('lock is freed when the run fails', async () => {
  const { f, log } = fake(3, 300);
  const broken = (url, opts) => (url.endsWith('/rpc/bot_jobs') ? Promise.resolve(new Response('{"message":"db down"}', { status: 500 })) : f(url, opts));
  await assert.rejects(run(env, broken, 0), /db down/);
  assert.equal(log.holder, null);
  assert.equal((await run(env, f, 0)).sent, 3);
});

const hook = (body, secret = 'secret-secret-0123') => new Request('https://x.test/telegram-bot/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body });
const henv = { ...env, WEBHOOK_SECRET: 'secret-secret-0123' };
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
await t('webhook: wrong secret stays 401', async () => {
  assert.equal((await handle(hook('{}', 'bad'), henv, async () => new Response('{}'))).status, 401);
});
await t('webhook: invalid JSON and malformed update → 200 ok', async () => {
  for (const body of ['{not json', 'null', '[]']) {
    const r = await quiet(() => handle(hook(body), henv, async () => new Response('{}')));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  }
});
await t('webhook: RPC failure → 200 ok', async () => {
  const upd = JSON.stringify({ message: { chat: { id: 5 }, from: { id: 5 }, text: '/stop' } });
  const r = await quiet(() => handle(hook(upd), henv, async () => { throw new Error('rpc down'); }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

await t('bot replies: /start, /stop, help and order alerts in the client\'s language', async () => {
  const sentTexts = [];
  const mk = (chatLangs, linkOk = true) => async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (url.endsWith('/rpc/bot_langs')) return new Response(JSON.stringify({ users: {}, chats: chatLangs }), { status: 200 });
    if (url.endsWith('/rpc/bot_link')) return new Response(JSON.stringify(linkOk ? { ok: true, shops: ['Дүкен'], app_url: 'https://a.kz' } : { ok: false }), { status: 200 });
    if (url.endsWith('/rpc/bot_unlink')) return new Response('null', { status: 200 });
    if (url.endsWith('/rpc/alert_create')) return new Response(JSON.stringify({ chat_id: 9, code: '77', shop: 'S', minutes: 20, app_url: 'https://a.kz' }), { status: 200 });
    // no answer base (migration 032 not applied yet): the bot falls back to the short help
    if (url.includes('/rpc/')) return new Response('{"message":"function not found"}', { status: 404 });
    sentTexts.push(body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const msg = (text, extra = {}) => hook(JSON.stringify({ message: { chat: { id: 9, type: 'private' }, from: { id: 9, ...extra }, text } }));
  const token = 'a'.repeat(64);
  await handle(msg(`/start ${token}`), henv, mk({ 9: 'kk' }));
  assert.ok(sentTexts.at(-2).text.startsWith('✅ Хабарламалар сәтті қосылды'), sentTexts.at(-2).text);
  assert.equal(sentTexts.at(-2).reply_markup.inline_keyboard[0][0].text, TEXTS.kk.btnOrders);
  assert.equal(sentTexts.at(-1).text, TEXTS.kk.askPhone, 'after linking: asked to confirm the phone');
  assert.equal(sentTexts.at(-1).reply_markup.keyboard[0][0].request_contact, true);
  await handle(msg(`/start ${token}`), henv, mk({ 9: 'ru' }));
  assert.ok(sentTexts.at(-2).text.startsWith('✅ Уведомления успешно подключены'));
  await handle(msg(`/start ${token}`, { language_code: 'kk' }), henv, mk({}, false));
  assert.equal(sentTexts.at(-1).text, TEXTS.kk.linkExpired, 'expired link: Telegram app language');
  await handle(msg('/stop'), henv, mk({ 9: 'kk' }));
  assert.equal(sentTexts.at(-1).text, TEXTS.kk.unlinked);
  await handle(msg('hi', { language_code: 'ru' }), henv, mk({}));
  assert.equal(sentTexts.at(-1).text, TEXTS.ru.help, 'not linked: how to connect');
  await handle(msg('Салем', { language_code: 'ru' }), henv, mk({ 9: 'ru' }));
  assert.equal(sentTexts.at(-1).text, TEXTS.ru.linkedHelp, 'linked: told it works, not asked to connect');
  await handle(msg('Салем', { language_code: 'ru' }), henv, mk({ 9: 'kk' }));
  assert.equal(sentTexts.at(-1).text, TEXTS.kk.linkedHelp, 'linked Kazakh account: Kazakh, whatever the Telegram app language');
  await handle(msg('hi', { language_code: 'kk' }), henv, mk({}));
  assert.equal(sentTexts.at(-1).text, TEXTS.kk.help);
  const alertReq = new Request('https://fn.test/telegram-bot/alert', { method: 'POST', headers: { authorization: 'Bearer seller-token' }, body: JSON.stringify({ code: '77', shop: 'S', minutes: 20 }) });
  await handle(alertReq, henv, mk({ 9: 'kk' }));
  assert.equal(sentTexts.at(-1).text, TEXTS.kk.deadline('77', 'S', 20));
});
// ---------- language of the client's interface ----------
await t('each message in the language the client chose (every 3rd user: Kazakh)', async () => {
  const { f, log } = fake(6, 10);
  await run(env, f, 0);
  assert.equal(log.langCalls, 1, 'one language lookup per batch');
  const byChat = Object.fromEntries(log.texts.map((x) => [x.chat, x.text]));
  assert.equal(byChat[0], TEXTS.kk.care('A'));
  assert.equal(byChat[3], TEXTS.kk.care('A'));
  assert.equal(byChat[1], TEXTS.ru.care('A'));
  assert.ok(/кабинетке кірмегеніңізді/.test(byChat[0]) && /не заходили/.test(byChat[1]));
});
await t('language lookup fails → Russian, messages still sent', async () => {
  const { f: inner, log } = fake(2, 10);
  const f = async (url, opts) => (url.endsWith('/rpc/bot_langs') ? new Response('{"message":"down"}', { status: 500 }) : inner(url, opts));
  const r = await run(env, f, 0);
  assert.equal(r.sent, 2);
  assert.ok(log.texts.every((x) => x.text === TEXTS.ru.care('A')));
});
await t('every kind has Kazakh text, no Russian words leak into it', async () => {
  const items = [
    { kind: 'morning', data: { name: 'Әли', day: '2026-11-23', stats: { orders: 3, sum: 15000, shipped: 2, at_risk: [{ code: '123', shop: 'Дүкен' }] } } },
    { kind: 'morning', data: { day: '2026-11-23', stats: {} } },
    { kind: 'care', data: {} }, { kind: 'grace', data: { days_left: 3 } },
    { kind: 'winback30', data: { name: 'Ә', whats_new: 'x' } }, { kind: 'winback60', data: {} },
    { kind: 'referral', data: {} }, { kind: 'alert', data: { kind: 'cancelled', code: '1', shop: 'S' } },
    { kind: 'alert', data: { code: '1', shop: 'S', minutes: 21 } },
    ...['no_first_sync_24h', 'trial_ending_2d', 'trial_expired_winback'].map((key) => ({ kind: 'nudge', data: { key, text: 'русский текст из базы' } })),
  ];
  for (const it of items) {
    const kk = format(it, 'kk'), ru = format(it, 'ru');
    assert.ok(kk && ru && kk !== ru, it.kind);
    assert.ok(!/\b(Заказ|магазин|Здравствуйте|Доброе|подписк|минут[аы]?\b(?! қалды)|дней|отмен)/i.test(kk.replace(/минут қалды/, '')), `Russian in kk ${it.kind}: ${kk}`);
  }
  assert.equal(format({ kind: 'nudge', data: { key: 'unknown', text: 'из базы' } }, 'kk'), 'из базы', 'unknown nudge key keeps the queued text');
  assert.equal(format(items[2], 'xx'), format(items[2], 'ru'), 'unknown language → Russian');
  assert.deepEqual(buttons({ app_url: 'https://a.kz', support_url: 'https://t.me/s' }, 'orders', 'kk').inline_keyboard[0].map((b) => b.text), [TEXTS.kk.btnOrders, TEXTS.kk.btnSupport]);
});
await t('Kazakh «what\'s new» replaces the Russian one for Kazakh users', async () => {
  const { f: inner, log } = fake(0, 10);
  let served = false;
  const f = async (url, opts) => {
    if (url.endsWith('/rpc/bot_jobs')) {
      const items = served ? [] : [{ user_id: 'u3', chat_id: 3, kind: 'winback30', key: 'k', data: { name: 'A', whats_new: 'Жаңалық RU' } }, { user_id: 'u1', chat_id: 1, kind: 'winback30', key: 'k', data: { name: 'A', whats_new: 'Новое RU' } }];
      served = true;
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    if (url.endsWith('/rpc/bot_langs')) return new Response(JSON.stringify({ users: { u3: 'kk', u1: 'ru' }, chats: {}, whats_new_kk: 'Жаңа мүмкіндіктер' }), { status: 200 });
    return inner(url, opts);
  };
  await run(env, f, 0);
  const byChat = Object.fromEntries(log.texts.map((x) => [x.chat, x.text]));
  assert.ok(byChat[3].includes('Жаңа мүмкіндіктер') && byChat[3].startsWith('👋 Сәлеметсіз бе'));
  assert.ok(byChat[1].includes('Новое RU') && byChat[1].startsWith('👋 Здравствуйте'));
});


await t('phone confirmation: only the sender\'s own contact, only in a linked chat', async () => {
  const out = [];
  const calls = [];
  const mk = (chatLangs, verify = { ok: true, phone: '77015554433' }) => async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (url.endsWith('/rpc/bot_langs')) return new Response(JSON.stringify({ users: {}, chats: chatLangs }), { status: 200 });
    if (url.endsWith('/rpc/bot_verify_phone')) { calls.push(body); return new Response(JSON.stringify(verify), { status: 200 }); }
    out.push(body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const contact = (owner, phone = '+7 701 555 44 33') => hook(JSON.stringify({ message: { chat: { id: 9, type: 'private' }, from: { id: 9 }, contact: { user_id: owner, phone_number: phone } } }));
  await handle(contact(9), henv, mk({ 9: 'ru' }));
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].p_chat_id, calls[0].p_phone], [9, '+7 701 555 44 33']);
  assert.equal(out.at(-1).text, TEXTS.ru.phoneOk('+7 701 555 44 33'));
  assert.equal(out.at(-1).reply_markup.remove_keyboard, true);
  await handle(contact(12345), henv, mk({ 9: 'ru' }));
  assert.equal(calls.length, 1, 'someone else\'s contact is never sent to the database');
  assert.equal(out.at(-1).text, TEXTS.ru.phoneNotOwn);
  await handle(contact(9), henv, mk({}));
  assert.equal(calls.length, 1, 'not linked: nothing stored');
  assert.equal(out.at(-1).text, TEXTS.ru.phoneNotLinked);
  await handle(contact(9, '+1 202 555 0100'), henv, mk({ 9: 'kk' }, { ok: false, error: 'invalid_phone' }));
  assert.equal(out.at(-1).text, TEXTS.kk.phoneBad);
  await handle(hook(JSON.stringify({ message: { chat: { id: 9, type: 'private' }, from: { id: 9 }, text: '/phone' } })), henv, mk({ 9: 'kk' }));
  assert.equal(out.at(-1).text, TEXTS.kk.askPhone);
  assert.equal(out.at(-1).reply_markup.keyboard[0][0].text, TEXTS.kk.btnSharePhone);
});
console.log(`\n${n} passed`);
