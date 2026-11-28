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
