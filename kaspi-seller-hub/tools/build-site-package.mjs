#!/usr/bin/env node
/**
 * SaudaPulse — one folder with the whole saudapulse.kz site, ready to upload
 * (Cloudflare Pages «Upload assets», or any static host).
 *
 *   node tools/build-app.mjs && node tools/build-site-package.mjs
 *   → dist/site-package/
 *        landing = site-landing/ (the Manus landing, one self-contained index.html, RU/KK switch inside),
 *        /offer, /privacy, /legal and their styles from the previous site (dist/site, else site-deploy/),
 *        /app (phone app), /install-button.js on every page, /captcha, /kk → /?lang=kk,
 *        _headers (security headers, Cloudflare Pages)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'site-package');
const need = (p) => {
  if (!fs.existsSync(path.join(ROOT, p))) {
    console.error(`missing ${p}`);
    process.exit(1);
  }
};
need('site-landing/index.html');
need('dist/app-site/app/index.html');
const BASE = fs.existsSync(path.join(ROOT, 'dist/site/offer/index.html')) ? 'dist/site' : 'site-deploy';
need(`${BASE}/offer/index.html`);

fs.rmSync(OUT, { recursive: true, force: true });
// legal pages + their shared styles/assets from the previous site
fs.mkdirSync(OUT, { recursive: true });
for (const keep of ['offer', 'privacy', 'legal', 'assets', 'styles.css', '404.html', 'open.html', 'app.js']) {
  const from = path.join(ROOT, BASE, keep);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(OUT, keep), { recursive: true });
}
fs.rmSync(path.join(OUT, 'assets', 'install-button.js'), { force: true });
// the landing itself (Manus): index.html, og image, logo, robots, llms.txt
for (const f of fs.readdirSync(path.join(ROOT, 'site-landing'))) {
  if (f === 'source') continue; // editable Vite sources, not served
  fs.cpSync(path.join(ROOT, 'site-landing', f), path.join(OUT, f), { recursive: true });
}
// the old Kazakh page address keeps working: the landing switches language itself
fs.mkdirSync(path.join(OUT, 'kk'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'kk', 'index.html'), '<!doctype html><meta charset="utf-8"><title>SaudaPulse</title><meta http-equiv="refresh" content="0; url=/?lang=kk"><link rel="canonical" href="https://saudapulse.kz/?lang=kk"><a href="/?lang=kk">SaudaPulse</a>\n');
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://saudapulse.kz/</loc></url>
  <url><loc>https://saudapulse.kz/?lang=kk</loc></url>
  <url><loc>https://saudapulse.kz/offer</loc></url>
  <url><loc>https://saudapulse.kz/privacy</loc></url>
</urlset>
`);
fs.cpSync(path.join(ROOT, 'dist/app-site/app'), path.join(OUT, 'app'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'site-widgets/install-button.js'), path.join(OUT, 'install-button.js'));
fs.mkdirSync(path.join(OUT, 'captcha'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'billing/captcha/index.html'), path.join(OUT, 'captcha/index.html'));

const storeUrl = (process.argv.find((a) => a.startsWith('--store-url=')) || '').split('=').slice(1).join('=');
const tag = `<script src="/install-button.js" defer${storeUrl ? ` data-store-url="${storeUrl.replace(/"/g, '')}"` : ''}></script>\n`;
let pages = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(OUT, p).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (!['app', 'captcha', 'legal', 'assets', 'kk'].includes(rel)) walk(p);
    } else if (e.name.endsWith('.html')) {
      let s = fs.readFileSync(p, 'utf8');
      if (s.includes('install-button.js') || !s.includes('</body>')) continue;
      const i = s.lastIndexOf('</body>');
      fs.writeFileSync(p, s.slice(0, i) + tag + s.slice(i));
      pages++;
    }
  }
};
walk(OUT);

fs.writeFileSync(
  path.join(OUT, '_headers'),
  `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), microphone=(), payment=()

/app/*
  X-Frame-Options: DENY
  Content-Security-Policy: frame-ancestors 'none'
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=()

/app/sw.js
  Cache-Control: no-cache

/app/index.html
  Cache-Control: no-cache
`,
);
console.log(`dist/site-package (legal pages from ${BASE}): Manus landing + /app + /captcha, «Установить» on ${pages} pages${storeUrl ? '' : ' (no store link yet: desktop button goes to «Как подключить»)'}`);
