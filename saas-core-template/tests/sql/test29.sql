\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- 032: support answers in the Telegram bot, tickets from Telegram, the owner's daily report and «digest is late»
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
create or replace function pg_temp.as_user(id text) returns boolean language sql as $$ select set_config('request.jwt.claim.sub', id, false) is not null $$;
insert into auth.users (id, email) values
  ('f2000000-0000-0000-0000-00000000000a', 'admin@example.kz'),
  ('f2000000-0000-0000-0000-00000000000b', 'seller@example.kz'),
  ('f2000000-0000-0000-0000-00000000000c', 'other@example.kz');
insert into public.admins values ('f2000000-0000-0000-0000-00000000000a');
update public.accounts set terms_version = (select terms_version from billing_config);
update public.ops_settings set bot_key_hash = encode(sha256(convert_to('bot-key-0123456789abcdef0123456789abcdef', 'utf8')), 'hex'),
                               key_hash = encode(sha256(convert_to('ops-key-0123456789abcdef0123456789abcdef', 'utf8')), 'hex');
insert into public.tg_links (user_id, chat_id, tg_name) values ('f2000000-0000-0000-0000-00000000000b', 2002, 'Seller');
\set K '''bot-key-0123456789abcdef0123456789abcdef'''

-- ===== the starting base =====
select pg_temp.ok('starting base: generic answers, every one in RU and KZ with keywords',
  (select count(*) >= 7 and bool_and(question_kk <> question_ru and answer_kk <> answer_ru and keywords <> '') from support_faq));
select pg_temp.ok('answers in several topics', (select count(distinct topic) >= 3 from support_faq));
-- re-running the seed keeps the owner's edits
update support_faq set answer_ru = 'Своя версия ответа' where slug = 'pay';
\ir ../../supabase/migrations/032_support_bot.sql
select pg_temp.ok('re-run keeps the edited answer and adds no duplicates', (select answer_ru = 'Своя версия ответа' from support_faq where slug = 'pay') and (select count(*) = count(distinct slug) from support_faq));

-- ===== who may call =====
select pg_temp.ok('bot functions: service_role only',
  has_function_privilege('service_role', 'public.bot_faq(text)', 'execute') and not has_function_privilege('authenticated', 'public.bot_faq(text)', 'execute')
  and not has_function_privilege('anon', 'public.bot_ask(text,bigint,text,text,int,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.bot_ticket(text,bigint,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.ops_daily_report()', 'execute'));
set role service_role;
do $$ begin perform bot_faq('wrong-key-0123456789abcdef0123456789'); raise notice 'FAIL wrong bot key'; exception when others then raise notice '% wrong bot key refused', case when sqlerrm = 'bad_key' then 'PASS' else 'FAIL' end; end $$;
select pg_temp.ok('bot_faq: enabled answers with keywords', (select jsonb_array_length(r->'items') >= 7 and r->'items'->0 ? 'kw' and r->'items'->0 ? 'a_kk' from (select bot_faq(:K) r) x));
reset role;
set role authenticated; select pg_temp.as_user('f2000000-0000-0000-0000-00000000000b');
do $$ begin perform admin_faq(); raise notice 'FAIL seller read the admin base'; exception when others then raise notice 'PASS seller cannot read the admin base (%)', sqlerrm; end $$;
do $$ begin perform admin_faq_save('{"topic":"bot","question_ru":"Взлом?","question_kk":"Взлом?","answer_ru":"да","answer_kk":"иә"}'); raise notice 'FAIL seller edited the base'; exception when others then raise notice 'PASS seller cannot edit the base (%)', sqlerrm; end $$;
do $$ begin perform admin_bot_questions(); raise notice 'FAIL seller read bot questions'; exception when others then raise notice 'PASS seller cannot read bot questions (%)', sqlerrm; end $$;
reset role;

