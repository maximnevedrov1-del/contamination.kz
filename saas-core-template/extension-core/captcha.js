/**
 * Captcha before an e-mail code is sent (Cloudflare Turnstile, checked by Supabase Auth).
 *
 * A Chrome extension may not load Cloudflare's script into its own pages (Manifest V3 forbids
 * remote code), so the widget lives on our site (CAPTCHA.pageUrl, source: captcha/index.html)
 * and is shown here in an iframe inside a small dialog. The page posts back:
 *   { source: 'saas-captcha', type: 'ready' }            — page loaded (sent before the widget)
 *   { source: 'saas-captcha', type: 'token', token }     — check passed
 *   { source: 'saas-captcha', type: 'error' | 'expired' } — widget problem, user can retry
 *
 * getCaptchaToken() resolves:
 *   - the token (string) — send it with /auth/v1/otp as gotrue_meta_security.captcha_token;
 *   - null — captcha is off (empty pageUrl) or the page did not load in time; the request is then
 *     sent without a token: it works while captcha is off in Supabase, otherwise the server answers
 *     with a captcha error (billingCaptcha), so nobody is silently locked out by a dead page.
 * It rejects with Error('captchaCancelled') when the user closes the dialog.
 */
import { CAPTCHA } from './billing-config.js';

const SOURCE = 'saas-captcha';

/** Pure part, unit-tested: what a message from the frame means for us. */
export function readCaptchaMessage(data) {
  if (!data || typeof data !== 'object' || data.source !== SOURCE) return null;
  if (data.type === 'token') return typeof data.token === 'string' && data.token.length > 10 && data.token.length < 4096 ? { type: 'token', token: data.token } : null;
  if (['ready', 'error', 'expired'].includes(data.type)) return { type: data.type };
  return null;
}

export const captchaEnabled = () => !!CAPTCHA.pageUrl;

/**
 * @param {{ t?: (key:string)=>string, lang?: string, readyMs?: number }} [opts]
 * @returns {Promise<string|null>}
 */
export function getCaptchaToken({ t = (k) => k, lang = 'ru', readyMs = CAPTCHA.readyTimeoutMs } = {}) {
  if (!captchaEnabled()) return Promise.resolve(null);
  const url = new URL(CAPTCHA.pageUrl);
  url.searchParams.set('lang', lang);
  const origin = url.origin;

  return new Promise((resolve, reject) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog captcha-dialog';
    dlg.setAttribute('aria-label', t('captcha.title'));
    const form = document.createElement('form');
    form.method = 'dialog';
    const title = document.createElement('h2');
    title.className = 'dialog__title';
    title.textContent = t('captcha.title');
    const text = document.createElement('p');
    text.className = 'dialog__text';
    text.textContent = t('captcha.text');
    const frame = document.createElement('iframe');
    frame.className = 'captcha-frame';
    frame.title = t('captcha.title');
    frame.src = url.href;
    frame.width = '304';
    frame.height = '72';
    frame.setAttribute('referrerpolicy', 'no-referrer');
    const status = document.createElement('p');
    status.className = 'muted small';
    status.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'dialog__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn--ghost';
    cancel.textContent = t('common.cancel');
    actions.append(cancel);
    form.append(title, text, frame, status, actions);
    dlg.append(form);
    document.body.append(dlg);

    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(readyTimer);
      window.removeEventListener('message', onMessage);
      try { dlg.close(); } catch { /* already closed */ }
      dlg.remove();
      fn(value);
    };
    // page never answered (not published yet, site down, blocked) → go on without a token
    const readyTimer = setTimeout(() => finish(resolve, null), readyMs);
    const onMessage = (e) => {
      if (e.origin !== origin || e.source !== frame.contentWindow) return;
      const m = readCaptchaMessage(e.data);
      if (!m) return;
      if (m.type === 'ready') clearTimeout(readyTimer);
      else if (m.type === 'token') finish(resolve, m.token);
      else status.textContent = t(m.type === 'expired' ? 'captcha.expired' : 'captcha.error');
    };
    window.addEventListener('message', onMessage);
    cancel.addEventListener('click', () => finish(reject, new Error('captchaCancelled')));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(reject, new Error('captchaCancelled'));
    });
    dlg.showModal();
  });
}
