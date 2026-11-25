#!/usr/bin/env node
/**
 * SaudaPulse — one folder with the whole saudapulse.kz site, ready to upload
 * (Cloudflare Pages «Upload assets», or any static host).
 *
 *   node tools/build-app.mjs && node tools/build-site-package.mjs
 *   → dist/site-package/
 *        landing (dist/site), /app (phone app), /install-button.js on every landing page,
 *        /captcha (billing/captcha/index.html), _headers (security headers, Cloudflare Pages)
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
need('dist/site/index.html');
need('dist/app-site/app/index.html');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'dist/site'), OUT, { recursive: true });
fs.rmSync(path.join(OUT, 'CNAME'), { force: true }); // GitHub Pages only
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
      if (!['app', 'captcha', 'legal', 'assets'].includes(rel)) walk(p);
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
console.log(`dist/site-package: landing + /app + /captcha, «Установить» on ${pages} pages${storeUrl ? '' : ' (no store link yet: desktop button goes to «Как подключить»)'}`);
