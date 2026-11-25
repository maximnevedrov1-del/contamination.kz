// One-tap transfer (shared/qr-transfer.js): text format, expiry, size, and a real round trip
// through the extension's QR picture (vendored qrcode-generator) and the phone's reader (jsQR).
//   node tests/unit/qr-transfer.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { encodeTransfer, decodeTransfer, qrMatrix, QR_PREFIX, QR_TTL_MS } from '../../shared/qr-transfer.js';
import qrcode from '../../vendor/qrcode/qrcode.mjs';

const jsQR = createRequire(import.meta.url)('../../app/vendor/jsQR.js');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const TOK = 'KaspiToken_QR_1234567890abcdef';
const payload = { stores: { 'api-1': { name: 'Магазин 1', color: '#eb6834' }, 'api-2': { name: 'Дом и уют' } }, tokens: { 'api-1': TOK, 'api-2': 'SecondToken_abcdefgh123' }, costs: { A: 100, B: 2500 }, profit: { defaultCommission: 12, byCategory: {} } };

/** Render a matrix like the extension's canvas (4-module quiet zone) and read it with jsQR. */
function readMatrix(m, scale = 4) {
  const n = m.length, size = (n + 8) * scale, px = new Uint8ClampedArray(size * size * 4).fill(255);
  m.forEach((row, r) => row.forEach((dark, c) => {
    if (!dark) return;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const i = (((r + 4) * scale + y) * size + (c + 4) * scale + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }));
  return jsQR(px, size, size)?.data || null;
}

await t('round trip: encode → QR picture → jsQR reads it → decode = same stores, tokens, costs', async () => {
  const { text, withCosts, exp } = await encodeTransfer(payload);
  assert.ok(text.startsWith(QR_PREFIX) && withCosts);
  assert.ok(!text.includes(TOK) && !text.includes('Магазин'));
  assert.ok(exp - Date.now() <= QR_TTL_MS);
  const read = readMatrix(qrMatrix(qrcode, text));
  assert.equal(read, text);
  const back = await decodeTransfer(read);
  assert.equal(back.tokens['api-1'], TOK);
  assert.equal(back.stores['api-2'].name, 'Дом и уют');
  assert.deepEqual(back.costs, { A: 100, B: 2500 });
  assert.equal(back.profit.defaultCommission, 12);
});

await t('expired after 2 minutes; a far-future expiry is refused too', async () => {
  const { text } = await encodeTransfer(payload, { now: Date.now() - QR_TTL_MS - 1000 });
  await assert.rejects(decodeTransfer(text), { code: 'qrExpired' });
  const { text: future } = await encodeTransfer(payload, { now: Date.now() + 365 * 86400000 });
  await assert.rejects(decodeTransfer(future), { code: 'qrNotOurs' });
});

await t('not ours: a link, random text, broken data', async () => {
  for (const x of ['https://evil.com', 'hello', 'SP1.!!!', 'SP1.AAAA', '']) await assert.rejects(decodeTransfer(x), { code: 'qrNotOurs' });
});

await t('many cost prices: the code stays small and leaves them out (phone keeps its own)', async () => {
  const costs = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`SKU-${i}-${Math.random().toString(36).slice(2)}`, i * 7]));
  const { text, withCosts } = await encodeTransfer({ ...payload, costs });
  assert.equal(withCosts, false);
  assert.ok(text.length <= 1600);
  const back = await decodeTransfer(text);
  assert.equal(back.costs, undefined);
  assert.equal(back.profit, undefined);
  assert.equal(back.tokens['api-1'], TOK);
  assert.equal(readMatrix(qrMatrix(qrcode, text)), text);
});

await t('no API stores → clear error', async () => {
  await assert.rejects(encodeTransfer({ stores: {}, tokens: {} }), { code: 'backupNoStores' });
});

console.log(`\n${n} checks passed`);
