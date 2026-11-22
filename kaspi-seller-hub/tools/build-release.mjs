#!/usr/bin/env node
/**
 * Kaspi Seller Hub — release build for the Chrome Web Store.
 *
 *   node tools/build-release.mjs                    → dist/kaspi-seller-hub-<version>.zip   (Chrome, Yandex, Edge, Opera, Brave)
 *   node tools/build-release.mjs --target=firefox   → dist/kaspi-seller-hub-<version>-firefox.zip (Firefox desktop & Android, addons.mozilla.org)
 *   --with-cabinet   keep the cabinet-tab mode and chat (off by default until checked on a live
 *                    cabinet: shared/features.js). Without it no content scripts are shipped.
 *
 * Refuses to build a version that could be used for free or leak secrets:
 *   - subscription server not configured (= developer mode, no limits);
 *   - no licence signing key (subscription could be faked in the browser storage);
 *   - a Supabase SECRET / service_role key instead of the public anon key;
 *   - test addresses (localhost, file://) or a non-production Kaspi API address.
 * And hardens what ships:
 *   - demo pages, the admin page, SQL and tools are left out;
 *   - demo/localhost/file permissions are removed from the manifest;
 *   - the pages may only talk to kaspi.kz and your Supabase project (CSP connect-src).
 *
 * Publish the zip through the Chrome Web Store: Chrome then verifies the installed
 * files and disables a copy whose code was modified.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WITH_CABINET = process.argv.includes('--with-cabinet');
const TARGET = (process.argv.find((a) => a.startsWith('--target=')) || '--target=chrome').split('=')[1];
if (!['chrome', 'firefox'].includes(TARGET)) {
  console.error('Unknown --target (chrome | firefox)');
  process.exit(1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'dist');
const PKG = path.join(OUT_DIR, TARGET === 'chrome' ? 'kaspi-seller-hub' : `kaspi-seller-hub-${TARGET}`);
const SHIP = ['manifest.json', 'background', 'content', 'dashboard', 'popup', 'shared', 'locales', 'icons', 'fonts', 'vendor', 'legal', 'help'];

const errors = [];
const fail = (msg) => errors.push(msg);

// ---------- read configuration ----------
// Drops comment lines (// …, /** …, * …) — enough for our own config and code files.
const stripComments = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const cfgSrc = stripComments(fs.readFileSync(path.join(ROOT, 'shared/billing-config.js'), 'utf8'));
const str = (name) => (cfgSrc.match(new RegExp(`${name}:\\s*'([^']*)'`)) || [])[1] || '';
const supabaseUrl = str('supabaseUrl').replace(/\/$/, '');
const anonKey = str('supabaseAnonKey');
const keysBlock = (cfgSrc.match(/licenseKeys:\s*\[([\s\S]*?)\]\s*,/) || [])[1] || '';
const hasSigningKey = /["']?kty["']?\s*:\s*["'](EC|RSA)["']/.test(keysBlock);

if (!supabaseUrl || !anonKey) fail('shared/billing-config.js: supabaseUrl / supabaseAnonKey are empty — the build would run in DEVELOPER MODE (free, no limits).');
if (supabaseUrl && !/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(supabaseUrl)) fail(`supabaseUrl must be an https address without a path: ${supabaseUrl}`);
if (!hasSigningKey) fail('shared/billing-config.js: licenseKeys is empty — without the public signing key a subscription can be faked by editing browser storage. See billing/README.md → «Подписанная лицензия».');

// The anon key is public by design; a service_role / secret key would give full database access to anyone.
if (/^sb_secret_/i.test(anonKey)) fail('supabaseAnonKey is a SECRET key (sb_secret_…). Use the publishable/anon key.');
if (anonKey.split('.').length === 3) {
  try {
    const role = JSON.parse(Buffer.from(anonKey.split('.')[1], 'base64url').toString()).role;
    if (role !== 'anon') fail(`supabaseAnonKey has role "${role}" — use the anon public key, NEVER service_role.`);
  } catch {
    fail('supabaseAnonKey is not a valid key.');
  }
}

const selectors = fs.readFileSync(path.join(ROOT, 'shared/selectors.js'), 'utf8');
const apiBase = (selectors.match(/base:\s*'([^']+)'/) || [])[1];
if (apiBase !== 'https://kaspi.kz/shop/api/v2') fail(`shared/selectors.js api.base must be https://kaspi.kz/shop/api/v2 (now: ${apiBase}).`);
const productsBase = (selectors.match(/productsBase:\s*'([^']+)'/) || [])[1];
if (productsBase !== 'https://kaspi.kz/shop/api/products') fail(`shared/selectors.js api.productsBase must be https://kaspi.kz/shop/api/products (now: ${productsBase}).`);

if (errors.length) {
  console.error('\n✗ Release build refused:\n' + errors.map((e) => '  - ' + e).join('\n') + '\n');
  process.exit(1);
}

// ---------- copy ----------
fs.rmSync(PKG, { recursive: true, force: true });
fs.mkdirSync(PKG, { recursive: true });
for (const item of SHIP) fs.cpSync(path.join(ROOT, item), path.join(PKG, item), { recursive: true });

// Demo tab patterns (localhost, file://) are not shipped.
const selPath = path.join(PKG, 'shared/selectors.js');
fs.writeFileSync(
  selPath,
  fs.readFileSync(selPath, 'utf8').replace(/tabMatchPatterns:\s*\[([^\]]*)\]/, (m, list) => `tabMatchPatterns: [${list.split(',').map((x) => x.trim()).filter((x) => x && !/localhost|file:/.test(x)).join(', ')}]`),
);

// Cabinet-tab mode and chat: off unless --with-cabinet (shared/features.js).
const featPath = path.join(PKG, 'shared/features.js');
const featSrc = fs.readFileSync(featPath, 'utf8');
const featOut = featSrc.replace(/cabinet:\s*(true|false)/, `cabinet: ${WITH_CABINET}`);
if (!/cabinet:\s*(true|false)/.test(featSrc)) {
  console.error('✗ shared/features.js: cabinet flag not found');
  process.exit(1);
}
fs.writeFileSync(featPath, featOut);

// ---------- manifest ----------
const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'manifest.json'), 'utf8'));
if (!WITH_CABINET) {
  // API-only: nothing runs on kaspi.kz pages, no script injection
  delete manifest.content_scripts;
  manifest.permissions = (manifest.permissions || []).filter((p) => p !== 'scripting');
  fs.rmSync(path.join(PKG, 'content'), { recursive: true, force: true });
}
const prodOnly = (list) => list.filter((p) => !/localhost|^file:|127\.0\.0\.1/.test(p));
manifest.host_permissions = prodOnly(manifest.host_permissions || []);
for (const cs of manifest.content_scripts || []) cs.matches = prodOnly(cs.matches);
delete manifest.key;
if (TARGET === 'firefox') {
  // Firefox runs MV3 backgrounds as event pages (no service_worker key) and needs an add-on id.
  // 128 = first version with content scripts in the page's MAIN world (network tap).
  manifest.background = { scripts: [manifest.background.service_worker], type: 'module' };
  delete manifest.minimum_chrome_version;
  manifest.browser_specific_settings = {
    gecko: {
      id: 'kaspi-seller-hub@sellerhub.kz',
      strict_min_version: '128.0',
    },
    gecko_android: { strict_min_version: '128.0' },
  };
}
const supa = new URL(supabaseUrl).origin;
manifest.content_security_policy = {
  extension_pages: [
    "script-src 'self'",
    "object-src 'self'",
    "frame-src 'self' blob:",
    `connect-src 'self' https://kaspi.kz https://*.kaspi.kz ${supa}`,
    // product photos: Kaspi's own image hosts only (shared/photos.js → PHOTO_HOSTS)
    `img-src 'self' data: blob: ${supa} https://kaspi.kz https://*.kaspi.kz https://*.cdn-kaspi.kz`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
};
fs.writeFileSync(path.join(PKG, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// ---------- final scan of what ships ----------
const leaks = [];
const walk = (dir) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.(js|json|html|css)$/.test(f.name) && !p.includes(`${path.sep}vendor${path.sep}`)) {
      const txt = stripComments(fs.readFileSync(p, 'utf8'));
      if (/https?:\/\/localhost|127\.0\.0\.1/.test(txt)) leaks.push(`${path.relative(PKG, p)}: test address`);
      if (/sb_secret_|service_role"?\s*[:=]\s*['"]ey/.test(txt)) leaks.push(`${path.relative(PKG, p)}: secret key`);
      if (/\beval\s*\(|new Function\s*\(/.test(txt)) leaks.push(`${path.relative(PKG, p)}: eval`);
    }
  }
};
walk(PKG);
if (leaks.length) {
  console.error('\n✗ Release build refused, found in the package:\n' + leaks.map((e) => '  - ' + e).join('\n') + '\n');
  process.exit(1);
}

// ---------- zip ----------
const zip = path.join(OUT_DIR, `kaspi-seller-hub-${manifest.version}${TARGET === 'chrome' ? '' : '-' + TARGET}.zip`);
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-qr', zip, '.'], { cwd: PKG });
console.log(`✓ ${path.relative(ROOT, zip)}\n  hosts: ${manifest.host_permissions.join(', ')}\n  server: ${supa}\n  cabinet mode + chat: ${WITH_CABINET ? 'ON' : 'off (API only, no content scripts)'}`);
