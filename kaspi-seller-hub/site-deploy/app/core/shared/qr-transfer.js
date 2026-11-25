/**
 * SaudaPulse — «Перенести на телефон» in one tap: a QR code on the computer screen, scanned by
 * the phone app's own camera screen (never by another app, never through a server).
 *
 * Text in the QR:  SP1.<base64url(deflate-raw(JSON))>
 *   JSON = { v:1, exp:<ms>, stores:{id:{name,alias,color}}, tokens:{id:token}, costs?, profit?, deadlines? }
 * - Short-lived: refused after `exp` (2 minutes after it is shown).
 * - Not a link: a phone camera app shows it as plain text and opens nothing; only the SaudaPulse
 *   app reads it. It is not encrypted (the key would have to be in the same picture): treat the
 *   QR on screen like the token itself — the dialog hides it after 2 minutes.
 * - Cost prices and profit settings are added only while the code stays easy to scan; otherwise
 *   they travel later in a .spbackup file.
 * The payload goes through the same sanitizePayload() as .spbackup files.
 */
import { sanitizePayload } from './spbackup.js';

export const QR_PREFIX = 'SP1.';
export const QR_TTL_MS = 2 * 60000;
/** Above this length a QR gets too dense to scan comfortably from a laptop screen. */
export const QR_MAX_CHARS = 1600;

const b64u = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s) => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const deflate = (text) => pipe(new TextEncoder().encode(text), new CompressionStream('deflate-raw'));
const inflate = async (bytes) => new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate-raw')));

export class QrTransferError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * @param {{ stores, tokens, costs?, profit?, deadlines? }} payload owner data
 * @returns {Promise<{ text: string, withCosts: boolean, exp: number }>}
 */
export async function encodeTransfer(payload, { now = Date.now(), maxChars = QR_MAX_CHARS } = {}) {
  const clean = sanitizePayload(payload, 'owner');
  if (!Object.keys(clean.tokens).length) throw new QrTransferError('backupNoStores');
  const exp = now + QR_TTL_MS;
  const base = { v: 1, exp, stores: clean.stores, tokens: clean.tokens };
  const money = { costs: clean.costs, profit: clean.profit, deadlines: clean.deadlines };
  const full = `${QR_PREFIX}${b64u(await deflate(JSON.stringify({ ...base, ...money, photos: clean.photos })))}`;
  if (full.length <= maxChars) return { text: full, withCosts: true, withPhotos: !!clean.photos, exp };
  const mid = `${QR_PREFIX}${b64u(await deflate(JSON.stringify({ ...base, ...money })))}`;
  if (mid.length <= maxChars) return { text: mid, withCosts: true, withPhotos: false, exp };
  const slim = `${QR_PREFIX}${b64u(await deflate(JSON.stringify(base)))}`;
  if (slim.length > maxChars * 1.6) throw new QrTransferError('qrTooBig'); // dozens of stores: use the file
  return { text: slim, withCosts: false, withPhotos: false, exp };
}

/** Text read from a QR → sanitized owner payload (stores, tokens, costs…). */
export async function decodeTransfer(text, { now = Date.now() } = {}) {
  text = String(text || '').trim();
  if (!text.startsWith(QR_PREFIX) || text.length > 6000 || !/^[A-Za-z0-9_-]+$/.test(text.slice(QR_PREFIX.length))) throw new QrTransferError('qrNotOurs');
  let data;
  try {
    data = JSON.parse(await inflate(unb64u(text.slice(QR_PREFIX.length))), (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
  } catch {
    throw new QrTransferError('qrNotOurs');
  }
  if (!data || data.v !== 1 || !Number.isFinite(data.exp)) throw new QrTransferError('qrNotOurs');
  if (now > data.exp) throw new QrTransferError('qrExpired');
  if (data.exp - now > QR_TTL_MS + 5 * 60000) throw new QrTransferError('qrNotOurs'); // a code «valid for a year» was not made by us
  const payload = sanitizePayload(data, 'owner');
  if (!('costs' in data)) {
    delete payload.costs; // not sent: leave the phone's own cost prices and settings alone
    delete payload.profit;
    delete payload.deadlines;
  }
  return payload;
}

/** QR matrix (true = dark) for a text, using vendored qrcode-generator (passed in: no DOM needed). */
export function qrMatrix(qrcode, text) {
  const q = qrcode(0, 'L');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}
