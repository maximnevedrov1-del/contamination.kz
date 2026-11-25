/**
 * SaudaPulse — the seller's Telegram bot (Supabase Edge Function, also runs in Node for tests).
 *
 * Routes (POST):
 *   …/telegram-bot/webhook  Telegram updates: /start <token> links the chat, /stop unlinks, /phone and the
 *                           «share my number» contact confirm the payer phone (031_phone_verified.sql);
 *                           checked with the X-Telegram-Bot-Api-Secret-Token header.
 *   …/telegram-bot/alert    from the extension with the SELLER's token: «order at risk» right now
 *                           (the database decides whether to send: linked, alerts on, once per order).
 *   …/telegram-bot/ticket-reply  from the admin page with the ADMIN's token: the answer to a support ticket goes
 *                           to the client's Telegram too (admin_ticket_tg checks is_admin).
 *   …/telegram-bot/run      scheduled at 09:00 Almaty with X-Bot-Key: morning digest, «6 days away»,
 *                           grace reminders, win-back at 30 / 60 days.
 * The bot reaches the database only through the bot_* functions: EXECUTE on them is granted to
 * service_role only (migration 017), so calls without a seller token use SUPABASE_SERVICE_ROLE_KEY
 * (auto-provided by the Edge runtime), and every call also carries its own key (BOT_KEY → p_key).
 * Messages are plain text (no HTML/Markdown parsing).
 *
 * Environment: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (all set by Supabase), BOT_TOKEN (@BotFather),
 * BOT_KEY (admin page → «Состояние» → «Ключ бота»), WEBHOOK_SECRET (any long random string).
 */

const money = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0)).replace(/\u00a0/g, ' ') + ' ₸';
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
const ddmm = (day) => { const [, m, d] = String(day).split('-'); return `${d}.${m}`; };
const hhmmAlmaty = (iso) => new Date(new Date(iso).getTime() + 5 * 3600000).toISOString().slice(11, 16);
/** Part of the day by Kazakhstan time (UTC+5) at send time: 04–11 morning, 12–17 day, otherwise evening. */
export const dayPart = (now = new Date()) => {
  const h = new Date(new Date(now).getTime() + 5 * 3600000).getUTCHours();
  return h >= 4 && h < 12 ? 'morning' : h >= 12 && h < 18 ? 'day' : 'evening';
};

/**
 * Every text the bot sends, in the client's interface language (accounts.lang, 029_client_language.sql).
 * Unknown language → Russian. Kazakh has no plural forms after a number, so `pl` returns one word.
 */
