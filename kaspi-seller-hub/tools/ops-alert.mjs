#!/usr/bin/env node
/**
 * Seller Hub — Telegram alerts for the owner (run every 10 minutes by .github/workflows/ops-alert.yml).
 *
 * Asks the subscription server for a digest (billing/supabase/003_support.sql → ops_digest) and,
 * when there is something to say, sends ONE Telegram message:
 *   - Kaspi (or Ozon/WB) API fails for many clients at once → «сбой», then «восстановилось»;
 *   - new questions to support, new invoices waiting for confirmation;
 *   - the morning digest has not gone out by 09:30 (once a day);
 *   - once a day after 10:00: a monitoring report (digest delivery, bot questions, tickets, clients, errors).
 * The digest holds only counts and market names — nothing about clients.
 *
 * Environment (GitHub → Settings → Secrets and variables → Actions):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — the project URL and the service_role key (ops_digest is executable by service_role only, migration 017);
 *   OPS_KEY                          — created in the admin page («Состояние» → «Создать ключ»);
 *   TELEGRAM_BOT_TOKEN               — from @BotFather;
 *   TELEGRAM_CHAT_ID                 — your chat id (see billing/README.md).
 * Node 18+, no dependencies.
 */
const MARKET = { kaspi: 'Kaspi', ozon: 'Ozon', wb: 'Wildberries' };
const KIND = { server: 'ошибка сервера', network: 'нет связи', timeout: 'таймаут', format: 'неожиданный ответ (API изменился?)', rate: 'лимит запросов', auth: 'неверный токен', other: 'другое' };

/** Digest → message text, or null when there is nothing to report. */
export function formatDigest(d) {
  const lines = [];
  for (const a of d.alerts || []) {
    const kinds = Object.entries(a.kinds || {}).filter(([k]) => k !== 'auth').sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, n]) => `${KIND[k] || k} — ${n}`).join(', ');
    lines.push(`🔴 СБОЙ ${MARKET[a.market] || a.market}: ошибки у ${a.failing} из ${a.users} клиентов (${Math.round(a.share * 100)} %) за последний час.${kinds ? ` Причины: ${kinds}.` : ''}`);
    lines.push('Опубликуйте сообщение клиентам: админка → «Состояние».');
  }
  for (const m of d.recovered || []) lines.push(`🟢 ${MARKET[m] || m} снова работает. Не забудьте убрать сообщение для клиентов.`);
  if (d.new_tickets > 0) lines.push(`💬 Новых вопросов: ${d.new_tickets} (всего ждут ответа: ${d.open_tickets}).`);
  if (d.new_invoices > 0) lines.push(`🧾 Новых счетов: ${d.new_invoices} (ждут подтверждения: ${d.pending_invoices} на ${new Intl.NumberFormat('ru-RU').format(d.pending_sum)} ₸).`);
  if (d.digest_late) {
    lines.push(`⏰ Утренняя сводка не ушла: ждут ${d.digest_late.pending} ${pl(d.digest_late.pending, 'клиент', 'клиента', 'клиентов')} (отправлено: ${d.digest_late.sent}).`);
    lines.push('GitHub мог не запустить рассылку: Actions → seller-hub-bot → «Run workflow».');
  }
  if (d.daily) lines.push(...(lines.length ? [''] : []), formatDaily(d.daily));
  return lines.length ? `SaudaPulse\n${lines.join('\n')}` : null;
}

const pl = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
const pct = (part, all) => (all ? `${Math.round((part / all) * 100)} %` : '—');

/** The once-a-day report (ops_daily_report in 032_support_bot.sql): how the solution worked in the last 24 hours. */
export function formatDaily(r) {
  const out = [`📊 Мониторинг за сутки (${String(r.day || '').split('-').reverse().join('.')})`];
  const g = r.digest || {};
  if (g.sent || g.failed || g.pending) {
    const when = g.first_at ? (g.first_at === g.last_at ? ` в ${g.first_at}` : ` с ${g.first_at} до ${g.last_at}`) : '';
    out.push(`☀️ Сводка: доставлено ${g.sent || 0}${when}${g.failed ? `, ошибок ${g.failed}` : ''}${g.pending ? `, не ушло ${g.pending}` : ''}.${g.first_at && g.first_at > '09:30' ? ' ⚠️ позже 09:30' : ''}`);
  } else out.push('☀️ Сводка: отправлять было некому.');
  const b = r.bot || {};
  if (b.asked) {
    out.push(`🤖 Вопросов в боте: ${b.asked}. Ответила база: ${b.answered} (${pct(b.answered, b.asked)}), без ответа: ${b.unanswered}. Помогло: ${b.helped}, не помогло: ${b.not_helped}.`);
    if ((b.top_faq || []).length) out.push(`   Чаще всего: ${b.top_faq.map((x) => `«${x.q}» ×${x.n}`).join(', ')}.`);
    if ((b.top_unanswered || []).length) out.push(`   Без ответа (добавьте в базу): ${b.top_unanswered.map((x) => `«${x}»`).join('; ')}.`);
  } else out.push('🤖 Вопросов в боте не было.');
  const t = r.tickets || {};
  out.push(`💬 Обращений: новых ${t.new || 0}${t.new_telegram ? ` (из Telegram ${t.new_telegram})` : ''}, ждут ответа ${t.open || 0}${t.oldest_open_hours != null && t.open ? `, самое старое ${t.oldest_open_hours} ч` : ''}.${t.oldest_open_hours >= 24 ? ' ⚠️' : ''}`);
  const c = r.clients || {};
  out.push(`👥 Клиенты: всего ${c.accounts || 0}, заходили за сутки ${c.active_24h || 0}, бот подключён у ${c.tg_linked || 0}${c.tg_blocked_24h ? `, заблокировали бота ${c.tg_blocked_24h}` : ''}.`);
  if ((r.errors || []).length) out.push(`🐞 Частые ошибки: ${r.errors.map((e) => `${e.code} — ${e.users} ${pl(e.users, 'клиент', 'клиента', 'клиентов')}`).join(', ')}.`);
  return out.join('\n');
}

export async function run(env = process.env, log = console.log) {
  const need = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPS_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].filter((k) => !env[k]);
  if (need.length) throw new Error(`missing settings: ${need.join(', ')}`);
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/ops_digest`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_key: env.OPS_KEY }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`digest: HTTP ${res.status} ${body.slice(0, 200)}`);
  const text = formatDigest(JSON.parse(body));
  if (!text) return log('nothing to report'), null;
  const tg = await fetch(`${env.TELEGRAM_API || 'https://api.telegram.org'}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!tg.ok) throw new Error(`telegram: HTTP ${tg.status} ${(await tg.text()).slice(0, 200)}`);
  log('sent');
  return text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(String(e.message).replace(/bot[^/\s]+/g, 'bot***')); // never print the bot token
    process.exit(1);
  });
}
