#!/usr/bin/env node
// Zero-dependency bootstrap: copies this template to a new directory and replaces every
// double-brace KEY token (APP_NAME, APP_SLUG, …) in text files with the values of a JSON config.
//
//   node scripts/init-new-saas.mjs --config <file> --out <dir> [--dry-run]
//
// Defaults: --config = saas.config.example.json next to the template,
//           --out    = ../<APP_SLUG> relative to the repository root (the folder holding the template's .git, else the template's parent).
// Refuses: a non-empty --out, an --out inside kaspi-seller-hub/ or inside the template itself.
// --dry-run: prints the file list, per-file replacement counts, the total and unreplaced tokens; writes nothing; exit 0.
// Exit codes: 0 ok, 1 refused (unsafe/non-empty out dir), 2 bad usage / config (missing or invalid keys).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE_DIRS = new Set(['scripts', 'node_modules', '.git']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.sql', '.html', '.css', '.md', '.sh', '.txt', '.yml', '.yaml', '.toml', '.svg', '']);
const REQUIRED = ['APP_NAME', 'APP_SLUG', 'APP_DOMAIN', 'SUPABASE_PROJECT_ID', 'CURRENCY', 'CURRENCY_SYMBOL', 'SUPPORT_EMAIL', 'TELEGRAM_HANDLE', 'TRIAL_DAYS'];
const OPTIONAL = { SUPABASE_ANON_KEY: '', LICENSE_PUBLIC_JWK: '[]' }; // empty → the client runs in developer mode (no login, no signature check)
const TOKEN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

const die = (code, msg) => { console.error(`error: ${msg}`); process.exit(code); };

function parseArgs(argv) {
  const a = { dryRun: false, config: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--config' || k === '--out') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) die(2, `${k} needs a value`);
      a[k.slice(2)] = argv[++i];
    } else if (k === '-h' || k === '--help') {
      console.log('usage: node scripts/init-new-saas.mjs --config <file> --out <dir> [--dry-run]');
      process.exit(0);
    } else die(2, `unknown argument ${k}`);
  }
  return a;
}

function loadConfig(file) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { die(2, `cannot read config ${file}: ${e.message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) die(2, 'config must be a JSON object');
  const missing = REQUIRED.filter((k) => raw[k] === undefined || raw[k] === null || String(raw[k]).trim() === '');
  if (missing.length) die(2, `missing required keys in config: ${missing.join(', ')}`);
  const cfg = { ...OPTIONAL, ...raw };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(cfg.APP_SLUG))) die(2, 'APP_SLUG must be lowercase letters, digits and dashes');
  if (!/^[a-z0-9-]+$/i.test(String(cfg.SUPABASE_PROJECT_ID))) die(2, 'SUPABASE_PROJECT_ID must be letters, digits and dashes');
  if (!/^\d+$/.test(String(cfg.TRIAL_DAYS))) die(2, 'TRIAL_DAYS must be a non-negative integer');
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v)]));
}

/** Folder holding .git above the template, else the template's parent. */
function repoRoot() {
  for (let d = TEMPLATE; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return path.dirname(TEMPLATE);
  }
}

const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

function checkOut(out, root) {
  if (path.resolve(out).split(path.sep).includes('kaspi-seller-hub') || inside(out, path.join(root, 'kaspi-seller-hub'))) die(1, `refusing: ${out} is inside kaspi-seller-hub`);
  if (inside(out, TEMPLATE)) die(1, `refusing: ${out} is inside the template itself`);
  if (inside(TEMPLATE, out)) die(1, `refusing: ${out} contains the template`);
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) die(1, `refusing: ${out} exists and is not a directory`);
    if (readdirSync(out).length) die(1, `refusing: ${out} is not empty`);
  }
}

function* walk(dir, rel = '') {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    if (e.isDirectory()) {
      if (rel === '' && EXCLUDE_DIRS.has(e.name)) continue;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      yield* walk(path.join(dir, e.name), path.posix.join(rel, e.name));
    } else if (e.isFile()) yield path.posix.join(rel, e.name);
  }
}

const isText = (rel, buf) => TEXT_EXT.has(path.extname(rel).toLowerCase()) && !buf.includes(0);
// A JWK list is embedded in a single-quoted JS string: escape backslashes and quotes there.
const escFor = (key, v) => (key === 'LICENSE_PUBLIC_JWK' ? v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : v);

function render(text, cfg, counts) {
  let n = 0;
  const out = text.replace(TOKEN, (m, key) => {
    if (!(key in cfg)) return m;
    n++;
    counts[key] = (counts[key] || 0) + 1;
    return escFor(key, cfg[key]);
  });
  return { out, n };
}

const args = parseArgs(process.argv.slice(2));
const configFile = path.resolve(args.config || path.join(TEMPLATE, 'saas.config.example.json'));
const cfg = loadConfig(configFile);
const root = repoRoot();
const out = path.resolve(args.out || path.join(path.dirname(root), cfg.APP_SLUG));
checkOut(out, root);

const counts = {};
const report = [];
const unreplaced = new Map();
let total = 0;
for (const rel of walk(TEMPLATE)) {
  const abs = path.join(TEMPLATE, rel);
  const buf = readFileSync(abs);
  let data = buf;
  let n = 0;
  if (isText(rel, buf)) {
    const r = render(buf.toString('utf8'), cfg, counts);
    n = r.n;
    data = Buffer.from(r.out);
    for (const m of r.out.matchAll(TOKEN)) unreplaced.set(m[0], [...(unreplaced.get(m[0]) || []), rel]);
  }
  total += n;
  report.push({ rel, n });
  if (!args.dryRun) {
    const dest = path.join(out, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    chmodSync(dest, statSync(abs).mode & 0o777);
  }
}

console.log(`${args.dryRun ? '[dry-run] ' : ''}template: ${TEMPLATE}`);
console.log(`${args.dryRun ? '[dry-run] ' : ''}config:   ${configFile}`);
console.log(`${args.dryRun ? '[dry-run] ' : ''}out:      ${out}`);
console.log(`\nfiles (${report.length}), replacements per file:`);
for (const { rel, n } of report) console.log(`  ${String(n).padStart(4)}  ${rel}`);
console.log('\nreplacements per key:');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log(`\ntotal replacements: ${total}`);
if (unreplaced.size) {
  console.log('unreplaced tokens:');
  for (const [tok, files] of unreplaced) console.log(`  ${tok}  in ${[...new Set(files)].join(', ')}`);
} else console.log('unreplaced tokens: none');
console.log(args.dryRun ? '\ndry run: nothing written.' : `\nwritten ${report.length} files to ${out}`);
