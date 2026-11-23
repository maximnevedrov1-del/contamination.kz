/**
 * Price-list feeds (Supabase Storage): one secret XML feed per store that Kaspi downloads.
 * Split out of billing.js (which keeps login, licence and invoices); uses its session.
 */
import { BILLING } from '../shared/billing-config.js';
import { BillingError, currentToken as accessToken, rpcWith } from './billing.js';

/** Secret feed of one store (created on first use). */
export async function ensureFeed(shopKey) {
  const token = await accessToken();
  if (!token) throw new BillingError('billingLoggedOut');
  return rpcWith(token, 'ensure_price_feed', { p_shop_key: shopKey });
}

/** Public URL Kaspi fetches the price list from. */
export const feedUrl = (feedId, shopKey) => `${BILLING.supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/pricelists/${feedId}/${shopKey}.xml`;

/** Upload (overwrite) the store's XML price list. */
export async function uploadFeed(feedId, shopKey, xml) {
  const token = await accessToken();
  if (!token) throw new BillingError('billingLoggedOut');
  let res;
  try {
    res = await fetch(`${BILLING.supabaseUrl.replace(/\/$/, '')}/storage/v1/object/pricelists/${feedId}/${shopKey}.xml`, {
      method: 'POST',
      headers: { apikey: BILLING.supabaseAnonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/xml', 'x-upsert': 'true', 'cache-control': 'max-age=60' },
      body: new Blob([xml], { type: 'application/xml' }),
    });
  } catch (e) {
    throw new BillingError('billingNetwork', e.message);
  }
  if (res.status === 413) throw new BillingError('feedTooLarge');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Storage answers 400 {"statusCode":"403","message":"new row violates row-level security policy"}
    if (res.status === 401 || res.status === 403 || /row-level security|"403"|Unauthorized/i.test(text)) throw new BillingError('feedForbidden', text.slice(0, 200));
    throw new BillingError('billingHttp', `${res.status} ${text.slice(0, 200)}`);
  }
  return feedUrl(feedId, shopKey);
}
