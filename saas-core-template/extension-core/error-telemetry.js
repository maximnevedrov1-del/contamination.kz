// Client error telemetry: anonymous, throttled, fire-and-forget reports to the report_client_error RPC
// (023_client_errors_and_retention.sql). The server strips URLs, emails, tokens and digits anyway;
// the client only sends a short code + short context.
import { isConfigured, currentToken, rpcWith } from './billing.js';

const THROTTLE_MS = 10 * 60000;
const MAX_KEYS = 50;

/** Build a reporter. Dependencies are injectable for tests; defaults use the billing client. */
export function createErrorReporter({
  configured = isConfigured,
  getToken = currentToken,
  rpc = rpcWith,
  getVersion = () => (typeof chrome !== 'undefined' ? chrome.runtime?.getManifest?.().version || '' : ''),
  now = Date.now,
} = {}) {
  const throttle = new Map();
  /**
   * Never throws, skips when signed out / not configured, same code+context at most once per 10 min.
   * Returns a promise only for tests; callers should not await it.
   */
  return function reportClientError(code, context = '') {
    try {
      if (!configured()) return;
      const c = String(code ?? '').slice(0, 120);
      const x = String(context ?? '').slice(0, 120);
      if (!c) return;
      const key = `${c}|${x}`;
      const t = now();
      if (t - (throttle.get(key) || 0) < THROTTLE_MS) return;
      if (throttle.size >= MAX_KEYS && !throttle.has(key)) throttle.delete(throttle.keys().next().value);
      throttle.set(key, t);
      return (async () => {
        try {
          const token = await getToken();
          if (!token) return;
          await rpc(token, 'report_client_error', { p_code: c, p_context: x, p_version: String(getVersion()).slice(0, 120) });
        } catch { /* telemetry must never break anything */ }
      })();
    } catch { /* ignore */ }
  };
}

export const reportClientError = createErrorReporter();
