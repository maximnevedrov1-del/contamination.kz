// Banner / expiry helpers.   node tests/unit/notices.test.mjs
import assert from 'node:assert/strict';
import { bannerFrom, expiryNotice } from '../../extension-core/notices.js';

// bannerFrom
assert.equal(bannerFrom(null), null);
assert.equal(bannerFrom({}), null);
assert.equal(bannerFrom({ systemBanner: { active: false, text: 'x' } }), null);
assert.equal(bannerFrom({ systemBanner: { active: true, text: '   ' } }), null);
assert.equal(bannerFrom({ systemBanner: { active: true } }), null);
assert.equal(bannerFrom({ systemBanner: 'x' }), null);
assert.deepEqual(bannerFrom({ systemBanner: { active: true, text: ' Привет ', type: 'warn' } }), { text: 'Привет', type: 'warn' });
assert.equal(bannerFrom({ systemBanner: { active: true, text: 'a', type: 'evil' } }).type, 'info');
assert.equal(bannerFrom({ systemBanner: { active: true, text: 'a'.repeat(500) } }).text.length, 300);

// expiryNotice
const v = (status, daysLeft) => ({ status, daysLeft });
assert.equal(expiryNotice(v('trial', 0)), null);
assert.deepEqual(expiryNotice(v('trial', 1)), { days: 1, kind: 'trial' });
assert.deepEqual(expiryNotice(v('trial', 3)), { days: 3, kind: 'trial' });
assert.equal(expiryNotice(v('trial', 4)), null);
assert.deepEqual(expiryNotice(v('active', 2)), { days: 2, kind: 'paid' });
assert.deepEqual(expiryNotice({ status: 'active', daysLeft: 2, cancelAt: '2026-12-01' }), { days: 2, kind: 'paid' });
for (const s of ['grace', 'expired', 'frozen', 'offline', 'loggedOut']) assert.equal(expiryNotice(v(s, 2)), null, s);
assert.equal(expiryNotice(null), null);
assert.equal(expiryNotice({ status: 'trial' }), null);
assert.equal(expiryNotice({ status: 'trial', daysLeft: 'x' }), null);
console.log('notices: ok');
