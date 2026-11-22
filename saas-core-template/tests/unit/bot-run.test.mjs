// Telegram bot scheduled run: results recorded in chunks, batches fetched until done, time budget.
//   node tests/unit/bot-run.test.mjs
import assert from 'node:assert/strict';
const { run, handle } = await import('../../supabase/functions/telegram-bot/bot.js');

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

console.log(`\n${n} passed`);
