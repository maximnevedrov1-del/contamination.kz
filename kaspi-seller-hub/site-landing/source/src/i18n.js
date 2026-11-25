import part1 from './locales/kk-part-1.json';
import part2 from './locales/kk-part-2.json';
import './i18n.css';

const normalize = (text) => text.replace(/\s+/gu, ' ').trim();
const messages = Object.fromEntries(Object.entries({
  ...part1,
  ...part2,
  'Выберите язык': 'Тілді таңдаңыз',
  'Заполните это поле.': 'Осы өрісті толтырыңыз.',
  'Подтвердите согласие.': 'Келісіміңізді растаңыз.',
}).map(([source, translation]) => [normalize(source), translation]));
const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const fragments = Object.keys(messages)
  .filter((key) => key.length > 1 && messages[key] !== key)
  .sort((a, b) => b.length - a.length);
const fragmentPattern = new RegExp(fragments.map(escapePattern).join('|'), 'gu');
const isWord = (character) => character && /[\p{L}\p{N}]/u.test(character);

// Complete messages first. Only compound demo announcements and numeric labels
// need fragments; replacements are a single pass, never translated twice.
export function translate(source, language = 'kk') {
  if (language !== 'kk' || !source) return source;
  const text = normalize(source);
  let translated = messages[text];
  if (translated === undefined) {
    const hours = text.match(/^(\d+) ч (\d+) мин$/u);
    const countdown = text.match(/^(\d+) мин до передачи$/u);
    const delay = text.match(/^Задержка (\d+) мин$/u);
    const items = text.match(/^(\d+) из (\d+) товаров$/u);
    const step = text.match(/^(Шаг|Этап) (\d+) из (\d+)\. (.+)$/u);
    if (hours) translated = `${hours[1]} сағ ${hours[2]} мин`;
    else if (countdown) translated = `Тапсыруға ${countdown[1]} мин қалды`;
    else if (delay) translated = `Кідіріс: ${delay[1]} мин`;
    else if (items) translated = `${items[1]} / ${items[2]} тауар`;
    else if (step) translated = `${step[2]} / ${step[3]} ${step[1] === 'Шаг' ? 'қадам' : 'кезең'}. ${translate(step[4])}`;
    else translated = text.replace(fragmentPattern, (match, offset, original) => {
      // Do not translate short words inside an unrelated word or a user's name.
      if ((isWord(match[0]) && isWord(original[offset - 1]))
        || (isWord(match.at(-1)) && isWord(original[offset + match.length]))) return match;
      return messages[match];
    });
  }
  if (translated === text) return source;
  return source.match(/^\s*/u)[0] + translated + source.match(/\s*$/u)[0];
}

const storageKey = 'saudapulse-language';
const supported = (value) => value === 'ru' || value === 'kk';
const attributes = ['placeholder', 'aria-label', 'aria-description', 'title', 'alt', 'data-open-label'];
const generatedCopy = {
  '--i18n-feature-cta': 'Посмотреть, как это работает →',
  '--i18n-pricing-cta': 'Выберите сценарий и покажем, где окупается единое окно',
  '--i18n-time-before': 'Сейчас →',
  '--i18n-time-after': 'Один процесс',
  '--i18n-pricing-window': '1 окно  ·  3 магазина  ·  2 роли',
  '--i18n-table-store': 'Магазин: ',
  '--i18n-table-total': 'Сумма: ',
};

function initialLanguage() {
  const query = new URLSearchParams(window.location.search).get('lang');
  if (supported(query)) return query;
  try {
    const preference = window.localStorage.getItem(storageKey);
    if (supported(preference)) return preference;
  } catch { /* The site also works when privacy settings block storage. */ }
  return 'ru';
}

