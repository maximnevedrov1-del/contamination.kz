// backup-atomic: snapshot → migrate → verify → rollback to the snapshot on any error.
//   node tests/unit/backup-atomic.test.mjs
import assert from 'node:assert/strict';
import { runAtomicMigration, restoreSnapshot } from '../../extension-core/backup-atomic.js';

const mk = (init = {}, { failSetOn = null } = {}) => {
  const d = structuredClone(init);
  return {
    d,
    async get() { return structuredClone(d); },
    async set(o) {
      if (failSetOn && failSetOn in o) throw new Error('quota');
      Object.assign(d, structuredClone(o));
    },
    async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete d[x]); },
  };
};
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const init = { 'app.costs': { a: 1 }, 'app.settings': { lang: 'ru' }, 'other.key': 'untouched' };

await t('success: migration applied, snapshot kept, foreign keys untouched', async () => {
  const a = mk(init);
  const r = await runAtomicMigration(a, (all) => ({ set: { 'app.costs': { a: all['app.costs'].a + 1 } }, remove: ['app.settings'] }), { now: () => 7 });
  assert.deepEqual(r, { ok: true, snapshotKey: 'app.preMigration' });
  assert.deepEqual(a.d['app.costs'], { a: 2 });
  assert.equal('app.settings' in a.d, false);
  assert.equal(a.d['app.preMigration'].at, 7);
  assert.deepEqual(a.d['app.preMigration'].data['app.costs'], { a: 1 });
  assert.equal(a.d['other.key'], 'untouched');
});
await t('migrate throws → rolled back to the snapshot', async () => {
  const a = mk(init);
  const r = await runAtomicMigration(a, () => { throw new Error('boom'); });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'boom');
  assert.equal(r.rolledBack, true);
  assert.deepEqual({ ...a.d, 'app.preMigration': undefined }, { ...init, 'app.preMigration': undefined });
});
await t('half-applied migration (set ok, remove fails) is undone, new keys removed', async () => {
  const a = mk(init);
  const r = await runAtomicMigration(a, () => ({ set: { 'app.costs': { a: 99 }, 'app.newKey': 1 } }), { verify: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'verifyFailed');
  assert.equal(r.rolledBack, true);
  assert.deepEqual(a.d['app.costs'], { a: 1 });
  assert.equal('app.newKey' in a.d, false);
});
await t('verify sees the data after the write', async () => {
  const a = mk(init);
  let seen = null;
  const r = await runAtomicMigration(a, () => ({ set: { 'app.costs': { a: 5 } } }), { verify: (after) => ((seen = after['app.costs'].a), true) });
  assert.equal(r.ok, true);
  assert.equal(seen, 5);
});
await t('restoreSnapshot restores from the stored backup', async () => {
  const a = mk(init);
  await runAtomicMigration(a, () => ({ set: { 'app.costs': { a: 3 } } }));
  await restoreSnapshot(a);
  assert.deepEqual(a.d['app.costs'], { a: 1 });
  await assert.rejects(restoreSnapshot(mk({})), /noSnapshot/);
});
await t('cannot even write the snapshot → throws (nothing migrated)', async () => {
  const a = mk(init, { failSetOn: 'app.preMigration' });
  await assert.rejects(runAtomicMigration(a, () => ({ set: { 'app.costs': { a: 9 } } })), /quota/);
  assert.deepEqual(a.d['app.costs'], { a: 1 });
});

console.log(`\n${n} passed`);