const ruPl = (n, one, few, many) => plural(n, one, few, many);
export const TEXTS = {
  ru: {
    btnOrders: '📦 Посмотреть заказы',
    btnSupport: '💬 Поддержка',
    hello: (name, part = 'morning') => `${{ morning: '☀️ Доброе утро', day: '🌤 Добрый день', evening: '🌙 Добрый вечер' }[part]}${name ? `, ${name}` : ''}!`,
    summary: (dm) => `📊 Сводка по вашим магазинам за вчера (${dm}):`,
    ordered: (n, sum) => `📦 Заказов оформлено: ${n} (на сумму ${sum})`,
    shipped: (n) => `🚚 Успешно отправлено: ${n}`,
    atRisk: (n, list) => `⚠️ Требуют внимания: ${n} ${ruPl(n, 'заказ', 'заказа', 'заказов')} — под угрозой просрочки сборки: ${list}`,
    noRisk: '✅ Зависших заказов нет',
    asOf: (hm) => `ℹ️ По данным на ${hm} — позже Chrome с расширением был закрыт.`,
    care: (name) => `${name || 'Здравствуйте'}, мы заметили, что вы пару дней не заходили в кабинет. Всё в порядке? Если нужна помощь с синхронизацией Kaspi, мы на связи 🙌`,
    grace: (n) => `⏳ Оплаченный период закончился. Кабинет работает ещё ${n} ${ruPl(n, 'день', 'дня', 'дней')} — оплатите продление, чтобы не потерять доступ к заказам и истории.`,
    winback30: (name, news) => `👋 Здравствуйте${name ? `, ${name}` : ''}! Вот что нового в SaudaPulse за последний месяц:\n\n${news}\n\nВаши магазины и настройки сохранены — вернуться можно в любой момент.`,
    winback60: (pct) => `🎁 Вернитесь в SaudaPulse со скидкой ${pct} % на первый месяц. Ваши старые магазины сохранены в архиве — настраивать заново ничего не нужно. Предложение действует 30 дней.`,
    referral: (days) => `🎉 Ваш друг оплатил подписку — вам начислено +${days} дней SaudaPulse!`,
    cancelled: (code, shop) => `❌ Заказ №${code} в магазине ${shop} отменён.`,
    deadline: (code, shop, m) => `🚨 Внимание! Заказ №${code} в магазине ${shop} под угрозой просрочки. Осталось ${m} ${ruPl(m, 'минута', 'минуты', 'минут')} до отмены!`,
    nudge: {
      no_first_sync_24h: 'Здравствуйте! Вы зарегистрировались в SaudaPulse, но данные из Kaspi ещё не загрузились. Откройте расширение и нажмите «Синхронизировать» — это займёт пару минут. Если что-то не получается, напишите нам, поможем.',
      trial_ending_2d: 'Пробный период SaudaPulse заканчивается через 2 дня. Чтобы не потерять доступ к заказам, остаткам и истории, оформите подписку в кабинете.',
      trial_expired_winback: 'Пробный период SaudaPulse закончился, но ваши магазины и данные сохранены. Вернуться можно в любой момент. А если пригласите друга, вы получите +14 дней подписки в подарок.',
    },
    linkExpired: 'Ссылка устарела. Откройте SaudaPulse → Настройки → «Подключить Telegram» и нажмите ещё раз.',
    linked: (shops) => `✅ Уведомления успешно подключены${shops.length ? ` для ${shops.length > 1 ? 'магазинов' : 'магазина'} ${shops.join(', ')}` : ''}!\n\nКаждое утро в 09:00 — сводка за вчера, а если заказ под угрозой просрочки — сразу сообщение. Отключить: /stop`,
    unlinked: 'Уведомления отключены. Подключить снова: SaudaPulse → Настройки → «Подключить Telegram».',
    help: 'Это бот уведомлений SaudaPulse. Чтобы подключить его, откройте SaudaPulse → Настройки → «Подключить Telegram».',
    linkedHelp: '✅ Уведомления подключены: каждое утро в 09:00 — сводка за вчера, а если заказ под угрозой просрочки — сразу сообщение. Подтвердить номер для оплаты: /phone. Отключить: /stop',
    btnSharePhone: '📱 Поделиться номером',
    askPhone: 'Подтвердите номер телефона, с которого платите за SaudaPulse: нажмите кнопку «📱 Поделиться номером» внизу. Тогда оплата по этому номеру будет засчитываться автоматически, без ожидания.',
    phoneOk: (ph) => `✅ Номер ${ph} подтверждён. Оплата с него будет засчитываться автоматически.`,
    phoneNotOwn: 'Можно подтвердить только свой номер — нажмите кнопку «📱 Поделиться номером», а не отправляйте чужой контакт.',
    phoneBad: 'Этот номер не похож на казахстанский мобильный. Платить можно и так — счёт подтвердят вручную.',
    phoneNotLinked: 'Сначала подключите бота: SaudaPulse → Настройки → «Подключить Telegram».',
    // support in the bot (032_support_bot.sql): menu of topics, answers from the base, «Написать в поддержку»
    topics: { connect: '🔌 Подключение', orders: '📦 Заказы и сводка', print: '🖨 Печать', payment: '💳 Оплата', goods: '🏷 Товары и склад', bot: '🤖 Telegram-бот' },
    btnWrite: '✍️ Написать в поддержку',
    btnMenu: '📋 Меню',
    btnBack: '⬅️ Назад',
    btnYes: '👍 Помогло',
    btnNo: '👎 Не помогло',
    btnCancel: '❌ Отмена',
    menuIntro: 'Чем помочь? Выберите тему или напишите вопрос своими словами.',
    hi: 'Здравствуйте! 👋',
    pickQuestion: 'Выберите вопрос:',
    wasHelpful: 'Помог ответ?',
    noAnswer: 'Не нашёл готового ответа 🤔 Выберите тему ниже или нажмите «✍️ Написать в поддержку» — ответим здесь.',
    thanks: 'Отлично, рад помочь! 🙌 Если будут вопросы — пишите.',
    welcome: 'Пожалуйста! Если будут вопросы — пишите 🙌',
    sorry: 'Жаль, что не помогло. Нажмите «✍️ Написать в поддержку» — ответим лично.',
    askTicket: 'Опишите вопрос одним сообщением — передам в поддержку. Ответ придёт сюда и в SaudaPulse («Помощь»).',
    ticketOk: (id) => `✅ Вопрос №${id} передан в поддержку. Ответим здесь, обычно в течение пары часов в рабочее время.`,
    ticketLimit: 'Слишком много обращений за короткое время. Попробуйте позже.',
    ticketNotLinked: (url) => `Чтобы написать в поддержку отсюда, подключите бота: SaudaPulse → Настройки → «Подключить Telegram».${url ? `\n\nИли напишите нам: ${url}` : ''}`,
    ticketCancelled: 'Хорошо, отменил.',
    ticketReply: (id, reply) => `💬 Ответ поддержки на вопрос №${id}:\n\n${reply}`,
  },
  kk: {
    btnOrders: '📦 Тапсырыстарды көру',
    btnSupport: '💬 Қолдау',
    hello: (name, part = 'morning') => `${{ morning: '☀️ Қайырлы таң', day: '🌤 Қайырлы күн', evening: '🌙 Қайырлы кеш' }[part]}${name ? `, ${name}` : ''}!`,
    summary: (dm) => `📊 Дүкендеріңіз бойынша кешегі қорытынды (${dm}):`,
    ordered: (n, sum) => `📦 Рәсімделген тапсырыстар: ${n} (сомасы ${sum})`,
    shipped: (n) => `🚚 Сәтті жөнелтілді: ${n}`,
    atRisk: (n, list) => `⚠️ Назар аударыңыз: ${n} тапсырыс жинау мерзімі өтіп кету қаупінде: ${list}`,
    noRisk: '✅ Тоқтап қалған тапсырыстар жоқ',
    asOf: (hm) => `ℹ️ Деректер ${hm} уақытындағы — кейін кеңейтімі бар Chrome жабылды.`,
    care: (name) => `${name || 'Сәлеметсіз бе'}, бірнеше күннен бері кабинетке кірмегеніңізді байқадық. Бәрі жақсы ма? Kaspi синхрондауына көмек керек болса, біз байланыстамыз 🙌`,
    grace: (n) => `⏳ Төленген мерзім аяқталды. Кабинет тағы ${n} күн жұмыс істейді — тапсырыстар мен тарихқа қолжетімділікті жоғалтпау үшін жазылымды ұзартыңыз.`,
    winback30: (name, news) => `👋 Сәлеметсіз бе${name ? `, ${name}` : ''}! Соңғы айда SaudaPulse-те не жаңа:\n\n${news}\n\nДүкендеріңіз бен баптауларыңыз сақталған — кез келген уақытта қайта оралуға болады.`,
    winback60: (pct) => `🎁 SaudaPulse-ке бірінші айға ${pct} % жеңілдікпен оралыңыз. Бұрынғы дүкендеріңіз мұрағатта сақталған — қайта баптаудың қажеті жоқ. Ұсыныс 30 күн жарамды.`,
    referral: (days) => `🎉 Досыңыз жазылымды төледі — сізге SaudaPulse-тің +${days} күні қосылды!`,
    cancelled: (code, shop) => `❌ ${shop} дүкеніндегі №${code} тапсырыс болдырылмады.`,
    deadline: (code, shop, m) => `🚨 Назар аударыңыз! ${shop} дүкеніндегі №${code} тапсырыстың мерзімі өтіп кету қаупінде. Болдырмауға дейін ${m} минут қалды!`,
    nudge: {
      no_first_sync_24h: 'Сәлеметсіз бе! Сіз SaudaPulse-те тіркелдіңіз, бірақ Kaspi деректері әлі жүктелмеді. Кеңейтімді ашып, «Синхрондау» батырмасын басыңыз — бұл бірнеше минут алады. Бірдеңе шықпаса, бізге жазыңыз, көмектесеміз.',
      trial_ending_2d: 'SaudaPulse сынақ мерзімі 2 күннен кейін аяқталады. Тапсырыстарға, қалдықтарға және тарихқа қолжетімділікті жоғалтпау үшін кабинетте жазылым рәсімдеңіз.',
      trial_expired_winback: 'SaudaPulse сынақ мерзімі аяқталды, бірақ дүкендеріңіз бен деректеріңіз сақталған. Кез келген уақытта оралуға болады. Ал досыңызды шақырсаңыз, сыйлыққа +14 күн жазылым аласыз.',
    },
    linkExpired: 'Сілтеменің мерзімі өтті. SaudaPulse → Баптаулар → «Telegram қосу» ашып, қайта басыңыз.',
    linked: (shops) => `✅ Хабарламалар сәтті қосылды${shops.length ? ` (${shops.length > 1 ? 'дүкендер' : 'дүкен'}: ${shops.join(', ')})` : ''}!\n\nКүн сайын таңғы 09:00-де — кешегі қорытынды, ал тапсырыс мерзімі өтіп кету қаупінде болса — бірден хабарлама. Өшіру: /stop`,
    unlinked: 'Хабарламалар өшірілді. Қайта қосу: SaudaPulse → Баптаулар → «Telegram қосу».',
    help: 'Бұл — SaudaPulse хабарламалар боты. Қосу үшін SaudaPulse → Баптаулар → «Telegram қосу» ашыңыз.',
    linkedHelp: '✅ Хабарламалар қосулы: күн сайын таңғы 09:00-де — кешегі қорытынды, ал тапсырыс мерзімі өтіп кету қаупінде болса — бірден хабарлама. Төлем нөмірін растау: /phone. Өшіру: /stop',
    btnSharePhone: '📱 Нөмірмен бөлісу',
    askPhone: 'SaudaPulse үшін төлейтін телефон нөміріңізді растаңыз: төмендегі «📱 Нөмірмен бөлісу» батырмасын басыңыз. Сонда осы нөмірден төлем күтпестен автоматты түрде есептеледі.',
    phoneOk: (ph) => `✅ ${ph} нөмірі расталды. Осы нөмірден төлем автоматты түрде есептеледі.`,
    phoneNotOwn: 'Тек өз нөміріңізді растай аласыз — басқа біреудің контактісін жібермей, «📱 Нөмірмен бөлісу» батырмасын басыңыз.',
    phoneBad: 'Бұл нөмір қазақстандық ұялы нөмірге ұқсамайды. Бәрібір төлей беруге болады — шотты қолмен растайды.',
    phoneNotLinked: 'Алдымен ботты қосыңыз: SaudaPulse → Баптаулар → «Telegram қосу».',
    topics: { connect: '🔌 Қосу', orders: '📦 Тапсырыстар мен қорытынды', print: '🖨 Басып шығару', payment: '💳 Төлем', goods: '🏷 Тауарлар мен қойма', bot: '🤖 Telegram-бот' },
    btnWrite: '✍️ Қолдауға жазу',
    btnMenu: '📋 Мәзір',
    btnBack: '⬅️ Артқа',
    btnYes: '👍 Көмектесті',
    btnNo: '👎 Көмектеспеді',
    btnCancel: '❌ Болдырмау',
    menuIntro: 'Немен көмектесейін? Тақырыпты таңдаңыз немесе сұрағыңызды өз сөзіңізбен жазыңыз.',
    hi: 'Сәлеметсіз бе! 👋',
    pickQuestion: 'Сұрақты таңдаңыз:',
    wasHelpful: 'Жауап көмектесті ме?',
    noAnswer: 'Дайын жауап таппадым 🤔 Төменнен тақырыпты таңдаңыз немесе «✍️ Қолдауға жазу» батырмасын басыңыз — осында жауап береміз.',
    thanks: 'Тамаша, көмектескеніме қуаныштымын! 🙌 Сұрақ болса — жазыңыз.',
    welcome: 'Оқасы жоқ! Сұрақ болса — жазыңыз 🙌',
    sorry: 'Көмектеспегені өкінішті. «✍️ Қолдауға жазу» батырмасын басыңыз — жеке жауап береміз.',
    askTicket: 'Сұрағыңызды бір хабарламамен сипаттаңыз — қолдауға жіберемін. Жауап осында және SaudaPulse-ке («Көмек») келеді.',
    ticketOk: (id) => `✅ №${id} сұрақ қолдауға жіберілді. Осында жауап береміз, әдетте жұмыс уақытында бірнеше сағат ішінде.`,
    ticketLimit: 'Қысқа уақытта өтініш тым көп. Кейінірек қайталаңыз.',
    ticketNotLinked: (url) => `Осы жерден қолдауға жазу үшін ботты қосыңыз: SaudaPulse → Баптаулар → «Telegram қосу».${url ? `\n\nНемесе бізге жазыңыз: ${url}` : ''}`,
    ticketCancelled: 'Жарайды, болдырмадым.',
    ticketReply: (id, reply) => `💬 №${id} сұраққа қолдау жауабы:\n\n${reply}`,
  },
};
export const langOf = (l) => (l === 'kk' ? 'kk' : 'ru');
const T = (lang) => TEXTS[langOf(lang)];

