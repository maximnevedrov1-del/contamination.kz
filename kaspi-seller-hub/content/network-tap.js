/**
 * SaudaPulse — passive network tap (runs in the PAGE's main world).
 *
 * Kaspi's cabinet loads its data as JSON over fetch/XHR. This script observes the
 * responses the page ALREADY receives in the seller's authenticated session and
 * hands same-origin JSON bodies to the isolated content script via postMessage.
 * It never issues requests, never changes requests or responses, and has no access
 * to extension APIs. content.js decides which URLs matter (selectors.js › network).
 */
(() => {
  if (window.__KSH_TAP__) return;
  window.__KSH_TAP__ = true;

  const MAX_BYTES = 1_500_000;
  const post = (url, body) => {
    try {
      if (new URL(url, location.href).origin !== location.origin) return;
      if (!body || body.length > MAX_BYTES) return;
      window.postMessage({ __ksh: 'net', url: String(url), body }, location.origin);
    } catch {
      /* ignore */
    }
  };
  const isJson = (ct) => typeof ct === 'string' && ct.includes('json');

  const origFetch = window.fetch;
  window.fetch = async function kshFetch(...args) {
    const res = await origFetch.apply(this, args);
    try {
      if (isJson(res.headers.get('content-type'))) {
        res.clone().text().then((txt) => post(res.url, txt)).catch(() => {});
      }
    } catch {
      /* ignore */
    }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function kshOpen(method, url, ...rest) {
    this.addEventListener('load', () => {
      try {
        if (isJson(this.getResponseHeader('content-type')) && (this.responseType === '' || this.responseType === 'text')) {
          post(this.responseURL || url, this.responseText);
        }
      } catch {
        /* ignore */
      }
    });
    return origOpen.call(this, method, url, ...rest);
  };
})();
