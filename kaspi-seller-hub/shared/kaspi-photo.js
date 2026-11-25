/**
 * SaudaPulse — the main photo of a product, from its public page on kaspi.kz (pure, unit-tested).
 *
 * Kaspi's API gives every order line the code of its Kaspi product card (q3207). That code opens
 * the public product page kaspi.kz/shop/p/-<code>/, whose og:image is the main photo on Kaspi's
 * image CDN (resources.cdn-kaspi.kz). Only that CDN address is kept — never anything else from the page.
 */

const CODE_RE = /^\d{3,20}$/;

/** Public product page of a Kaspi product code. */
export const productPageUrl = (code) => (CODE_RE.test(String(code)) ? `https://kaspi.kz/shop/p/-${code}/` : null);

/** Kaspi product code from a product page link the seller pasted (…/shop/p/<slug>-<code>/…), else null. */
export function codeFromProductLink(link) {
  let u;
  try {
    u = new URL(String(link || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !(u.hostname === 'kaspi.kz' || u.hostname.endsWith('.kaspi.kz'))) return null;
  const m = u.pathname.match(/^\/shop\/p\/(?:[^/]*-)?(\d{3,20})\/?$/);
  return m ? m[1] : null;
}

/** Main photo (og:image) of a product page, only if it is on Kaspi's image CDN; medium size for thumbnails. */
export function photoFromProductPage(html) {
  const text = String(html || '').slice(0, 2_000_000);
  const m = text.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || text.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (!m) return null;
  let u;
  try {
    u = new URL(m[1].replace(/&amp;/g, '&'));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'resources.cdn-kaspi.kz' || !/^\/img\/m\/p\/[\w/.-]+\.(jpe?g|png|webp)$/i.test(u.pathname)) return null;
  return `${u.origin}${u.pathname}?format=gallery-medium`;
}
