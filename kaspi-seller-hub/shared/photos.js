/**
 * SaudaPulse — product photos for picking (order card, pick list, cost prices).
 *
 * Kaspi's order API gives name, SKU and quantity, but no picture. A photo is found by SKU:
 *   1. the photo the seller set for that SKU (link from the Kaspi product page, or a file);
 *   2. otherwise the first photo of the product in «Выгрузка товаров».
 *
 * Only two kinds of source are shown:
 *   - images on Kaspi's own hosts (resources.cdn-kaspi.kz …) — the release build allows
 *     exactly these hosts in its Content-Security-Policy;
 *   - a file the seller chose, stored as a small JPEG data: URL (resized to ≤ 400 px).
 * Any other address is refused: it would leak the seller's IP to a third-party host and
 * the release CSP would block it anyway.
 */

/** Hosts the release CSP allows for <img> (keep in sync with tools/build-release.mjs). */
export const PHOTO_HOSTS = ['cdn-kaspi.kz', 'kaspi.kz'];
export const MAX_PHOTO_DATA = 400 * 1024; // characters of the data: URL
/** All own photo files together (ksh.photos is one storage key, rewritten on every change). */
export const MAX_PHOTOS_DATA = 40 * 1024 * 1024;
/** Characters taken by uploaded files (data: URLs); Kaspi links are tiny and not counted. */
export const photosDataSize = (photos = {}) => Object.values(photos).reduce((n, v) => n + (typeof v === 'string' && v.startsWith('data:') ? v.length : 0), 0);
const DATA_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

/** Is this a photo source the extension may store and show? */
export function isAllowedPhoto(src) {
  if (typeof src !== 'string' || !src) return false;
  if (src.startsWith('data:')) return src.length <= MAX_PHOTO_DATA && DATA_RE.test(src);
  try {
    const u = new URL(src);
    return u.protocol === 'https:' && !u.username && !u.password && PHOTO_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Photo for an order line / product key (SKU, or the name when the SKU is unknown).
 * @param {string} key
 * @param {Record<string,string>} photos seller's own photos by SKU
 * @param {Record<string,{images?:string[]}>} catalog «Выгрузка товаров» products by SKU
 */
export function photoFor(key, photos = {}, catalog = {}) {
  if (!key) return null;
  const own = photos[key];
  if (isAllowedPhoto(own)) return own;
  return (catalog[key]?.images || []).find(isAllowedPhoto) || null;
}

/**
 * A chosen image file → JPEG data: URL, longest side ≤ maxSide px (browser only).
 * @param {Blob} file
 */
export async function fileToPhoto(file, maxSide = 400) {
  if (!/^image\//.test(file?.type || '')) throw new Error('photoNotImage');
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * k));
  canvas.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNG → white, not black, in JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  for (const q of [0.82, 0.7, 0.55]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length <= MAX_PHOTO_DATA) return url;
  }
  throw new Error('photoTooBig');
}
