-- SaaS core: support answers in the Telegram bot, and daily monitoring for the owner. Safe to run again.
-- Apply AFTER 031_phone_verified.sql, then grants.sql.
-- The starting base below is generic (subscription, payment, the bot): add your product's own answers in the admin page.
--
-- 1. support_faq: the answer base (RU + KZ). The bot matches a seller's message against the keywords (bot.js
--    matchFaq), or the seller picks a topic and a question from the menu. The owner edits the base in the admin
--    page («База ответов»); the bot reads it on every question, so no redeploy is needed.
-- 2. bot_questions: every question asked in the bot, which answer it got (or none), and whether it helped.
--    Unanswered questions show the owner what to add. Long digit runs (phones, IIN) are masked; kept 180 days.
-- 3. «Написать в поддержку» in the bot: the next message of a linked chat becomes a support ticket
--    (source 'telegram'); the owner's reply is sent back to that chat (admin_ticket_tg → bot route /ticket-reply).
-- 4. ops_digest (every 10 minutes) also returns:
--    digest_late — the morning digest has still not gone out by 09:30 (once a day);
--    daily       — once a day after 10:00: digest delivery, bot questions, tickets, clients, top errors.
-- All times are Kazakhstan time (Asia/Almaty, UTC+5).
begin;

-- ---------- 1. the answer base ----------
create table if not exists public.support_faq (
  id          serial primary key,
  slug        text unique check (slug ~ '^[a-z0-9_]{2,40}$'),
  topic       text not null check (topic in ('connect', 'orders', 'print', 'payment', 'goods', 'bot')),
  question_ru text not null check (length(btrim(question_ru)) between 3 and 100),
  question_kk text not null check (length(btrim(question_kk)) between 3 and 100),
  answer_ru   text not null check (length(btrim(answer_ru)) between 3 and 1500),
  answer_kk   text not null check (length(btrim(answer_kk)) between 3 and 1500),
  keywords    text not null default '' check (length(keywords) <= 1000),   -- comma-separated word starts, RU and KZ
  sort        int not null default 100,
  enabled     boolean not null default true,
  shown       int not null default 0,
  helped      int not null default 0,
  not_helped  int not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.support_faq enable row level security;
revoke all on public.support_faq from public, anon, authenticated;
revoke all on sequence public.support_faq_id_seq from public, anon, authenticated;

-- ---------- 2. questions asked in the bot ----------
create table if not exists public.bot_questions (
  id         bigserial primary key,
  chat_id    bigint not null,
  user_id    uuid references auth.users (id) on delete cascade,
  lang       text not null default 'ru' check (lang in ('ru', 'kk')),
  source     text not null check (source in ('text', 'menu')),
  text       text not null check (length(text) <= 500),
  faq_id     int references public.support_faq (id) on delete set null,
  helped     boolean,
  ticket_id  bigint references public.support_tickets (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists bot_questions_created on public.bot_questions (created_at desc);
create index if not exists bot_questions_chat on public.bot_questions (chat_id, created_at desc);
alter table public.bot_questions enable row level security;
revoke all on public.bot_questions from public, anon, authenticated;
revoke all on sequence public.bot_questions_id_seq from public, anon, authenticated;

-- ---------- 3. tickets from Telegram ----------
alter table public.support_tickets add column if not exists source text not null default 'app';
alter table public.support_tickets drop constraint if exists support_tickets_source_check;
alter table public.support_tickets add constraint support_tickets_source_check check (source in ('app', 'telegram'));
alter table public.tg_links add column if not exists ticket_wait_until timestamptz;

-- ---------- 4. monitoring state ----------
alter table public.ops_settings add column if not exists digest_alert_day date;
alter table public.ops_settings add column if not exists report_day date;

-- ---------- the bot (service_role, BOT_KEY) ----------
-- The base for matching and the menu, plus the support link for chats that are not linked.
create or replace function public.bot_faq(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'topic', topic, 'q_ru', question_ru, 'q_kk', question_kk,
                                                           'a_ru', answer_ru, 'a_kk', answer_kk, 'kw', keywords) order by sort, id)
                       from public.support_faq where enabled), '[]'),
    'support_url', (select support_url from public.billing_config where id = 1),
    'app_url', (select app_url from public.billing_config where id = 1));
end $$;

