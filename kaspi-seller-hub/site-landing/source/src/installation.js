import { translate } from './i18n.js';

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content.trim() || '';
const REF_RE = /^SP-[A-Z0-9]{6}$/;
const installUrl = 'https://saudapulse.kz';
const localized = (source) => translate(source, document.documentElement.lang || 'ru');

const getRef = () => {
  try {
    const query = (new URLSearchParams(window.location.search).get('ref') || '').trim().toUpperCase();
    if (REF_RE.test(query)) localStorage.setItem('sp_ref_code', query);
    const stored = localStorage.getItem('sp_ref_code');
    return stored && REF_RE.test(stored) ? stored : undefined;
  } catch { return undefined; }
};

const getInstallUrl = () => {
  const ref = getRef();
  return ref ? `${installUrl}/?ref=${encodeURIComponent(ref)}` : installUrl;
};

const isDesktopChrome = () => Boolean(window.chrome)
  && /Chrome\//.test(navigator.userAgent)
  && !/Android|iPhone|iPad|Edg\/|OPR\//.test(navigator.userAgent);

const scrollToInstall = () => {
  const section = document.querySelector('#install');
  if (!section) return;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#install`);
  section.scrollIntoView({ behavior: 'smooth' });
};
const openStore = (storeUrl) => {
  if (storeUrl) window.open(storeUrl, '_blank', 'noopener');
  else scrollToInstall();
};

function mountInstallFlow() {
  const extensionId = meta('sp-extension-id');
  const storeUrl = meta('sp-store-url');
  const links = document.querySelectorAll('[data-sp-install]');

  links.forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      if (!isDesktopChrome()) { scrollToInstall(); return; }
      if (!extensionId || !(window.chrome?.runtime?.sendMessage)) { openStore(storeUrl); return; }
      let done = false;
      const timer = window.setTimeout(() => { if (!done) { done = true; openStore(storeUrl); } }, 800);
      try {
        window.chrome.runtime.sendMessage(extensionId, { type: 'OPEN_DASHBOARD', ref: getRef() }, (response) => {
          void window.chrome.runtime.lastError;
          window.clearTimeout(timer);
          if (done) return;
          done = true;
          if (!(response && response.ok)) openStore(storeUrl);
        });
      } catch {
        window.clearTimeout(timer);
        if (!done) { done = true; openStore(storeUrl); }
      }
    });
  });

  if (extensionId && isDesktopChrome() && window.chrome?.runtime?.sendMessage) {
    try {
      window.chrome.runtime.sendMessage(extensionId, { type: 'PING' }, (response) => {
        void window.chrome.runtime.lastError;
        if (response?.ok) links.forEach((link) => {
          if (link.dataset.openLabel) link.textContent = localized('Открыть SaudaPulse');
        });
      });
    } catch { /* Browser extension is optional during the pre-publication stage. */ }
  }

  const copyLink = document.querySelector('[data-copy-install-link]');
  copyLink?.addEventListener('click', async () => {
    const link = getInstallUrl();
    try { await navigator.clipboard.writeText(link); }
    catch {
      const helper = document.createElement('textarea');
      helper.value = link;
      helper.style.position = 'fixed'; helper.style.opacity = '0';
      document.body.append(helper); helper.select(); document.execCommand('copy'); helper.remove();
    }
    const original = copyLink.textContent;
    copyLink.textContent = localized('Ссылка скопирована');
    window.setTimeout(() => { copyLink.textContent = original; }, 2200);
  });
}

const copyText = async (text) => {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const helper = document.createElement('textarea');
    helper.value = text; helper.style.position = 'fixed'; helper.style.opacity = '0';
    document.body.append(helper); helper.select();
    const copied = document.execCommand('copy'); helper.remove(); return copied;
  }
};

export function mountApplicationForm() {
  const form = document.querySelector('#pilot-form');
  if (!form) return;
  const mail = form.querySelector('[data-mail-application]');
  const toast = document.querySelector('.toast');
  const newApplication = form.querySelector('[data-new-application]');
  const telegramFallback = form.querySelector('[data-telegram-fallback]');
  const storesByValue = {
    'Kaspi-1': '1 магазин',
    'Kaspi-2': '2 магазина',
    'Kaspi-3': '3 магазина',
    'Kaspi-4plus': '4+ / своя команда',
  };
  const buildMessage = () => {
    const name = form.elements.name.value.trim();
    const contact = form.elements.contact.value.trim();
    const selectedMarket = form.querySelector('input[name="market"]:checked');
    const stores = storesByValue[selectedMarket?.value] || selectedMarket?.value || '';
    const volume = form.elements.volume.value;
    return `Заявка SaudaPulse: ${name}, ${contact}, магазинов: ${stores}, заказов в день: ${volume}`;
  };
  const updateMail = () => {
    if (!mail) return;
    const message = buildMessage();
    mail.href = `mailto:support@saudapulse.kz?subject=${encodeURIComponent('Заявка SaudaPulse')}&body=${encodeURIComponent(message)}`;
  };
  form.querySelectorAll('input, select').forEach((field) => field.addEventListener('input', updateMail));
  form.querySelectorAll('input, select').forEach((field) => field.addEventListener('change', updateMail));
  updateMail();
  newApplication?.addEventListener('click', () => {
    form.elements.name.value = '';
    form.elements.contact.value = '';
    form.elements.consent.checked = false;
    newApplication.hidden = true;
    if (telegramFallback) telegramFallback.hidden = true;
    updateMail();
    form.elements.name.focus();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = buildMessage();
    await copyText(message);
    let telegramWindow = null;
    try { telegramWindow = window.open('https://t.me/SaudaPulse', '_blank', 'noopener'); } catch { /* Popup blockers can throw. */ }
    if (telegramFallback) telegramFallback.hidden = Boolean(telegramWindow);
    if (newApplication) newApplication.hidden = false;
    toast.textContent = localized('Текст заявки скопирован — вставьте его в чат и отправьте');
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 6500);
  });
}

export function mountInstallation() {
  mountInstallFlow();
  mountApplicationForm();
}
