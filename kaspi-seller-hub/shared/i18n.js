/**
 * Kaspi Seller Hub — internationalization.
 *
 * - Locale dictionaries live in /locales/<lang>.json, nested by screen.
 * - t('orders.title') looks up a dot-path; {name} placeholders are substituted.
 * - Plural forms: a value may be an object keyed by Intl.PluralRules categories
 *   ({ one, few, many, other }); pass `count` in vars to pick one.
 * - Numbers, money (KZT), percents and dates are formatted with Intl using the
 *   current locale. Nothing user-facing is formatted anywhere else.
 * - Russian is the fallback dictionary for missing keys.
 * - Some Chromium builds ship without ICU data for kk-KZ. When the browser lacks
 *   a locale, numbers are formatted with ru-RU (same grouping: "12 345,5") and
 *   month names / relative times come from the locale's "format" block instead.
 */

import { getSettings, saveSettings, KEYS, onKeyChange } from './storage.js';

/** Supported languages and their Intl locales. */
export const LANGS = Object.freeze({
  ru: { intl: 'ru-RU', numberFallback: 'ru-RU', label: 'RU' },
  kk: { intl: 'kk-KZ', numberFallback: 'ru-RU', label: 'KZ' },
});

/**
 * Does this browser have real ICU data for a locale? supportedLocalesOf() is not
 * enough: some builds claim support but format months as "M01" and numbers in
 * English style, so we probe the actual output.
 */
function intlSupports(locale) {
  try {
    if (!Intl.DateTimeFormat.supportedLocalesOf([locale]).length) return false;
    const month = new Intl.DateTimeFormat(locale, { month: 'short' }).format(new Date(2020, 0, 15));
    const num = new Intl.NumberFormat(locale).format(12345.5);
    return !/^M?\d/.test(month) && !num.includes('12,345');
  } catch {
    return false;
  }
}
let native = true;

let lang = 'ru';
let dict = {};
let fallback = {};
let plural = new Intl.PluralRules('ru-RU');
const cache = new Map();

async function loadDict(l) {
  if (!cache.has(l)) {
    const res = await fetch(chrome.runtime.getURL(`locales/${l}.json`));
    cache.set(l, await res.json());
  }
  return cache.get(l);
}

/**
 * Load the language saved in settings (or the one given).
 * @param {'ru'|'kk'} [forced]
 */
export async function initI18n(forced) {
  const l = forced ?? (await getSettings()).lang;
  lang = l in LANGS ? l : 'ru';
  [dict, fallback] = await Promise.all([loadDict(lang), loadDict('ru')]);
  native = intlSupports(LANGS[lang].intl);
  plural = new Intl.PluralRules(LANGS[lang].intl);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  return lang;
}

/** Persist and activate a language. Other open extension pages follow via onLangChange. */
export async function setLang(l) {
  await saveSettings({ lang: l });
  return initI18n(l);
}

export const getLang = () => lang;
/** Locale passed to Intl formatters (falls back when ICU data is missing). */
export const intlLocale = () => (native ? LANGS[lang].intl : LANGS[lang].numberFallback);

/**
 * Call cb after the language changes in any extension page.
 * @param {(lang:string)=>void} cb
 */
export function onLangChange(cb) {
  return onKeyChange(KEYS.settings, async (next, prev) => {
    if (next?.lang && next.lang !== prev?.lang && next.lang !== lang) cb(await initI18n(next.lang));
  });
}

/** Array-valued entries of the locale's "format" block. */
const lookupFmt = (k) => lookup(dict, `format.${k}`) ?? lookup(fallback, `format.${k}`) ?? [];

const lookup = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * Translate a key.
 * @param {string} key dot-path, e.g. "orders.bulk.pack"
 * @param {Record<string, string|number>} [vars] placeholders; `count` selects a plural form
 * @returns {string}
 */
