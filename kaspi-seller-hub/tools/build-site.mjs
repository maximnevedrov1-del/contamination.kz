#!/usr/bin/env node
/**
 * Seller Hub landing page → dist/site/ (static files, any host: GitHub Pages, Netlify, nginx).
 *
 *   node tools/build-site.mjs
 *
 * site/site.config.json holds what is only known at launch (domain, support contacts, response
 * time). An element marked data-requires="key" is kept only when that value is filled in;
 * data-unless="key" is kept only when it is empty. "contacts" = any of whatsapp/telegram/email.
 * {{key}} in the HTML is replaced by the value. Nothing is invented: an empty value simply
 * leaves its block out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'site');
const OUT = path.join(ROOT, 'dist/site');

const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'site.config.json'), 'utf8'));
const v = {
  ...cfg,
  domain: String(cfg.domain || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  whatsappDigits: String(cfg.whatsapp || '').replace(/\D/g, ''),
  telegramName: String(cfg.telegram || '').replace(/^@/, '').replace(/^https?:\/\/t\.me\//, ''),
};
v.contacts = v.whatsappDigits || v.telegramName || v.email ? 'yes' : '';
v.whatsapp = v.whatsappDigits;
v.telegram = v.telegramName;
const filled = (k) => String(v[k] ?? '').trim() !== '';

const VOID = new Set(['link', 'meta', 'img', 'br', 'hr', 'input', 'source']);
/** Drop elements whose data-requires / data-unless condition fails (nesting-aware). */
function conditional(html) {
  const re = /<([a-z0-9]+)\b[^>]*\sdata-(requires|unless)="([a-zA-Z]+)"[^>]*>/g;
  let out = '';
  let pos = 0;
  let m;
  while ((m = re.exec(html))) {
    const [open, tag, kind, key] = m;
    const keep = kind === 'requires' ? filled(key) : !filled(key);
    if (keep) continue;
    let end = m.index + open.length;
    if (!VOID.has(tag) && !open.endsWith('/>')) {
      // find the matching closing tag
      const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
      tagRe.lastIndex = end;
      let depth = 1;
      let t;
      while (depth && (t = tagRe.exec(html))) depth += t[1] ? -1 : 1;
      end = t ? t.index + t[0].length : html.length;
    }
    out += html.slice(pos, m.index);
    pos = end;
    re.lastIndex = end;
  }
  out += html.slice(pos);
  return out.replace(/\sdata-(requires|unless)="[a-zA-Z]+"/g, '');
}
const fill = (text) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => {
  if (!filled(k)) throw new Error(`{{${k}}} is used outside a data-requires block but site.config.json has no value`);
  return String(v[k]).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
});

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (f.name === 'site.config.json') continue;
  const from = path.join(SRC, f.name);
  const to = path.join(OUT, f.name);
  if (f.isDirectory()) fs.cpSync(from, to, { recursive: true });
  else if (f.name.endsWith('.html')) fs.writeFileSync(to, fill(conditional(fs.readFileSync(from, 'utf8'))));
  else fs.copyFileSync(from, to);
}
// the how-to GIF and the legal documents come from the extension itself (one source of truth)
fs.copyFileSync(path.join(ROOT, 'help/connect.gif'), path.join(OUT, 'assets/connect.gif'));
fs.mkdirSync(path.join(OUT, 'legal'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'legal/legal.css'), path.join(OUT, 'legal/legal.css'));
let legal = fs.readFileSync(path.join(ROOT, 'legal/terms.html'), 'utf8');
if (v.domain) legal = legal.replaceAll('[адрес сайта]', `https://${v.domain}`);
fs.writeFileSync(path.join(OUT, 'legal/terms.html'), legal);

// robots.txt and sitemap.xml (the sitemap needs the domain)
fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n${v.domain ? `Sitemap: https://${v.domain}/sitemap.xml\n` : ''}`);
if (v.domain) {
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://${v.domain}/</loc><lastmod>${today}</lastmod></url>\n  <url><loc>https://${v.domain}/legal/terms.html</loc><lastmod>${today}</lastmod></url>\n</urlset>\n`);
  fs.writeFileSync(path.join(OUT, 'CNAME'), `${v.domain}\n`); // GitHub Pages custom domain
}
const missing = ['domain', 'whatsapp', 'telegram', 'email', 'responseTime'].filter((k) => !filled(k));
console.log(`✓ dist/site${missing.length ? `\n  not filled in yet (their blocks are left out): ${missing.join(', ')}` : ''}`);
