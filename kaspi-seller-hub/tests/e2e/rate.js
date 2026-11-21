// Counts server calls made by ONE user in each mode during 3 minutes.
const { chromium } = require('playwright');
const path = require('path');
const EXT = path.join(__dirname, '../billcopy');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => fetch('http://localhost:8098/__sql', { method: 'POST', body: JSON.stringify({ sql: q }) }).then((r) => r.json());
const logLen = async () => (await (await fetch('http://localhost:8098/__log')).json());
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'rateprof' + Date.now()), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  for (const x of ['a', 'b', 'c']) { const p = await ctx.newPage(); await p.goto(`file://${EXT}/demo/mc/store-${x}.html`); }
  const d = await ctx.newPage();
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#account`); await d.waitForSelector('input[type=email]');
  await d.fill('input[type=email]', 'rate@example.kz'); await d.check('label.consent input'); await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  await sleep(4000); await d.evaluate(() => (location.hash = 'orders'));
  const measure = async (name, ms) => {
    await d.bringToFront();
    const st = await d.evaluate(() => ({ hidden: document.hidden, pay: document.getElementById('payDialog').open }));
    const before = (await logLen()).length; await sleep(ms); const log = (await logLen()).slice(before).filter((e) => e.rpc || e.refresh);
    const by = log.reduce((m, e) => ((m[e.rpc || 'token refresh'] = (m[e.rpc || 'token refresh'] || 0) + 1), m), {});
    console.log(`${name} [hidden=${st.hidden} payWindow=${st.pay}]: ${log.length} calls in ${ms / 60000} min → ${Math.round((log.length * 3600000) / ms)}/hour`, JSON.stringify(by));
  };
  const force = () => d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:billingState', payload: { force: true } }));
  const payOpen = () => d.evaluate(() => document.getElementById('payDialog').open);
  await measure('normal (trial, dashboard open)', 180000);

  await sql("update accounts set trial_ends_at = now() + interval '3 days' where email = 'rate@example.kz'");
  await force(); await d.reload(); await sleep(5000);
  console.log('renewal: payment window opened by itself once:', await payOpen());
  if (await payOpen()) await d.click('#payDialog button:has-text("Позже")');
  await sleep(1000);
  await measure('renewal window (3 days left, dashboard open, window closed)', 180000);
  console.log('  window still closed:', !(await payOpen()));

  await sql("update accounts set trial_ends_at = now() - interval '1 day' where email = 'rate@example.kz'");
  await force(); await d.reload(); await sleep(5000);
  console.log('blocked: payment window open:', await payOpen());
  await measure('blocked, payment window open (tab visible)', 120000);
  const bg = await ctx.newPage(); await bg.goto('about:blank'); await bg.bringToFront();
  await sleep(1000);
  const before = (await logLen()).length; await sleep(120000);
  const n = (await logLen()).slice(before).filter((e) => e.rpc || e.refresh).length;
  console.log(`blocked, payment window, tab in background [hidden=${await d.evaluate(() => document.hidden)}]: ${n} calls in 2 min → ${n * 30}/hour`);
  await ctx.close();
})();
