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
  supabaseUrl: '',
  supabaseAnonKey: '',
  // How often the licence is re-checked online, and how long a cached licence is
  // trusted while the server cannot be reached.
  refreshMinutes: 10,
  offlineGraceDays: 3,
  // PUBLIC signing key(s) of the Supabase project (Settings → JWT Keys, the ES256
  // key's public JWK — the entries of https://<project>.supabase.co/auth/v1/.well-known/jwks.json).
  // When set, the subscription is read ONLY from tokens signed by this key, so it cannot
  // be faked by editing the browser storage. Paste the objects as they are, e.g.
  //   licenseKeys: [{ kty: 'EC', crv: 'P-256', x: '…', y: '…', kid: '…', alg: 'ES256' }],
  licenseKeys: [],
});

/**
 * Public offer and privacy policy shown next to the consent checkbox.
 * Empty URL → the copy bundled in the extension (legal/terms.html) is opened.
 * After publishing the texts on your site, put the links here; when the texts
 * change, also raise «Версия условий» in the admin page so clients accept again.
 */
export const LEGAL = Object.freeze({
  offerUrl: '',
  privacyUrl: '',
});

/** Link for the offer ('offer') or the privacy policy ('privacy'). */
export function legalUrl(kind) {
  const own = kind === 'privacy' ? LEGAL.privacyUrl : LEGAL.offerUrl;
  return own || chrome.runtime.getURL(`legal/terms.html#${kind}`);
}
