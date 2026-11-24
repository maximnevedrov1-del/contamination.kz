/**
 * Atomic data migration with a pre-migration snapshot (generic; derived from the extension's migrations.js).
 *
 *   snapshot → apply migration → verify → on any error restore the snapshot
 *
 * Works on any chrome.storage-like area ({ get(null), set(obj), remove(keys) }), a Map-backed
 * fake in tests included. Only keys matching `prefix` are snapshotted / touched by the rollback;
 * the snapshot itself is kept under `backupKey` so support can restore it by hand after a crash.
 *
 * `migrate(all)` receives a copy of the whole area and returns { set?, remove? } (or a Promise of it).
 * `verify(after)` (optional) gets the area after the write and returns true / throws / returns false.
 *
 * Result: { ok:true, snapshotKey } | { ok:false, error, rolledBack:boolean }
 */
export async function runAtomicMigration(area, migrate, { prefix = 'app.', backupKey = `${prefix}preMigration`, verify, now = Date.now } = {}) {
  const all = await area.get(null);
  const inScope = (k) => k.startsWith(prefix) && k !== backupKey;
  const snapshot = Object.fromEntries(Object.entries(all).filter(([k]) => inScope(k)));
  await area.set({ [backupKey]: { at: now(), data: structuredClone(snapshot) } });
  try {
    const out = (await migrate(structuredClone(all))) || {};
    if (out.set && Object.keys(out.set).length) await area.set(out.set);
    if (out.remove?.length) await area.remove(out.remove);
    if (verify) {
      const ok = await verify(await area.get(null));
      if (ok === false) throw new Error('verifyFailed');
    }
    return { ok: true, snapshotKey: backupKey };
  } catch (e) {
    const error = String(e?.message || e).slice(0, 200);
    try {
      await restoreSnapshot(area, { prefix, backupKey, snapshot });
      return { ok: false, error, rolledBack: true };
    } catch {
      return { ok: false, error, rolledBack: false };
    }
  }
}

/** Put the area back to `snapshot` (or to the one stored under backupKey): extra in-scope keys are removed, changed ones restored. */
export async function restoreSnapshot(area, { prefix = 'app.', backupKey = `${prefix}preMigration`, snapshot } = {}) {
  const all = await area.get(null);
  const data = snapshot ?? all[backupKey]?.data;
  if (!data) throw new Error('noSnapshot');
  const extra = Object.keys(all).filter((k) => k.startsWith(prefix) && k !== backupKey && !(k in data));
  if (extra.length) await area.remove(extra);
  if (Object.keys(data).length) await area.set(structuredClone(data));
}
