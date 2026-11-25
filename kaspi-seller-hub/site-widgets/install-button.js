/*!
 * SaudaPulse — «Установить» on saudapulse.kz (all pages). One file, no dependencies.
 *
 * Add before </body> on every page of the site:
 *   <script src="/install-button.js" defer
 *           data-store-url="https://chromewebstore.google.com/detail/<id>"></script>
 *
 *  - Computer / laptop: floating button bottom-right → the extension in the Chrome Web Store
 *    (until the store link is known: to the landing's install section, /#install).
 *  - Tablet (iPad, Android tablet): floating button bottom-right → the phone app, because
 *    tablets cannot run Chrome extensions.
 *  - Phone: a bar at the bottom → /app/?install=1, the app opens with its install step
 *    (Android: one tap «Установить»; iPhone: «Поделиться → На экран Домой»).
 * «✕» hides it until the browser tab is closed. Not shown inside the installed app or on /app.
 * Kazakh texts on pages with <html lang="kk">.
 */
(function () {
  'use strict';
  if (location.pathname.indexOf('/app') === 0) return;
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) return;
  var me = document.currentScript || document.querySelector('script[src*="install-button"]');
  var cfg = (me && me.dataset) || {};
  var storeUrl = cfg.storeUrl || '';
  var appUrl = cfg.appUrl || '/app/?install=1';
  var kk = (document.documentElement.lang || '').toLowerCase().indexOf('kk') === 0;
  var T = kk
    ? { install: 'Орнату', ext: 'Кеңейтімді орнату', app: 'Қосымшаны орнату', phoneTitle: 'SaudaPulse телефонға', phoneSub: 'Тапсырыстар мен түсім қалтаңызда', close: 'Жабу' }
    : { install: 'Установить', ext: 'Установить расширение', app: 'Установить приложение', phoneTitle: 'SaudaPulse на телефон', phoneSub: 'Заказы и выручка Kaspi в кармане', close: 'Закрыть' };
  try { if (sessionStorage.getItem('sp-install-hidden') === '1') return; } catch (e) { /* storage blocked: show */ }

  var ua = navigator.userAgent;
  var coarse = window.matchMedia('(pointer: coarse)').matches;
  var shortSide = Math.min(screen.width, screen.height);
  var iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  var phone = /iPhone|iPod|Android.+Mobile|Windows Phone/i.test(ua) || (coarse && shortSide < 600 && !iPadOS);
  var tablet = !phone && (iPadOS || /iPad|Android|Tablet/i.test(ua) || (coarse && shortSide >= 600 && !/Windows NT|Macintosh|CrOS|Linux x86/i.test(ua)));

  var css = [
    '.spi{--spi-accent:#047857;--spi-on:#fff;--spi-bg:#fff;--spi-fg:#0F172A;--spi-muted:#475569;--spi-line:#E2E8F0;font:15px/1.35 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;z-index:2147483000;box-sizing:border-box}',
    '@media (prefers-color-scheme:dark){.spi{--spi-accent:#10B981;--spi-on:#0F172A;--spi-bg:#111A2E;--spi-fg:#E2E8F0;--spi-muted:#94A3B8;--spi-line:#22304D}}',
    '.spi *{box-sizing:border-box}',
    '.spi-fab{position:fixed;right:calc(24px + env(safe-area-inset-right,0px));bottom:calc(24px + env(safe-area-inset-bottom,0px));display:flex;align-items:center;gap:6px}',
    '.spi-fab a{display:inline-flex;align-items:center;gap:10px;min-height:52px;padding:0 22px 0 16px;border-radius:999px;background:var(--spi-accent);color:var(--spi-on);font-weight:700;text-decoration:none;box-shadow:0 10px 30px rgba(2,6,23,.28)}',
    '.spi-fab a:hover{filter:brightness(1.06)}',
    '.spi-fab a:focus-visible,.spi button:focus-visible,.spi-bar a:focus-visible{outline:3px solid var(--spi-accent);outline-offset:3px}',
    '.spi-x{width:32px;height:32px;border-radius:50%;border:1px solid var(--spi-line);background:var(--spi-bg);color:var(--spi-muted);font-size:16px;line-height:1;cursor:pointer}',
    '.spi-bar{position:fixed;left:0;right:0;bottom:0;display:flex;align-items:center;gap:10px;padding:10px max(12px,env(safe-area-inset-right,0px)) calc(10px + env(safe-area-inset-bottom,0px)) max(12px,env(safe-area-inset-left,0px));background:var(--spi-bg);color:var(--spi-fg);border-top:1px solid var(--spi-line);box-shadow:0 -6px 24px rgba(2,6,23,.16)}',
    '.spi-bar img{width:40px;height:40px;border-radius:10px;flex:none}',
    '.spi-bar .spi-t{flex:1;min-width:0;display:flex;flex-direction:column}',
    '.spi-bar .spi-t small{color:var(--spi-muted)}',
    '.spi-bar a{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:12px;background:var(--spi-accent);color:var(--spi-on);font-weight:700;text-decoration:none;white-space:nowrap}',
    '.spi-bar .spi-x{width:44px;height:44px;border:0;background:transparent;font-size:18px}',
    '@media (max-width:360px){.spi-bar .spi-t small{display:none}.spi-bar a{padding:0 14px}}',
    '@media (prefers-reduced-motion:no-preference){.spi-fab,.spi-bar{animation:spi-in .35s ease-out}@keyframes spi-in{from{transform:translateY(16px);opacity:0}}}',
    '@media print{.spi{display:none!important}}',
    // the landing's own sticky phone bar (.mcta) would sit under ours: hidden while ours is shown
    'html.spi-phone .mcta{display:none!important}'
  ].join('');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    (kids || []).forEach(function (c) { n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function closeBtn(box) {
    var x = el('button', { type: 'button', class: 'spi-x', 'aria-label': T.close }, ['✕']);
    x.addEventListener('click', function () {
      box.remove();
      document.documentElement.classList.remove('spi-phone');
      try { sessionStorage.setItem('sp-install-hidden', '1'); } catch (e) { /* ignore */ }
    });
    return x;
  }
  var icon = cfg.icon || '/app/icons/icon-192.png';

  var box;
  if (phone) {
    box = el('div', { class: 'spi spi-bar', role: 'region', 'aria-label': T.app }, [
      el('img', { src: icon, alt: '' }),
      el('span', { class: 'spi-t' }, [el('strong', {}, [T.phoneTitle]), el('small', {}, [T.phoneSub])]),
      el('a', { href: appUrl, 'data-spi': 'phone' }, [T.install])
    ]);
    box.insertBefore(closeBtn(box), box.firstChild);
  } else {
    // no store link yet: the landing's own install section (#install)
    var href = tablet ? appUrl : storeUrl || (document.getElementById('install') ? '#install' : '/#install');
    var link = el('a', { href: href, 'data-spi': tablet ? 'tablet' : 'desktop' }, [
      el('span', { 'aria-hidden': 'true', style: 'font-size:18px' }, ['⬇']),
      tablet ? T.app : T.ext
    ]);
    if (!tablet && storeUrl) { link.target = '_blank'; link.rel = 'noopener'; }
    // the landing has its own install logic (Manus: [data-sp-install] — opens the extension if it is
    // installed, else the store, else its #install section): the floating button reuses it
    if (!tablet && !storeUrl) {
      link.addEventListener('click', function (e) {
        var own = document.querySelector('[data-sp-install]');
        if (own) {
          e.preventDefault();
          own.click();
          return;
        }
        var target = href.charAt(0) === '#' && document.querySelector(href);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
    box = el('div', { class: 'spi spi-fab' }, [link]);
    box.insertBefore(closeBtn(box), link);
  }
  // Phones and tablets cannot run the Chrome extension: the landing's own «Установить» buttons
  // ([data-sp-install], Manus landing) open the phone app instead of the desktop instructions.
  if (phone || tablet) {
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('[data-sp-install]');
      if (!a) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      location.href = appUrl;
    }, true);
  }

  function mount() {
    document.body.appendChild(box);
    if (phone) document.documentElement.classList.add('spi-phone');
    // phone: keep the page's last lines visible above the bar
    if (phone) document.body.style.paddingBottom = 'calc(' + (getComputedStyle(document.body).paddingBottom || '0px') + ' + 72px)';
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
