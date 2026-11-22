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
    .glow{position:absolute;inset:-30% -20% auto 35%;height:140%;background:radial-gradient(closest-side,rgba(42,120,214,.18),transparent)}
    .t{position:absolute;left:64px;top:92px;width:470px}
    .logo{display:flex;align-items:center;gap:12px;font-weight:700;font-size:26px}
    .logo img{width:40px;height:40px;border-radius:9px}
    h1{margin:44px 0 0;font-size:58px;line-height:1.05;letter-spacing:-.03em}
    p{margin:24px 0 0;font-size:24px;line-height:1.4;color:#52525b}
    .f{position:absolute;left:600px;top:110px;width:760px;border-radius:18px;overflow:hidden;border:1px solid #e4e4e7;background:#fff;box-shadow:0 30px 70px rgba(0,0,0,.16);transform:perspective(1400px) rotateY(-10deg) rotateX(4deg)}
    .bar{height:30px;background:#f4f4f5;border-bottom:1px solid #e4e4e7;display:flex;gap:6px;align-items:center;padding:0 12px}.bar i{width:9px;height:9px;border-radius:50%;background:#e4e4e7}
    .f img{display:block;width:100%}
  </style></head><body><div class="glow"></div>
    <div class="t"><div class="logo"><img src="${data('icon-128.png', 'image/png')}">SaudaPulse</div>
    <h1>Все магазины Kaspi — в одном окне</h1>
    <p>Заказы, сроки, сборка, накладные и прибыль 2–5 магазинов. 30 дней бесплатно.</p></div>
    <div class="f"><div class="bar"><i></i><i></i><i></i></div><img src="${data('home.webp', 'image/webp')}"></div>
  </body></html>`, { waitUntil: 'load' });
  await p.screenshot({ path: path.join(A, 'og.png') });
  await b.close();
  console.log('og.png');
})();
