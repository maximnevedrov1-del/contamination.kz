// Payment webhook (billing/supabase/functions/payment-webhook/handler.js): signature, replay window, payload
// checks, what is sent to the database and how its answers map to HTTP codes.
//   node tests/unit/payment-webhook.test.mjs
// With PGHOST/PGPORT/PGUSER and a database PAYDB that has 001…028 applied, it also runs against the real SQL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { handle, hmacHex, safeEqual } from '../../billing/supabase/functions/payment-webhook/handler.js';

const SECRET = 's'.repeat(40);
const NOW = 1_800_000_000;
const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', PAYMENT_WEBHOOK_SECRET: SECRET };
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

async function signed(body, { ts = NOW, secret = SECRET, provider = 'generic', sig } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const s = sig ?? (await hmacHex(secret, `${ts}.${raw}`));
  return new Request(`https://p.supabase.co/functions/v1/payment-webhook/${provider}`, {
    method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Timestamp': String(ts), 'X-Signature': s },
  });
}
function db(answer = [200, { outcome: 'confirmed', reason: null, invoice_id: 5, duplicate: false }]) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const [status, body] = answer;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { f, calls };
}
const run = (req, f, now = NOW) => handle(req, env, f, { nowS: () => now });
const PAID = { event: 'payment.paid', payment_id: 'pay_1', amount: 12000, invoice_id: 5, phone: '+7 701 111 11 11' };

await t('valid signed payment → payment_received with service role, 200 confirmed', async () => {
  const { f, calls } = db();
  const res = await run(await signed(PAID), f);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, outcome: 'confirmed', reason: null, duplicate: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://p.supabase.co/rest/v1/rpc/payment_received');
  assert.equal(calls[0].headers.Authorization, 'Bearer service-key');
  assert.deepEqual(calls[0].body, { p_provider: 'generic', p_payment_id: 'pay_1', p_amount: 12000, p_invoice_id: 5, p_phone: '+7 701 111 11 11' });
});
await t('review outcome is passed through', async () => {
  const { f } = db([200, { outcome: 'review', reason: 'amount_mismatch', invoice_id: 5, duplicate: false }]);
  assert.deepEqual(await (await run(await signed(PAID), f)).json(), { ok: true, outcome: 'review', reason: 'amount_mismatch', duplicate: false });
});
await t('wrong secret / tampered body / missing signature → 401, database not called', async () => {
  const { f, calls } = db();
  assert.equal((await run(await signed(PAID, { secret: 'x'.repeat(40) }), f)).status, 401);
  const req = await signed(PAID);
  const tampered = new Request(req.url, { method: 'POST', body: JSON.stringify({ ...PAID, amount: 1 }), headers: req.headers });
  assert.equal((await run(tampered, f)).status, 401);
  assert.equal((await run(await signed(PAID, { sig: '' }), f)).status, 401);
  assert.equal(calls.length, 0);
});
await t('timestamp older or newer than 5 minutes → 401 (replay)', async () => {
  const { f, calls } = db();
  assert.equal((await run(await signed(PAID, { ts: NOW - 301 }), f)).status, 401);
  assert.equal((await run(await signed(PAID, { ts: NOW + 301 }), f)).status, 401);
  assert.equal((await run(await signed(PAID, { ts: NOW - 299 }), f)).status, 200);
  assert.equal(calls.length, 1);
});
await t('bad payloads → 400', async () => {
  const { f, calls } = db();
  for (const body of [{ ...PAID, amount: 120.5 }, { ...PAID, amount: '12000' }, { ...PAID, amount: 0 }, { ...PAID, payment_id: '' }, { ...PAID, payment_id: 'x'.repeat(129) }, { ...PAID, invoice_id: 'abc' }, { ...PAID, invoice_id: -3 }]) {
    assert.equal((await run(await signed(body), f)).status, 400, JSON.stringify(body));
  }
  assert.equal((await run(await signed('not json'), f)).status, 400);
  assert.equal(calls.length, 0);
});
await t('other events are acknowledged and ignored', async () => {
  const { f, calls } = db();
  const res = await run(await signed({ event: 'payment.created', payment_id: 'p', amount: 1 }), f);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, ignored: true });
  assert.equal(calls.length, 0);
});
await t('unknown provider → 404; aipay not connected yet → 501; GET → 405', async () => {
  const { f, calls } = db();
  assert.equal((await run(await signed(PAID, { provider: 'evil' }), f)).status, 404);
  assert.equal((await run(await signed(PAID, { provider: '__proto__' }), f)).status, 404);
  assert.equal((await run(await signed(PAID, { provider: 'aipay' }), f)).status, 501);
  assert.equal((await run(new Request('https://p.supabase.co/functions/v1/payment-webhook/generic'), f)).status, 405);
  assert.equal(calls.length, 0);
});
await t('secret missing or short → 500, nothing accepted', async () => {
  const { f, calls } = db();
  const res = await handle(await signed(PAID), { ...env, PAYMENT_WEBHOOK_SECRET: 'short' }, f, { nowS: () => NOW });
  assert.equal(res.status, 500);
  assert.equal(calls.length, 0);
});
await t('database down → 500 (provider retries); our validation refusal → 400', async () => {
  assert.equal((await run(await signed(PAID), db([503, 'upstream']).f)).status, 500);
  assert.equal((await run(await signed(PAID), db([400, { message: 'invalid_payment' }]).f)).status, 400);
  const res = await run(await signed(PAID), async () => { throw new TypeError('fetch failed'); });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: 'internal_error' });
});
await t('body over 64 KB → 413', async () => {
  const { f } = db();
  assert.equal((await run(await signed({ ...PAID, pad: 'x'.repeat(70000) }), f)).status, 413);
});
await t('safeEqual', async () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(null, 'a'), false);
});

