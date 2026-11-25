#!/usr/bin/env node
/**
 * SaudaPulse — build of the phone app (PWA) for https://saudapulse.kz/app
 *
 *   node tools/build-app.mjs [--turnstile-key=0x…]     (or env TURNSTILE_SITE_KEY)
 *   → dist/app-site/app/…      copy this folder into the site root (it becomes /app/)
 *   → dist/app-site/_headers   security headers for Cloudflare Pages / Netlify (optional)
 *
 * The app reuses the extension's own modules (shared/, background/kaspi-api.js, background/billing.js):
 * they are copied into app/core/ unchanged, only the app's import paths are rewritten.
 * Refuses to build when the subscription server is not configured, when a secret key is in the
 * config, or when the page's Content-Security-Policy does not match the Supabase project.
 * Does not touch the extension's build (dist/kaspi-seller-hub*, *.zip).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'app-site');
const APP_OUT = path.join(OUT, 'app');
const errors = [];
const fail = (m) => errors.push(m);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------- config checks ----------
const cfg = read('shared/billing-config.js');
const supabaseUrl = (cfg.match(/supabaseUrl:\s*'([^']*)'/) || [])[1] || '';
const anonKey = (cfg.match(/supabaseAnonKey:\s*'([^']*)'/) || [])[1] || '';
if (!supabaseUrl || !anonKey) fail('shared/billing-config.js: supabaseUrl / supabaseAnonKey empty');
if (/^sb_secret_/.test(anonKey)) fail('supabaseAnonKey is a SECRET key');
try {
  if (anonKey.split('.').length === 3 && JSON.parse(Buffer.from(anonKey.split('.')[1], 'base64url')).role !== 'anon') fail('supabaseAnonKey is not the anon key');
} catch {
  fail('supabaseAnonKey unreadable');
}
if (!/licenseKeys:\s*\[\s*\{/.test(cfg)) fail('licenseKeys empty: the licence could be faked');
const html = read('app/index.html');
const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
const connect = (csp.match(/connect-src ([^;]+)/) || [])[1] || '';
if (!connect.split(/\s+/).includes(supabaseUrl.replace(/\/$/, ''))) fail(`app/index.html CSP connect-src must list ${supabaseUrl}`);
if (/connect-src[^;]*(\*|kaspi\.kz)/.test(csp)) fail('CSP connect-src must not allow kaspi.kz or *: Kaspi is reached only through the relay');
const turnstileKey = (process.argv.find((a) => a.startsWith('--turnstile-key=')) || '').split('=')[1] || process.env.TURNSTILE_SITE_KEY || '';
if (turnstileKey && !/^0x[0-9A-Za-z_-]{10,}$/.test(turnstileKey)) fail('Turnstile site key looks wrong (expected 0x…)');

// ---------- collect the module graph from app/js ----------
const files = new Map(); // repo path → output path (relative to APP_OUT)
const IMPORT_RE = /^\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;
function walk(repoPath) {
  if (files.has(repoPath)) return;
  const out = repoPath.startsWith('app/') ? repoPath.slice(4) : `core/${repoPath}`;
  files.set(repoPath, out);
  if (!repoPath.endsWith('.js')) return;
  const src = read(repoPath);
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2] || m[3];
    if (!spec.startsWith('.')) fail(`${repoPath}: non-relative import ${spec}`);
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), spec));
    if (!fs.existsSync(path.join(ROOT, target))) fail(`${repoPath}: missing ${target}`);
    else walk(target);
  }
}
for (const f of fs.readdirSync(path.join(ROOT, 'app/js'))) if (f.endsWith('.js')) walk(`app/js/${f}`);

// ---------- write ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(APP_OUT, { recursive: true });
const written = [];
const put = (rel, content) => {
  const p = path.join(APP_OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  written.push(rel);
};
for (const [repoPath, out] of files) {
  let src = read(repoPath);
  if (repoPath.startsWith('app/js/')) {
    src = src.replaceAll("'../../shared/", "'../core/shared/").replaceAll("'../../background/", "'../core/background/");
    if (repoPath === 'app/js/config.js' && turnstileKey) src = src.replace('__TURNSTILE_SITE_KEY__', turnstileKey);
  }
  if (/service_role|sb_secret_/.test(src.replace(/\/\/.*|\*.*$/gm, ''))) fail(`${repoPath}: secret key reference`);
  if (/\beval\s*\(|new Function\s*\(/.test(src)) fail(`${repoPath}: eval / new Function`);
  put(out, src);
}
for (const f of ['index.html', 'app.css', 'manifest.webmanifest']) put(f, read(`app/${f}`));
for (const f of fs.readdirSync(path.join(ROOT, 'app/icons'))) put(`icons/${f}`, fs.readFileSync(path.join(ROOT, 'app/icons', f)));
for (const f of fs.readdirSync(path.join(ROOT, 'app/vendor'))) put(`vendor/${f}`, fs.readFileSync(path.join(ROOT, 'app/vendor', f))); // jsQR (Apache-2.0) for the camera scanner

// service worker: shell list = exactly the files built above
const shell = ['./', ...written.sort().map((f) => `./${f}`)];
const hash = crypto.createHash('sha256');
for (const f of written.sort()) hash.update(f).update(fs.readFileSync(path.join(APP_OUT, f)));
const build = hash.digest('hex').slice(0, 12);
let sw = read('app/sw.js').replace('__APP_BUILD__', build);
sw = `self.__SHELL__ = ${JSON.stringify(shell)};\n${sw}`;
put('sw.js', sw);

// the site's «Установить» button (all pages of saudapulse.kz): published at /install-button.js
fs.copyFileSync(path.join(ROOT, 'site-widgets/install-button.js'), path.join(OUT, 'install-button.js'));

// headers for hosts that read a _headers file (Cloudflare Pages, Netlify); GitHub Pages ignores it
fs.writeFileSync(
  path.join(OUT, '_headers'),
  `/app/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=()
  X-Frame-Options: DENY
/app/sw.js
  Cache-Control: no-cache
/app/index.html
  Cache-Control: no-cache
`,
);

if (errors.length) {
  console.error('build-app refused:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log(`dist/app-site/app: ${written.length + 1} files, build ${build}${turnstileKey ? ', Turnstile on' : ', Turnstile off (no site key)'}`);
