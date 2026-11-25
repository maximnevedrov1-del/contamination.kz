/**
 * SaudaPulse — stateless Zero-Knowledge relay: phone browser → Kaspi Shop API.
 *
 * Why: a phone browser may not call kaspi.kz directly (Kaspi sends no CORS headers), the Chrome
 * extension can. This relay forwards ONE request and forgets it.
 *
 * Guarantees (each one covered by tests/unit/kaspi-relay.test.mjs):
 *   - Allowlist: only https://kaspi.kz/shop/api/v2/… and https://kaspi.kz/shop/api/products/…,
 *     methods GET and POST. Anything else → 403, nothing is fetched.
 *   - Zero persistence: no database client, no storage, no cache, no queue. This file never
 *     calls console.* — nothing about a request (URL, body, Kaspi token, user) is written to
 *     the function logs. The Kaspi target, the Kaspi token and the body travel INSIDE the POST
 *     body (never in the URL or in headers), so even the platform's request log (method, path,
 *     status, time) holds only «POST /functions/v1/kaspi-relay 200».
 *   - Only signed-in SaudaPulse users: a Supabase access token (ES256, checked against the
 *     project's PUBLIC keys, audience «authenticated», not expired) is required. The anon key
 *     alone is refused.
 *   - Rate limit per user (in memory of this instance only; nothing stored).
 *   - Redirects are never followed (a 3xx could carry the token elsewhere) → 502.
 *   - Kaspi's answer is passed back as is (status, body, Content-Type, Retry-After) with
 *     Cache-Control: no-store; Set-Cookie and every other upstream header are dropped.
 *
 * Request (from shared/kaspi-relay-client.js):
 *   POST <relay>  Authorization: Bearer <Supabase access token>   apikey: <anon key>
 *   body: { "url": "https://kaspi.kz/shop/api/v2/orders?…", "method": "GET"|"POST",
 *           "token": "<Kaspi X-Auth-Token>", "accept": "…", "contentType": "…", "body": "<string>"|null }
 * Relay's own refusals carry the header X-Relay-Error: <code> and a JSON body { relayError }.
 */
import { createLicenseVerifier } from './license-signature.js';

export const ALLOWED_HOST = 'kaspi.kz';
export const ALLOWED_PATHS = ['/shop/api/v2/', '/shop/api/products/'];
const METHODS = new Set(['GET', 'POST']);
const MAX_ENVELOPE = 6 * 1024 * 1024; // card uploads can be a few MB
const UPSTREAM_TIMEOUT_MS = 30000;
const TOKEN_RE = /^[A-Za-z0-9+/=_.\-]{8,512}$/;
const MEDIA_RE = /^[\w.+\-]+\/[\w.+\-*]+(\s*;\s*[\w\-]+=[\w.\-"]+)*(\s*,\s*[\w.+\-*]+\/[\w.+\-*]+(\s*;\s*[\w\-]+=[\w.\-"]+)*)*$/;

/**
 * Is this exact URL allowed? Parsed by the WHATWG URL parser (dot segments, %2e, backslashes
 * and userinfo are resolved first), then compared strictly.
 * @returns {URL|null}
 */
export function allowedTarget(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== ALLOWED_HOST || u.port !== '' || u.username || u.password || u.hash) return null;
  if (!ALLOWED_PATHS.some((p) => u.pathname.startsWith(p))) return null;
  if (/%2f|%5c/i.test(u.pathname)) return null; // encoded slashes: refuse rather than guess
  return u;
}

/** Fixed-window counter per user, in this instance's memory only. */
export function createLimiter({ perMinute = 300, maxUsers = 5000, now = () => Date.now() } = {}) {
  const hits = new Map(); // sub → { start, n }
  return (sub) => {
    const t = now();
    let h = hits.get(sub);
    if (!h || t - h.start >= 60000) {
      if (hits.size >= maxUsers) for (const [k, v] of hits) if (t - v.start >= 60000) hits.delete(k);
      if (hits.size >= maxUsers) return 60; // full of active users: refuse newcomers rather than evict (no counter reset by flooding)
      h = { start: t, n: 0 };
      hits.set(sub, h);
    }
    h.n++;
    return h.n <= perMinute ? null : Math.ceil((h.start + 60000 - t) / 1000);
  };
}

const parseOrigins = (s) => String(s || 'https://saudapulse.kz').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);

/**
 * @param {{ env: Record<string,string|undefined>, fetchImpl?: typeof fetch, now?: () => number, jwks?: object[] }} opts
 *   env.SUPABASE_URL           project URL (set by Supabase automatically)
 *   env.RELAY_ALLOWED_ORIGINS  comma-separated page origins (default https://saudapulse.kz)
 *   env.RELAY_JWKS             optional: the project's public JWKs as JSON (else read once from
 *                              <SUPABASE_URL>/auth/v1/.well-known/jwks.json and kept 10 min)
 *   env.RELAY_RATE_PER_MINUTE  optional, default 300
 */
