// Both languages have the same keys and the same {placeholders}; every t('…') key used in code exists.
//   node tests/unit/locales.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (l) => JSON.parse(fs.readFileSync(path.join(ROOT, `locales/${l}.json`), 'utf8'));
const flat = (o, p = '', out = {}) => {
  for (const [k, v] of Object.entries(o)) {
    // plural objects ({one, few, many, other}) count as one key
    if (v && typeof v === 'object' && !Object.keys(v).every((x) => ['zero', 'one', 'two', 'few', 'many', 'other'].includes(x))) flat(v, `${p}${k}.`, out);
    else out[p + k] = v;
  }
  return out;
};
const ru = flat(load('ru'));
const kk = flat(load('kk'));
const problems = [];
for (const k of Object.keys(ru)) if (!(k in kk)) problems.push(`kk is missing ${k}`);
for (const k of Object.keys(kk)) if (!(k in ru)) problems.push(`ru is missing ${k}`);
const vars = (v) => [...new Set(JSON.stringify(v).match(/\{\w+\}/g) || [])].sort().join(',');
for (const k of Object.keys(ru)) if (k in kk && vars(ru[k]) !== vars(kk[k])) problems.push(`placeholders differ in ${k}: ru ${vars(ru[k])} / kk ${vars(kk[k])}`);

// static t('a.b.c') calls in the code
const files = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((f) => {
  const p = path.join(d, f.name);
  if (f.isDirectory() && !['vendor', 'tests', 'dist', 'node_modules', 'tools'].includes(f.name)) walk(p);
  else if (f.name.endsWith('.js')) files.push(p);
});
['background', 'dashboard', 'popup', 'shared', 'content'].forEach((d) => walk(path.join(ROOT, d)));
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
    const key = m[1];
    if (!(key in ru) && !Object.keys(ru).some((k) => k.startsWith(key + '.'))) problems.push(`${path.relative(ROOT, f)} uses missing key ${key}`);
  }
}
problems.forEach((p) => console.log('FAIL', p));
console.log(problems.length ? `${problems.length} FAILED` : `ALL PASSED (${Object.keys(ru).length} keys)`);
process.exit(problems.length ? 1 : 0);