export function mountI18n(app) {
  const header = app.querySelector('.site-header');
  if (!header || header.querySelector('.language-switch')) return;
  header.querySelector('.header-cta').insertAdjacentHTML('beforebegin', `
    <div class="language-switch" role="group" aria-label="Выберите язык">
      <button type="button" data-language="ru" lang="ru" data-i18n-skip aria-pressed="true">Русский</button>
      <button type="button" data-language="kk" lang="kk" data-i18n-skip aria-pressed="false">Қазақша</button>
    </div>`);
  // An option without value inherits its translated label. Keep the original
  // form payload and selection stable while changing its visible text.
  app.querySelectorAll('option:not([value])').forEach((option) => {
    option.value = option.textContent;
  });

  let language = initialLanguage();
  const originals = new WeakMap();
  const excluded = 'script, style, textarea, [data-i18n-skip]';
  const options = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes };
  const lowerBoundPrices = new Set([...app.querySelectorAll('#pricing .price')]
    .filter((price) => /^\s*от\s+\d/u.test(price.firstChild?.textContent || '')));

  function localizeValue(node, key, value, write) {
    let fields = originals.get(node);
    if (!fields) { fields = new Map(); originals.set(node, fields); }
    let record = fields.get(key);
    // Demo modules write Russian source messages on each frame. Retain that
    // latest source rather than restoring an older scene when switching back.
    if (!record || value !== record.rendered) record = { source: value };
    let rendered = translate(record.source, language);
    // The Kazakh "from" suffix follows the currency, not the amount. Keep the
    // existing amount/unit nodes and typography while restoring RU verbatim.
    if (language === 'kk' && node.nodeType === Node.TEXT_NODE) {
      if (lowerBoundPrices.has(node.parentElement)) rendered = record.source.replace(/^\s*от\s+/u, '');
      else if (lowerBoundPrices.has(node.parentElement?.parentElement) && normalize(record.source) === '₸ / мес') {
        rendered = '₸-ден бастап / ай';
      }
    }
    if (value !== rendered) write(rendered);
    record.rendered = rendered;
    fields.set(key, record);
  }

  function localizeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.parentElement?.closest(excluded)) {
        localizeValue(node, 'text', node.nodeValue, (value) => { node.nodeValue = value; });
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.closest(excluded)) return;
    for (const name of attributes) {
      if (node.hasAttribute(name)) localizeValue(node, name, node.getAttribute(name), (value) => node.setAttribute(name, value));
    }
    node.childNodes.forEach(localizeNode);
  }

  const observer = new MutationObserver((changes) => {
    observer.disconnect();
    const targets = new Set();
    for (const change of changes) {
      if (change.type === 'childList') change.addedNodes.forEach((node) => targets.add(node));
      else targets.add(change.target);
    }
    targets.forEach(localizeNode);
    observer.observe(app, options);
  });

  const requiredFields = [...app.querySelectorAll('#pilot-form input[required]')];
  const validationSource = (field) => field.type === 'checkbox' ? 'Подтвердите согласие.' : 'Заполните это поле.';
  requiredFields.forEach((field) => {
    field.addEventListener('invalid', () => {
      if (field.validity.valueMissing) field.setCustomValidity(translate(validationSource(field), language));
    });
    field.addEventListener('input', () => field.setCustomValidity(''));
    field.addEventListener('change', () => field.setCustomValidity(''));
  });

  function setLanguage(next, remember = false) {
    if (!supported(next)) return;
    observer.disconnect();
    language = next;
    document.documentElement.lang = next;
    localizeNode(app);
    localizeNode(document.querySelector('title'));
    document.querySelectorAll('meta[name="description"], meta[property="og:title"], meta[property="og:description"]').forEach((meta) => {
      localizeValue(meta, 'content', meta.content, (value) => { meta.content = value; });
    });
    for (const [property, source] of Object.entries(generatedCopy)) {
      document.documentElement.style.setProperty(property, JSON.stringify(translate(source, language)));
    }
    header.querySelectorAll('[data-language]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.language === next));
    });
    requiredFields.forEach((field) => {
      if (field.validity.customError) field.setCustomValidity(translate(validationSource(field), language));
    });
    observer.observe(app, options);
    if (remember) {
      try { window.localStorage.setItem(storageKey, next); } catch { /* Optional preference, never form values or tokens. */ }
      // A shared-language URL must not undo a deliberate subsequent choice.
      const url = new URL(window.location.href);
      if (url.searchParams.has('lang')) {
        url.searchParams.set('lang', next);
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      }
    }
  }

  header.querySelectorAll('[data-language]').forEach((button) => {
    button.addEventListener('click', () => setLanguage(button.dataset.language, true));
  });
  setLanguage(language);
}
