/**
 * SaudaPulse — the seller's Telegram bot (Supabase Edge Function, also runs in Node for tests).
 *
 * Routes (POST):
 *   …/telegram-bot/webhook  Telegram updates: /start <token> links the chat, /stop unlinks;
 *                           checked with the X-Telegram-Bot-Api-Secret-Token header.
 *   …/telegram-bot/alert    from the extension with the SELLER's token: «order at risk» right now
 *                           (the database decides whether to send: linked, alerts on, once per order).
 *   …/telegram-bot/run      scheduled at 09:00 Almaty with X-Bot-Key: morning digest, «6 days away»,
 *                           grace reminders, win-back at 30 / 60 days.
 * The bot reaches the database only through the bot_* functions with its own key (BOT_KEY);
 * the service_role key is not used. Messages are plain text (no HTML/Markdown parsing).
 *
 * Environment: SUPABASE_URL, SUPABASE_ANON_KEY (set by Supabase), BOT_TOKEN (@BotFather),
 * BOT_KEY (admin page → «Состояние» → «Ключ бота»), WEBHOOK_SECRET (any long random string).
 */

const money = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0)).replace(/ /g, ' ') + ' ₸';
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
const ddmm = (day) => { const [, m, d] = String(day).split('-'); return `${d}.${m}`; };
const hhmmAlmaty = (iso) => new Date(new Date(iso).getTime() + 5 * 3600000).toISOString().slice(11, 16);

/** Inline buttons: [📦 Посмотреть заказы] [💬 Поддержка] — only those with an https link. */
export function buttons({ app_url, support_url }, route = 'orders') {
  const row = [];
  if (app_url) row.push({ text: '📦 Посмотреть заказы', url: `${app_url.replace(/\/$/, '')}/open#${route}` });
  if (support_url) row.push({ text: '💬 Поддержка', url: support_url });
  return row.length ? { inline_keyboard: [row] } : undefined;
}

/** Text of each message kind. */
export function format(item) {
  const d = item.data || {};
  const hi = d.name ? `, ${d.name}` : '';
  if (item.kind === 'morning') {
    const s = d.stats || {};
    const risk = Array.isArray(s.at_risk) ? s.at_risk : [];
    const lines = [
      `☀️ Доброе утро${hi}!`,
      `📊 Сводка по вашим магазинам за вчера (${ddmm(d.day)}):`,
      '',
      `📦 Заказов оформлено: ${s.orders || 0} (на сумму ${money(s.sum)})`,
      `🚚 Успешно отправлено: ${s.shipped || 0}`,
      risk.length
        ? `⚠️ Требуют внимания: ${risk.length} ${plural(risk.length, 'заказ', 'заказа', 'заказов')} — под угрозой просрочки сборки: ${risk.slice(0, 5).map((r) => `№${r.code}${r.shop ? ` (${r.shop})` : ''}`).join(', ')}${risk.length > 5 ? '…' : ''}`
        : '✅ Зависших заказов нет',
    ];
    // numbers come from the extension: say how fresh they are if Chrome was closed before midnight
    if (d.as_of && new Date(d.as_of).getTime() < new Date(`${d.day}T19:00:00Z`).getTime()) lines.push('', `ℹ️ По данным на ${hhmmAlmaty(d.as_of)} — позже Chrome с расширением был закрыт.`);
    return lines.join('\n');
  }
  if (item.kind === 'care') return `${d.name || 'Здравствуйте'}, мы заметили, что вы пару дней не заходили в кабинет. Всё в порядке? Если нужна помощь с синхронизацией Kaspi, мы на связи 🙌`;
  if (item.kind === 'grace') return `⏳ Оплаченный период закончился. Кабинет работает ещё ${d.days_left} ${plural(d.days_left, 'день', 'дня', 'дней')} — оплатите продление, чтобы не потерять доступ к заказам и истории.`;
  if (item.kind === 'winback30') return `👋 Здравствуйте${hi}! Вот что нового в SaudaPulse за последний месяц:\n\n${d.whats_new}\n\nВаши магазины и настройки сохранены — вернуться можно в любой момент.`;
  if (item.kind === 'winback60') return `🎁 Вернитесь в SaudaPulse со скидкой ${d.pct || 50} % на первый месяц. Ваши старые магазины сохранены в архиве — настраивать заново ничего не нужно. Предложение действует 30 дней.`;
  if (item.kind === 'alert') {
    if (d.kind === 'cancelled') return `❌ Заказ №${d.code} в магазине ${d.shop} отменён.`;
    const m = Math.max(0, Math.round(d.minutes || 0));
    return `🚨 Внимание! Заказ №${d.code} в магазине ${d.shop} под угрозой просрочки. Осталось ${m} ${plural(m, 'минута', 'минуты', 'минут')} до отмены!`;
  }
  return '';
}

