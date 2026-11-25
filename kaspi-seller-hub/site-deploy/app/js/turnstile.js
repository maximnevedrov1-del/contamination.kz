/**
 * Cloudflare Turnstile, native on saudapulse.kz/app (no frame needed on our own site).
 * Returns the token for /auth/v1/otp (checked by Supabase Auth), or null when captcha is off
 * (no site key configured) or Cloudflare's script does not load in time — then the code is
 * requested without a token, exactly like the extension (shared/captcha.js).
 */
import { TURNSTILE_SITE_KEY, turnstileOn } from './config.js';

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading = null;
const load = () =>
  (loading ??= new Promise((ok, fail) => {
    if (globalThis.turnstile) return ok(globalThis.turnstile);
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (globalThis.turnstile ? ok(globalThis.turnstile) : fail(new Error('no turnstile')));
    s.onerror = () => fail(new Error('turnstile blocked'));
    document.head.append(s);
  }).catch((e) => ((loading = null), Promise.reject(e))));

/** @param {HTMLElement} box where the widget is shown @returns {Promise<string|null>} */
export async function getTurnstileToken(box, { timeoutMs = 8000 } = {}) {
  if (!turnstileOn()) return null;
  let ts;
  try {
    ts = await Promise.race([load(), new Promise((_, f) => setTimeout(() => f(new Error('timeout')), timeoutMs))]);
  } catch {
    return null;
  }
  box.replaceChildren();
  return new Promise((resolve, reject) => {
    const id = ts.render(box, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: 'auto',
      language: 'ru',
      callback: (token) => resolve(token),
      'error-callback': () => reject(Object.assign(new Error('billingCaptcha'), { code: 'billingCaptcha' })),
      'expired-callback': () => ts.reset(id),
    });
  });
}
