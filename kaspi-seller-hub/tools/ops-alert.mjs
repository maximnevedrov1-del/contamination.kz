#!/usr/bin/env node
/**
 * Seller Hub — Telegram alerts for the owner (run every 10 minutes by .github/workflows/ops-alert.yml).
 *
 * Asks the subscription server for a digest (billing/supabase/003_support.sql → ops_digest) and,
 * when there is something to say, sends ONE Telegram message:
 *   - Kaspi (or Ozon/WB) API fails for many clients at once → «сбой», then «восстановилось»;
 *   - new questions to support, new invoices waiting for confirmation.
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
  return lines.length ? `SaudaPulse\n${lines.join('\n')}` : null;
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
