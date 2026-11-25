// Product photo from the Kaspi product page (shared/kaspi-photo.js).
//   node tests/unit/kaspi-photo.test.mjs
import assert from 'node:assert/strict';
import { productPageUrl, codeFromProductLink, photoFromProductPage } from '../../shared/kaspi-photo.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('product page of a Kaspi product code', () => {
  assert.equal(productPageUrl('103403297'), 'https://kaspi.kz/shop/p/-103403297/');
  assert.equal(productPageUrl('12;evil'), null);
});

t('code from the link the seller pastes (with or without slug, query, city)', () => {
  assert.equal(codeFromProductLink('https://kaspi.kz/shop/p/fruktovik-jabloko-chernyi-prints-pol-sha-1-kg-103403297/'), '103403297');
  assert.equal(codeFromProductLink('https://kaspi.kz/shop/p/-103403297/?c=750000000'), '103403297');
  assert.equal(codeFromProductLink(' https://kaspi.kz/shop/p/iphone-15-128gb-113137790 '), '113137790');
  for (const bad of ['https://evil.com/shop/p/x-123456/', 'http://kaspi.kz/shop/p/x-123456/', 'https://kaspi.kz/shop/c/phones/', 'kaspi', '']) assert.equal(codeFromProductLink(bad), null, bad);
});

t('og:image on Kaspi CDN → medium-size link; anything else refused', () => {
  const page = '<head><meta property="og:image" content="https://resources.cdn-kaspi.kz/img/m/p/hea/h0e/64221419175966.jpg?format=gallery-large"></head>';
  assert.equal(photoFromProductPage(page), 'https://resources.cdn-kaspi.kz/img/m/p/hea/h0e/64221419175966.jpg?format=gallery-medium');
  assert.equal(photoFromProductPage('<meta content="https://resources.cdn-kaspi.kz/img/m/p/a/b/1.jpg" property="og:image">'), 'https://resources.cdn-kaspi.kz/img/m/p/a/b/1.jpg?format=gallery-medium');
  for (const bad of ['<meta property="og:image" content="https://evil.com/x.jpg">', '<meta property="og:image" content="javascript:alert(1)">', '<meta property="og:image" content="https://resources.cdn-kaspi.kz/../../x.jpg">', '<html>captcha</html>', '']) assert.equal(photoFromProductPage(bad), null, bad);
});

console.log(`\n${n} checks passed`);
