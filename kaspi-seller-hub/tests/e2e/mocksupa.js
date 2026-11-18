// Test double for Supabase: GoTrue-like auth (email OTP) + PostgREST-like /rest/v1/rpc
// that runs the REAL billing SQL functions in a local PostgreSQL, as role
// `authenticated` with request.jwt.claim.sub = the logged-in user (like Supabase does).
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const PORT = 8098, ANON = 'test-anon-key';
const pool = new Pool({ host: '/tmp', port: 5499, user: 'postgres', database: 'billing' });
const sessions = new Map(); // access_token → { uid, email }
const refresh = new Map(); // refresh_token → { uid, email }
const codes = new Map(); // email → code
const log = [];
const files = new Map(); // storage: bucket/name → { body, type }

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };

// ES256 signing key, like a Supabase project with asymmetric JWT keys (fixed file so the
// test extension can embed the public half).
const fs = require('fs');
const KEYFILE = __dirname + '/mockkey.json';
if (!fs.existsSync(KEYFILE)) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  fs.writeFileSync(KEYFILE, JSON.stringify(privateKey.export({ format: 'jwk' })));
}
const PRIV = crypto.createPrivateKey({ key: JSON.parse(fs.readFileSync(KEYFILE, 'utf8')), format: 'jwk' });
const PUB_JWK = { ...crypto.createPublicKey(PRIV).export({ format: 'jwk' }), kid: 'mock-1', alg: 'ES256' };
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const tweaks = { iatShift: 0 }; // test control: issue tokens "from the future" etc.