/** Inline buttons: [📦 Посмотреть заказы] [💬 Поддержка] — only those with an https link. */
export function buttons({ app_url, support_url }, route = 'orders', lang = 'ru') {
  const row = [];
  if (app_url) row.push({ text: T(lang).btnOrders, url: `${app_url.replace(/\/$/, '')}/open#${route}` });
  if (support_url) row.push({ text: T(lang).btnSupport, url: support_url });
  return row.length ? { inline_keyboard: [row] } : undefined;
}

/** Reply keyboard with Telegram's own «share my number» button (request_contact: the user's number, verified by Telegram). */
export const phoneKeyboard = (lang = 'ru') => ({ keyboard: [[{ text: T(lang).btnSharePhone, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true });
const fmtPhone = (p) => { const d = String(p || ''); return /^77\d{9}$/.test(d) ? `+7 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9)}` : d; };

/** Text of each message kind, in `lang` ('ru' | 'kk'). */
export function format(item, lang = 'ru', now = new Date()) {
  const t = T(lang);
  const d = item.data || {};
  if (item.kind === 'morning') {
    const s = d.stats || {};
    const risk = Array.isArray(s.at_risk) ? s.at_risk : [];
    const list = `${risk.slice(0, 5).map((r) => `№${r.code}${r.shop ? ` (${r.shop})` : ''}`).join(', ')}${risk.length > 5 ? '…' : ''}`;
    const lines = [
      t.hello(d.name, dayPart(now)),
      t.summary(ddmm(d.day)),
      '',
      t.ordered(s.orders || 0, money(s.sum)),
      t.shipped(s.shipped || 0),
      risk.length ? t.atRisk(risk.length, list) : t.noRisk,
    ];
    // numbers come from the extension: say how fresh they are if Chrome was closed before midnight
    if (d.as_of && new Date(d.as_of).getTime() < new Date(`${d.day}T19:00:00Z`).getTime()) lines.push('', t.asOf(hhmmAlmaty(d.as_of)));
    return lines.join('\n');
  }
  if (item.kind === 'care') return t.care(d.name);
  if (item.kind === 'grace') return t.grace(d.days_left);
  if (item.kind === 'winback30') return t.winback30(d.name, d.whats_new);
  if (item.kind === 'winback60') return t.winback60(d.pct || 50);
  // retention nudges: the text by its key in the client's language; an unknown key keeps the text queued by the database
  if (item.kind === 'nudge') return String(t.nudge[d.key] || d.text || '').slice(0, 1000);
  if (item.kind === 'referral') return t.referral(d.days || 14);
  if (item.kind === 'alert') {
    if (d.kind === 'cancelled') return t.cancelled(d.code, d.shop);
    return t.deadline(d.code, d.shop, Math.max(0, Math.round(d.minutes || 0)));
  }
  return '';
}

/** Languages for the users / chats the bot is about to write to; Russian when the lookup fails (never blocks sending). */
async function langs(env, f, { users = [], chats = [] } = {}) {
  try {
    const r = await rpc(env, 'bot_langs', { p_key: env.BOT_KEY, p_user_ids: users.length ? users : null, p_chat_ids: chats.length ? chats : null }, null, f);
    return { users: r?.users || {}, chats: r?.chats || {}, whats_new_kk: r?.whats_new_kk || null };
  } catch (e) {
    console.warn('[telegram-bot] bot_langs failed, Russian used', String(e?.message || e).slice(0, 100));
    return { users: {}, chats: {}, whats_new_kk: null };
  }
}
/** Language of a chat not linked yet: the Telegram app's language (kk → Kazakh, anything else → Russian). */
const tgLang = (msg) => (String(msg?.from?.language_code || '').toLowerCase().startsWith('kk') ? 'kk' : 'ru');

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
    headers: token
      ? { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      : { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
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


/* ---------- support in the bot: the answer base (032_support_bot.sql) ---------- */
export const TOPICS = ['connect', 'orders', 'print', 'payment', 'goods', 'bot'];
/** Lower case, ё → е, letters and digits only, single spaces. */
export const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const GREETING = new Set(('салем сәлем салам салем алейкум ассалаумағалейкум ассалаумалейкум ассалаумуалейкум сәлеметсіз сәлеметсиз салеметсиз '
  + 'бе привет приветствую здравствуйте здраствуйте здрасте здравствуй добрый доброе утро день вечер қайырлы таң кеш күн hello hi hey ау').split(' '));
const THANKS = new Set('спасибо спс благодарю рахмет рақмет ракмет рахмет рахмеет thanks thank you понятно ясно хорошо ок ok жарайды түсінікті'.split(' '));
/** Only a greeting («Салем», «Добрый день!») / only thanks — not a question. */
export const isGreeting = (text) => { const w = norm(text).split(' ').filter(Boolean); return w.length > 0 && w.length <= 4 && w.every((x) => GREETING.has(x)); };
export const isThanks = (text) => { const w = norm(text).split(' ').filter(Boolean); return w.length > 0 && w.length <= 4 && w.every((x) => THANKS.has(x)); };

/**
 * The best answer for a free-text question, or null. A keyword is the START of a word: «токен» matches «токена».
 * A keyword of several words matches when every one of them starts some word of the message, in any order
 * («неверн токен» ← «пишет, что токен неверный»), and weighs as many points as it has words. The answer with the
 * most points wins; ties → the first in the base order (sort, id).
 */
export function matchFaq(text, items) {
  const words = norm(text).split(' ').filter(Boolean);
  if (!words.length) return null;
  const has = (w) => words.some((x) => x.startsWith(w));
  let best = null;
  let score = 0;
  for (const it of items || []) {
    let sc = 0;
    for (const k of String(it.kw || '').split(',')) {
      const kw = norm(k).split(' ').filter(Boolean);
      if (kw.length && kw.every(has)) sc += kw.length;
    }
    if (sc > score) { best = it; score = sc; }
  }
  return best;
}

const kb = (rows) => ({ keyboard: rows.filter((r) => r.length).map((r) => r.map((text) => ({ text }))), resize_keyboard: true, is_persistent: true });
const menuKb = (lang) => { const t = T(lang).topics; return kb([[t.connect, t.orders], [t.print, t.payment], [t.goods, t.bot], [T(lang).btnWrite]]); };
const answerKb = (lang) => kb([[T(lang).btnYes, T(lang).btnNo], [T(lang).btnWrite, T(lang).btnMenu]]);
/** Which button was pressed (in either language: the keyboard may be older than a language change). */
const pressed = (text, key) => text === TEXTS.ru[key] || text === TEXTS.kk[key];
const topicOf = (text) => TOPICS.find((k) => text === TEXTS.ru.topics[k] || text === TEXTS.kk.topics[k]);
const q = (it, lang) => (lang === 'kk' ? it.q_kk : it.q_ru);
const a = (it, lang) => (lang === 'kk' ? it.a_kk : it.a_ru);

/** A message that is not a command: menu buttons, «Написать в поддержку», a question for the base. */
async function support(env, f, { chat, text, lang, linked }) {
  const t = T(lang);
  const say = (body, reply_markup) => tg(env, 'sendMessage', { chat_id: chat, text: body, reply_markup, disable_web_page_preview: true }, f);
  const call = (fn, args) => rpc(env, fn, { p_key: env.BOT_KEY, p_chat_id: chat, ...args }, null, f);
  if (pressed(text, 'btnCancel')) {
    if (linked) await call('bot_ticket_wait', { p_on: false }).catch(() => {});
    return say(t.ticketCancelled, menuKb(lang));
  }
  // waiting for the question to support: this message is it (buttons above are not)
  const isButton = pressed(text, 'btnWrite') || pressed(text, 'btnMenu') || pressed(text, 'btnBack') || pressed(text, 'btnYes') || pressed(text, 'btnNo') || topicOf(text);
  if (linked && text && !isButton && !text.startsWith('/')) {
    const r = await call('bot_ticket', { p_text: text }).catch((e) => console.warn('[telegram-bot] bot_ticket failed', String(e?.message || e).slice(0, 100)));
    if (r?.ok) return say(t.ticketOk(r.id), menuKb(lang));
    if (r?.error === 'ticket_limit') return say(t.ticketLimit, menuKb(lang));
  }
  // bot_faq(p_key) takes no chat: PostgREST matches functions by their argument names
  const base = await rpc(env, 'bot_faq', { p_key: env.BOT_KEY }, null, f).catch((e) => {
    console.warn('[telegram-bot] bot_faq failed', String(e?.message || e).slice(0, 100));
    return null;
  });
  // the base is not there (migration 032 not applied, database down): the old short answer
  if (!base) return say(linked ? t.linkedHelp : t.help);
  const items = base.items || [];
  if (pressed(text, 'btnWrite')) {
    if (!linked) return say(t.ticketNotLinked(base.support_url), menuKb(lang));
    await call('bot_ticket_wait', { p_on: true });
    return say(t.askTicket, kb([[t.btnCancel]]));
  }
  if (pressed(text, 'btnYes') || pressed(text, 'btnNo')) {
    const yes = pressed(text, 'btnYes');
    await call('bot_feedback', { p_helped: yes }).catch(() => {});
    return say(yes ? t.thanks : t.sorry, yes ? menuKb(lang) : kb([[t.btnWrite], [t.btnMenu]]));
  }
  const topic = topicOf(text);
  if (topic) {
    const list = items.filter((it) => it.topic === topic);
    if (!list.length) return say(t.menuIntro, menuKb(lang));
    return say(t.pickQuestion, kb([...list.map((it) => [q(it, lang)]), [t.btnBack]]));
  }
  if (!text || pressed(text, 'btnMenu') || pressed(text, 'btnBack') || /^\/(start|help|menu)(@\w+)?$/.test(text)) {
    return say(text.startsWith('/') ? `${linked ? t.linkedHelp : t.help}\n\n${t.menuIntro}` : t.menuIntro, menuKb(lang));
  }
  if (isGreeting(text)) return say(`${t.hi} ${linked ? '' : `${t.help}\n\n`}${t.menuIntro}`, menuKb(lang));
  if (isThanks(text)) return say(t.welcome, menuKb(lang));
  // a question from the menu (exact text in either language) or in the seller's own words
  const picked = items.find((it) => text === it.q_ru || text === it.q_kk);
  const hit = picked || matchFaq(text, items);
  await call('bot_ask', { p_lang: lang, p_text: text.slice(0, 500), p_faq: hit ? hit.id : null, p_source: picked ? 'menu' : 'text' })
    .catch((e) => console.warn('[telegram-bot] bot_ask failed', String(e?.message || e).slice(0, 100)));
  if (!hit) return say(t.noAnswer, menuKb(lang));
  return say(`${a(hit, lang)}\n\n${t.wasHelpful}`, answerKb(lang));
}

/** Telegram update → link / unlink / phone / support. */
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
    if (!r?.ok) return tg(env, 'sendMessage', { chat_id: chat, text: T(tgLang(msg)).linkExpired }, f);
    const shops = (r.shops || []).filter(Boolean);
    // linked now: the account's interface language
    const lang = (await langs(env, f, { chats: [chat] })).chats[String(chat)] || tgLang(msg);
    await tg(env, 'sendMessage', { chat_id: chat, text: T(lang).linked(shops), reply_markup: buttons(r, 'orders', lang) }, f);
    return tg(env, 'sendMessage', { chat_id: chat, text: T(lang).askPhone, reply_markup: phoneKeyboard(lang) }, f);
  }
  // still linked before /stop: the account's language; otherwise the Telegram app's
  const linkedLang = (await langs(env, f, { chats: [chat] })).chats[String(chat)];
  const lang = linkedLang || tgLang(msg);
  // «Поделиться номером»: only the sender's OWN contact counts (a forwarded or picked contact has another user_id)
  if (msg.contact) {
    if (!linkedLang) return tg(env, 'sendMessage', { chat_id: chat, text: T(lang).phoneNotLinked, reply_markup: { remove_keyboard: true } }, f);
    if (!msg.from?.id || msg.contact.user_id !== msg.from.id) return tg(env, 'sendMessage', { chat_id: chat, text: T(lang).phoneNotOwn, reply_markup: phoneKeyboard(lang) }, f);
    const v = await rpc(env, 'bot_verify_phone', { p_key: env.BOT_KEY, p_chat_id: chat, p_phone: String(msg.contact.phone_number || '').slice(0, 32) }, null, f);
    const out = v?.ok ? T(lang).phoneOk(fmtPhone(v.phone)) : v?.error === 'not_linked' ? T(lang).phoneNotLinked : T(lang).phoneBad;
    return tg(env, 'sendMessage', { chat_id: chat, text: out, reply_markup: { remove_keyboard: true } }, f);
  }
  if (/^\/phone/.test(text)) {
    if (!linkedLang) return tg(env, 'sendMessage', { chat_id: chat, text: T(lang).phoneNotLinked }, f);
    return tg(env, 'sendMessage', { chat_id: chat, text: T(lang).askPhone, reply_markup: phoneKeyboard(lang) }, f);
  }
  if (/^\/stop/.test(text)) {
    await rpc(env, 'bot_unlink', { p_key: env.BOT_KEY, p_chat_id: chat, p_blocked: false }, null, f);
    return tg(env, 'sendMessage', { chat_id: chat, text: T(lang).unlinked }, f);
  }
  // menu, answers from the base, «Написать в поддержку»
  return support(env, f, { chat, text, lang, linked: !!linkedLang });
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
    // queue retention nudges (tg_outbox, deduped in the database); a failure must never break the run
    await rpc(env, 'enqueue_retention_nudges', {}, null, f).catch((e) => console.warn('[telegram-bot] enqueue_retention_nudges failed', String(e?.message || e).slice(0, 100)));
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
    const L = await langs(env, f, { users: [...new Set(items.map((i) => i.user_id).filter(Boolean))] });
    let progressed = false;
    for (const item of items) {
      if (now() - t0 > budgetMs) {
        stats.more = true;
        break;
      }
      stats.due++;
      const lang = langOf(L.users[item.user_id]);
      // the Kazakh «what's new» when the admin wrote one, else the Russian text
      const it = lang === 'kk' && item.kind === 'winback30' && L.whats_new_kk ? { ...item, data: { ...item.data, whats_new: L.whats_new_kk } } : item;
      const text = format(it, lang);
      if (!text) {
        // unknown kind / empty text: acknowledge as skipped so bot_jobs never returns it again (no queue starvation)
        console.warn('[telegram-bot] skipped, no text for kind', String(item.kind).slice(0, 40));
        pending.push({ user_id: item.user_id, kind: item.kind, key: item.key, ok: false, error: 'skipped_no_text', blocked: false });
        progressed = true;
        if (pending.length >= chunk) await flush();
        continue;
      }
      const route = item.kind === 'morning' ? 'orders' : item.kind === 'care' ? 'home' : 'account';
      const r = await tg(env, 'sendMessage', { chat_id: item.chat_id, text, reply_markup: buttons(jobs, route, lang), disable_web_page_preview: true }, f);
      if (!r.ok) console.warn('[telegram-bot] not sent', item.kind, r.error); // the error is kept in tg_sent too
      pending.push({ user_id: item.user_id, kind: item.kind, key: item.key, ok: r.ok, error: r.error || null, blocked: !!r.blocked });
      progressed = true;
      stats[r.ok ? 'sent' : 'failed']++;
      if (r.blocked) stats.blocked++;
      if (pending.length >= chunk) await flush();
      if (pause) await new Promise((res) => setTimeout(res, pause)); // Telegram: ~30 messages per second
    }
    await flush();
    // stop when out of time, or when nothing could be sent (every item, even one without text, is acknowledged via bot_sent)
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
      // After the secret check always answer 200: Telegram would resend (and retry forever) the update otherwise.
      try {
        await webhook(await req.json(), env, f);
      } catch (e) {
        console.error('[telegram-bot] webhook update dropped:', String(e?.message || e).slice(0, 200));
      }
      return json({ ok: true });
    }
    if (path.endsWith('/alert')) {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!token || token === env.SUPABASE_ANON_KEY) return json({ error: 'auth' }, 401);
      const b = await req.json();
      const a = await rpc(env, 'alert_create', { p_code: String(b.code || ''), p_shop: String(b.shop || ''), p_minutes: Number(b.minutes) || 0, p_kind: b.kind === 'cancelled' ? 'cancelled' : 'deadline' }, token, f);
      if (!a) return json({ sent: false });
      const lang = langOf((await langs(env, f, { chats: [a.chat_id] })).chats[String(a.chat_id)]);
      const r = await tg(env, 'sendMessage', { chat_id: a.chat_id, text: format({ kind: 'alert', data: a }, lang), reply_markup: buttons(a, 'orders', lang) }, f);
      if (r.blocked) await rpc(env, 'bot_unlink', { p_key: env.BOT_KEY, p_chat_id: a.chat_id, p_blocked: true }, null, f).catch(() => {});
      return json({ sent: r.ok, error: r.ok ? undefined : r.error });
    }
    if (path.endsWith('/ticket-reply')) {
      // the admin page, right after the owner answered a ticket: the answer also goes to the client's Telegram
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!token || token === env.SUPABASE_ANON_KEY) return json({ error: 'auth' }, 401);
      const b = await req.json();
      const r = await rpc(env, 'admin_ticket_tg', { p_id: Number(b.id) || 0 }, token, f); // checks is_admin()
      if (!r?.chat_id) return json({ sent: false, reason: 'no_telegram' });
      const lang = langOf(r.lang);
      const s = await tg(env, 'sendMessage', { chat_id: r.chat_id, text: T(lang).ticketReply(r.id, String(r.reply).slice(0, 3500)), reply_markup: menuKb(lang) }, f);
      if (s.blocked) await rpc(env, 'bot_unlink', { p_key: env.BOT_KEY, p_chat_id: r.chat_id, p_blocked: true }, null, f).catch(() => {});
      return json({ sent: s.ok, error: s.ok ? undefined : s.error });
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
