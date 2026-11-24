/**
 * Payment notifications → invoice paid, without the admin.
 *
 * URL: https://<project>.supabase.co/functions/v1/payment-webhook/<provider>
 * Every request must carry a valid signature of the provider; the database then decides (payment_received,
 * 028_payment_autoconfirm.sql): an invoice is confirmed only when it is pending and the amount matches exactly,
 * everything else lands in the admin's review queue. Retries of the same payment are harmless.
 *
 * Providers:
 *   generic — our own documented format, for tests and for any bridge we control:
 *       POST JSON { "event": "payment.paid", "payment_id": "…", "amount": 12000, "invoice_id": 123?, "phone": "+7…"? }
 *       headers  X-Timestamp: <unix seconds>,  X-Signature: hex(HMAC-SHA256(secret, `${timestamp}.${raw body}`))
 *       secret   PAYMENT_WEBHOOK_SECRET; a request older or newer than 5 minutes is refused (replay).
 *   aipay   — AiPay.kz (Kaspi Pay via the Cashier role). NOT CONNECTED YET: their API documentation could not be read
 *       when this was written, so the payload fields and the signature scheme are unknown. Fill parse() below from
 *       their docs (and add tests) before pointing their webhook here; until then it answers 501.
 *
 * Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (set by Supabase), PAYMENT_WEBHOOK_SECRET.
 * Answers: 200 handled (also for a duplicate or an ignored event), 401 bad signature, 400 bad payload,
 *          404 unknown provider, 501 provider not connected, 500 database error (the provider should retry).
 */

const MAX_BODY = 64 * 1024;
const MAX_SKEW_S = 300;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/** Constant-time comparison of two strings. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

/** Common checks of what a provider adapter extracted. */
function payment(p) {
  const id = String(p.payment_id ?? '').trim();
  if (!id || id.length > 128) throw new HttpError(400, 'bad_payment_id');
  if (!Number.isInteger(p.amount) || p.amount <= 0 || p.amount > 100_000_000) throw new HttpError(400, 'bad_amount');
  let invoice = null;
  if (p.invoice_id != null && p.invoice_id !== '') {
    invoice = Number(p.invoice_id);
    if (!Number.isSafeInteger(invoice) || invoice <= 0) throw new HttpError(400, 'bad_invoice_id');
  }
  const phone = p.phone == null ? null : String(p.phone).slice(0, 32);
  return { payment_id: id, amount: p.amount, invoice_id: invoice, phone };
}

export const PROVIDERS = {
  generic: {
    async parse(raw, headers, env, nowS) {
      const secret = env.PAYMENT_WEBHOOK_SECRET;
      if (!secret || secret.length < 32) throw new HttpError(500, 'secret_not_set');
      const ts = headers.get('x-timestamp') || '';
      const sig = (headers.get('x-signature') || '').toLowerCase();
      if (!/^\d{9,11}$/.test(ts) || Math.abs(nowS - Number(ts)) > MAX_SKEW_S) throw new HttpError(401, 'stale_or_missing_timestamp');
      if (!safeEqual(sig, await hmacHex(secret, `${ts}.${raw}`))) throw new HttpError(401, 'bad_signature');
      let body;
      try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'bad_json'); }
      if (!body || typeof body !== 'object') throw new HttpError(400, 'bad_json');
      if (body.event !== 'payment.paid') return null; // other events are acknowledged and ignored
      return payment(body);
    },
  },
  aipay: {
    async parse() {
      throw new HttpError(501, 'provider_not_connected');
    },
  },
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * @param {Request} req
 * @param {Record<string,string>} env
 * @param {typeof fetch} f
 * @param {{ nowS?: () => number }} [opts]
 */
export async function handle(req, env, f = fetch, { nowS = () => Math.floor(Date.now() / 1000) } = {}) {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    const name = new URL(req.url).pathname.split('/').filter(Boolean).pop() || '';
    const provider = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : null;
    if (!provider) throw new HttpError(404, 'unknown_provider');
    const raw = await req.text();
    if (raw.length > MAX_BODY) throw new HttpError(413, 'too_large');
    const p = await provider.parse(raw, req.headers, env, nowS());
    if (!p) return json(200, { ok: true, ignored: true });

    const res = await f(`${env.SUPABASE_URL}/rest/v1/rpc/payment_received`, {
      method: 'POST',
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_provider: name, p_payment_id: p.payment_id, p_amount: p.amount, p_invoice_id: p.invoice_id, p_phone: p.phone }),
    });
    const text = await res.text();
    if (!res.ok) {
      // our own validation refused it: retrying will not help
      if (text.includes('invalid_payment')) throw new HttpError(400, 'invalid_payment');
      throw new HttpError(500, 'database_error');
    }
    let out = {};
    try { out = JSON.parse(text) || {}; } catch { /* keep {} */ }
    return json(200, { ok: true, outcome: out.outcome ?? null, reason: out.reason ?? null, duplicate: !!out.duplicate });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    // never echo payload or secrets back
    return json(status, { ok: false, error: e instanceof HttpError ? e.code : 'internal_error' });
  }
}
