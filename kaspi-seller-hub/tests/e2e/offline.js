// Shared offline guard for E2E suites. `require('./offline')` once, after `require('playwright')`.
//  - patches chromium.launchPersistentContext: always adds --no-sandbox / --disable-dev-shm-usage
//    (merged with the suite's own args) and routes every request of the context through the guard;
//  - https://saudapulse.kz/* is served from the locally built site (dist/site, else site/);
//  - any other non-local http(s) host is aborted at once (no hanging behind the sandbox proxy);
//  - localhost / 127.0.0.1, chrome-extension:// and data:/blob:/about: are left alone.
// Suites that route a host themselves (e.g. t.me, kaspi.kz) register their route later; Playwright
// runs the most recently registered matching route first, so theirs win.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '../..');
const SITE = [path.join(ROOT, 'dist/site'), path.join(ROOT, 'site')].find((d) => fs.existsSync(path.join(d, 'index.html')));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };

function localSite(pathname) {
  if (!SITE) return null;
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const base = path.resolve(SITE);
  for (const c of [rel, rel + '.html', path.join(rel, 'index.html')]) {
    const f = path.resolve(base, c);
    if (f.startsWith(base) && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

async function guard(route) {
  let u;
  try { u = new URL(route.request().url()); } catch { return route.continue(); }
  if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return route.continue();
  if (u.hostname === 'saudapulse.kz' || u.hostname === 'www.saudapulse.kz') {
    const f = localSite(u.pathname);
    if (f) return route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>stub</title><p>stub</p>' });
  }
  return route.abort('connectionrefused');
}

const orig = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (dir, opts = {}) => {
  const args = [...new Set([...(opts.args || []), '--no-sandbox', '--disable-dev-shm-usage'])];
  const ctx = await orig(dir, { ...opts, args });
  await ctx.route('**/*', guard);
  return ctx;
};
const origLaunch = chromium.launch.bind(chromium);
chromium.launch = (opts = {}) => origLaunch({ ...opts, args: [...new Set([...(opts.args || []), '--no-sandbox', '--disable-dev-shm-usage'])] });
module.exports = { guard };