-- ===== questions, answers, feedback =====
select id tok from support_faq where slug = 'pay' \gset
set role service_role;
select (bot_ask(:K, 2002, 'ru', 'Где взять токен? мой номер +7 701 555 44 33', :tok, 'text')->>'id')::bigint q1 \gset
reset role;
select pg_temp.ok('question stored, phone masked, linked to the account', (select text = 'Где взять токен? мой номер [номер]' and user_id = 'f2000000-0000-0000-0000-00000000000b' from bot_questions where id = :q1));
select pg_temp.ok('the answer counted as shown', (select shown = 1 from support_faq where slug = 'pay'));
set role service_role;
select pg_temp.ok('«Помогло» counted once', (bot_feedback(:K, 2002, true)->>'ok')::boolean and not (bot_feedback(:K, 2002, false)->>'ok')::boolean);
select pg_temp.ok('a question from an unknown chat is still stored (no account)', (bot_ask(:K, 7777, 'kk', 'сәлем, қанша тұрады?', null, 'text')->>'id') is not null);
reset role;
select pg_temp.ok('helped = 1, not_helped = 0', (select helped = 1 and not_helped = 0 from support_faq where slug = 'pay'));
select pg_temp.ok('unknown chat: no user, Kazakh', (select user_id is null and lang = 'kk' from bot_questions where chat_id = 7777));
-- flood: 60 per chat per hour
insert into bot_questions (chat_id, source, text) select 3003, 'text', 'x' from generate_series(1, 60);
set role service_role;
select pg_temp.ok('61st question in an hour is not stored', (bot_ask(:K, 3003, 'ru', 'ещё', null, 'text')->>'limited')::boolean);
reset role;
delete from bot_questions where chat_id = 3003;

-- ===== «Написать в поддержку» =====
set role service_role;
select pg_temp.ok('not waiting: a message is not a ticket', (bot_ticket(:K, 2002, 'просто текст')->>'error') = 'not_waiting');
select pg_temp.ok('unlinked chat cannot write to support', (bot_ticket_wait(:K, 7777, true)->>'error') = 'not_linked');
select pg_temp.ok('linked chat: waiting for the question', (bot_ticket_wait(:K, 2002, true)->>'ok')::boolean);
select (bot_ticket(:K, 2002, 'Не могу найти, где менять токен')->>'id')::bigint t1 \gset
select pg_temp.ok('the next message is not a ticket again', (bot_ticket(:K, 2002, 'спасибо')->>'error') = 'not_waiting');
reset role;
select pg_temp.ok('ticket from Telegram: topic of the last answer, source, context', (select topic = 'payment' and source = 'telegram' and email = 'seller@example.kz'
  and report like 'Из Telegram. Перед этим спрашивал:%' from support_tickets where id = :t1));
select pg_temp.ok('the question is linked to the ticket', (select ticket_id = :t1 from bot_questions where id = :q1));
set role service_role;
select pg_temp.ok('«Отмена» stops waiting', (bot_ticket_wait(:K, 2002, true)->>'ok')::boolean and (bot_ticket_wait(:K, 2002, false)->>'ok')::boolean and (bot_ticket(:K, 2002, 'x')->>'error') = 'not_waiting');
reset role;
update tg_links set ticket_wait_until = now() - interval '1 minute' where chat_id = 2002;
set role service_role;
select pg_temp.ok('waiting expires after 15 minutes', (bot_ticket(:K, 2002, 'x')->>'error') = 'not_waiting');
reset role;
insert into support_tickets (user_id, topic, message) select 'f2000000-0000-0000-0000-00000000000b', 'other', 'm' from generate_series(1, 5);
set role service_role;
select pg_temp.ok('ticket limit as in the extension', (bot_ticket_wait(:K, 2002, true)->>'ok')::boolean and (bot_ticket(:K, 2002, 'ещё вопрос')->>'error') = 'ticket_limit');
reset role;

