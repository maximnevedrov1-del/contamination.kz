/**
 * SaudaPulse — encrypted transfer file (.spbackup) between the Chrome extension and the phone app.
 *
 * No server sync: the owner saves a file on the computer, moves it to the phone (AirDrop,
 * cable, messenger «to myself») and opens it in the app with the passphrase. Kaspi tokens are
 * inside, so the file is ALWAYS encrypted:
 *   key  = PBKDF2-SHA-256(passphrase, random 16-byte salt, 600 000 iterations) → AES-GCM 256
 *   data = AES-GCM(random 12-byte IV, JSON payload), additional data = the file header
 * The header (format, version, scope, KDF parameters) is authenticated: changing «staff» to
 * «owner», or lowering the iterations, makes the file fail to open.
 *
 * Scopes:
 *   owner — stores + tokens + cost prices and profit settings (everything to work on the phone)
 *   staff — stores + tokens of the chosen stores + the owner's id; NO cost prices, NO profit
 *           settings, NO billing. Built for a packer's phone.
 * Pure Web Crypto: runs the same in the extension worker, the phone app and Node tests.
 */

export const SPBACKUP_FORMAT = 'spbackup';
export const SPBACKUP_VERSION = 1;
export const KDF_ITERATIONS = 600000;
const MIN_ITERATIONS = 200000;
const MAX_ITERATIONS = 5000000;
export const MIN_PASSPHRASE = 12;
const MAX_FILE = 20 * 1024 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = (buf) => {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new SpBackupError('backupInvalid');
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

export class SpBackupError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Canonical header text used as AES-GCM additional data (fixed key order). */
const headerAad = (h) => enc.encode(JSON.stringify([h.format, h.v, h.scope, h.createdAt, h.kdf.name, h.kdf.hash, h.kdf.iterations, h.kdf.salt, h.cipher.name, h.cipher.iv]));

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export const passphraseOk = (p) => typeof p === 'string' && p.normalize('NFC').length >= MIN_PASSPHRASE && p.length <= 256;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const TOKEN_RE = /^[A-Za-z0-9+/=_.\-]{8,512}$/;
const ID_RE = /^[A-Za-z0-9_.:\-]{1,64}$/;
const BAD_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const PHOTO_RE = /^https:\/\/resources\.cdn-kaspi\.kz\/img\/m\/p\/[\w/.-]+\.(jpe?g|png|webp)(\?format=gallery-(small|medium|large))?$/i;

/**
 * Keep only what a transfer file may carry, per scope. Applied when the file is made AND when it
 * is opened, so a hand-edited staff file still cannot bring money data onto a packer's phone.
 */
export function sanitizePayload(p, scope) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new SpBackupError('backupInvalid');
  const stores = {};
  const tokens = {};
  for (const [id, st] of Object.entries(p.stores || {}).slice(0, 50)) {
    if (!ID_RE.test(id) || BAD_IDS.has(id) || !st || typeof st !== 'object') continue;
    stores[id] = { name: str(st.name, 120) || id, alias: str(st.alias, 60), color: /^#[0-9a-f]{6}$/i.test(st.color || '') ? st.color : '#2a78d6' };
    const tok = p.tokens?.[id];
    if (typeof tok === 'string' && TOKEN_RE.test(tok.trim())) tokens[id] = tok.trim();
  }
  const out = { app: 'saudapulse', scope, stores, tokens };
  // product photos: links to Kaspi's image CDN only (never files, never other hosts) — packers see them too
  const photos = {};
  for (const [sku, url] of Object.entries(p.photos || {}).slice(0, 20000)) {
    if (typeof sku === 'string' && sku.length <= 200 && !BAD_IDS.has(sku) && PHOTO_RE.test(String(url || ''))) photos[sku] = url;
  }
  if (Object.keys(photos).length) out.photos = photos;
  if (scope === 'staff') {
    out.ownerId = /^[0-9a-f-]{36}$/i.test(p.ownerId || '') ? p.ownerId.toLowerCase() : null;
    if (!out.ownerId) throw new SpBackupError('backupNoOwner');
    return out; // nothing else: no cost prices, no profit, no licence, no orders
  }
  const num = (v) => (v == null || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null); // empty ≠ 0
  const costs = {};
  for (const [sku, v] of Object.entries(p.costs || {}).slice(0, 50000)) if (typeof sku === 'string' && sku.length <= 200 && num(v) != null) costs[sku] = num(v);
  out.costs = costs;
  const pr = p.profit || {};
  const byCategory = {};
  for (const [c, v] of Object.entries(pr.byCategory || {}).slice(0, 2000)) if (typeof c === 'string' && c.length <= 200 && num(v) != null && v <= 100) byCategory[c] = num(v);
  out.profit = { defaultCommission: num(pr.defaultCommission) != null && pr.defaultCommission <= 100 ? num(pr.defaultCommission) : null, byCategory };
  const dl = p.deadlines || {};
  out.deadlines = { acceptHours: num(dl.acceptHours) ?? 2, warnHours: num(dl.warnHours) ?? 2 };
  return out;
}

/**
 * @param {object} payload { stores, tokens, costs?, profit?, deadlines?, ownerId? }
 * @param {string} passphrase
 * @param {{ scope?: 'owner'|'staff', iterations?: number, now?: Date }} [opts]
 * @returns {Promise<object>} the file content (JSON-serialisable)
 */
export async function encryptBackup(payload, passphrase, { scope = 'owner', iterations = KDF_ITERATIONS, now = new Date() } = {}) {
  if (!['owner', 'staff'].includes(scope)) throw new SpBackupError('backupInvalid');
  if (!passphraseOk(passphrase)) throw new SpBackupError('backupWeakPassphrase');
  const clean = sanitizePayload(payload, scope);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = {
    format: SPBACKUP_FORMAT,
    v: SPBACKUP_VERSION,
    scope,
    createdAt: now.toISOString(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64u(salt) },
    cipher: { name: 'AES-GCM', iv: b64u(iv) },
  };
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: headerAad(header) }, key, enc.encode(JSON.stringify(clean)));
  return { ...header, data: b64u(ct) };
}

