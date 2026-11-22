/**
 * SaudaPulse — versioned local data.
 *
 * Everything the seller entered (cost prices, catalog, price-list settings, store
 * names and colours) lives in chrome.storage.local and must survive every update
 * of the extension. When a release changes the shape of stored data it bumps
 * DATA_VERSION and adds one step to MIGRATIONS; the worker runs the missing steps
 * once, before it answers any page, on the first start after the update.
 *
 * Safety rules:
 *   - before the first step, all ksh.* data is copied to KEYS.preMigration, so a
 *     failed or wrong step never loses what the seller typed (restorable by support);
 *   - the version is saved after every successful step: a crash in the middle
 *     resumes from the failed step on the next start, finished steps never re-run;
 *   - data written by a NEWER version (the seller went back to an older build) is
 *     left untouched — never "migrated" backwards.
 */

export const VERSION_KEY = 'ksh.dataVersion';
export const BACKUP_KEY = 'ksh.preMigration';

/** Current shape of the stored data. Bump together with a new MIGRATIONS entry. */
export const DATA_VERSION = 1;

/**
 * Step N turns data of version N-1 into version N. Each step gets the whole
 * local storage object and returns the keys to write (and `remove`: keys to delete).
 * Example for a future release:
 *   2: (all) => ({ set: { 'ksh.costs': upgradeCosts(all['ksh.costs']) } }),
 * @type {Record<number, (all: Record<string, any>) => ({ set?: Record<string, any>, remove?: string[] } | Promise<{ set?: Record<string, any>, remove?: string[] }>)>}
 */
export const MIGRATIONS = {};

/**
 * Bring local data to DATA_VERSION.
 * @param {chrome.storage.StorageArea} [area]
 * @param {{ target?: number, steps?: typeof MIGRATIONS }} [opts] tests pass their own steps
 * @returns {Promise<{ from:number, to:number, ran:number[], downgraded?:boolean, error?:string }>}
 */
export async function migrateStorage(area = chrome.storage.local, { target = DATA_VERSION, steps = MIGRATIONS } = {}) {
  const all = await area.get(null);
  const stored = all[VERSION_KEY];
  // No version yet: a fresh install, or data from before versioning (= version 1 format).
  const from = Number.isInteger(stored) ? stored : 1;
  if (from > target) return { from, to: from, ran: [], downgraded: true };
  const ran = [];
  if (from < target) {
    const backup = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('ksh.') && k !== BACKUP_KEY));
    await area.set({ [BACKUP_KEY]: { from, at: Date.now(), data: backup } });
  }
  let data = all;
  for (let v = from + 1; v <= target; v++) {
    const step = steps[v];
    if (!step) return { from, to: v - 1, ran, error: `missingStep${v}` };
    try {
      const out = (await step(data)) || {};
      if (out.set && Object.keys(out.set).length) await area.set(out.set);
      if (out.remove?.length) await area.remove(out.remove);
      await area.set({ [VERSION_KEY]: v });
      data = await area.get(null);
      ran.push(v);
    } catch (e) {
      return { from, to: v - 1, ran, error: String(e?.message || e).slice(0, 200) };
    }
  }
  if (stored !== target) await area.set({ [VERSION_KEY]: target });
  return { from, to: target, ran };
}
