// Support in the Telegram bot: the answer base from 032_support_bot.sql, keyword matching, the menu,
// «Помогло», «Написать в поддержку», the owner's answer sent back to Telegram.
//   node --test tests/unit/bot-support.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { handle, matchFaq, isGreeting, isThanks, TEXTS } = await import('../../supabase/functions/telegram-bot/bot.js');

/** The starting base exactly as the migration seeds it. */
function seed() {
  const sql = readFileSync(new URL('../../supabase/migrations/032_support_bot.sql', import.meta.url), 'utf8');
  const block = sql.slice(sql.indexOf('insert into public.support_faq (slug'), sql.indexOf('on conflict (slug) do nothing'));
  return block.split(/\n\('/).slice(1).map((row, i) => {
    const s = [...`('${row}`.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    const [slug, topic, q_ru, q_kk, a_ru, a_kk, kw] = s;
    return { id: i + 1, slug, topic, q_ru, q_kk, a_ru, a_kk, kw };
  });
}
const BASE = seed();
const slugOf = (text) => matchFaq(text, BASE)?.slug ?? null;

test('the base parsed: generic answers, all fields', () => {
  assert.ok(BASE.length >= 7, `answers: ${BASE.length}`);
  for (const it of BASE) assert.ok(it.slug && it.q_ru && it.q_kk && it.a_ru && it.a_kk && it.kw, JSON.stringify(it).slice(0, 80));
  assert.equal(new Set(BASE.map((x) => x.q_ru)).size, BASE.length, 'menu questions are unique');
});

test('real questions find the right answer (RU and KZ)', () => {
  const cases = [
    ['во сколько приходит сводка?', 'digest_time'],
    ['как оплатить подписку', 'pay'],
    ['я оплатил но подписка не включилась', 'pay_wait'],
    ['төледім бірақ қосылмады', 'pay_wait'],
    ['как подтвердить номер для оплаты', 'phone'],
    ['хочу отменить подписку', 'cancel'],
    ['как подключить телеграм', 'telegram'],
    ['как отключить уведомления', 'stop'],
  ];
  const wrong = cases.filter(([text, slug]) => slugOf(text) !== slug).map(([text, slug]) => `«${text}» → ${slugOf(text)} (ждали ${slug})`);
  assert.deepEqual(wrong, []);
});

test('no answer for unrelated text', () => {
  for (const text of ['какая погода в Алматы', 'asdfgh', '', '   ']) assert.equal(slugOf(text), null, text);
});

test('greetings and thanks are not questions', () => {
  for (const text of ['Салем', 'сәлем!', 'Привет', 'Добрый день', 'Қайырлы таң', 'Ассалаумағалейкум']) assert.ok(isGreeting(text), text);
  for (const text of ['Спасибо!', 'рахмет', 'Понятно, спасибо']) assert.ok(isThanks(text), text);
  for (const text of ['Салем, где взять токен?', 'спасибо, а как оплатить подписку?']) assert.ok(!isGreeting(text) && !isThanks(text), text);
});

/* ---------- the dialogue, against a fake database ---------- */
const env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', BOT_KEY: 'k', BOT_TOKEN: 't', TELEGRAM_API: 'https://tg.test', WEBHOOK_SECRET: 'secret-secret-0123' };
function fakeDb({ linked = { 9: 'ru' } } = {}) {
  const db = { asked: [], feedback: [], waiting: new Set(), tickets: [], sent: [] };
  const ok = (v) => new Response(JSON.stringify(v), { status: 200 });
  db.f = async (url, opts) => {
    const b = opts?.body ? JSON.parse(opts.body) : {};
    const rpcName = url.includes('/rpc/') ? url.split('/rpc/')[1] : null;
    if (rpcName === 'bot_langs') return ok({ users: {}, chats: Object.fromEntries((b.p_chat_ids || []).filter((c) => linked[c]).map((c) => [String(c), linked[c]])) });
    if (rpcName === 'bot_faq') return ok({ items: BASE, support_url: 'https://wa.me/77000000000' });
    if (rpcName === 'bot_ask') { db.asked.push(b); return ok({ id: db.asked.length }); }
    if (rpcName === 'bot_feedback') { db.feedback.push(b.p_helped); return ok({ ok: true }); }
    if (rpcName === 'bot_ticket_wait') {
      if (!linked[b.p_chat_id]) return ok({ ok: false, error: 'not_linked' });
      b.p_on ? db.waiting.add(b.p_chat_id) : db.waiting.delete(b.p_chat_id);
      return ok({ ok: true });
    }
    if (rpcName === 'bot_ticket') {
      if (!db.waiting.delete(b.p_chat_id)) return ok({ ok: false, error: 'not_waiting' });
      db.tickets.push(b.p_text);
      return ok({ ok: true, id: 100 + db.tickets.length });
    }
    if (rpcName === 'admin_ticket_tg') {
      db.adminAuth = opts.headers.Authorization;
      return ok(b.p_id === 7 ? { id: 7, chat_id: 9, lang: 'kk', reply: 'Төлем расталды' } : null);
    }
    if (rpcName) return ok(null);
    db.sent.push(b);
    return ok({ ok: true });
  };
  db.say = async (text, chat = 9, lang = 'ru') => {
    const req = new Request('https://x.test/telegram-bot/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': env.WEBHOOK_SECRET },
      body: JSON.stringify({ message: { chat: { id: chat, type: 'private' }, from: { id: chat, language_code: lang }, text } }) });
    assert.equal((await handle(req, env, db.f)).status, 200);
    return db.sent.at(-1);
  };
  return db;
}
const buttons = (m) => (m.reply_markup?.keyboard || []).flat().map((b) => b.text);

