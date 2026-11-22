// Feature flags from the cached licence.   node tests/unit/feature-flags.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let store = {};
let broken = false;
globalThis.chrome = {
  storage: {
    local: {
      async get(k) {
        if (broken) throw new Error('storage down');
        const keys = Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, structuredClone(store[x])]));
      },
    },
  },
};
const { isFeatureEnabled, getFeatures, featureFrom } = await import(pathToFileURL(path.join(ROOT, 'extension-core/feature-flags.js')).href);
const cache = (data) => (store = { 'app.license': { data, fetchedAt: Date.now(), skew: 0 } });

cache({ status: 'active', features: { new_ui: true, beta_x: false, weird: 'yes', num: 1 } });
assert.equal(await isFeatureEnabled('new_ui'), true);
assert.equal(await isFeatureEnabled('beta_x', true), false);
assert.equal(await isFeatureEnabled('unknown'), false);
assert.equal(await isFeatureEnabled('unknown', true), true);
assert.equal(await isFeatureEnabled('weird', true), true, 'non-boolean -> fallback');
assert.equal(await isFeatureEnabled('num'), false, 'non-boolean -> fallback');
assert.deepEqual(await getFeatures(), { new_ui: true, beta_x: false, weird: 'yes', num: 1 });

store = {};
assert.deepEqual(await getFeatures(), {}, 'no cache');
assert.equal(await isFeatureEnabled('new_ui', true), true);
cache({ status: 'active' });
assert.deepEqual(await getFeatures(), {}, 'old cache without features');
cache({ features: ['new_ui'] });
assert.deepEqual(await getFeatures(), {}, 'array is not a features object');
cache({ features: { new_ui: true } });
broken = true;
assert.deepEqual(await getFeatures(), {}, 'storage throws');
assert.equal(await isFeatureEnabled('new_ui', true), true, 'storage throws -> fallback');
assert.equal(await isFeatureEnabled('new_ui'), false);
broken = false;
assert.equal(featureFrom(null, 'a', true), true);
assert.equal(featureFrom({ a: false }, 'a', true), false);
console.log('feature-flags: ok');