-- ===== the admin page =====
set role authenticated; select pg_temp.as_user('f2000000-0000-0000-0000-00000000000a');
select pg_temp.ok('admin sees the base with counters', (select jsonb_array_length(admin_faq()) >= 7));
select (admin_faq_save('{"topic":"orders","question_ru":"Как вернуть товар?","question_kk":"Тауарды қалай қайтарамын?","answer_ru":"Раздел «Возвраты».","answer_kk":"«Қайтарулар» бөлімі.","keywords":"Возврат, вернуть , возврат,қайтар"}')->>'id')::int f1 \gset
reset role;
select pg_temp.ok('new answer: keywords cleaned and deduplicated', (select keywords = 'вернуть, возврат, қайтар' from support_faq where id = :f1));
set role authenticated; select pg_temp.as_user('f2000000-0000-0000-0000-00000000000a');
select pg_temp.ok('edit: switch off', (select (admin_faq_save(jsonb_build_object('id', :f1, 'enabled', false))->>'enabled')::boolean = false));
do $$ begin perform admin_faq_save('{"topic":"nope","question_ru":"Вопрос?","question_kk":"Сұрақ?","answer_ru":"ответ","answer_kk":"жауап"}'); raise notice 'FAIL unknown topic accepted'; exception when others then raise notice 'PASS unknown topic refused (%)', sqlerrm; end $$;
select pg_temp.ok('unanswered list: the Kazakh question without an answer', (select r->'items' @> '[{"text":"сәлем, қанша тұрады?"}]' and (r->'stats'->>'unanswered')::int >= 1 from (select admin_bot_questions('unanswered') r) x));
select pg_temp.ok('admin deletes an answer', admin_faq_delete(:f1));
-- the owner answers the Telegram ticket → where to send it
select pg_temp.ok('no reply yet → nothing to send', admin_ticket_tg(:t1) is null);
select admin_ticket_reply(:t1, 'Настройки → ваш магазин → «Переподключить токен»') is not null;
select pg_temp.ok('reply goes to the seller''s chat', (select r->>'chat_id' = '2002' and r->>'reply' like 'Настройки%' and r->>'lang' = 'ru' from (select admin_ticket_tg(:t1) r) x));
reset role;
set role authenticated; select pg_temp.as_user('f2000000-0000-0000-0000-00000000000b');
do $$ begin perform admin_ticket_tg(1); raise notice 'FAIL seller looked up a chat'; exception when others then raise notice 'PASS seller cannot look up chats (%)', sqlerrm; end $$;
reset role;

-- ===== monitoring =====
-- yesterday's numbers for both sellers; only one got the digest
insert into digest_stats (user_id, day, stats) values ('f2000000-0000-0000-0000-00000000000b', (now() at time zone 'Asia/Almaty')::date - 1, '{"orders":3}');
select pg_temp.ok('digest pending for the linked seller', digest_pending((now() at time zone 'Asia/Almaty')::date - 1) = 1);
insert into tg_sent (user_id, kind, key, sent_at) values ('f2000000-0000-0000-0000-00000000000b', 'morning', ((now() at time zone 'Asia/Almaty')::date - 1)::text, now() - interval '1 hour');
select pg_temp.ok('sent → nothing pending', digest_pending((now() at time zone 'Asia/Almaty')::date - 1) = 0);
select pg_temp.ok('daily report: digest, bot, tickets, clients', (select (r->'digest'->>'sent')::int = 1 and r->'digest'->>'first_at' ~ '^\d\d:\d\d$'
  and (r->'bot'->>'asked')::int >= 2 and (r->'bot'->>'unanswered')::int >= 1 and (r->'bot'->>'helped')::int = 1
  and r->'bot'->'top_unanswered' ? 'сәлем, қанша тұрады?' and r->'bot'->'top_faq'->0->>'q' = 'Как оплатить подписку?'
  and (r->'tickets'->>'new_telegram')::int = 1 and (r->'clients'->>'tg_linked')::int = 1 from (select ops_daily_report() r) x));
delete from tg_sent where kind = 'morning';
update ops_settings set digest_alert_day = null, report_day = null;
set role service_role;
select ops_digest('ops-key-0123456789abcdef0123456789abcdef') d1 \gset
select ops_digest('ops-key-0123456789abcdef0123456789abcdef') d2 \gset
reset role;
select pg_temp.ok('«digest late» after 09:30 only, once a day', case when (now() at time zone 'Asia/Almaty')::time >= '09:30'
  then (:'d1'::jsonb->'digest_late'->>'pending')::int = 1 and :'d2'::jsonb->'digest_late' = 'null'
  else :'d1'::jsonb->'digest_late' = 'null' end);
select pg_temp.ok('daily report after 10:00 only, once a day', case when (now() at time zone 'Asia/Almaty')::time >= '10:00'
  then :'d1'::jsonb->'daily' ? 'bot' and :'d2'::jsonb->'daily' = 'null'
  else :'d1'::jsonb->'daily' = 'null' end);
select pg_temp.ok('ops_digest still has the old fields', :'d1'::jsonb ?& array['alerts', 'recovered', 'new_tickets', 'open_tickets', 'new_invoices']);
