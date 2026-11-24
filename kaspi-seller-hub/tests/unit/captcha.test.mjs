// Captcha frame messages: only well-formed messages from our page are accepted.
//   node tests/unit/captcha.test.mjs
import assert from 'node:assert/strict';
import { readCaptchaMessage, captchaEnabled } from '../../shared/captcha.js';
import { CAPTCHA } from '../../shared/billing-config.js';

const S = 'saudapulse-captcha';
assert.deepEqual(readCaptchaMessage({ source: S, type: 'ready' }), { type: 'ready' });
assert.deepEqual(readCaptchaMessage({ source: S, type: 'token', token: '0.abcdefghijklmnop' }), { type: 'token', token: '0.abcdefghijklmnop' });
assert.deepEqual(readCaptchaMessage({ source: S, type: 'expired' }), { type: 'expired' });
assert.deepEqual(readCaptchaMessage({ source: S, type: 'error', code: '110200' }), { type: 'error' });
assert.equal(readCaptchaMessage({ source: 'other', type: 'token', token: '0.abcdefghijklmnop' }), null, 'foreign source');
assert.equal(readCaptchaMessage({ source: S, type: 'token', token: 'short' }), null, 'too short');
assert.equal(readCaptchaMessage({ source: S, type: 'token', token: 'x'.repeat(5000) }), null, 'too long');
assert.equal(readCaptchaMessage({ source: S, type: 'token', token: 123456789012 }), null, 'not a string');
assert.equal(readCaptchaMessage({ source: S, type: 'eval' }), null, 'unknown type');
assert.equal(readCaptchaMessage('saudapulse-captcha'), null);
assert.equal(readCaptchaMessage(null), null);
// the page is on our https site, and the manifest lets the extension frame exactly that origin
assert.ok(CAPTCHA.pageUrl.startsWith('https://'), 'https page');
assert.equal(captchaEnabled(), true);
const { readFileSync } = await import('node:fs');
const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
assert.ok(manifest.content_security_policy.extension_pages.includes(new URL(CAPTCHA.pageUrl).origin), 'frame-src allows the captcha origin');
assert.ok(!/script-src[^;]*challenges\.cloudflare\.com/.test(manifest.content_security_policy.extension_pages), 'no remote script in the extension');
console.log('ok captcha messages');
