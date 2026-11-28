/**
 * Advertisements (Stage 04). The ONLY thing a subscription changes.
 *
 * `raw` is the answer of the server's get_entitlements() (billing/supabase/036_supporter.sql); the client never
 * computes a plan or a payment state itself. Unknown, missing or malformed data means «show ads» (free tier),
 * never «hide». No business function reads any of this.
 */
const FREE = Object.freeze({ status: 'free', adFree: false, showAds: true, endsAt: null, cancelAt: null, priceMonth: 5000, currency: 'KZT', maxMonths: 12, paymentsEnabled: false, pendingInvoice: null });

/** @returns {typeof FREE} */
export function normalizeEntitlements(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...FREE };
  const endsAt = typeof raw.ends_at === 'string' && Number.isFinite(Date.parse(raw.ends_at)) ? raw.ends_at : null;
  // ad-free only when the server said so AND the period it reported has not run out meanwhile
  const adFree = raw.ad_free === true && raw.show_ads === false && !!endsAt && Date.parse(endsAt) > now;
  const status = adFree ? (raw.status === 'supporter_ending' ? 'supporter_ending' : 'supporter') : ['expired', 'free'].includes(raw.status) ? raw.status : 'free';
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
  return {
    status,
    adFree,
    showAds: !adFree,
    endsAt: adFree ? endsAt : null,
    cancelAt: adFree && raw.cancel_at ? String(raw.cancel_at) : null,
    priceMonth: num(raw.price_month, FREE.priceMonth),
    currency: 'KZT',
    maxMonths: Math.min(24, num(raw.max_months, FREE.maxMonths)),
    paymentsEnabled: raw.payments_enabled === true,
    pendingInvoice: raw.pending_invoice && typeof raw.pending_invoice === 'object' ? raw.pending_invoice : null,
  };
}

/** True when an advertisement may be rendered. */
export const adsVisible = (ent) => (ent ? ent.showAds !== false : true);

// ---- the ads themselves (Stage 05) ----
// get_ads() (037_advertising.sql) already validates everything; this is a second, independent check so that a
// compromised or buggy server answer can never put a non-https link, a script URL or markup into the UI.
const URL_RE = /^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}|xn--[a-z0-9-]{2,20})(\/[^\s<>"'\\#]*)?$/i;
const IMG_RE = /^https:\/\/[^/?#]+\/[^?#\s]*\.(png|jpe?g|webp)$/i;
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, max) : '');
export const MAX_ADS = 3;

/** @returns {{ showAds: boolean, fallback: boolean, ads: Array<{id:number, kind:string, sponsor:string, headline:string, body:string, image:string|null, alt:string, url:string}> }} */
export function normalizeAds(raw) {
  const none = { showAds: true, fallback: false, ads: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return none;
  if (raw.show_ads === false) return { showAds: false, fallback: false, ads: [] };   // ad-free: nothing, ever
  if (!Array.isArray(raw.ads)) return none;
  const ads = [];
  for (const a of raw.ads) {
    if (!a || typeof a !== 'object' || ads.length >= MAX_ADS) continue;
    const id = Number(a.id);
    const url = typeof a.destination_url === 'string' && a.destination_url.length <= 500 && a.destination_url.startsWith('https://') && URL_RE.test(a.destination_url) ? a.destination_url : null;
    const headline = text(a.headline, 80);
    if (!Number.isSafeInteger(id) || id <= 0 || !url || !headline || !['sponsor', 'internal'].includes(a.kind)) continue;
    const image = typeof a.creative_url === 'string' && IMG_RE.test(a.creative_url) && a.creative_url.startsWith('https://') && a.creative_url.length <= 500 ? a.creative_url : null;
    ads.push({ id, kind: a.kind, sponsor: text(a.sponsor_name, 80), headline, body: text(a.body, 200), image, alt: text(a.creative_alt, 120), url });
  }
  return { showAds: true, fallback: raw.fallback === true && ads.length > 0, ads };
}
