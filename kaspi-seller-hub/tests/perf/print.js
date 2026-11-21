// Printing a big batch: N waybills (Kaspi PDFs, half A4 sheets, half 100×150 labels) rendered at
// 300 dpi in the print page → time until the print dialog would open, and page memory.
const { chromium } = require('playwright');
const path = require('path');
const EXT = path.join(__dirname, '../apicopy');
const N = Number(process.env.N || 50);
const pdf = (w, h, text) => {
  const content = `BT /F1 20 Tf 20 ${h - 40} Td (${text}) Tj ET 0 0 0 rg 20 20 ${w - 40} 30 re f`;
  return Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF`, 'latin1');
};
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'printprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const a4 = `data:application/pdf;base64,${pdf(595.28, 841.89, 'A4 WAYBILL').toString('base64')}`;
  const label = `data:application/pdf;base64,${pdf(283.46, 425.2, 'LABEL').toString('base64')}`;
  await sw.evaluate(async ([a4, label, n]) => {
    const inv = Array.from({ length: n }, (_, i) => ({ orderId: 'O' + i, shopId: 'S1', kind: 'pdf', data: i % 2 ? label : a4, ts: Date.now() }));
    await chrome.storage.local.set({ 'ksh.invoices': inv });
    await chrome.storage.session.set({ 'ksh.printQueue': inv.map((i) => ({ shopId: 'S1', orderId: i.orderId })) });
  }, [a4, label, N]);
  const out = {};
  for (const mode of ['label', 'a4']) {
    await sw.evaluate(async (mode) => { const k = 'ksh.settings'; const s = (await chrome.storage.local.get(k))[k] || {}; s.print = { ...(s.print || {}), paper: mode === 'label' ? 'label' : 'a4' }; await chrome.storage.local.set({ [k]: s }); }, mode);
    const p = await ctx.newPage();
    await p.addInitScript(() => { window.__t0 = performance.now(); window.print = () => (window.__printedAt = performance.now()); });
    await p.goto(`chrome-extension://${id}/dashboard/print.html`);
    await p.waitForFunction(() => window.__printedAt, null, { timeout: 180000 });
    const r = await p.evaluate(() => ({ ms: Math.round(window.__printedAt), pages: document.querySelectorAll('.page, .page--sheet').length, heapMb: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576) }));
    out[mode] = r;
    await p.close();
  }
  console.log('REPORT ' + JSON.stringify({ waybills: N, ...out }));
  await ctx.close();
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
