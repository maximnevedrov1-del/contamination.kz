/**
 * {{APP_NAME}} — subscription server (Supabase project).
 *
 * Fill these two values from Supabase → Project Settings → API:
 *   - Project URL        → supabaseUrl
 *   - anon public key    → supabaseAnonKey   (public by design; access is enforced
 *                                             by Row Level Security in the database)
 * While both are empty the extension runs in DEVELOPER MODE: no login, no limits.
 * Never put the service_role key here.
 */
/** Parses the LICENSE_PUBLIC_JWK value (JSON array or single JWK); anything else → [] (developer mode, no signature check). */
function parseJwks(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  } catch {
    return [];
  }
}

/** Product identity, filled by scripts/init-new-saas.mjs. */
export const APP = Object.freeze({
  name: '{{APP_NAME}}',
  slug: '{{APP_SLUG}}',
  domain: '{{APP_DOMAIN}}',
  currency: '{{CURRENCY}}',
  currencySymbol: '{{CURRENCY_SYMBOL}}',
  trialDays: Number('{{TRIAL_DAYS}}') || 0,
});

export const BILLING = Object.freeze({
  supabaseUrl: 'https://{{SUPABASE_PROJECT_ID}}.supabase.co',
  supabaseAnonKey: '{{SUPABASE_ANON_KEY}}',
  // How often the licence is re-checked online, and how long a cached licence is
  // trusted while the server cannot be reached.
  refreshMinutes: 30,
  offlineGraceDays: 3,
  // PUBLIC signing key(s) of the Supabase project (Settings → JWT Keys, the ES256
  // key's public JWK — the entries of https://<project>.supabase.co/auth/v1/.well-known/jwks.json).
  // When set, the subscription is read ONLY from tokens signed by this key, so it cannot
  // be faked by editing the browser storage. The value is a JSON array of public JWKs
  // (or one JWK object); empty / invalid → [] (developer mode, no signature check).
  licenseKeys: parseJwks('{{LICENSE_PUBLIC_JWK}}'),
});
// Deep-freeze the keys so nothing running later in the worker can add its own key.
Object.freeze(BILLING.licenseKeys);
BILLING.licenseKeys.forEach(Object.freeze);

/**
 * Captcha before the e-mail code (Cloudflare Turnstile, checked by Supabase Auth).
 * pageUrl — our site page with the widget (source: captcha/index.html). Empty → no captcha.
 * Publish the page BEFORE releasing a version with this URL; turn captcha on in Supabase
 * (Authentication → Attack Protection) only AFTER most clients have updated.
 * readyTimeoutMs — if the page does not answer in this time, the code is requested without a token.
 */
export const CAPTCHA = Object.freeze({
  pageUrl: 'https://{{APP_DOMAIN}}/captcha',
  readyTimeoutMs: 6000,
});

/**
 * Public offer and privacy policy shown next to the consent checkbox.
 * Empty URL → the copy bundled in the extension (legal/terms.html) is opened.
 * After publishing the texts on your site, put the links here; when the texts
 * change, also raise «Версия условий» in the admin page so clients accept again.
 */
export const LEGAL = Object.freeze({
  offerUrl: 'https://{{APP_DOMAIN}}/offer',
  privacyUrl: 'https://{{APP_DOMAIN}}/privacy',
});

/** Link for the offer ('offer') or the privacy policy ('privacy'). */
export function legalUrl(kind) {
  const own = kind === 'privacy' ? LEGAL.privacyUrl : LEGAL.offerUrl;
  return own || chrome.runtime.getURL(`legal/terms.html#${kind}`);
}

/**
 * Support contacts shown on the «Помощь» page. Fill in what you use; empty ones are hidden.
 *   whatsapp — number in international format, digits only: '77011234567'
 *   telegram — user name (a leading @ is stripped by the UI)
 */
export const SUPPORT = Object.freeze({
  whatsapp: '',
  telegram: '@{{TELEGRAM_HANDLE}}',
  email: '{{SUPPORT_EMAIL}}',
  hours: 'Пн–Вс, 09:00–21:00 (Алматы)',
});
