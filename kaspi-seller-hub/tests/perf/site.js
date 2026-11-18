// Landing page speed on a phone over mobile 4G (CDP throttling): first paint, largest paint (LCP),
// layout shift (CLS), bytes and requests on first load, and with the cache on a repeat visit.
const { chromium, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../../site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
  fs.createReadStream(p).pipe(res);
}).listen(8096);
(async () => {
  const browser = await chromium.launch();
  const out = {};
  for (const [name, net] of [['4G', { latency: 70, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 }], ['slow3G', { latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 }]]) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, ...net });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); // mid-range phone
    let bytes = 0, reqs = 0;
    cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; reqs++; });
    await p.addInitScript(() => {
      window.__lcp = 0; window.__cls = 0;
      new PerformanceObserver((l) => l.getEntries().forEach((e) => (window.__lcp = e.startTime))).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (!e.hadRecentInput) window.__cls += e.value; })).observe({ type: 'layout-shift', buffered: true });
    });
    const t0 = Date.now();
    await p.goto('http://localhost:8096/', { waitUntil: 'load' });
    const loadMs = Date.now() - t0;
    await p.waitForTimeout(1500);
    const m = await p.evaluate(() => ({ fcp: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0), lcp: Math.round(window.__lcp), cls: Math.round(window.__cls * 1000) / 1000 }));
    const first = { ...m, loadMs, kb: Math.round(bytes / 1024), requests: reqs };
    // scroll to the bottom: lazy images load only then
    bytes = 0; reqs = 0;
    await p.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 150)); } });
    await p.waitForTimeout(2500);
    first.scrolledExtraKb = Math.round(bytes / 1024);
    // repeat visit
    bytes = 0; reqs = 0;
    const t1 = Date.now(); await p.reload({ waitUntil: 'load' }); first.repeatLoadMs = Date.now() - t1; first.repeatKb = Math.round(bytes / 1024);
    out[name] = first;
    await ctx.close();
  }
  console.log('REPORT ' + JSON.stringify(out));
  await browser.close(); server.close();
})();
