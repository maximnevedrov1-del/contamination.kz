// Telegram bot scheduled run: results recorded in chunks, batches fetched until done, time budget.
//   node tests/unit/bot-run.test.mjs
import assert from 'node:assert/strict';
const { run } = await import('../../billing/supabase/functions/telegram-bot/bot.js');

const env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', BOT_KEY: 'k', BOT_TOKEN: 't', TELEGRAM_API: 'https://tg.test' };
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

console.log(`\n${n} passed`);
