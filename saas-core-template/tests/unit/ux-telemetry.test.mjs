// {{APP_NAME}} anonymous UX tracker: batching window, key validation, rage clicks, abandoned forms.   node tests/unit/ux-telemetry.test.mjs
import assert from 'node:assert/strict';
import { createUxTracker, createUxReporter, isValidKey, normalizeKey } from '../../extension-core/ux-telemetry.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('PASS', name); };

// fake clock + timer
function rig(opts = {}) {
  let t = 1_000_000; const timers = []; const sent = [];
  const tr = createUxTracker({
    send: (events) => { sent.push(events); },
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    ...opts,
  });
  const advance = (ms) => { t += ms; for (const x of timers) if (x.fn && x.at <= t) { const f = x.fn; x.fn = null; f(); } };
  return { tr, sent, advance, timers };
}

test('key validation: only short codes, never digits-only / URLs / text / cyrillic', () => {
  for (const ok of ['home', 'nav_orders', 'act_reason-send', 'a:b', 'a1', 'x'.repeat(64)]) assert.ok(isValidKey(ok), ok);
  for (const bad of ['', '123456', 'https://example.com/x', 'example.com', 'has space', 'Upper', 'кнопка', 'a/b', 'a@b', 'x'.repeat(65), null, undefined, 5]) assert.ok(!isValidKey(bad), String(bad));
  assert.equal(normalizeKey('connectDialog'), 'connectdialog');
  assert.equal(normalizeKey('my dialog!'), 'my_dialog_');
  assert.equal(normalizeKey('12345'), null);
  assert.equal(normalizeKey(''), null);
});

test('invalid events are dropped silently', () => {
  const { tr } = rig();
  assert.equal(tr.track('keylogger', 'home', 'home'), false);
  assert.equal(tr.track('action_click', 'https://x.kz', 'home'), false);
  assert.equal(tr.track('action_click', 'btn', '123'), false);
  assert.equal(tr.screenView('Кнопка'), false);
  assert.equal(tr.click('bad key'), false);
  assert.equal(tr.pendingCount(), 0);
});

test('batches in memory, aggregates counts, one flush per window', () => {
  const { tr, sent, advance } = rig();
  tr.screenView('home');
  for (let i = 0; i < 3; i++) { tr.click('nav_orders'); advance(5000); } // spaced out: no rage
  assert.equal(sent.length, 0, 'nothing sent before the window ends');
  tr.screenView('orders'); tr.screenView('home');
  advance(60000);
  assert.equal(sent.length, 1);
  const byKey = Object.fromEntries(sent[0].map((e) => [`${e.t}|${e.k}|${e.s}`, e.n]));
  assert.equal(byKey['action_click|nav_orders|home'], 3);
  assert.equal(byKey['screen_view|home|home'], 2);
  assert.deepEqual(Object.keys(sent[0][0]).sort(), ['k', 'n', 's', 't']);
  // next event starts a new window; no flush earlier than 60 s later
  tr.click('nav_home');
  advance(59000); assert.equal(sent.length, 1);
  advance(1000); assert.equal(sent.length, 2);
  advance(120000); assert.equal(sent.length, 2, 'empty batches are never sent');
});

test('explicit flush (page hidden) sends once and clears the batch', () => {
  const { tr, sent } = rig();
  tr.click('btn_sync');
  assert.equal(tr.flush(), true);
  assert.equal(tr.flush(), false);
  assert.equal(sent.length, 1);
});

test('send failures (throw / rejected promise) are swallowed', async () => {
  const a = createUxTracker({ send: () => { throw new Error('boom'); }, setTimer: () => 1 });
  a.click('x1'); assert.doesNotThrow(() => a.flush());
  const b = createUxTracker({ send: () => Promise.reject(new Error('no')), setTimer: () => 1 });
  b.click('x1'); assert.doesNotThrow(() => b.flush());
  await new Promise((r) => setTimeout(r, 5)); // no unhandled rejection
});

test('batch is bounded: distinct keys and per-event count', () => {
  const { tr, sent } = rig({ maxKeys: 3, maxCount: 4 });
  for (const k of ['a1', 'a2', 'a3', 'a4']) tr.track('action_click', k, 'home');
  for (let i = 0; i < 10; i++) tr.track('help_opened', 'a1', 'home');
  tr.flush();
  assert.equal(sent[0].length, 3);
  assert.ok(sent[0].every((e) => e.n <= 4));
});