async function hookClaims(uid, claims) {
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role supabase_auth_admin');
    const r = await c.query('select public.custom_access_token_hook($1::jsonb) r', [JSON.stringify({ user_id: uid, claims })]);
    await c.query('commit');
    return r.rows[0].r.claims;
  } finally { c.release(); }
}
function signJwt(payload) {
  const head = b64u({ alg: 'ES256', typ: 'JWT', kid: 'mock-1' });
  const body = b64u(payload);
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: PRIV, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function issue(uid, email) {
  const now = Math.floor(Date.now() / 1000) + tweaks.iatShift;
  const claims = await hookClaims(uid, { iss: `http://localhost:${PORT}/auth/v1`, sub: uid, aud: 'authenticated', role: 'authenticated', email, iat: now, exp: now + 3600 });
  const at = signJwt(claims), rt = 'rt-' + crypto.randomBytes(8).toString('hex');
  sessions.set(at, { uid, email }); refresh.set(rt, { uid, email });
  return { access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'bearer', user: { id: uid, email } };
}

async function rpc(uid, fn, args, headers = {}) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(uid ? 'set local role authenticated' : 'set local role anon');
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [uid || '']);
    await c.query("select set_config('request.headers', $1, true)", [JSON.stringify({ "user-agent": headers["user-agent"], "x-forwarded-for": "5.76.0.9" })]); // like PostgREST
    const keys = Object.keys(args);
    const sql = `select public.${fn.replace(/[^a-z_]/g, '')}(${keys.map((k, i) => `${k.replace(/[^a-z_]/g, '')} => $${i + 1}`).join(', ')}) as r`;
    const r = await c.query(sql, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' && (!Array.isArray(args[k]) || args[k].some((v) => v !== null && typeof v === 'object')) ? JSON.stringify(args[k]) : args[k])));
    await c.query('commit');
    return r.rows[0].r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', async () => {
    const bodyBuf = Buffer.concat(chunks);
    const body = bodyBuf.toString('utf8');
    const u = new URL(req.url, 'http://x');
    let b = {}; try { b = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
    try {
      if (u.pathname === '/__log') return send(res, 200, log);
      if (u.pathname === '/__jwk') return send(res, 200, PUB_JWK);
      if (u.pathname === '/__tweak') { Object.assign(tweaks, b); return send(res, 200, tweaks); }
      if (u.pathname === '/__sign') return send(res, 200, { jwt: signJwt(b) }); // test control: sign arbitrary claims
      if (u.pathname === '/auth/v1/.well-known/jwks.json') return send(res, 200, { keys: [PUB_JWK] });
      if (u.pathname === '/__sql') { const r = await pool.query(b.sql); return send(res, 200, r.rows); } // test control only
      // Storage: public read (no key), like a public bucket
      const pub = u.pathname.match(/^\/storage\/v1\/object\/public\/([a-z]+)\/(.+)$/);
      if (pub && req.method === 'GET') {
        const f = files.get(`${pub[1]}/${decodeURIComponent(pub[2])}`);
        if (!f) return send(res, 404, { message: 'Object not found' });
        res.writeHead(200, { 'Content-Type': f.type, ...cors }); return res.end(f.body);
      }
      if (req.headers.apikey !== ANON) return send(res, 401, { message: 'No API key found in request' });
      if (u.pathname === '/auth/v1/otp') {
        const email = String(b.email || '').toLowerCase();
        const exists = (await pool.query('select 1 from auth.users where email=$1', [email])).rowCount;
        if (!exists && b.create_user === false) return send(res, 400, { error_description: 'Signups not allowed for otp' });
        codes.set(email, '123456'); log.push({ otp: email });
        return send(res, 200, {});
      }
      if (u.pathname === '/auth/v1/verify') {
        const email = String(b.email || '').toLowerCase();
        if (b.type !== 'email' || codes.get(email) !== b.token) return send(res, 403, { error_description: 'Token has expired or is invalid' });
        codes.delete(email);
        let row = (await pool.query('select id from auth.users where email=$1', [email])).rows[0];
        if (!row) row = (await pool.query('insert into auth.users(email) values ($1) returning id', [email])).rows[0]; // trigger → account + trial
        return send(res, 200, await issue(row.id, email));
      }
      if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token') {
        const s = refresh.get(b.refresh_token); if (!s) return send(res, 400, { error_description: 'Invalid Refresh Token' });
        refresh.delete(b.refresh_token); log.push({ refresh: s.email }); return send(res, 200, await issue(s.uid, s.email));
      }
      if (u.pathname === '/auth/v1/logout') return send(res, 204, {});
      // Storage upload: the row goes through the REAL storage.objects RLS policies from 001_billing.sql
      const up = u.pathname.match(/^\/storage\/v1\/object\/([a-z]+)\/(.+)$/);
      if (up && req.method === 'POST') {
        const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
        const s = sessions.get(tok);
        if (!s) return send(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'invalid jwt' });
        const bucket = up[1], name = decodeURIComponent(up[2]);
        if (bodyBuf.length > 5242880) return send(res, 413, { message: 'Payload too large' });
        if (!/xml/.test(req.headers['content-type'] || '')) return send(res, 400, { message: 'mime type not supported' });
        const c = await pool.connect();
        try {
          await c.query('begin'); await c.query('set local role authenticated');
          await c.query("select set_config('request.jwt.claim.sub', $1, true)", [s.uid]);
          const r = req.headers['x-upsert'] === 'true'
            ? await c.query("insert into storage.objects (bucket_id, name, metadata) values ($1, $2, '{}') on conflict (bucket_id, name) do update set updated_at = now() returning id", [bucket, name])
            : await c.query("insert into storage.objects (bucket_id, name, metadata) values ($1, $2, '{}') returning id", [bucket, name]);
          await c.query('commit');
          files.set(`${bucket}/${name}`, { body: bodyBuf, type: req.headers['content-type'] });
          log.push({ upload: `${bucket}/${name}`, email: s.email, bytes: bodyBuf.length });
          return send(res, 200, { Key: `${bucket}/${name}`, Id: r.rows[0]?.id });
        } catch (e) {
          await c.query('rollback').catch(() => {});
          log.push({ uploadDenied: `${bucket}/${name}`, email: s.email, error: e.message });
          return send(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
        } finally { c.release(); }
      }
      const m = u.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
      if (m) {
        const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (tok === ANON) { log.push({ rpc: m[1], anon: true }); return send(res, 200, await rpc(null, m[1], b, req.headers)); } // like PostgREST: anon key = role anon
        const s = sessions.get(tok);
        if (!s) return send(res, 401, { message: 'JWT expired' });
        log.push({ rpc: m[1], email: s.email, args: b });
        return send(res, 200, await rpc(s.uid, m[1], b, req.headers));
      }
      send(res, 404, { message: 'not found' });
    } catch (e) {
      send(res, 400, { code: e.code, message: e.message, details: null, hint: null });
    }
  });
}).listen(PORT, () => console.log('mock supabase on', PORT));
