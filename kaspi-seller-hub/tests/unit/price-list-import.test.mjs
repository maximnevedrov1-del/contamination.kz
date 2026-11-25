// Importing the price list downloaded from the Kaspi cabinet (shared/catalog.js rowsToOffers).
// Format per guide.kaspi.kz/partner/ru/shop/goods/price_list/q2962: SKU, model, brand, price, PP1–PP5
// (quantity on each warehouse, or yes / no), preorder. No photo or product link in the file.
//   node tests/unit/price-list-import.test.mjs
import assert from 'node:assert/strict';
import { rowsToOffers } from '../../shared/catalog.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const head = ['SKU', 'model', 'brand', 'price', 'PP1', 'PP2', 'PP3', 'PP4', 'PP5', 'preorder'];

t('PP1–PP5 quantities are the stock (added up across warehouses)', () => {
  const { offers } = rowsToOffers([head, ['A1', 'Фильтр', 'Bosch', '5000', '20', '', '', '', '', ''], ['A2', 'Масло', 'Shell', '9000', '3', '4', '', '', '', '2']]);
  assert.equal(offers[0].stock, 20);
  assert.equal(offers[1].stock, 7);
  assert.equal(offers[1].preOrder, 2);
  assert.equal(offers[0].price, 5000);
});

t('«yes» / «no» still work: yes without a number = 1, no = 0', () => {
  const { offers } = rowsToOffers([head, ['B1', 'x', 'y', '100', 'yes', 'no', '', '', '', ''], ['B2', 'x', 'y', '100', 'no', '', '', '', '', '']]);
  assert.equal(offers[0].stock, 1);
  assert.equal(offers[1].stock, 0);
});

t('a quantity wins over yes in another warehouse; 0 means out of stock', () => {
  const { offers } = rowsToOffers([head, ['C1', 'x', 'y', '100', 'yes', '5', '', '', '', ''], ['C2', 'x', 'y', '100', '0', '', '', '', '', '']]);
  assert.equal(offers[0].stock, 5);
  assert.equal(offers[1].stock, 0);
});

console.log(`\n${n} checks passed`);