test('rage click: 4 clicks within 2 s on the same key', () => {
  const { tr, sent, advance } = rig();
  tr.screenView('orders');
  for (let i = 0; i < 3; i++) { tr.click('btn_sync'); advance(300); }
  tr.flush();
  assert.ok(!sent[0].some((e) => e.t === 'rage_click'), '3 clicks are not rage');
  for (let i = 0; i < 4; i++) { tr.click('btn_sync'); advance(300); }
  tr.flush();
  const rage = sent[1].filter((e) => e.t === 'rage_click');
  assert.deepEqual(rage, [{ t: 'rage_click', k: 'btn_sync', s: 'orders', n: 1 }]);
  // slow clicks never count; other keys are independent
  for (let i = 0; i < 6; i++) { tr.click('btn_slow'); advance(1500); }
  for (let i = 0; i < 3; i++) { tr.click('nav_a'); tr.click('nav_b'); advance(100); }
  tr.flush();
  assert.ok(!sent[2].some((e) => e.t === 'rage_click'));
});

test('rage detection restarts after reporting (no event per extra click)', () => {
  const { tr, sent } = rig();
  for (let i = 0; i < 8; i++) tr.click('btn_x1');
  tr.flush();
  assert.equal(sent[0].find((e) => e.t === 'rage_click').n, 2);
});

test('abandoned form: open > 15 s and closed without save', () => {
  const { tr, sent, advance } = rig();
  tr.screenView('home');
  tr.formOpened('connectdialog'); advance(16000);
  assert.equal(tr.formClosed('connectdialog', false), true);
  tr.formOpened('connectdialog'); advance(16000);
  assert.equal(tr.formClosed('connectdialog', true), false, 'saved is not abandoned');
  tr.formOpened('connectdialog'); advance(5000);
  assert.equal(tr.formClosed('connectdialog', false), false, 'quick close is not abandoned');
  assert.equal(tr.formClosed('never_opened', false), false);
  tr.flush();
  assert.deepEqual(sent[0].filter((e) => e.t === 'form_abandoned'), [{ t: 'form_abandoned', k: 'connectdialog', s: 'home', n: 1 }]);
});

test('help opened', () => {
  const { tr, sent } = rig();
  tr.screenView('settings'); tr.help('gif_settings'); tr.help('bad key!');
  tr.flush();
  assert.deepEqual(sent[0].find((e) => e.t === 'help_opened'), { t: 'help_opened', k: 'gif_settings', s: 'settings', n: 1 });
});

{
  const calls = [];
  const rep = createUxReporter({ configured: () => true, getToken: async () => 'tok', rpc: async (...a) => { calls.push(a); } });
  await rep([{ t: 'rage_click', k: 'btn_x1', s: 'home', n: 99 }, { t: 'evil', k: 'a1', s: 'home', n: 1 }, { t: 'action_click', k: 'https://x', s: 'home', n: 1 }, { t: 'help_opened', k: 'tour', s: 'home', n: 1 }]);
  assert.equal(calls.length, 6, '5 (capped) + 1');
  assert.deepEqual(calls[0], ['tok', 'track_ux_event', { p_event_type: 'rage_click', p_target_key: 'btn_x1', p_screen_key: 'home' }]);
  const off = []; await createUxReporter({ configured: () => true, getToken: async () => null, rpc: async (...a) => off.push(a) })([{ t: 'screen_view', k: 'home', s: 'home', n: 1 }]);
  await createUxReporter({ configured: () => false, getToken: async () => 'tok', rpc: async (...a) => off.push(a) })([{ t: 'screen_view', k: 'home', s: 'home', n: 1 }]);
  assert.equal(off.length, 0);
  await createUxReporter({ configured: () => true, getToken: async () => 'tok', rpc: async () => { throw new Error('down'); } })([{ t: 'screen_view', k: 'home', s: 'home', n: 1 }]); // silent
  passed++; console.log('PASS reporter');
}

console.log(`${passed} passed`);
