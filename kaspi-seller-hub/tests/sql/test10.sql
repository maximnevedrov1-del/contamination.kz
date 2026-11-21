\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- Growth: «Старт»/«Мульти», trial boost, upgrade proration, grace, cancellation flow, freeze,
-- the seller's Telegram bot (link, digest, alerts, care, win-back) and attempts to get around it.
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
create or replace function pg_temp.as_user(id text) returns boolean language sql as $$ select set_config('request.jwt.claim.sub', id, false) is not null $$;
insert into auth.users (id, email) values
  ('c1000000-0000-0000-0000-00000000000a', 'admin@example.kz'),
  ('c1000000-0000-0000-0000-00000000000b', 'start@example.kz'),
  ('c1000000-0000-0000-0000-00000000000c', 'other@example.kz');
insert into public.admins values ('c1000000-0000-0000-0000-00000000000a');
-- «start@» paid «Старт» (1 store), 15 of 30 days left
update public.accounts set paid_until = now() + interval '15 days', trial_ends_at = now() - interval '15 days', store_limit = 1,
       terms_version = (select terms_version from billing_config) where email = 'start@example.kz';
update public.accounts set terms_version = (select terms_version from billing_config) where email = 'other@example.kz';
update public.ops_settings set bot_key_hash = encode(sha256(convert_to('bot-key-0123456789abcdef0123456789abcdef', 'utf8')), 'hex');
update public.billing_config set bot_username = 'SellerHubBot', app_url = 'https://app.example.kz', support_url = 'https://t.me/support', whats_new = 'Новое: печать пачкой быстрее';

-- 1. prices
select pg_temp.ok('«Старт» 1 store = 12 000', billing_price(1, 1) = 12000);
select pg_temp.ok('«Мульти» 2–3 stores = 20 000', billing_price(2, 1) = 20000 and billing_price(3, 1) = 20000);
select pg_temp.ok('4 stores = 25 000, 5 = 30 000', billing_price(4, 1) = 25000 and billing_price(5, 1) = 30000);

set role authenticated;
select pg_temp.as_user('c1000000-0000-0000-0000-00000000000b');
select pg_temp.ok('licence: plan «start», 1 store, boost available', (select l->>'plan' = 'start' and (l->>'store_limit')::int = 1 and (l->>'can_boost')::boolean from (select get_license(1, null) l) x));
-- 2. upgrade quote: (20 000 − 12 000) / 30 × 15 = 4 000
select pg_temp.ok('upgrade quote to 2 stores: (20 000 − 12 000) / 30 × 15 days = 4 000', (select (q->>'upgrade_cost')::int = 4000 and (q->>'stores')::int = 3 and (q->>'monthly_diff')::int = 8000 from (select upgrade_quote(2) q) x));
select pg_temp.ok('add-on invoice uses the same formula, covers 3 stores', (select (i->>'amount')::int = 4000 and (i->>'stores')::int = 3 and i->>'kind' = 'addon' from (select request_store_addon(2) i) x));
-- 3. trial boost: 3 stores for 24 hours, once
select pg_temp.ok('boost: 3 stores now', (select (l->>'store_limit')::int = 3 and l->>'boost_until' is not null from (select start_trial_boost() l) x));
do $$ begin perform start_trial_boost(); raise notice 'FAIL boost twice'; exception when others then raise notice 'PASS boost only once (%)', sqlerrm; end $$;
reset role;
select pg_temp.ok('boost is in the signed token (bu, bs)', (select (custom_access_token_hook(jsonb_build_object('user_id', 'c1000000-0000-0000-0000-00000000000b', 'claims', '{}'::jsonb))->'claims'->'ksh'->>'bu') is not null));
update public.accounts set boost_until = now() - interval '1 minute' where email = 'start@example.kz';
set role authenticated; select pg_temp.as_user('c1000000-0000-0000-0000-00000000000b');
select pg_temp.ok('boost over → back to 1 store', (select (l->>'store_limit')::int = 1 from (select get_license(2, null) l) x));
-- confirm the add-on → «Мульти» for the rest of the period
reset role;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-00000000000a', false);
select admin_confirm_invoice((select id from invoices where status = 'pending' and kind = 'addon'), 'test') is not null;
select pg_temp.ok('paid add-on → store_limit 3, same end date', (select store_limit = 3 and paid_until between now() + interval '14 days' and now() + interval '16 days' from accounts where email = 'start@example.kz'));
-- 4. renewal: a «Мульти» payer with 1 store keeps «Мульти» unless «перейти на Старт»
update public.accounts set paid_until = now() + interval '3 days' where email = 'start@example.kz';
set role authenticated; select pg_temp.as_user('c1000000-0000-0000-0000-00000000000b');
select pg_temp.ok('renewal keeps the paid plan (3 stores, 20 000)', (select (i->>'amount')::int = 20000 from (select ensure_renewal_invoice(1) i) x));

