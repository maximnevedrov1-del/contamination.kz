// Preview image for links in messengers / social networks (site/assets/og.png, 1200×630).
const { chromium } = require('playwright');
const path = require('path');
const A = path.join(__dirname, '../../site/assets');
const data = (f, type) => `data:${type};base64,${require('fs').readFileSync(path.join(A, f)).toString('base64')}`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await p.setContent(`<!doctype html><html><head><style>
    body{margin:0;width:1200px;height:630px;overflow:hidden;font-family:Inter,sans-serif;background:#fafafa;color:#0a0a0a;position:relative}
    .glow{position:absolute;inset:-40% -25% auto 45%;height:140%;background:radial-gradient(closest-side,rgba(42,120,214,.18),transparent)}
    .t{position:absolute;left:84px;top:70px;width:1000px}
    .logo{display:flex;align-items:center;gap:18px;font-weight:700;font-size:44px;letter-spacing:-.02em}
    .logo img{width:72px;height:72px;border-radius:16px}
    h1{margin:40px 0 0;font-size:76px;line-height:1.04;letter-spacing:-.035em}
    p{margin:28px 0 0;font-size:28px;line-height:1.4;color:#52525b;width:900px}
    .chips{position:absolute;left:84px;bottom:56px;display:flex;gap:12px}
    .chips span{padding:10px 20px;border-radius:999px;background:#fff;border:1px solid #e4e4e7;font-size:22px;color:#27272a}
  </style></head><body><div class="glow"></div>
    <div class="t"><div class="logo"><img src="${data('icon-128.png', 'image/png')}">SaudaPulse</div>
    <h1>Все магазины Kaspi — в одном окне</h1>
    <p>Заказы, сроки, сборка, накладные и прибыль 2–5 магазинов. 30 дней бесплатно.</p></div>
    <div class="chips"><span>Заказы</span><span>Сроки</span><span>Сборка</span><span>Накладные</span><span>Прибыль</span></div>
  </body></html>`, { waitUntil: 'load' });
  await p.screenshot({ path: path.join(A, 'og.png') });
  await b.close();
  console.log('og.png');
})();