-- A question asked (p_faq = the answer given, null = none found). Returns the question id.
create or replace function public.bot_ask(p_key text, p_chat_id bigint, p_lang text, p_text text, p_faq int default null, p_source text default 'text')
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; q public.bot_questions; clean text;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  if p_chat_id is null then raise exception 'invalid_chat' using errcode = '22023'; end if;
  -- a script or a stuck client must not fill the table
  if (select count(*) from public.bot_questions where chat_id = p_chat_id and created_at > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('id', null, 'limited', true);
  end if;
  select user_id into uid from public.tg_links where chat_id = p_chat_id and blocked_at is null;
  clean := left(btrim(regexp_replace(coalesce(p_text, ''), '\+?\d(?:[\s()-]*\d){9,}', '[номер]', 'g')), 500);
  if clean = '' then clean := '—'; end if;
  insert into public.bot_questions (chat_id, user_id, lang, source, text, faq_id)
  values (p_chat_id, uid, case when p_lang = 'kk' then 'kk' else 'ru' end, case when p_source = 'menu' then 'menu' else 'text' end,
          clean, (select id from public.support_faq where id = p_faq))
  returning * into q;
  if q.faq_id is not null then update public.support_faq set shown = shown + 1 where id = q.faq_id; end if;
  delete from public.bot_questions where created_at < now() - interval '180 days';
  return jsonb_build_object('id', q.id, 'limited', false);
end $$;

-- «👍 Помогло» / «👎 Не помогло»: about the last answer this chat got (within a day), once.
create or replace function public.bot_feedback(p_key text, p_chat_id bigint, p_helped boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.bot_questions;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  select * into q from public.bot_questions
   where chat_id = p_chat_id and faq_id is not null and created_at > now() - interval '1 day'
   order by created_at desc limit 1;
  if q.id is null or q.helped is not null then return jsonb_build_object('ok', false); end if;
  update public.bot_questions set helped = coalesce(p_helped, false) where id = q.id;
  update public.support_faq set helped = helped + case when p_helped then 1 else 0 end,
                                not_helped = not_helped + case when p_helped then 0 else 1 end
   where id = q.faq_id;
  return jsonb_build_object('ok', true, 'faq_id', q.faq_id);
end $$;

-- «Написать в поддержку» (p_on = true): the next message of this chat (within 15 minutes) becomes a ticket.
-- «Отмена» (p_on = false). Only a linked chat: a ticket belongs to an account.
create or replace function public.bot_ticket_wait(p_key text, p_chat_id bigint, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  update public.tg_links set ticket_wait_until = case when p_on then now() + interval '15 minutes' end
   where chat_id = p_chat_id and blocked_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0, 'error', case when n = 0 then 'not_linked' end);
end $$;

-- A message from a chat waiting for «Написать в поддержку» → a ticket. {ok:false, error:'not_waiting'} otherwise.
create or replace function public.bot_ticket(p_key text, p_chat_id bigint, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.tg_links; t public.support_tickets; last_q public.bot_questions; topic text; msg text;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  select * into l from public.tg_links where chat_id = p_chat_id and blocked_at is null;
  if l.user_id is null or l.ticket_wait_until is null or l.ticket_wait_until < now() then
    return jsonb_build_object('ok', false, 'error', 'not_waiting');
  end if;
  update public.tg_links set ticket_wait_until = null where user_id = l.user_id;
  msg := left(btrim(coalesce(p_text, '')), 2000);
  if msg = '' then return jsonb_build_object('ok', false, 'error', 'empty'); end if;
  -- the same limits as ticket_create in the extension
  if (select count(*) from public.support_tickets where user_id = l.user_id and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.support_tickets where user_id = l.user_id and created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'error', 'ticket_limit');
  end if;
  -- the topic of the last answer the seller saw, if any
  select * into last_q from public.bot_questions where chat_id = p_chat_id and created_at > now() - interval '1 day' order by created_at desc limit 1;
  select case f.topic when 'connect' then 'connect' when 'orders' then 'orders' when 'print' then 'print'
                      when 'payment' then 'payment' when 'goods' then 'warehouse' else 'other' end
    into topic from public.support_faq f where f.id = last_q.faq_id;
  insert into public.support_tickets (user_id, email, topic, message, report, source)
  values (l.user_id, (select email from auth.users where id = l.user_id), coalesce(topic, 'other'), msg,
          case when last_q.id is not null then left('Из Telegram. Перед этим спрашивал: ' || last_q.text, 8000) else 'Из Telegram.' end,
          'telegram')
  returning * into t;
  if last_q.id is not null then update public.bot_questions set ticket_id = t.id where id = last_q.id; end if;
  return jsonb_build_object('ok', true, 'id', t.id);
end $$;

-- ---------- the admin page ----------
create or replace function public.admin_faq()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(to_jsonb(f) order by f.topic, f.sort, f.id) from public.support_faq f), '[]');
end $$;

-- Insert (no id) or update one answer. Keywords: lower case, comma-separated, duplicates dropped.
create or replace function public.admin_faq_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare f public.support_faq; kw text;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select string_agg(distinct k, ', ') into kw
    from (select btrim(lower(x)) k from unnest(string_to_array(coalesce(p->>'keywords', ''), ',')) x) y where k <> '';
  if nullif(p->>'id', '') is null then
    insert into public.support_faq (topic, question_ru, question_kk, answer_ru, answer_kk, keywords, sort, enabled)
    values (p->>'topic', btrim(p->>'question_ru'), btrim(p->>'question_kk'), btrim(p->>'answer_ru'), btrim(p->>'answer_kk'),
            left(coalesce(kw, ''), 1000), coalesce((p->>'sort')::int, 100), coalesce((p->>'enabled')::boolean, true))
    returning * into f;
  else
    update public.support_faq set
      topic = coalesce(p->>'topic', topic),
      question_ru = coalesce(btrim(p->>'question_ru'), question_ru), question_kk = coalesce(btrim(p->>'question_kk'), question_kk),
      answer_ru = coalesce(btrim(p->>'answer_ru'), answer_ru), answer_kk = coalesce(btrim(p->>'answer_kk'), answer_kk),
      keywords = case when p ? 'keywords' then left(coalesce(kw, ''), 1000) else keywords end,
      sort = coalesce((p->>'sort')::int, sort), enabled = coalesce((p->>'enabled')::boolean, enabled), updated_at = now()
    where id = (p->>'id')::int returning * into f;
    if f.id is null then raise exception 'not_found'; end if;
  end if;
  return to_jsonb(f);
end $$;

create or replace function public.admin_faq_delete(p_id int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  delete from public.support_faq where id = p_id;
  return found;
end $$;

-- Questions asked in the bot. p_filter: 'unanswered' (no answer found), 'not_helped', anything else = all.
create or replace function public.admin_bot_questions(p_filter text default 'unanswered', p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select q.id, q.created_at, q.lang, q.source, q.text, q.helped, q.ticket_id, q.faq_id, f.question_ru faq, l.tg_name name
          from public.bot_questions q left join public.support_faq f on f.id = q.faq_id left join public.tg_links l on l.chat_id = q.chat_id
         where case p_filter when 'unanswered' then q.faq_id is null and q.source = 'text' when 'not_helped' then q.helped = false else true end
         order by q.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'),
    'stats', (select jsonb_build_object(
        'days', 7,
        'asked', count(*),
        'answered', count(*) filter (where faq_id is not null),
        'unanswered', count(*) filter (where faq_id is null and source = 'text'),
        'helped', count(*) filter (where helped),
        'not_helped', count(*) filter (where helped = false),
        'tickets', count(*) filter (where ticket_id is not null))
      from public.bot_questions where created_at > now() - interval '7 days'));
end $$;

-- After the owner answered a ticket: where to send the answer in Telegram (null = the client has no linked bot).
create or replace function public.admin_ticket_tg(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t public.support_tickets; chat bigint; lng text;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select * into t from public.support_tickets where id = p_id;
  if t.id is null or coalesce(btrim(t.reply), '') = '' then return null; end if;
  select l.chat_id into chat from public.tg_links l where l.user_id = t.user_id and l.blocked_at is null;
  if chat is null then return null; end if;
  select lang into lng from public.accounts where user_id = t.user_id;
  return jsonb_build_object('id', t.id, 'chat_id', chat, 'lang', coalesce(lng, 'ru'), 'question', left(t.message, 300), 'reply', t.reply);
end $$;

-- ---------- monitoring ----------
-- Chats whose digest for p_day is due but not sent yet (the same rule as bot_jobs → 'morning').
create or replace function public.digest_pending(p_day date)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.tg_links l join public.digest_stats ds on ds.user_id = l.user_id and ds.day = p_day
   where l.blocked_at is null and l.digest and public.has_access_of(l.user_id)
     and not exists (select 1 from public.tg_sent s where s.user_id = l.user_id and s.kind = 'morning' and s.key = p_day::text);
$$;

-- The owner's daily report: the last 24 hours, Kazakhstan time.
create or replace function public.ops_daily_report()
returns jsonb language sql stable security definer set search_path = public as $$
  with local as (select (now() at time zone 'Asia/Almaty')::date today),
  d as (select today - 1 yday from local),
  sent as (select s.* from public.tg_sent s, d where s.kind = 'morning' and s.key = d.yday::text)
  select jsonb_build_object(
    'day', (select today from local),
    'digest', jsonb_build_object(
      'for_day', (select yday from d),
      'sent', (select count(*) from sent where error is null),
      'failed', (select count(*) from sent where error is not null),
      'first_at', (select to_char(min(sent_at) at time zone 'Asia/Almaty', 'HH24:MI') from sent where error is null),
      'last_at', (select to_char(max(sent_at) at time zone 'Asia/Almaty', 'HH24:MI') from sent where error is null),
      'pending', (select public.digest_pending(yday) from d)),
    'bot', (select jsonb_build_object(
        'asked', count(*),
        'answered', count(*) filter (where faq_id is not null),
        'unanswered', count(*) filter (where faq_id is null and source = 'text'),
        'helped', count(*) filter (where helped),
        'not_helped', count(*) filter (where helped = false),
        'top_unanswered', coalesce((select jsonb_agg(left(x.text, 80)) from (
            select text from public.bot_questions where faq_id is null and source = 'text' and created_at > now() - interval '1 day'
             order by created_at desc limit 5) x), '[]'),
        'top_faq', coalesce((select jsonb_agg(jsonb_build_object('q', x.q, 'n', x.n)) from (
            select f.question_ru q, count(*) n from public.bot_questions b join public.support_faq f on f.id = b.faq_id
             where b.created_at > now() - interval '1 day' group by f.question_ru order by count(*) desc limit 3) x), '[]'))
      from public.bot_questions where created_at > now() - interval '1 day'),
    'tickets', jsonb_build_object(
      'new', (select count(*) from public.support_tickets where created_at > now() - interval '1 day'),
      'new_telegram', (select count(*) from public.support_tickets where created_at > now() - interval '1 day' and source = 'telegram'),
      'open', (select count(*) from public.support_tickets where status = 'open'),
      'oldest_open_hours', (select floor(extract(epoch from now() - min(created_at)) / 3600)::int from public.support_tickets where status = 'open')),
    'clients', jsonb_build_object(
      'accounts', (select count(*) from public.accounts),
      'active_24h', (select count(*) from public.accounts where last_seen_at > now() - interval '1 day'),
      'tg_linked', (select count(*) from public.tg_links where blocked_at is null),
      'tg_blocked_24h', (select count(*) from public.tg_links where blocked_at > now() - interval '1 day')),
    'errors', coalesce((select jsonb_agg(jsonb_build_object('code', x.error_code, 'users', x.users, 'n', x.n)) from (
        select error_code, count(distinct user_id) users, sum(occurrences) n from public.client_errors
         where last_seen_at > now() - interval '1 day' group by error_code order by count(distinct user_id) desc, sum(occurrences) desc limit 3) x), '[]'));
$$;

-- ops_digest as in 014, plus digest_late and the daily report.
create or replace function public.ops_digest(p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.ops_settings; kh text; w jsonb; e jsonb; alerts jsonb := '[]'; recovered jsonb := '[]'; down jsonb; since timestamptz;
        purged jsonb; loc timestamp := now() at time zone 'Asia/Almaty'; late jsonb; daily jsonb; n int;
begin
  -- verify the key without a lock
  select key_hash into kh from public.ops_settings where id = 1;
  if kh is null or p_key is null or length(p_key) < 32
     or encode(sha256(convert_to(p_key, 'utf8')), 'hex') <> kh then
    perform pg_sleep(0.5);
    raise exception 'bad_key';
  end if;
  select * into o from public.ops_settings where id = 1 for update;
  since := coalesce(o.last_digest_at, now() - interval '1 hour');
  down := o.alerted;
  w := public.health_window(60);
  for e in select * from jsonb_array_elements(w) loop
    if (e->>'failing')::int >= o.min_users and (e->>'share')::numeric >= o.min_share then
      -- new outage, or a reminder every 2 hours while it lasts
      if not (down ? (e->>'market')) or (down->>(e->>'market'))::timestamptz < now() - interval '2 hours' then
        alerts := alerts || jsonb_build_array(e);
        down := down || jsonb_build_object(e->>'market', now());
      end if;
    elsif down ? (e->>'market') and (e->>'share')::numeric < o.min_share / 2 then
      recovered := recovered || to_jsonb(e->>'market');
      down := down - (e->>'market');
    end if;
  end loop;
  -- the morning digest should be out by 09:30: say so once a day if it is not
  if loc::time >= time '09:30' and o.digest_alert_day is distinct from loc::date then
    n := public.digest_pending(loc::date - 1);
    if n > 0 then
      late := jsonb_build_object('pending', n, 'sent', (select count(*) from public.tg_sent where kind = 'morning' and key = (loc::date - 1)::text and error is null));
      o.digest_alert_day := loc::date;
    end if;
  end if;
  -- the daily report, once a day after 10:00
  if loc::time >= time '10:00' and o.report_day is distinct from loc::date then
    daily := public.ops_daily_report();
    o.report_day := loc::date;
  end if;
  update public.ops_settings set last_digest_at = now(), alerted = down, digest_alert_day = o.digest_alert_day, report_day = o.report_day where id = 1;
  if o.last_purge_at is null or o.last_purge_at < now() - interval '1 day' then
    purged := public.purge_expired();
  end if;
  return jsonb_build_object(
    'alerts', alerts,
    'recovered', recovered,
    'new_tickets', (select count(*) from public.support_tickets where created_at > since),
    'open_tickets', (select count(*) from public.support_tickets where status = 'open'),
    'new_invoices', (select count(*) from public.invoices where created_at > since and status = 'pending'),
    'pending_invoices', (select count(*) from public.invoices where status = 'pending'),
    'pending_sum', (select coalesce(sum(amount), 0) from public.invoices where status = 'pending'),
    'purged', purged,
    'digest_late', late,
    'daily', daily);
end
$$;

-- ---------- privileges ----------
revoke execute on function public.bot_faq(text), public.bot_ask(text, bigint, text, text, int, text), public.bot_feedback(text, bigint, boolean),
  public.bot_ticket_wait(text, bigint, boolean), public.bot_ticket(text, bigint, text), public.digest_pending(date), public.ops_daily_report(),
  public.ops_digest(text) from public, anon, authenticated;
grant execute on function public.bot_faq(text), public.bot_ask(text, bigint, text, text, int, text), public.bot_feedback(text, bigint, boolean),
  public.bot_ticket_wait(text, bigint, boolean), public.bot_ticket(text, bigint, text), public.ops_digest(text) to service_role;
revoke execute on function public.admin_faq(), public.admin_faq_save(jsonb), public.admin_faq_delete(int),
  public.admin_bot_questions(text, int), public.admin_ticket_tg(bigint) from public, anon;
grant execute on function public.admin_faq(), public.admin_faq_save(jsonb), public.admin_faq_delete(int),
  public.admin_bot_questions(text, int), public.admin_ticket_tg(bigint) to authenticated;

-- ---------- the starting base: generic answers (subscription, payment, the bot) ----------
-- Inserted once by slug: the owner's later edits are never overwritten when this file runs again.
insert into public.support_faq (slug, topic, sort, question_ru, question_kk, answer_ru, answer_kk, keywords) values
('digest_time', 'orders', 20,
 'Когда приходит сводка?', 'Қорытынды қашан келеді?',
 'Каждый день в 09:00 по времени Казахстана — итоги за вчера. Отключить сводку: «Настройки» → «Telegram-уведомления».',
 'Күн сайын Қазақстан уақытымен 09:00-де — кешегі қорытынды. Қорытындыны өшіру: «Баптаулар» → «Telegram хабарламалары».',
 'сводк, когда приход, во сколько, время сводк, утром, вечером, отчет, отчёт, қорытынды, қашан, нешеде'),
('pay', 'payment', 10,
 'Как оплатить подписку?', 'Жазылымды қалай төлеуге болады?',
 'Раздел «Подписка»: выберите тариф, нажмите «Оплатить по QR» и оплатите в приложении банка. Подписка включится после подтверждения оплаты.',
 '«Жазылым» бөлімі: тарифті таңдап, «QR арқылы төлеу» батырмасын басыңыз да, банк қолданбасында төлеңіз. Жазылым төлем расталғаннан кейін қосылады.',
 'оплат, заплат, qr, кьюар, подписк, продлить, продлен, счет, счёт, төле, жазылым, ұзарт'),
('pay_wait', 'payment', 20,
 'Оплатил, а подписка не включилась', 'Төледім, бірақ жазылым қосылмады',
 'Оплату подтверждаем вручную, обычно в течение пары часов в рабочее время. Чтобы оплата засчитывалась сразу, подтвердите номер, с которого платите: команда /phone в этом боте. Если прошло больше 3 часов — нажмите «Написать в поддержку» и пришлите чек.',
 'Төлемді қолмен растаймыз, әдетте жұмыс уақытында бірнеше сағат ішінде. Төлем бірден есептелуі үшін төлейтін нөміріңізді растаңыз: осы боттағы /phone командасы. 3 сағаттан көп өтсе — «Қолдауға жазу» батырмасын басып, түбіртекті жіберіңіз.',
 'оплатил, оплатила, заплатил, не включ, не активир, не подтверд, деньги ушли, списал, чек, төледім, қосылмады, расталмады, түбіртек'),
('phone', 'payment', 30,
 'Как подтвердить номер для оплаты?', 'Төлем нөмірін қалай растаймын?',
 'Отправьте в этот бот команду /phone и нажмите кнопку «📱 Поделиться номером». Номер подтверждает сам Telegram, и оплата с него будет засчитываться автоматически.',
 'Осы ботқа /phone командасын жіберіп, «📱 Нөмірмен бөлісу» батырмасын басыңыз. Нөмірді Telegram өзі растайды, сонда осы нөмірден төлем автоматты түрде есептеледі.',
 'подтверд номер, номер для оплат, номер телефон, телефон для оплат, phone, нөмірді раста, төлем нөмір, нөмірмен бөлі'),
('cancel', 'payment', 50,
 'Как отменить подписку?', 'Жазылымды қалай тоқтатамын?',
 'Раздел «Подписка» → «Отменить подписку». Доступ сохранится до конца оплаченного периода, ваши данные останутся — вернуться можно в любой момент. Там же можно вместо отмены заморозить аккаунт: оплаченные дни сохранятся.',
 '«Жазылым» бөлімі → «Жазылымнан бас тарту». Қолжетімділік төленген мерзім соңына дейін сақталады, деректеріңіз қалады — кез келген уақытта қайта оралуға болады. Сол жерде бас тартудың орнына аккаунтты тоқтатып қоюға болады: төленген күндер сақталады.',
 'отмен подписк, отключ подписк, отказ, заморо, вернуть деньг, возврат денег, тоқтат, бас тарт, қайтар'),
('telegram', 'bot', 10,
 'Как подключить Telegram-бота?', 'Telegram-ботты қалай қосамын?',
 'Откройте «Настройки» → карточка «Telegram-уведомления» → «Подключить Telegram» и нажмите «Start» в боте. Если на компьютере нет Telegram — нажмите «OPEN IN WEB» или откройте ссылку на телефоне. Ссылка действует 15 минут: если не успели, нажмите кнопку ещё раз.',
 '«Баптаулар» → «Telegram хабарламалары» картасы → «Telegram қосу» батырмасын басып, боттағы «Start» басыңыз. Компьютерде Telegram болмаса — «OPEN IN WEB» басыңыз немесе сілтемені телефоннан ашыңыз. Сілтеме 15 минут жарамды: үлгермесеңіз, батырманы қайта басыңыз.',
 'подключ бот, подключ телеграм, telegram, телеграм, ссылка устар, бот не, ботты қос, сілтеме'),
('stop', 'bot', 20,
 'Как отключить уведомления?', 'Хабарламаларды қалай өшіремін?',
 'Отправьте /stop — бот перестанет писать. Чтобы выключить только сводку или только срочные сообщения: «Настройки» → «Telegram-уведомления».',
 '/stop жіберіңіз — бот жазуды тоқтатады. Тек қорытындыны немесе тек шұғыл хабарларды өшіру үшін: «Баптаулар» → «Telegram хабарламалары».',
 'отключ уведом, выключ уведом, не присылай, не пиши, отписат, stop, стоп, өшір, тоқтат хабар')
on conflict (slug) do nothing;

commit;