test('«Салем» → greeting and the menu of topics (not «уведомления подключены»)', async () => {
  const db = fakeDb();
  const m = await db.say('Салем');
  assert.ok(m.text.startsWith(TEXTS.ru.hi) && m.text.endsWith(TEXTS.ru.menuIntro), m.text);
  assert.deepEqual(buttons(m), [...Object.values(TEXTS.ru.topics), TEXTS.ru.btnWrite]);
  assert.equal(db.asked.length, 0, 'a greeting is not logged as a question');
});

test('topic → its questions → answer, logged as a menu pick; «Помогло» recorded', async () => {
  const db = fakeDb();
  const list = await db.say(TEXTS.ru.topics.payment);
  assert.equal(list.text, TEXTS.ru.pickQuestion);
  assert.ok(buttons(list).includes('Как оплатить подписку?') && buttons(list).at(-1) === TEXTS.ru.btnBack);
  const ans = await db.say('Как оплатить подписку?');
  assert.ok(ans.text.startsWith('Раздел «Подписка»') && ans.text.endsWith(TEXTS.ru.wasHelpful));
  assert.deepEqual(buttons(ans), [TEXTS.ru.btnYes, TEXTS.ru.btnNo, TEXTS.ru.btnWrite, TEXTS.ru.btnMenu]);
  assert.equal(db.asked.at(-1).p_source, 'menu');
  assert.equal(db.asked.at(-1).p_faq, BASE.find((x) => x.slug === 'pay').id);
  assert.equal((await db.say(TEXTS.ru.btnYes)).text, TEXTS.ru.thanks);
  assert.deepEqual(db.feedback, [true]);
  assert.equal((await db.say(TEXTS.ru.btnBack)).text, TEXTS.ru.menuIntro);
});

test('free text in Kazakh → Kazakh answer; unknown question → «не нашёл», logged without an answer', async () => {
  const db = fakeDb({ linked: { 9: 'kk' } });
  const ans = await db.say('Жазылымды қалай төлеймін?');
  assert.ok(ans.text.startsWith('«Жазылым» бөлімі') && ans.text.endsWith(TEXTS.kk.wasHelpful), ans.text);
  assert.equal(db.asked.at(-1).p_lang, 'kk');
  const none = await db.say('какая погода завтра');
  assert.equal(none.text, TEXTS.kk.noAnswer);
  assert.equal(db.asked.at(-1).p_faq, null);
  assert.equal(db.asked.at(-1).p_source, 'text');
});

test('«Не помогло» → offer to write to support; the next message becomes a ticket', async () => {
  const db = fakeDb();
  await db.say('как оплатить подписку');
  const no = await db.say(TEXTS.ru.btnNo);
  assert.equal(no.text, TEXTS.ru.sorry);
  assert.deepEqual(db.feedback, [false]);
  const ask = await db.say(TEXTS.ru.btnWrite);
  assert.equal(ask.text, TEXTS.ru.askTicket);
  assert.deepEqual(buttons(ask), [TEXTS.ru.btnCancel]);
  const done = await db.say('Оплатил вчера, а доступа всё нет, ошибка 401');
  assert.equal(done.text, TEXTS.ru.ticketOk(101));
  assert.deepEqual(db.tickets, ['Оплатил вчера, а доступа всё нет, ошибка 401']);
  // after the ticket the same kind of text is a question again, not a second ticket
  await db.say('ошибка 401');
  assert.equal(db.tickets.length, 1);
});

test('«Отмена» stops waiting; an unlinked chat gets the support link instead', async () => {
  const db = fakeDb();
  await db.say(TEXTS.ru.btnWrite);
  assert.equal((await db.say(TEXTS.ru.btnCancel)).text, TEXTS.ru.ticketCancelled);
  await db.say('как оплатить подписку');
  assert.equal(db.tickets.length, 0);
  const m = await db.say(TEXTS.ru.btnWrite, 55);
  assert.equal(m.text, TEXTS.ru.ticketNotLinked('https://wa.me/77000000000'));
});

test('an unlinked chat still gets answers, and /start shows how to connect + the menu', async () => {
  const db = fakeDb({ linked: {} });
  assert.ok((await db.say('как подключить телеграм', 55)).text.startsWith('Откройте «Настройки»'));
  const st = await db.say('/start', 55);
  assert.ok(st.text.startsWith(TEXTS.ru.help) && st.text.endsWith(TEXTS.ru.menuIntro));
});

test('the owner\'s answer goes to the client\'s Telegram (admin token only)', async () => {
  const db = fakeDb();
  const req = (id, token) => new Request('https://x.test/telegram-bot/ticket-reply', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify({ id }) });
  assert.equal((await handle(req(7), env, db.f)).status, 401);
  assert.equal((await handle(req(7, 'anon'), env, db.f)).status, 401, 'the anon key is not a user');
  assert.deepEqual(await (await handle(req(7, 'admin-jwt'), env, db.f)).json(), { sent: true });
  assert.equal(db.adminAuth, 'Bearer admin-jwt', 'asked the database with the admin\'s own token');
  assert.equal(db.sent.at(-1).chat_id, 9);
  assert.equal(db.sent.at(-1).text, TEXTS.kk.ticketReply(7, 'Төлем расталды'));
  assert.deepEqual(await (await handle(req(8, 'admin-jwt'), env, db.f)).json(), { sent: false, reason: 'no_telegram' });
});
