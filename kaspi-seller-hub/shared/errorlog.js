/**
 * Selleros — local error journal for support.
 *
 * The last errors of the worker and the pages are kept on this computer only
 * (nothing is sent anywhere automatically). In «Помощь» the seller copies a short
 * report and sends it to support, so a bug report comes with what actually failed.
 *
 * Privacy: messages are cut to 200 characters and scrubbed of anything that looks
 * like a token, an e-mail, a phone number, a person's name in a URL query or a long
 * number; API error bodies (which may contain buyers' data) are never stored.
 */

export const ERROR_LOG_KEY = 'ksh.errorLog';
const MAX = 50;

/** Remove personal data and secrets from a free-text message. */
export function scrub(text) {
  return String(text ?? '')
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, '[key]') // tokens, JWTs, keys
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?[78][\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g, '[phone]')
    .replace(/([?&][\w[\]]+=)[^&\s]*/g, '$1…') // query values
    .replace(/\d{9,}/g, '[n]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Add an entry. Same message from the same place within a minute only bumps a counter
 * (a failing poll every 30 s must not wipe the journal).
 * @param {string} where e.g. "worker:ui:acceptOrder", "page:dashboard"
 * @param {any} err Error, ApiError ({code,status}) or text
 */
export async function logError(where, err, area = chrome.storage.local) {
  try {
    const entry = {
      at: Date.now(),
      where: scrub(where).slice(0, 60),
      code: err?.code ? String(err.code).slice(0, 40) : undefined,
      status: Number.isInteger(err?.status) ? err.status : undefined,
      msg: scrub(err?.message ?? err),
      n: 1,
    };
    const { [ERROR_LOG_KEY]: list = [] } = await area.get(ERROR_LOG_KEY);
    const last = list[list.length - 1];
    if (last && last.where === entry.where && last.msg === entry.msg && last.code === entry.code && entry.at - last.at < 60000) {
      last.n = (last.n || 1) + 1;
      last.at = entry.at;
    } else list.push(entry);
    await area.set({ [ERROR_LOG_KEY]: list.slice(-MAX) });
  } catch {
    /* the journal must never break the extension */
  }
}

export async function getErrorLog(area = chrome.storage.local) {
  const { [ERROR_LOG_KEY]: list = [] } = await area.get(ERROR_LOG_KEY);
  return Array.isArray(list) ? list : [];
}

export const clearErrorLog = (area = chrome.storage.local) => area.remove(ERROR_LOG_KEY);

/**
 * Plain-text report for the support chat.
 * @param {{ version:string, browser:string, dataVersion:number, stores:number, apiStores:number, licence:string, errors:any[] }} info
 */
export function formatReport(info) {
  const p = (n) => String(n).padStart(2, '0');
  // Kazakhstan time (UTC+5), same as everywhere in the extension
  const ts = (ms) => {
    const d = new Date(ms + 5 * 3600000);
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  };
  const lines = [
    'Selleros — отчёт для поддержки',
    `Версия: ${info.version} (данные v${info.dataVersion})`,
    `Браузер: ${info.browser}`,
    `Магазинов: ${info.stores}, по токену API: ${info.apiStores}`,
    `Подписка: ${info.licence}`,
    `Создан: ${ts(Date.now())}`,
    '',
    info.errors.length ? `Последние ошибки (${info.errors.length}):` : 'Ошибок не записано.',
    ...info.errors
      .slice(-20)
      .reverse()
      .map((e) => `${ts(e.at)} ${e.where}${e.code ? ` [${e.code}${e.status ? ` ${e.status}` : ''}]` : ''}${e.n > 1 ? ` ×${e.n}` : ''}: ${e.msg}`),
  ];
  return lines.join('\n');
}
