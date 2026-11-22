/**
 * SaudaPulse — packing journal and product barcodes (used by the packer panel).
 *
 * Journal (local, this computer): who packed which order and when, how each line was checked
 * (scanner or by hand), wrong scans, problems. Order numbers stay on this computer; the server
 * only knows who is in the owner's team.
 * Barcodes: product SKU → the barcodes scanned on its packaging (EAN etc.).
 */
import { activeStaff } from './staff.js';

const LOG_KEY = 'ksh.packLog';
const BARCODES_KEY = 'ksh.barcodes';
const MAX_LOG = 3000;
const CODE_RE = /^[0-9A-Za-z\-./]{3,64}$/;
const local = chrome.storage.local;
const get = async (k, def) => (await local.get(k))[k] ?? def;

export const getBarcodes = () => get(BARCODES_KEY, {});

async function addLog(entry) {
  const act = await activeStaff();
  const who = act ? { staff: act.member.name, staffEmail: act.email } : { staff: null };
  const row = {
    at: Date.now(),
    ...who,
    action: String(entry.action || '').slice(0, 20), // packed | accepted | problem | barcode
    shopId: String(entry.shopId || '').slice(0, 64),
    orderId: String(entry.orderId || '').slice(0, 64),
    checked: entry.checked === 'manual' ? 'manual' : entry.checked === 'scan' ? 'scan' : undefined,
    wrongScans: Number.isInteger(entry.wrongScans) ? Math.min(entry.wrongScans, 999) : undefined,
    seconds: Number.isFinite(entry.seconds) ? Math.round(Math.min(entry.seconds, 86400)) : undefined,
    note: entry.note ? String(entry.note).slice(0, 200) : undefined,
  };
  const log = await get(LOG_KEY, []);
  log.push(row);
  await local.set({ [LOG_KEY]: log.slice(-MAX_LOG) });
  return row;
}

export function packingHandlers() {
  return {
    /** A packer (or the owner) finished / accepted an order. */
    'ui:packLogAdd': async ({ entry }) => ({ ok: true, row: await addLog(entry || {}) }),
    /** «Проблема с заказом»: no stock, damaged… → the owner sees it on Home. */
    'ui:packProblem': async ({ shopId, orderId, note }) => ({ ok: true, row: await addLog({ action: 'problem', shopId, orderId, note }) }),
    /** The owner reads the journal (locked for packers by staffGate). */
    'ui:packLogGet': async () => ({ ok: true, log: (await get(LOG_KEY, [])).slice(-500).reverse() }),
    /** Remember a barcode for a product (scanned once, known for every next order). */
    'ui:setBarcode': async ({ sku, code }) => {
      sku = String(sku || '').trim();
      code = String(code || '').trim();
      if (!sku || sku.length > 200 || !CODE_RE.test(code)) return { ok: false, error: 'badBarcode' };
      const map = await getBarcodes();
      const list = new Set(map[sku] || []);
      list.add(code);
      map[sku] = [...list].slice(-10);
      await local.set({ [BARCODES_KEY]: map });
      await addLog({ action: 'barcode', note: `${sku}: ${code}` });
      return { ok: true, barcodes: map[sku] };
    },
  };
}