export function t(key, vars = {}) {
  let v = lookup(dict, key) ?? lookup(fallback, key);
  if (v == null) {
    console.warn('[i18n] missing key', key);
    return key;
  }
  if (typeof v === 'object') {
    const cat = typeof vars.count === 'number' ? plural.select(vars.count) : 'other';
    v = v[cat] ?? v.other ?? Object.values(v)[0];
  }
  return String(v).replace(/\{(\w+)\}/g, (_, k) =>
    k in vars ? (typeof vars[k] === 'number' ? formatNumber(vars[k]) : String(vars[k])) : `{${k}}`,
  );
}

/** Does a key exist (in the current or fallback dictionary)? */
export const hasKey = (key) => lookup(dict, key) != null || lookup(fallback, key) != null;

/* ---------- formatting ---------- */

const nf = (opts) => new Intl.NumberFormat(intlLocale(), opts);

/** 12 345 */
export const formatNumber = (n, digits = 0) =>
  n == null || !Number.isFinite(n) ? '—' : nf({ maximumFractionDigits: digits }).format(n);

/** 12 345 ₸ */
export const formatMoney = (n) =>
  n == null || !Number.isFinite(n) ? '—' : nf({ style: 'currency', currency: 'KZT', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 }).format(n);

/** Compact money for chart axes: 1,2 млн ₸ / 1,2 млн ₸ (kk: мың, млн, млрд) */
export function formatMoneyCompact(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (native) return nf({ style: 'currency', currency: 'KZT', currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const [div, unit] = Math.abs(n) >= 1e9 ? [1e9, 'billion'] : Math.abs(n) >= 1e6 ? [1e6, 'million'] : Math.abs(n) >= 1e3 ? [1e3, 'thousand'] : [1, ''];
  return `${formatNumber(n / div, 1)}${unit ? ` ${t(`format.${unit}`)}` : ''} ₸`;
}

/** 0.0512 → 5,1 % */
export const formatPercent = (r, digits = 1) =>
  r == null || !Number.isFinite(r) ? '—' : nf({ style: 'percent', maximumFractionDigits: digits }).format(r);

/**
 * Format a date.
 * @param {string|number|Date|null} v
 * @param {'date'|'datetime'|'time'|'short'|'weekday'} [style]
 */
export function formatDate(v, style = 'date') {
  if (v == null || v === '') return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  if (!native && (style === 'short' || style === 'weekday')) {
    const month = lookupFmt('monthsShort')[d.getMonth()] ?? '';
    const day = `${d.getDate()} ${month}`;
    return style === 'weekday' ? `${lookupFmt('weekdaysShort')[d.getDay()]}, ${day}` : day;
  }
  const opts = {
    date: { day: '2-digit', month: '2-digit', year: 'numeric' },
    datetime: { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' },
    time: { hour: '2-digit', minute: '2-digit' },
    short: { day: 'numeric', month: 'short' },
    weekday: { weekday: 'short', day: 'numeric', month: 'short' },
  }[style];
  return new Intl.DateTimeFormat(intlLocale(), opts).format(d);
}

/** "5 мин назад" / "5 минут бұрын" */
export function formatRelative(v) {
  if (!v) return '—';
  const diff = (new Date(v).getTime() - Date.now()) / 1000;
  if (!native) {
    const abs = Math.abs(diff);
    if (abs < 10) return t('format.now');
    const [unit, size] = abs < 60 ? ['second', 1] : abs < 3600 ? ['minute', 60] : abs < 86400 ? ['hour', 3600] : ['day', 86400];
    return t(`format.relative.${unit}`, { count: Math.round(abs / size) });
  }
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

/** Chat-list timestamp: time for today, short date otherwise. */
export function formatChatTime(v) {
  if (!v) return '';
  const d = new Date(v);
  return d.toDateString() === new Date().toDateString() ? formatDate(d, 'time') : formatDate(d, 'short');
}

/**
 * Translate static markup:
 *   data-i18n="key"                     → textContent
 *   data-i18n-attr="placeholder:key;title:key;aria-label:key"
 * @param {ParentNode} [root]
 */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split(';').forEach((pair) => {
      const [attr, key] = pair.split(':').map((x) => x.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
}
