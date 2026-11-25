/**
 * SaudaPulse phone app — sends the Kaspi API client's requests through the stateless relay
 * (billing/supabase/functions/kaspi-relay). Used ONLY by the web app; the Chrome extension
 * calls kaspi.kz directly and never loads this file.
 *
 * installRelayFetch() wraps globalThis.fetch: a request to https://kaspi.kz/shop/api/… is turned
 * into ONE POST to the relay, with the Kaspi target, method, token and body inside the POST body
 * (never in the URL or headers). Every other request goes to the real fetch untouched.
 * background/kaspi-api.js therefore runs unchanged: same retries, same timeouts, same checks.
 */

const KASPI_API = /^https:\/\/kaspi\.kz\/shop\/api\//;

/** Header value from a Headers object, an array of pairs or a plain object. */
function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const list = Array.isArray(headers) ? headers : Object.entries(headers);
  const hit = list.find(([k]) => String(k).toLowerCase() === name.toLowerCase());
  return hit ? String(hit[1]) : null;
}

/**
 * @param {{ relayUrl: string, anonKey: string, accessToken: () => Promise<string|null>, realFetch?: typeof fetch }} opts
 * @returns {() => void} uninstall
 */
export function installRelayFetch({ relayUrl, anonKey, accessToken, realFetch = globalThis.fetch.bind(globalThis) }) {
  if (!/^https:\/\//.test(relayUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(relayUrl)) throw new Error('relayUrl must be https');
  const relayed = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (!KASPI_API.test(String(url || ''))) return realFetch(input, init);
    const method = String(init.method || 'GET').toUpperCase();
    const envelope = JSON.stringify({
      url: String(url),
      method,
      token: header(init.headers, 'X-Auth-Token') || '',
      accept: header(init.headers, 'Accept') || undefined,
      contentType: header(init.headers, 'Content-Type') || undefined,
      body: method === 'GET' || init.body == null ? null : String(init.body),
    });
    const send = async (jwt) =>
      realFetch(relayUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, apikey: anonKey, 'Content-Type': 'application/json' },
        body: envelope,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: init.signal,
      });
    let jwt = await accessToken();
    if (!jwt) throw Object.assign(new Error('relayLoggedOut'), { code: 'billingLoggedOut' });
    let res = await send(jwt);
    // our own session expired between the check and the call: one retry with a fresh token
    if (res.status === 401 && res.headers.get('X-Relay-Error') === 'auth') {
      jwt = await accessToken(true);
      if (jwt) res = await send(jwt);
    }
    return res;
  };
  const prev = globalThis.fetch;
  globalThis.fetch = relayed;
  return () => {
    if (globalThis.fetch === relayed) globalThis.fetch = prev;
  };
}

/** Relay URL of a Supabase project. */
export const relayUrlFor = (supabaseUrl) => `${String(supabaseUrl).replace(/\/$/, '')}/functions/v1/kaspi-relay`;
