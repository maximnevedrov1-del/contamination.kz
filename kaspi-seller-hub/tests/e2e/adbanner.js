// Advertising banner (Stage 06) in the REAL dashboard (real extension, real CSS), with the worker's ad/entitlement
// answers stubbed in the page. Covers: placement, desktop/mobile size, 30 s rotation (fake clock), manual navigation,
// pause (button / hover / keyboard focus / hidden tab), supporter exclusion, empty / error / hang, internal promo,
// tracking calls, layout shift, keyboard + ARIA, two languages. Screenshots → docs/transformation/evidence/.
//   node tests/e2e/adbanner.js
const { chromium } = require('playwright'); require('./offline');
const path = require('path');
const fs = require('fs');
const EXT = path.join(__dirname, '../..');
const SHOTS = path.join(EXT, '../docs/transformation/evidence');
fs.mkdirSync(SHOTS, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const AD = (id, o = {}) => ({ id, kind: 'sponsor', sponsor: `Sponsor ${id}`, headline: `Headline ${id}: a rather long offer title for sellers`, body: `Body text ${id} that explains the offer in one line`, image: 'https://cdn.example.kz/a.png', alt: '', url: `https://ad${id}.example.kz/promo`, ...o });
const FREE = { ok: true, entitlements: { adFree: false, showAds: true } };
const SUP = { ok: true, entitlements: { adFree: true, showAds: false } };
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : extra); };