// ---------- against the real SQL (optional) ----------
if (process.env.PGHOST && process.env.PAYDB) {
  const psql = (sql) => execFileSync('psql', ['-d', process.env.PAYDB, '-Atq', '-c', sql], { encoding: 'utf8' }).trim();
  psql(`insert into auth.users (id, email) values ('c0000000-0000-0000-0000-000000000001', 'wh@example.kz') on conflict do nothing;
        insert into public.accounts (user_id, trial_ends_at) values ('c0000000-0000-0000-0000-000000000001', now()) on conflict do nothing;
        insert into public.invoices (id, user_id, kind, stores, months, amount, phone, status) overriding system value
        values (7701, 'c0000000-0000-0000-0000-000000000001', 'manual', 2, 1, 9000, '77017777777', 'pending') on conflict do nothing;`);
  // the "database" is psql as service_role running exactly what PostgREST would run
  const real = async (url, opts) => {
    const b = JSON.parse(opts.body);
    const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
    try {
      const out = psql(`set role service_role; select payment_received(${q(b.p_provider)}, ${q(b.p_payment_id)}, ${b.p_amount}, ${b.p_invoice_id ?? 'null'}, ${q(b.p_phone)});`);
      return new Response(out.split('\n').pop(), { status: 200 });
    } catch (e) { return new Response(JSON.stringify({ message: String(e.stderr || e.message) }), { status: 400 }); }
  };
  await t('real SQL: phone + amount → invoice paid; retry → duplicate', async () => {
    const body = { event: 'payment.paid', payment_id: 'real_1', amount: 9000, phone: '8 701 777 77 77' };
    assert.deepEqual(await (await run(await signed(body), real)).json(), { ok: true, outcome: 'confirmed', reason: null, duplicate: false });
    assert.equal(psql('select status from invoices where id = 7701'), 'paid');
    assert.deepEqual(await (await run(await signed(body), real)).json(), { ok: true, outcome: 'confirmed', reason: null, duplicate: true });
    assert.equal(psql("select count(*) from payment_events where payment_id = 'real_1'"), '1');
  });
} else {
  console.log('skip real SQL part (set PGHOST and PAYDB)');
}
console.log(`\n${n} passed`);