-- 5. cancellation flow
do $$ begin perform cancel_flow('price', 'bribe'); raise notice 'FAIL unknown outcome'; exception when others then raise notice 'PASS unknown outcome refused (%)', sqlerrm; end $$;
select pg_temp.ok('«Дорого» → 30 % on the next 2 invoices', (select (l->'discount'->>'pct')::int = 30 and (l->'discount'->>'left')::int = 2 from (select cancel_flow('price', 'discount') l) x));
select pg_temp.ok('the open renewal now costs 14 000', (select (i->>'amount')::int = 14000 from (select ensure_renewal_invoice(1) i) x));
do $$ begin perform cancel_flow('price', 'discount'); raise notice 'FAIL discount twice'; exception when others then raise notice 'PASS discount offer once per 180 days (%)', sqlerrm; end $$;
select pg_temp.ok('«Перейти на Старт» → next renewal for 1 store, 12 000 − 30 % = 8 400', (select (l->>'downgrade_next')::boolean from (select cancel_flow('price', 'downgrade') l) x)
   and (select (i->>'amount')::int = 8400 and (i->>'stores')::int = 1 from (select ensure_renewal_invoice(1) i) x));
select pg_temp.ok('«Закрыл магазин» → frozen 30 days, paid days kept', (select l->>'status' = 'frozen' and (l->>'store_limit')::int = 0 from (select cancel_flow('closed', 'freeze') l) x));
reset role;
select pg_temp.ok('freeze moved the paid end by 30 days', (select paid_until between now() + interval '32 days' and now() + interval '34 days' from accounts where email = 'start@example.kz'));
set role authenticated; select pg_temp.as_user('c1000000-0000-0000-0000-00000000000b');
select pg_temp.ok('frozen: no renewal reminders', (select ensure_renewal_invoice(1) is null));
select pg_temp.ok('«Разморозить» early → access back, unused freeze days taken back', (select l->>'status' = 'active' from (select resume_subscription() l) x));
reset role;
select pg_temp.ok('paid end back to ~3 days', (select paid_until between now() + interval '2 days' and now() + interval '4 days' from accounts where email = 'start@example.kz'));
set role authenticated; select pg_temp.as_user('c1000000-0000-0000-0000-00000000000b');
select pg_temp.ok('«Не хватает функций» + cancel → no renewal, question for the owner', (select l->>'cancel_at' is not null from (select cancel_flow('missing', 'cancelled', 'Нет демпинг-бота') l) x)
   and (select ensure_renewal_invoice(1) is null));
reset role;
select pg_temp.ok('the comment reached support and «Пульт»', (select count(*) = 1 from support_tickets where topic = 'idea' and message like '%демпинг%') and (select count(*) >= 1 from feedback where kind = 'exit' and reason = 'missing'));
update public.accounts set paid_until = now() - interval '1 day' where email = 'start@example.kz';
set role authenticated; select pg_temp.as_user('c1000000-0000-0000-0000-00000000000b');
select pg_temp.ok('cancelled → no grace after the end', (select get_license(1, null)->>'status' = 'expired'));
select pg_temp.ok('paying again cancels the cancellation', (select resume_subscription()->>'cancel_at' is null));
do $$ begin perform 1 from public.cancellations; raise notice 'FAIL cancellations readable'; exception when others then raise notice 'PASS cancellations not readable directly (%)', sqlerrm; end $$;