/** Telegram call. Returns {ok, blocked, error}. Waits once on 429 (Telegram tells how long). */
export async function tg(env, method, body, f = fetch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res, data;
    try {
      res = await f(`${env.TELEGRAM_API || 'https://api.telegram.org'}/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      return { ok: false, error: `network: ${String(e.message || e).slice(0, 100)}` };
    }
    if (data.ok) return { ok: true };
    const retry = data.parameters?.retry_after;
    if (res.status === 429 && retry && attempt === 0) { await new Promise((r) => setTimeout(r, Math.min(retry, 30) * 1000)); continue; }
    // 403 «bot was blocked by the user» / «user is deactivated»; 400 «chat not found»: stop sending there
    const blocked = res.status === 403 || (res.status === 400 && /chat not found/i.test(data.description || ''));
    return { ok: false, blocked, error: `${res.status} ${String(data.description || '').slice(0, 150)}` };
  }
  return { ok: false, error: '429 too many requests' };
}

async function rpc(env, fn, args, token, f = fetch) {
  const res = await f(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token || env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw Object.assign(new Error(String(data?.message || res.status)), { status: res.status });
  return data;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && a.length >= 16 && [...a].reduce((x, ch, i) => x | (ch.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;

/** Telegram update → link / unlink / help. */
async function webhook(update, env, f) {
  const msg = update.message;
  // the seller blocked the bot (or removed the chat)
  const member = update.my_chat_member;
  if (member && ['kicked', 'left'].includes(member.new_chat_member?.status)) {
    await rpc(env, 'bot_unlink', { p_key: env.BOT_KEY, p_chat_id: member.chat.id, p_blocked: true }, null, f).catch(() => {});
    return;
  }
  if (!msg?.chat?.id || msg.chat.type !== 'private') return;
  const chat = msg.chat.id;
  const text = String(msg.text || '').trim();
  const start = /^\/start(?:@\w+)?\s+([0-9a-f]{64})$/.exec(text);
  if (start) {
    const r = await rpc(env, 'bot_link', { p_key: env.BOT_KEY, p_token: start[1], p_chat_id: chat, p_name: String(msg.from?.first_name || '').slice(0, 64) }, null, f);
    if (!r?.ok) return tg(env, 'sendMessage', { chat_id: chat, text: 'Ссылка устарела. Откройте SaudaPulse → Настройки → «Подключить Telegram» и нажмите ещё раз.' }, f);
    const shops = (r.shops || []).filter(Boolean);
    return tg(env, 'sendMessage', {
      chat_id: chat,
      text: `✅ Уведомления успешно подключены${shops.length ? ` для ${shops.length > 1 ? 'магазинов' : 'магазина'} ${shops.join(', ')}` : ''}!\n\nКаждое утро в 09:00 — сводка за вчера, а если заказ под угрозой просрочки — сразу сообщение. Отключить: /stop`,
      reply_markup: buttons(r),
    }, f);
  }
  if (/^\/stop/.test(text)) {
    await rpc(env, 'bot_unlink', { p_key: env.BOT_KEY, p_chat_id: chat, p_blocked: false }, null, f);
    return tg(env, 'sendMessage', { chat_id: chat, text: 'Уведомления отключены. Подключить снова: SaudaPulse → Настройки → «Подключить Telegram».' }, f);
  }
  return tg(env, 'sendMessage', { chat_id: chat, text: 'Это бот уведомлений SaudaPulse. Чтобы подключить его, откройте SaudaPulse → Настройки → «Подключить Telegram».' }, f);
}

/**
 * Scheduled run: everything due now, one message each, results back to the database.
 * Results are recorded every `chunk` messages (not once at the end), so a run cut off by the
 * function's time limit or a caller timeout never sends the same message again next time.
 * The run stops after `budgetMs` and reports `more: true`; the caller calls again.
 * bot_jobs returns at most a batch (007_bot_batch.sql); sent items drop out of the next batch.
 * Only one run at a time (008_bot_lock.sql): a second run gets `busy: true` and sends nothing.
 * The lease outlives the time budget (+ a 30 s Telegram wait); a crashed run's lease just expires.
 */
export async function run(env, f = fetch, pause = 40, { chunk = 50, budgetMs = 45000, now = Date.now } = {}) {
  const holder = crypto.randomUUID();
  const ttl = Math.ceil(budgetMs / 1000) + 90;
  if ((await rpc(env, 'bot_lock', { p_key: env.BOT_KEY, p_holder: holder, p_ttl: ttl }, null, f)) !== true) {
    return { due: 0, sent: 0, blocked: 0, failed: 0, more: false, busy: true };
  }
  try {
    return await send(env, f, pause, { chunk, budgetMs, now });
  } finally {
    await rpc(env, 'bot_unlock', { p_key: env.BOT_KEY, p_holder: holder }, null, f).catch(() => {}); // else it expires
  }
}

async function send(env, f, pause, { chunk, budgetMs, now }) {
  const t0 = now();
  const stats = { due: 0, sent: 0, blocked: 0, failed: 0, more: false };
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    await rpc(env, 'bot_sent', { p_key: env.BOT_KEY, p_results: batch }, null, f);
  };
  for (;;) {
    const jobs = await rpc(env, 'bot_jobs', { p_key: env.BOT_KEY }, null, f);
    const items = jobs.items || [];
    if (!items.length) break;
    let progressed = false;
    for (const item of items) {
      if (now() - t0 > budgetMs) {
        stats.more = true;
        break;
      }
      stats.due++;
      const text = format(item);
      if (!text) continue;
      const route = item.kind === 'morning' ? 'orders' : item.kind === 'care' ? 'home' : 'account';
      const r = await tg(env, 'sendMessage', { chat_id: item.chat_id, text, reply_markup: buttons(jobs, route), disable_web_page_preview: true }, f);
      if (!r.ok) console.warn('[telegram-bot] not sent', item.kind, r.error); // the error is kept in tg_sent too
      pending.push({ user_id: item.user_id, kind: item.kind, key: item.key, ok: r.ok, error: r.error || null, blocked: !!r.blocked });
      progressed = true;
      stats[r.ok ? 'sent' : 'failed']++;
      if (r.blocked) stats.blocked++;
      if (pending.length >= chunk) await flush();
      if (pause) await new Promise((res) => setTimeout(res, pause)); // Telegram: ~30 messages per second
    }
    await flush();
    // stop when out of time, or when nothing could be sent (items without text are never recorded)
    if (stats.more || !progressed || !jobs.batch || items.length < jobs.batch) break;
  }
  return stats;
}

/** @param {Request} req */
export async function handle(req, env, f = fetch) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type', 'Access-Control-Allow-Methods': 'POST' } });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const path = new URL(req.url).pathname.replace(/\/$/, '');
  try {
    if (path.endsWith('/webhook')) {
      if (!sameSecret(req.headers.get('x-telegram-bot-api-secret-token'), env.WEBHOOK_SECRET)) return json({ error: 'forbidden' }, 401);
      await webhook(await req.json(), env, f);
      return json({ ok: true }); // always 200: Telegram would resend the update otherwise
    }
    if (path.endsWith('/alert')) {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!token || token === env.SUPABASE_ANON_KEY) return json({ error: 'auth' }, 401);
      const b = await req.json();
      const a = await rpc(env, 'alert_create', { p_code: String(b.code || ''), p_shop: String(b.shop || ''), p_minutes: Number(b.minutes) || 0, p_kind: b.kind === 'cancelled' ? 'cancelled' : 'deadline' }, token, f);
      if (!a) return json({ sent: false });
      const r = await tg(env, 'sendMessage', { chat_id: a.chat_id, text: format({ kind: 'alert', data: a }), reply_markup: buttons(a, 'orders') }, f);
      if (r.blocked) await rpc(env, 'bot_unlink', { p_key: env.BOT_KEY, p_chat_id: a.chat_id, p_blocked: true }, null, f).catch(() => {});
      return json({ sent: r.ok, error: r.ok ? undefined : r.error });
    }
    if (path.endsWith('/run')) {
      if (!sameSecret(req.headers.get('x-bot-key'), env.BOT_KEY)) return json({ error: 'forbidden' }, 401);
      return json(await run(env, f));
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    console.error('[telegram-bot]', path, e.message);
    return json({ error: String(e.message).slice(0, 200) }, e.status === 401 || e.status === 403 ? 401 : 500);
  }
}