/** Header fields of a file, without decrypting (to show «файл для упаковщика от …»). */
export function readHeader(file) {
  const f = typeof file === 'string' ? safeParse(file) : file;
  if (!f || f.format !== SPBACKUP_FORMAT || f.v !== SPBACKUP_VERSION || !['owner', 'staff'].includes(f.scope)) throw new SpBackupError('backupInvalid');
  const it = f.kdf?.iterations;
  if (f.kdf?.name !== 'PBKDF2' || f.kdf?.hash !== 'SHA-256' || !Number.isInteger(it) || it < MIN_ITERATIONS || it > MAX_ITERATIONS) throw new SpBackupError('backupInvalid');
  if (f.cipher?.name !== 'AES-GCM' || typeof f.data !== 'string' || typeof f.createdAt !== 'string') throw new SpBackupError('backupInvalid');
  return { scope: f.scope, createdAt: f.createdAt };
}

function safeParse(text) {
  if (typeof text !== 'string' || text.length > MAX_FILE) throw new SpBackupError('backupTooBig');
  try {
    return JSON.parse(text, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
  } catch {
    throw new SpBackupError('backupInvalid');
  }
}

/**
 * @param {string|object} file content of the .spbackup file
 * @param {string} passphrase
 * @param {{ expectScope?: 'owner'|'staff' }} [opts]
 * @returns {Promise<{ scope:'owner'|'staff', createdAt:string, payload:object }>}
 */
export async function decryptBackup(file, passphrase, { expectScope } = {}) {
  const f = typeof file === 'string' ? safeParse(file) : file;
  const { scope, createdAt } = readHeader(f);
  if (expectScope && scope !== expectScope) throw new SpBackupError(scope === 'staff' ? 'backupIsStaff' : 'backupIsOwner');
  const salt = unb64u(f.kdf.salt);
  const iv = unb64u(f.cipher.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new SpBackupError('backupInvalid');
  let plain;
  try {
    const key = await deriveKey(passphrase, salt, f.kdf.iterations);
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: headerAad(f) }, key, unb64u(f.data));
  } catch {
    throw new SpBackupError('backupWrongPassphrase'); // wrong passphrase or a modified file: same answer
  }
  let payload;
  try {
    payload = JSON.parse(dec.decode(plain));
  } catch {
    throw new SpBackupError('backupInvalid');
  }
  return { scope, createdAt, payload: sanitizePayload(payload, scope) };
}

/** Suggested file name. */
export const backupFileName = (scope, now = new Date()) => `saudapulse-${scope === 'staff' ? 'packer' : 'owner'}-${now.toISOString().slice(0, 10)}.spbackup`;