async function open(ctx, id, stub, { hint = false } = {}) {
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.clock.install({ time: Date.now() });
  await p.addInitScript(({ stub, hint }) => {
    window.__stub = stub; window.__calls = [];
    if (hint) { try { localStorage.setItem('ksh.adHint', '1'); } catch {} } else { try { localStorage.removeItem('ksh.adHint'); } catch {} }
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    const answer = (v, delay) => new Promise((res, rej) => { const f = () => (v instanceof Object && v.__throw ? rej(new Error(v.__throw)) : res(v)); delay ? setTimeout(f, delay) : f(); });
    chrome.runtime.sendMessage = (msg, ...rest) => {
      if (msg && ['ui:adsGet', 'ui:supporterGet', 'ui:adsEvent'].includes(msg.type)) {
        window.__calls.push({ type: msg.type, payload: msg.payload });
        const s = window.__stub;
        if (msg.type === 'ui:adsEvent') return Promise.resolve({ ok: true });
        if (msg.type === 'ui:supporterGet') return answer(s.sup, 0);
        if (s.hang) return new Promise(() => {});
        return answer(s.ads, s.delay || 0);
      }
      return orig(msg, ...rest);
    };
    // layout shift budget
    window.__cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; (window.__clsLog ||= []).push({ v: e.value, t: Math.round(e.startTime), nodes: (e.sources || []).map((x) => (x.node && (x.node.id || x.node.className || x.node.nodeName)) + '') }); } }).observe({ type: 'layout-shift', buffered: true });
    // controllable tab visibility
    let hidden = false;
    Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible'), configurable: true });
    window.__setHidden = (v) => { hidden = v; document.dispatchEvent(new Event('visibilitychange')); };
  }, { stub, hint });
  await p.goto(`chrome-extension://${id}/dashboard/dashboard.html#home`);
  await p.waitForSelector('#pageTitle:not(:empty)', { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(600);
  await p.clock.pauseAt((await p.evaluate(() => Date.now())) + 500);   // from here only runFor() moves time: deterministic 30 s checks
  await p.waitForTimeout(700);
  return { p, errs };
}
const state = (p) => p.evaluate(() => document.getElementById('adSlot').dataset.adState);
const head = (p) => p.evaluate(() => document.querySelector('.ad-banner__headline')?.textContent || null);
const calls = (p, type) => p.evaluate((t) => window.__calls.filter((c) => c.type === t), type);
const box = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vis: getComputedStyle(e).display !== 'none' && r.height > 0 }; }, sel);
const tick = async (p, ms) => { await p.clock.runFor(ms); await p.waitForTimeout(150); };

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'adprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route('https://cdn.example.kz/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await ctx.route('https://ad*.example.kz/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>sponsor</title>' }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];

  // ---------- 1. free user, 3 campaigns, desktop ----------
  {
    const { p, errs } = await open(ctx, id, { sup: FREE, ads: { ok: true, showAds: true, ads: [AD(1), AD(2), AD(3)] } }, { hint: true });
    check('ready state', (await state(p)) === 'ready', await state(p));
    const b = await box(p, '#adSlot .ad-banner');
    check('desktop height 60–80 px', b && b.h >= 60 && b.h <= 80, JSON.stringify(b));
    const order = await p.evaluate(() => { const s = document.getElementById('adSlot'); const m = s.previousElementSibling; const hd = m?.previousElementSibling; return [hd?.tagName, hd?.className, m?.className, s.nextElementSibling?.id]; });
    check('placed directly below the main header (header → sync line → ad → notices)', order[0] === 'HEADER' && order[1] === 'topbar' && order[3] === 'banners', JSON.stringify(order));
    check('exactly one ad slot / one banner element', (await p.locator('#adSlot').count()) === 1 && (await p.locator('.ad-banner').count()) === 1);
    check('sponsored content is labelled', (await p.locator('.ad-banner__label').innerText()) === 'Реклама' && (await p.locator('.ad-banner__sponsor').innerText()) === 'Sponsor 1');
    check('shows 3 campaigns, "1 / 3"', (await p.locator('.ad-banner__pos').innerText()) === '1 / 3');
    check('image shown', await p.evaluate(() => { const i = document.querySelector('.ad-banner__img'); return !!i && i.naturalWidth > 0; }));
    const a = p.locator('.ad-banner__link');
    check('link: https, new tab, noopener, sponsored, no referrer', (await a.getAttribute('href')) === 'https://ad1.example.kz/promo' && (await a.getAttribute('target')) === '_blank' && /noopener/.test(await a.getAttribute('rel')) && /sponsored/.test(await a.getAttribute('rel')) && (await a.getAttribute('referrerpolicy')) === 'no-referrer');
    const viewTop0 = (await box(p, '#view')).y;
    check('impression sent once for the first ad, ids only', JSON.stringify(await calls(p, 'ui:adsEvent')) === JSON.stringify([{ type: 'ui:adsEvent', payload: { id: 1, event: 'impression' } }]), JSON.stringify(await calls(p, 'ui:adsEvent')));
    await p.screenshot({ path: `${SHOTS}/stage06-desktop-light-or-default.png` });

    // rotation
    await tick(p, 25000); check('no change before 30 s (25 s in)', (await head(p)).startsWith('Headline 1'));
    await tick(p, 6000); check('auto-rotates at 30 s → ad 2', (await head(p)).startsWith('Headline 2'), await head(p));
    await tick(p, 30000); check('→ ad 3', (await head(p)).startsWith('Headline 3'));
    await tick(p, 30000); check('wraps → ad 1', (await head(p)).startsWith('Headline 1'));
    check('each campaign counted once (3 impressions)', (await calls(p, 'ui:adsEvent')).filter((c) => c.payload.event === 'impression').map((c) => c.payload.id).join() === '1,2,3', JSON.stringify(await calls(p, 'ui:adsEvent')));
    console.log('   CLS log (page load + rotation):', JSON.stringify(await p.evaluate(() => window.__clsLog)));
    check('no layout shift from rotation (view top constant)', (await box(p, '#view')).y === viewTop0);
    check('height identical across ads', (await box(p, '#adSlot .ad-banner')).h === b.h);

    // manual navigation
    await p.click('[data-ad-action=next]'); check('next → ad 2', (await head(p)).startsWith('Headline 2'));
    await p.click('[data-ad-action=prev]'); await p.click('[data-ad-action=prev]'); check('prev ×2 wraps → ad 3', (await head(p)).startsWith('Headline 3'));
    await p.mouse.move(5, 5);
    // pause button
    await p.click('[data-ad-action=pause]'); await p.mouse.move(5, 5);
    check('pause button flips to play (aria-label)', (await p.locator('[data-ad-action=play]').getAttribute('aria-label')) === 'Возобновить смену объявлений');
    await tick(p, 120000); check('paused: no rotation in 2 min', (await head(p)).startsWith('Headline 3'));
    await p.click('[data-ad-action=play]'); await p.mouse.move(5, 5); await tick(p, 30500); check('resume → rotates again', (await head(p)).startsWith('Headline 1'), await head(p));
    // hover pause
    await p.hover('.ad-banner'); await tick(p, 90000); check('hover pauses', (await head(p)).startsWith('Headline 1'));
    await p.mouse.move(5, 5); await tick(p, 30500); check('mouse leaves → rotates', (await head(p)).startsWith('Headline 2'), await head(p));
    // hidden tab
    const imp0 = (await calls(p, 'ui:adsEvent')).length;
    await p.evaluate(() => window.__setHidden(true)); await tick(p, 120000);
    check('hidden tab: no rotation, no new impression', (await head(p)).startsWith('Headline 2') && (await calls(p, 'ui:adsEvent')).length === imp0);
    await p.evaluate(() => window.__setHidden(false)); await tick(p, 29000); check('visible again: full interval first', (await head(p)).startsWith('Headline 2'));
    await tick(p, 1500); check('…then rotates', (await head(p)).startsWith('Headline 3'), await head(p));
    // click tracking
    const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null), p.click('.ad-banner__link')]);
    await popup?.close().catch(() => {});
    check('click sends {id, click} only', (await calls(p, 'ui:adsEvent')).some((c) => c.payload.event === 'click' && c.payload.id === 3 && Object.keys(c.payload).sort().join() === 'event,id'));
    check('page never sent anything but ids (no order/store data in ad calls)', (await p.evaluate(() => window.__calls.every((c) => c.type === 'ui:adsEvent' ? Object.keys(c.payload).sort().join() === 'event,id' : true))));

    // accessibility
    await p.mouse.move(5, 5); await p.waitForTimeout(150);
    const a11y = await p.evaluate(() => {
      const bar = document.querySelector('.ad-banner');
      const names = [...bar.querySelectorAll('button')].map((x) => x.getAttribute('aria-label'));
      return { region: bar.getAttribute('role') + '/' + bar.getAttribute('aria-roledescription') + '/' + bar.getAttribute('aria-label'), names, live: bar.querySelector('.ad-banner__stage').getAttribute('aria-live'), link: document.querySelector('.ad-banner__link').getAttribute('aria-label'), imgAlt: document.querySelector('.ad-banner__img')?.getAttribute('alt'), tiny: [...bar.querySelectorAll('button')].filter((x) => x.getBoundingClientRect().width < 24 || x.getBoundingClientRect().height < 24).length };
    });
    check('a11y: group/carousel with a name, labelled buttons, link name mentions "Реклама", decorative image alt=""', /group\/carousel\/Реклама/.test(a11y.region) && a11y.names.every(Boolean) && a11y.names.length === 3 && /^Реклама Sponsor \d:/.test(a11y.link) && a11y.imgAlt === '' && a11y.tiny === 0, JSON.stringify(a11y));
    check('a11y: live region is "off" while auto-rotating', a11y.live === 'off', a11y.live);
    // keyboard
    await p.mouse.move(5, 5);
    await p.focus('.ad-banner__link'); await p.keyboard.press('Tab'); await p.keyboard.press('Tab'); // → prev? order: link, prev, next
    const f1 = await p.evaluate(() => document.activeElement.dataset.adAction);
    await p.keyboard.press('Enter');
    const f2 = await p.evaluate(() => document.activeElement.dataset.adAction);
    check('keyboard: Tab reaches controls, Enter activates, focus stays on the button after re-render', f1 === 'next' && f2 === 'next', `${f1}/${f2}`);
    const h0 = await head(p); await tick(p, 90000);
    check('keyboard focus inside the banner pauses rotation', (await head(p)) === h0);
    check('polite live region when paused', (await p.locator('.ad-banner__stage').getAttribute('aria-live')) === 'polite');
    await p.keyboard.press('Shift+Tab'); await p.keyboard.press('Shift+Tab'); await p.keyboard.press('Shift+Tab'); await p.keyboard.press('Shift+Tab');
    await p.screenshot({ path: `${SHOTS}/stage06-desktop-focus.png`, clip: { x: 0, y: 0, width: 1440, height: 220 } });
    // language
    await p.evaluate(() => document.querySelector('#langSwitch [data-lang=kk]').click()); await p.waitForTimeout(400);
    check('language switch re-renders the label (kk: «Жарнама»)', (await p.locator('.ad-banner__label').innerText()) === 'Жарнама', await p.locator('.ad-banner__label').innerText());
    await p.screenshot({ path: `${SHOTS}/stage06-desktop-kk.png`, clip: { x: 0, y: 0, width: 1440, height: 220 } });
    check('no page errors (ad scenario)', !errs.length, errs.join(';'));

    // business workflow unaffected: navigate with the banner on
    await p.evaluate(() => (location.hash = '#orders')); await p.waitForTimeout(500);
    check('navigation works with the banner visible; banner persists, one only', (await p.locator('#pageTitle').innerText()).length > 0 && (await p.locator('.ad-banner').count()) === 1 && (await box(p, '#view')).vis);
    await p.close();
  }

  // ---------- 2. dark theme screenshot ----------
  {
    const { p } = await open(ctx, id, { sup: FREE, ads: { ok: true, showAds: true, ads: [AD(1), AD(2)] } });
    await p.emulateMedia({ colorScheme: 'light' }); await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await p.waitForTimeout(300);
    await p.screenshot({ path: `${SHOTS}/stage06-desktop-light.png`, clip: { x: 0, y: 0, width: 1440, height: 220 } });
    await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await p.waitForTimeout(300);
    await p.screenshot({ path: `${SHOTS}/stage06-desktop-dark.png`, clip: { x: 0, y: 0, width: 1440, height: 220 } });
    await p.close();
  }

  // ---------- 3. mobile ----------
  for (const [name, vp] of [['mobile-390', { width: 390, height: 844 }], ['mobile-360', { width: 360, height: 740 }], ['mobile-320', { width: 320, height: 640 }], ['tablet-768', { width: 768, height: 1024 }]]) {
    const { p } = await open(ctx, id, { sup: FREE, ads: { ok: true, showAds: true, ads: [AD(1), AD(2), AD(3)] } });
    await p.setViewportSize(vp); await p.waitForTimeout(400);
    const b = await box(p, '#adSlot .ad-banner');
    const m = await p.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, btns: [...document.querySelectorAll('.ad-banner__btn')].map((x) => { const r = x.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), r.right <= document.documentElement.clientWidth]; }), headlineW: document.querySelector('.ad-banner__headline').getBoundingClientRect().width, labelVisible: !!document.querySelector('.ad-banner__label').offsetParent }));
    if (vp.width <= 760) check(`${name}: height 50–60 px`, b.h >= 50 && b.h <= 60, String(b.h)); else check(`${name}: height 60–80 px`, b.h >= 60 && b.h <= 80, String(b.h));
    check(`${name}: no horizontal scroll, controls inside viewport and ≥24 px, label visible, headline has room`, m.overflow <= 0 && m.btns.every((x) => x[0] >= 24 && x[1] >= 24 && x[2]) && m.labelVisible && m.headlineW >= 60, JSON.stringify(m));
    if (vp.width === 390) { await p.screenshot({ path: `${SHOTS}/stage06-mobile-390.png` }); await p.screenshot({ path: `${SHOTS}/stage06-mobile-390-top.png`, clip: { x: 0, y: 0, width: 390, height: 260 } }); }
    if (vp.width === 320) await p.screenshot({ path: `${SHOTS}/stage06-mobile-320-top.png`, clip: { x: 0, y: 0, width: 320, height: 260 } });
    await p.close();
  }

  // ---------- 4. single ad: no controls, no rotation ----------
  {
    const { p } = await open(ctx, id, { sup: FREE, ads: { ok: true, showAds: true, ads: [AD(1, { image: null })] } });
    check('one ad: controls not drawn', (await p.locator('.ad-banner__controls').count()) === 0 && (await state(p)) === 'ready');
    await tick(p, 120000); check('one ad: stays', (await head(p)).startsWith('Headline 1'));
    check('missing image: no hole, no img element', (await p.locator('.ad-banner__img').count()) === 0);
    await p.close();
  }

  // ---------- 5. internal promo ----------
  {
    const { p } = await open(ctx, id, { sup: FREE, ads: { ok: true, showAds: true, fallback: true, ads: [AD(7, { kind: 'internal', sponsor: '', headline: 'Подключите Telegram-бота', body: 'Дайджест заказов утром', image: null, url: 'https://saudapulse.kz/bot' })] } });
    const label = await p.locator('.ad-banner__label').innerText();
    check('internal promo shown when no sponsor, labelled "SaudaPulse" (not "Реклама")', label === 'SaudaPulse' && (await head(p)) === 'Подключите Telegram-бота', label);
    await p.screenshot({ path: `${SHOTS}/stage06-internal.png`, clip: { x: 0, y: 0, width: 1440, height: 220 } });
    await p.close();
  }

  // ---------- 6. active supporter ----------
  {
    const { p, errs } = await open(ctx, id, { sup: SUP, ads: { ok: true, showAds: true, ads: [AD(1), AD(2)] } }, { hint: true });
    const b = await box(p, '#adSlot');
    check('SUPPORTER: slot hidden, zero height, no ad nodes, even when the ads answer has campaigns', (await state(p)) === 'adfree' && (!b || !b.vis) && (await p.locator('.ad-banner').count()) === 0 && (await p.locator('.ad-banner__link').count()) === 0, JSON.stringify(b));
    check('SUPPORTER: no impression/click sent', (await calls(p, 'ui:adsEvent')).length === 0);
    check('SUPPORTER: loading placeholder cleared (hint did not leave an empty box)', !(await box(p, '#adSlot'))?.vis);
    const t0 = await p.evaluate(() => document.getElementById('view').getBoundingClientRect().top);
    check('SUPPORTER: no page errors', !errs.length, errs.join(';'));
    await tick(p, 120000); check('SUPPORTER: stays hidden over time', (await state(p)) === 'adfree');
    await p.close();
  }
  // supporter via the ads answer only (entitlement call failed)
  {
    const { p } = await open(ctx, id, { sup: { __throw: 'sw' }, ads: { ok: true, showAds: false, ads: [] } });
    check('SUPPORTER (entitlement unknown, server says show_ads=false): hidden', (await state(p)) === 'adfree' && !(await box(p, '#adSlot'))?.vis);
    await p.close();
  }

  // ---------- 7. empty / error / hang / signed out ----------
  for (const [name, stub, want] of [
    ['empty list', { sup: FREE, ads: { ok: true, showAds: true, ads: [] } }, 'empty'],
    ['worker error (ok:false)', { sup: FREE, ads: { ok: false, error: 'x' } }, 'error'],
    ['request rejected', { sup: FREE, ads: { __throw: 'Extension context invalidated' } }, 'error'],
    ['garbage answer', { sup: FREE, ads: 'nonsense' }, 'error'],
    ['both calls fail', { sup: { __throw: 'a' }, ads: { __throw: 'b' } }, 'error'],
  ]) {
    const { p, errs } = await open(ctx, id, stub, { hint: true });
    await p.waitForTimeout(300);
    const st = await state(p); const bx = await box(p, '#adSlot');
    check(`${name}: slot hidden (state ${want}), takes no room, no error text`, (st === want || (want === 'error' && st === 'empty')) && (!bx || !bx.vis) && (await p.locator('#adSlot').innerText()).trim() === '', `${st} ${JSON.stringify(bx)}`);
    await p.evaluate(() => (location.hash = '#orders')); await p.waitForTimeout(400);
    check(`${name}: business navigation still works, no page errors`, (await p.locator('#pageTitle').innerText()).length > 0 && !errs.length, errs.join(';'));
    await p.close();
  }
  {
    const { p, errs } = await open(ctx, id, { sup: FREE, hang: true });
    check('hang: banner hidden/loading-free while waiting, dashboard usable', !(await box(p, '#adSlot'))?.vis && !errs.length);
    await p.evaluate(() => (location.hash = '#orders')); await p.waitForTimeout(300);
    check('hang: navigation works while the ad request is pending', (await p.locator('#pageTitle').innerText()).length > 0);
    await tick(p, 9000); check('hang: gives up after the 8 s timeout → error state', (await state(p)) === 'error', await state(p));
    await p.close();
  }
  {
    // retry after an error: first answer fails, then campaigns appear
    const { p } = await open(ctx, id, { sup: FREE, ads: { ok: false, error: 'x' } });
    await p.evaluate(() => { window.__stub.ads = { ok: true, showAds: true, ads: [{ id: 1, kind: 'sponsor', sponsor: 'S', headline: 'H1', body: '', image: null, alt: '', url: 'https://ad1.example.kz/' }] }; });
    await tick(p, 61000); await p.waitForTimeout(300);
    check('error → automatic retry after 60 s recovers', (await state(p)) === 'ready', await state(p));
    await p.close();
  }

  // ---------- 8. reserved space while loading (no layout shift) ----------
  {
    const { p } = await open(ctx, id, { sup: FREE, delay: 800, ads: { ok: true, showAds: true, ads: [AD(1), AD(2)] } }, { hint: true });
    const st = await state(p); const during = await box(p, '#adSlot .ad-banner');
    check('loading: space reserved at final height (skeleton, aria-busy)', st === 'loading' && during && during.h === 72 && (await p.locator('#adSlot').getAttribute('aria-busy')) === 'true', `${st} ${JSON.stringify(during)}`);
    await p.screenshot({ path: `${SHOTS}/stage06-loading.png`, clip: { x: 0, y: 0, width: 1440, height: 220 } });
    const topBefore = (await box(p, '#view')).y;
    await tick(p, 900); await p.waitForTimeout(300);
    console.log('   CLS log (loading→ready):', JSON.stringify(await p.evaluate(() => window.__clsLog)));
    check('loading → ready: content does not move', (await state(p)) === 'ready' && (await box(p, '#view')).y === topBefore);
    await p.close();
  }

  // ---------- 9. reduced motion ----------
  {
    const p = await ctx.newPage(); await p.close();
    const { p: q } = await (async () => { await ctx.pages()[0]?.emulateMedia?.({ reducedMotion: 'reduce' }); return open(ctx, id, { sup: FREE, ads: { ok: true, showAds: true, ads: [AD(1), AD(2)] } }); })();
    await q.emulateMedia({ reducedMotion: 'reduce' }); await q.reload(); await q.waitForTimeout(800);
    await tick(q, 120000);
    check('prefers-reduced-motion: no automatic rotation; manual navigation still works', (await head(q)).startsWith('Headline 1'));
    await q.click('[data-ad-action=next]'); check('reduced motion: next works', (await head(q)).startsWith('Headline 2'));
    await q.close();
  }

  await ctx.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(EXT, '../docs/transformation/evidence/stage06-e2e.txt'), results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ' — ' + r.extra}`).join('\n') + `\n\n${results.length - bad.length}/${results.length} checks passed\n`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