export function createRelay({ env = {}, fetchImpl = globalThis.fetch, now = () => Date.now(), jwks = null } = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const origins = parseOrigins(env.RELAY_ALLOWED_ORIGINS);
  const limit = createLimiter({ perMinute: Number(env.RELAY_RATE_PER_MINUTE) || 300, now });
  let keys = jwks || (env.RELAY_JWKS ? safeJson(env.RELAY_JWKS)?.keys || safeJson(env.RELAY_JWKS) : null);
  let keysAt = keys ? Infinity : 0;
  let verifier = null;
  const getVerifier = async () => {
    if (!keys || now() - keysAt > 600000) {
      try {
        const r = await fetchImpl(`${base}/auth/v1/.well-known/jwks.json`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
        const j = r.ok ? await r.json() : null;
        if (Array.isArray(j?.keys) && j.keys.length) (keys = j.keys), (keysAt = now()), (verifier = null);
      } catch {
        /* keep the previous keys */
      }
    }
    if (!keys?.length) return null;
    verifier ??= createLicenseVerifier({ keys: () => keys, issuer: () => `${base}/auth/v1` });
    return verifier;
  };

  const cors = (origin) => {
    const h = { Vary: 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (origin && origins.includes(origin)) {
      h['Access-Control-Allow-Origin'] = origin;
      h['Access-Control-Expose-Headers'] = 'Retry-After, X-Relay-Error';
    }
    return h;
  };
  const refuse = (status, code, origin, extra = {}) =>
    new Response(JSON.stringify({ relayError: code }), { status, headers: { ...cors(origin), 'Content-Type': 'application/json', 'X-Relay-Error': code, ...extra } });

  return async function handle(req) {
    const origin = req.headers.get('Origin');
    if (origin && !origins.includes(origin)) return refuse(403, 'origin', null);
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...cors(origin), 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Max-Age': '600' },
      });
    }
    if (req.method !== 'POST') return refuse(405, 'method', origin);
    if (!base) return refuse(500, 'config', origin);

    // 1. who is calling: a signed-in user of our project
    const auth = req.headers.get('Authorization') || '';
    const jwt = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const v = jwt ? await getVerifier() : null;
    if (jwt && !v) return refuse(503, 'keys', origin);
    const claims = v ? await v.verifiedClaims(jwt) : null;
    if (!claims || claims.role !== 'authenticated' || !claims.sub || claims.is_anonymous === true || claims.exp * 1000 <= now()) return refuse(401, 'auth', origin);
    const wait = limit(claims.sub);
    if (wait) return refuse(429, 'rate', origin, { 'Retry-After': String(wait) });

    // 2. what to forward
    const len = Number(req.headers.get('Content-Length') || 0);
    if (len > MAX_ENVELOPE) return refuse(413, 'size', origin);
    let env_;
    try {
      const text = await req.text();
      if (text.length > MAX_ENVELOPE) return refuse(413, 'size', origin);
      env_ = JSON.parse(text);
    } catch {
      return refuse(400, 'envelope', origin);
    }
    if (!env_ || typeof env_ !== 'object') return refuse(400, 'envelope', origin);
    const target = allowedTarget(env_.url);
    if (!target) return refuse(403, 'target', origin);
    const method = String(env_.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) return refuse(403, 'method', origin);
    const token = typeof env_.token === 'string' ? env_.token.trim() : '';
    if (!TOKEN_RE.test(token)) return refuse(400, 'token', origin);
    const accept = typeof env_.accept === 'string' && MEDIA_RE.test(env_.accept) ? env_.accept : 'application/vnd.api+json';
    const contentType = typeof env_.contentType === 'string' && MEDIA_RE.test(env_.contentType) ? env_.contentType : 'application/vnd.api+json';
    if (method === 'GET' && env_.body != null) return refuse(400, 'envelope', origin);
    if (env_.body != null && typeof env_.body !== 'string') return refuse(400, 'envelope', origin);

    // 3. forward once: only these headers reach Kaspi (no client IP, cookies or Supabase token)
    let up;
    try {
      up = await fetchImpl(target.href, {
        method,
        headers: { 'X-Auth-Token': token, Accept: accept, 'Content-Type': contentType, 'User-Agent': 'SaudaPulse-Relay/1' },
        body: method === 'GET' ? undefined : env_.body ?? undefined,
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (e) {
      return refuse(e?.name === 'TimeoutError' ? 504 : 502, 'upstream', origin);
    }
    if (up.status >= 300 && up.status < 400 || up.type === 'opaqueredirect') {
      try { await up.body?.cancel(); } catch { /* ignore */ }
      return refuse(502, 'redirect', origin);
    }
    const headers = { ...cors(origin), 'Content-Type': up.headers.get('Content-Type') || 'application/octet-stream' };
    const ra = up.headers.get('Retry-After');
    if (ra && /^\d{1,6}$/.test(ra)) headers['Retry-After'] = ra;
    return new Response(up.body, { status: up.status, headers }); // streamed through, never buffered or kept
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