-- 6. Telegram link
select pg_temp.as_user('c1000000-0000-0000-0000-00000000000b');
select set_config('t.url', tg_link_create()->>'url', false) is not null;
select pg_temp.ok('link url = t.me/SellerHubBot?start=<64 hex>', current_setting('t.url') ~ '^https://t\.me/SellerHubBot\?start=[0-9a-f]{64}$');
reset role; set role anon;
do $$ begin perform bot_link('wrong-key-wrong-key-wrong-key-wrong', split_part(current_setting('t.url'), '=', 2), 111, 'X'); raise notice 'FAIL bot_link without the key'; exception when others then raise notice 'PASS bot functions need the bot key (%)', sqlerrm; end $$;
select pg_temp.ok('bot links the chat', (select (bot_link('bot-key-0123456789abcdef0123456789abcdef', split_part(current_setting('t.url'), '=', 2), 555001, 'Алишер')->>'ok')::boolean));
select pg_temp.ok('a token works once', (select bot_link('bot-key-0123456789abcdef0123456789abcdef', split_part(current_setting('t.url'), '=', 2), 555002, 'Хакер')->>'error' = 'token_expired'));
do $$ begin perform 1 from public.tg_links; raise notice 'FAIL tg_links readable'; exception when others then raise notice 'PASS tg_links not readable directly (%)', sqlerrm; end $$;
reset role; set role authenticated;
select pg_temp.as_user('c1000000-0000-0000-0000-00000000000b');
select pg_temp.ok('seller sees «linked» with the name', (select (s->>'linked')::boolean and s->>'name' = 'Алишер' from (select tg_status() s) x));
select pg_temp.as_user('c1000000-0000-0000-0000-00000000000c');
select pg_temp.ok('another seller is not linked', (select not (tg_status()->>'linked')::boolean));
-- 7. digest numbers, alerts
select pg_temp.as_user('c1000000-0000-0000-0000-00000000000b');
reset role; update public.accounts set paid_until = now() + interval '20 days', cancel_at = null where email = 'start@example.kz'; set role authenticated;
select pg_temp.as_user('c1000000-0000-0000-0000-00000000000b');
select pg_temp.ok('digest numbers stored (cleaned)', (select digest_report((now() at time zone 'Asia/Almaty')::date - 1, '{"orders": 24, "sum": 412000, "shipped": 22, "at_risk": [{"code": "777001", "shop": "Магазин А", "minutes": 15, "buyer": "SECRET"}], "shops": ["Магазин А"]}')));
reset role;
select pg_temp.ok('nothing but numbers, order no. and store name kept', (select stats::text !~ 'SECRET|buyer' and (stats->>'orders')::int = 24 from digest_stats));
set role authenticated; select pg_temp.as_user('c1000000-0000-0000-0000-00000000000b');
select pg_temp.ok('alert: chat returned once per order', (select (a->>'chat_id')::bigint = 555001 from (select alert_create('777001', 'Магазин А', 15) a) x) and (select alert_create('777001', 'Магазин А', 10) is null));
do $$ begin perform alert_create('1; drop table x', 'A', 5); raise notice 'FAIL bad order number accepted'; exception when others then raise notice 'PASS bad order number refused (%)', sqlerrm; end $$;
select pg_temp.as_user('c1000000-0000-0000-0000-00000000000c');
select pg_temp.ok('a seller without Telegram gets no alert', (select alert_create('777002', 'B', 15) is null));
-- 8. scheduled run
reset role; set role anon;
select set_config('t.jobs', bot_jobs('bot-key-0123456789abcdef0123456789abcdef')::text, false) is not null;
select pg_temp.ok('morning digest due with yesterday''s numbers', (select exists (select 1 from jsonb_array_elements(current_setting('t.jobs')::jsonb->'items') e where e->>'kind' = 'morning' and (e->'data'->'stats'->>'orders')::int = 24 and (e->>'chat_id')::bigint = 555001)));
select bot_sent('bot-key-0123456789abcdef0123456789abcdef', (select jsonb_agg(jsonb_build_object('user_id', e->>'user_id', 'kind', e->>'kind', 'key', e->>'key', 'ok', true)) from jsonb_array_elements(current_setting('t.jobs')::jsonb->'items') e)) >= 1;
select pg_temp.ok('sent once: not due again', (select not exists (select 1 from jsonb_array_elements(bot_jobs('bot-key-0123456789abcdef0123456789abcdef')->'items') e where e->>'kind' = 'morning')));
reset role;
update public.user_progress set last_active_at = now() - interval '7 days' where user_id = 'c1000000-0000-0000-0000-00000000000b';
insert into public.user_progress (user_id, last_active_at) values ('c1000000-0000-0000-0000-00000000000b', now() - interval '7 days') on conflict (user_id) do update set last_active_at = excluded.last_active_at;
set role anon;
select pg_temp.ok('6 days without the cabinet → care message', (select exists (select 1 from jsonb_array_elements(bot_jobs('bot-key-0123456789abcdef0123456789abcdef')->'items') e where e->>'kind' = 'care' and e->'data'->>'name' = 'Алишер')));
reset role;
update public.accounts set paid_until = now() - interval '1 day' where email = 'start@example.kz';
set role anon;
select pg_temp.ok('grace: daily reminder with days left', (select exists (select 1 from jsonb_array_elements(bot_jobs('bot-key-0123456789abcdef0123456789abcdef')->'items') e where e->>'kind' = 'grace' and (e->'data'->>'days_left')::int = 3)));
reset role;
update public.accounts set paid_until = now() - interval '62 days', trial_ends_at = now() - interval '100 days' where email = 'start@example.kz';
set role anon;
select set_config('t.jobs', bot_jobs('bot-key-0123456789abcdef0123456789abcdef')::text, false) is not null;
select pg_temp.ok('60 days after the end → win-back offer 50 %', (select exists (select 1 from jsonb_array_elements(current_setting('t.jobs')::jsonb->'items') e where e->>'kind' = 'winback60')));
select bot_sent('bot-key-0123456789abcdef0123456789abcdef', (select jsonb_agg(jsonb_build_object('user_id', e->>'user_id', 'kind', e->>'kind', 'key', e->>'key', 'ok', true)) from jsonb_array_elements(current_setting('t.jobs')::jsonb->'items') e where e->>'kind' = 'winback60')) >= 1;
reset role;
set role authenticated; select pg_temp.as_user('c1000000-0000-0000-0000-00000000000b');
select pg_temp.ok('the offer is real: next invoice 12 000 − 50 % = 6 000', (select (i->>'amount')::int = 6000 from (select create_invoice(1, 1, null) i) x));
reset role; set role anon;
select pg_temp.ok('blocked bot (403) → chat marked, nothing more sent', (select bot_sent('bot-key-0123456789abcdef0123456789abcdef', jsonb_build_array(jsonb_build_object('user_id', 'c1000000-0000-0000-0000-00000000000b', 'kind', 'care', 'key', 'x', 'ok', false, 'error', 'Forbidden: bot was blocked by the user', 'blocked', true))) = 1)
   and (select not exists (select 1 from jsonb_array_elements(bot_jobs('bot-key-0123456789abcdef0123456789abcdef')->'items') e where (e->>'chat_id')::bigint = 555001)));
reset role;
set role authenticated;
do $$ begin perform plan_stores(1); raise notice 'FAIL helper callable'; exception when others then raise notice 'PASS internal helper not callable (%)', sqlerrm; end $$;
do $$ begin perform admin_growth_settings('{}'); raise notice 'FAIL seller read bot settings'; exception when others then raise notice 'PASS seller cannot change bot settings (%)', sqlerrm; end $$;
reset role;
