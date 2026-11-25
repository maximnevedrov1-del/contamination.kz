/**
 * Signed licence: JWT verification (ES256 / RS256) against PUBLIC keys, no dependencies.
 *
 * The subscription state is read ONLY from an access token signed by the auth server's private
 * key, so editing browser storage or replaying fake server answers cannot grant access.
 * Shared with saas-core-template/extension-core/license-signature.js (keep the two identical).
 * background/billing.js wires it to shared/billing-config.js.
 *
 *   const v = createLicenseVerifier({ keys: [jwk, …], issuer: 'https://<project>.supabase.co/auth/v1' });
 *   v.required()                 // true when at least one key is configured (signature check on)
 *   await v.verifiedClaims(jwt)  // payload, or null when anything is wrong
 *
 * `keys` and `issuer` may be values or functions returning them (read lazily, at first use).
 * Rejected: alg none / HS256, private (`d`) or symmetric (`k`) JWKs, wrong issuer, wrong audience,
 * missing exp/iat, wrong `sub`, wrong signature length, unknown `kid`.
 */

const b64url = (str) => {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

const ALGS = {
  ES256: { kty: 'EC', import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
  RS256: { kty: 'RSA', import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
};

const val = (v) => (typeof v === 'function' ? v() : v);

/**
 * @param {object} opts { keys: object[] | (() => object[]), issuer: string | (() => string), audience?: string }
 */
export function createLicenseVerifier({ keys, issuer, audience = 'authenticated' }) {
  const list = () => {
    const k = val(keys);
    return Array.isArray(k) ? k : [];
  };
  let keysPromise = null;
  const verifyingKeys = () => {
    keysPromise ??= Promise.all(
      list().map(async (jwk) => {
        const alg = Object.keys(ALGS).find((a) => ALGS[a].kty === jwk?.kty);
        if (!alg || (jwk.alg && jwk.alg !== alg) || (alg === 'ES256' && jwk.crv !== 'P-256')) return null;
        if (jwk.d || jwk.k) return null; // a private/symmetric key was pasted by mistake — never use it
        const { kty, crv, x, y, n, e } = jwk; // public parts only
        const key = await crypto.subtle.importKey('jwk', { kty, crv, x, y, n, e }, ALGS[alg].import, false, ['verify']).catch(() => null);
        return key && { kid: jwk.kid || null, alg, key };
      }),
    ).then((all) => all.filter(Boolean));
    return keysPromise;
  };

  return {
    required: () => list().length > 0,

    /** Claims of a JWT whose signature checks out against `keys`; otherwise null. */
    async verifiedClaims(jwt, expectedSub = null) {
      const parts = String(jwt || '').split('.');
      if (parts.length !== 3) return null;
      let header, payload;
      try {
        header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
        payload = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
      } catch {
        return null;
      }
      if (!ALGS[header?.alg]) return null; // never "none" or HS256 (symmetric: the secret would have to ship in the client)
      if (payload?.iss !== val(issuer) || (expectedSub && payload.sub !== expectedSub)) return null;
      // User tokens only (not anon/service keys or tokens of another audience), with a lifetime.
      if (payload.aud !== audience || !Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) return null;
      const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      let sig;
      try {
        sig = b64url(parts[2]);
      } catch {
        return null;
      }
      if (header.alg === 'ES256' && sig.length !== 64) return null; // JWS ES256 = raw r||s, 64 bytes
      for (const k of await verifyingKeys()) {
        if (k.alg !== header.alg || (header.kid && k.kid && k.kid !== header.kid)) continue;
        if (await crypto.subtle.verify(ALGS[k.alg].verify, k.key, sig, data).catch(() => false)) return payload;
      }
      return null;
    },
  };
}
