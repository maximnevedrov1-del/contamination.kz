// The owner's Telegram monitoring: «digest is late» and the daily report (tools/ops-alert.mjs, 032_support_bot.sql).
import test from 'node:test';
import assert from 'node:assert/strict';
const { formatDigest, formatDaily } = await import('../../tools/ops-alert.mjs');

const daily = {
  day: '2026-11-24',
  digest: { for_day: '2026-11-23', sent: 41, failed: 1, pending: 0, first_at: '19:32', last_at: '19:33' },
  bot: { asked: 12, answered: 9, unanswered: 3, helped: 4, not_helped: 1, top_faq: [{ q: 'Где взять токен API?', n: 3 }], top_unanswered: ['как вернуть товар'] },
  tickets: { new: 4, new_telegram: 1, open: 2, oldest_open_hours: 26 },
  clients: { accounts: 57, active_24h: 33, tg_linked: 41, tg_blocked_24h: 1 },
  errors: [{ code: 'apiUnauthorized', users: 2, n: 14 }],
};

test('nothing to say → no message', () => {
  assert.equal(formatDigest({ alerts: [], recovered: [], new_tickets: 0, new_invoices: 0, digest_late: null, daily: null }), null);
});

test('late digest: how many wait and what to do', () => {
  const m = formatDigest({ alerts: [], recovered: [], digest_late: { pending: 3, sent: 0 } });
  assert.match(m, /Утренняя сводка не ушла: ждут 3 клиента/);
  assert.match(m, /Run workflow/);
});

test('daily report: delivery time with a warning when late, bot quality, tickets, clients, errors', () => {
  const m = formatDaily(daily);
  assert.match(m, /^📊 Мониторинг за сутки \(24\.11\.2026\)/);
  assert.match(m, /доставлено 41 с 19:32 до 19:33, ошибок 1\. ⚠️ позже 09:30/);
  assert.match(m, /Ответила база: 9 \(75 %\), без ответа: 3/);
  assert.match(m, /Без ответа \(добавьте в базу\): «как вернуть товар»/);
  assert.match(m, /самое старое 26 ч\. ⚠️/);
  assert.match(m, /apiUnauthorized — 2 клиента/);
  const ok = formatDaily({ ...daily, digest: { ...daily.digest, first_at: '09:07', last_at: '09:08', failed: 0 } });
  assert.match(ok, /доставлено 41 с 09:07 до 09:08\.\n/);
  assert.ok(!/позже 09:30/.test(ok));
});

test('quiet day: no questions, nobody to send the digest to', () => {
  const m = formatDaily({ day: '2026-11-25', digest: { sent: 0, failed: 0, pending: 0 }, bot: { asked: 0 }, tickets: { new: 0, open: 0 }, clients: { accounts: 1, active_24h: 1, tg_linked: 1 }, errors: [] });
  assert.match(m, /Сводка: отправлять было некому/);
  assert.match(m, /Вопросов в боте не было/);
});
