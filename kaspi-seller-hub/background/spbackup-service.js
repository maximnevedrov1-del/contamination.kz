/**
 * SaudaPulse — «Перенести на телефон»: encrypted .spbackup files (shared/spbackup.js).
 *
 * The plain Kaspi tokens are read and the file is encrypted HERE, in the worker; the dashboard
 * only gets the finished ciphertext. Nothing is sent to any server: the owner moves the file
 * to the phone themselves and types the passphrase there.
 *   ui:spbackupExport { scope: 'owner'|'staff', passphrase }  → { ok, file, name }
 *   ui:spbackupImport { text, passphrase }                    → { ok, stores, costs }  (owner files only)
 * Packers on a «Компьютер склада» cannot call either (not in staff.js STAFF_ALLOWED).
 */
import { encryptBackup, decryptBackup, backupFileName, SpBackupError } from '../shared/spbackup.js';
import { getSettings, saveSettings, getApiTokens, getCosts, setCosts } from '../shared/storage.js';
import * as B from './billing.js';
import { encodeTransfer, qrMatrix, QrTransferError } from '../shared/qr-transfer.js';
import qrcode from '../vendor/qrcode/qrcode.mjs';

/**
 * @param {{ connectApi: (p:{name:string, token:string, shopId?:string}) => Promise<{ok:boolean, error?:string}>, lock: (fn:Function) => Promise<any> }} deps
 */
export function spbackupHandlers({ connectApi, lock }) {
  return {
    'ui:spbackupExport': async ({ scope = 'owner', passphrase } = {}) => {
      try {
        const settings = await getSettings();
        const tokens = await getApiTokens();
        const stores = Object.values(settings.stores || {}).filter((s) => s.api?.connected && tokens[s.id]);
        if (!stores.length) return { ok: false, error: 'backupNoStores' };
        const payload = {
          stores: Object.fromEntries(stores.map((s) => [s.id, { name: s.name, alias: s.alias || '', color: s.color }])),
          tokens: Object.fromEntries(stores.map((s) => [s.id, tokens[s.id]])),
        };
        if (scope === 'staff') {
          payload.ownerId = await B.ownerUserId();
          if (!payload.ownerId) return { ok: false, error: 'backupNoOwner' };
        } else {
          payload.costs = await getCosts();
          payload.profit = settings.profit;
          payload.deadlines = settings.deadlines;
        }
        const file = await encryptBackup(payload, String(passphrase || ''), { scope: scope === 'staff' ? 'staff' : 'owner' });
        return { ok: true, file: JSON.stringify(file), name: backupFileName(scope) };
      } catch (e) {
        return { ok: false, error: e instanceof SpBackupError ? e.code : 'backupInvalid' };
      }
    },

    /** One-tap transfer: the QR picture as a matrix (the page draws it; it never gets the token as text). */
    'ui:qrTransfer': async () => {
      try {
        const settings = await getSettings();
        const tokens = await getApiTokens();
        const stores = Object.values(settings.stores || {}).filter((s) => s.api?.connected && tokens[s.id]);
        if (!stores.length) return { ok: false, error: 'backupNoStores' };
        const { text, withCosts, exp } = await encodeTransfer({
          stores: Object.fromEntries(stores.map((s) => [s.id, { name: s.name, alias: s.alias || '', color: s.color }])),
          tokens: Object.fromEntries(stores.map((s) => [s.id, tokens[s.id]])),
          costs: await getCosts(),
          profit: settings.profit,
          deadlines: settings.deadlines,
        });
        return { ok: true, matrix: qrMatrix(qrcode, text), withCosts, exp, stores: stores.length };
      } catch (e) {
        return { ok: false, error: e instanceof QrTransferError ? e.code : 'backupInvalid' };
      }
    },

    'ui:spbackupImport': async ({ text, passphrase } = {}) => {
      let payload;
      try {
        ({ payload } = await decryptBackup(String(text || ''), String(passphrase || ''), { expectScope: 'owner' }));
      } catch (e) {
        return { ok: false, error: e instanceof SpBackupError ? e.code : 'backupInvalid' };
      }
      let stores = 0;
      const failed = [];
      for (const [id, st] of Object.entries(payload.stores)) {
        const token = payload.tokens[id];
        if (!token) continue;
        // the extension's own connect: checks the token with Kaspi, same store id from the token hash
        const res = await connectApi({ name: st.name, token });
        if (res?.ok) stores++;
        else failed.push(res?.error || 'apiHttp');
      }
      await lock(async () => {
        await setCosts({ ...(await getCosts()), ...payload.costs });
        const s = await getSettings();
        const dc = payload.profit.defaultCommission ?? s.profit.defaultCommission; // an empty value in the file never erases one set here
        await saveSettings({ profit: { ...s.profit, defaultCommission: dc, byCategory: { ...s.profit.byCategory, ...payload.profit.byCategory } }, deadlines: { ...s.deadlines, ...payload.deadlines } });
      });
      return { ok: true, stores, costs: Object.keys(payload.costs).length, failed: failed.length, failedReason: failed[0] || null };
    },
  };
}
