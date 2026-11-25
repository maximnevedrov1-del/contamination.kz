// Stock write-off from orders (shared/stock-moves.js).
//   node tests/unit/stock-moves.test.mjs
import assert from 'node:assert/strict';
import { applyOrderStock, seedLedger } from '../../shared/stock-moves.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const T0 = Date.UTC(2026, 10, 25, 6);
const iso = (ms) => new Date(ms).toISOString();
const catalog = () => ({
  'SKU-1': { sku: 'SKU-1', title: 'Фильтр', stock: 99, stores: { A: { on: true, price: 5000, stock: 20 }, B: { on: true, price: 5000, stock: 7 } } },
  'SKU-2': { sku: 'SKU-2', title: 'Масло', stock: 5, stores: { A: { on: true, price: 9000, stock: 3 } } },
});
const order = (id, status, entries, at = T0 + 3600000, kind = 'order') => ({ id, kind, status, date: iso(at), entries: entries.map(([sku, quantity]) => ({ sku, quantity })) });
const run = (ordersByShop, extra = {}) => applyOrderStock({ catalog: catalog(), ledger: {}, ordersByShop, importedAt: { A: T0, B: T0 }, now: T0 + 7200000, ...extra });

t('packed order: −1 / −2 in that store only; Kaspi price list of that store must be re-sent', () => {
  const cat = catalog();
  const r = applyOrderStock({ catalog: cat, ledger: {}, ordersByShop: { A: [order('100', 'packed', [['SKU-1', 1], ['SKU-2', 2]])] }, importedAt: { A: T0 }, now: T0 + 7200000 });
  assert.equal(r.catalog['SKU-1'].stores.A.stock, 19);
  assert.equal(r.catalog['SKU-2'].stores.A.stock, 1);
  assert.equal(r.catalog['SKU-1'].stores.B.stock, 7); // other store untouched
  assert.deepEqual(r.changedShops, ['A']);
  assert.equal(cat['SKU-1'].stores.A.stock, 20); // input not mutated
  assert.deepEqual(r.moves.map((m) => [m.sku, m.qty, m.left]), [['SKU-1', -1, 19], ['SKU-2', -2, 1]]);
});

t('only once per order, also across syncs (ledger)', () => {
  const o = order('100', 'packed', [['SKU-1', 3]]);
  const r1 = run({ A: [o] });
  const r2 = applyOrderStock({ catalog: r1.catalog, ledger: r1.ledger, ordersByShop: { A: [{ ...o, status: 'delivered' }] }, importedAt: { A: T0 }, now: T0 + 9000000 });
  assert.equal(r2.catalog['SKU-1'].stores.A.stock, 17);
  assert.equal(r2.count, 0);
  assert.deepEqual(r2.changedShops, []);
});

t('new / accepted orders are not written off yet; delivering and delivered are', () => {
  const r = run({ A: [order('1', 'new', [['SKU-1', 1]]), order('2', 'accepted', [['SKU-1', 1]]), order('3', 'delivering', [['SKU-1', 2]]), order('4', 'delivered', [['SKU-2', 1]])] });
  assert.equal(r.catalog['SKU-1'].stores.A.stock, 18);
  assert.equal(r.catalog['SKU-2'].stores.A.stock, 2);
});

t('cancelled after packing → stock comes back once; a return is not put back automatically', () => {
  const r1 = run({ A: [order('7', 'packed', [['SKU-1', 4]]), order('8', 'packed', [['SKU-2', 1]])] });
  assert.equal(r1.catalog['SKU-1'].stores.A.stock, 16);
  const later = { A: [order('7', 'cancelled', [['SKU-1', 4]], undefined, 'refusal'), order('8', 'returned', [['SKU-2', 1]], undefined, 'return')] };
  const r2 = applyOrderStock({ catalog: r1.catalog, ledger: r1.ledger, ordersByShop: later, importedAt: { A: T0 }, now: T0 + 9000000 });
  assert.equal(r2.catalog['SKU-1'].stores.A.stock, 20);
  assert.equal(r2.catalog['SKU-2'].stores.A.stock, 2);
  const r3 = applyOrderStock({ catalog: r2.catalog, ledger: r2.ledger, ordersByShop: later, importedAt: { A: T0 }, now: T0 + 9900000 });
  assert.equal(r3.catalog['SKU-1'].stores.A.stock, 20); // not twice
});

t('history before the import, stores without import, unknown SKUs: nothing changes', () => {
  const r = applyOrderStock({
    catalog: catalog(), ledger: {}, now: T0 + 7200000,
    importedAt: { A: T0 },
    ordersByShop: { A: [order('old', 'packed', [['SKU-1', 5]], T0 - 20 * 86400000), order('x', 'packed', [['NOPE', 1]])], B: [order('b1', 'packed', [['SKU-1', 1]])] },
  });
  assert.equal(r.catalog['SKU-1'].stores.A.stock, 20);
  assert.equal(r.catalog['SKU-1'].stores.B.stock, 7);
  assert.deepEqual(r.changedShops, []);
  assert.ok(r.ledger['A::x']); // remembered: not retried every sync
});

t('import: orders already shipped are not written off; an order that came before the import and ships after it is', () => {
  const before = [order('s1', 'packed', [['SKU-1', 2]], T0 - 3600000), order('w1', 'accepted', [['SKU-1', 3]], T0 - 3600000), order('c1', 'cancelled', [['SKU-1', 1]], T0 - 3600000, 'refusal')];
  const ledger = seedLedger({}, 'A', before, T0);
  assert.deepEqual(Object.keys(ledger).sort(), ['A::c1', 'A::s1']);
  const after = [order('s1', 'delivered', [['SKU-1', 2]], T0 - 3600000), order('w1', 'packed', [['SKU-1', 3]], T0 - 3600000), order('c1', 'cancelled', [['SKU-1', 1]], T0 - 3600000, 'refusal')];
  const r = applyOrderStock({ catalog: catalog(), ledger, ordersByShop: { A: after }, importedAt: { A: T0 }, now: T0 + 7200000 });
  assert.equal(r.catalog['SKU-1'].stores.A.stock, 17); // only w1: −3
});

t('never below zero; contents not loaded yet → wait for the next sync', () => {
  const r = run({ A: [order('9', 'packed', [['SKU-2', 10]]), { id: '10', kind: 'order', status: 'packed', date: iso(T0 + 3600000) }] });
  assert.equal(r.catalog['SKU-2'].stores.A.stock, 0);
  assert.equal(r.ledger['A::10'], undefined);
});

t('old ledger entries are dropped after 120 days', () => {
  const r = applyOrderStock({ catalog: catalog(), ledger: { 'A::old': { at: T0 - 200 * 86400000, lines: [] } }, ordersByShop: {}, importedAt: {}, now: T0 });
  assert.deepEqual(r.ledger, {});
});

console.log(`\n${n} checks passed`);
