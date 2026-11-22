/**
 * Kaspi Seller Hub — subscription server (Supabase project).
 *
 * Fill these two values from Supabase → Project Settings → API:
 *   - Project URL        → supabaseUrl
 *   - anon public key    → supabaseAnonKey   (public by design; access is enforced
 *                                             by Row Level Security in the database)
 * While both are empty the extension runs in DEVELOPER MODE: no login, no limits.
 * Never put the service_role key here.
 */
export const BILLING = Object.freeze({
  supabaseUrl: 'https://zraktrilvwrfpcbmkqwi.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpyYWt0cmlsdndyZnBjYm1rcXdpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUyMjE4MzgsImV4cCI6MjExMDc5NzgzOH0.57Hd8d70R2OVjC40H_Ej552xWXn9_vFK4XasiAvU-XA',
  // How often the licence is re-checked online, and how long a cached licence is
  // trusted while the server cannot be reached.
  refreshMinutes: 30,
  offlineGraceDays: 3,
  // PUBLIC signing key(s) of the Supabase project (Settings → JWT Keys, the ES256
  // key's public JWK — the entries of https://<project>.supabase.co/auth/v1/.well-known/jwks.json).
  // When set, the subscription is read ONLY from tokens signed by this key, so it cannot
  // be faked by editing the browser storage. Paste the objects as they are, e.g.
  //   licenseKeys: [{ kty: 'EC', crv: 'P-256', x: '…', y: '…', kid: '…', alg: 'ES256' }],
  licenseKeys: [
    { kty: 'EC', crv: 'P-256', alg: 'ES256', kid: '1cdfdce0-66d9-457a-9b62-035d1d1ebaff', x: 'cvZImr8hS_rStHS_VwlVXrcb1N-TdhmdeCw-G7zHono', y: 'fFNyzE2N12mbol8pLyOwNuEuQ46UXl5ezpEYKKyv938' },
    { kty: 'EC', crv: 'P-256', alg: 'ES256', kid: 'aa6ca63c-7540-45b2-a3ca-19669682cbae', x: 'Migl7uXgj3nGAKRkPmocOjnhssv8on2yBt1ibCp1kRE', y: 'ncjgsnfCQcFqKv-1Z9HvfFuTRQ0Xy7VByX350IUn-pQ' },
  ],
});
// Deep-freeze the keys so nothing running later in the worker can add its own key.
Object.freeze(BILLING.licenseKeys);
BILLING.licenseKeys.forEach(Object.freeze);

/**
 * Public offer and privacy policy shown next to the consent checkbox.
 * Empty URL → the copy bundled in the extension (legal/terms.html) is opened.
 * After publishing the texts on your site, put the links here; when the texts
 * change, also raise «Версия условий» in the admin page so clients accept again.
 */
export const LEGAL = Object.freeze({
  offerUrl: 'https://saudapulse.kz/offer',
  privacyUrl: 'https://saudapulse.kz/privacy',
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
  telegram: '@SaudaPulse',
  email: 'support@saudapulse.kz',
  hours: 'Пн–Вс, 09:00–21:00 (Алматы)',
});
