\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- «Пульт»: progress, usage counts, NPS / exit / «ответ помог?», funnel, cohorts, risk list.
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
create or replace function pg_temp.as_user(id text) returns boolean language sql as $$ select set_config('request.jwt.claim.sub', id, false) is not null $$;
insert into auth.users (id, email) values
  ('a1000000-0000-0000-0000-00000000000a', 'admin@example.kz'),
  ('a1000000-0000-0000-0000-00000000000b', 'active@example.kz'),
  ('a1000000-0000-0000-0000-00000000000c', 'stuck@example.kz'),
  ('a1000000-0000-0000-0000-00000000000d', 'gone@example.kz');
insert into public.admins values ('a1000000-0000-0000-0000-00000000000a');
-- «stuck» signed up 3 days ago, never connected a store; «gone» had a trial that ended 2 days ago
update public.accounts set created_at = now() - interval '3 days' where email = 'stuck@example.kz';
update public.accounts set created_at = now() - interval '20 days', trial_ends_at = now() - interval '2 days' where email = 'gone@example.kz';
update public.accounts set created_at = now() - interval '20 days' where email = 'active@example.kz';

set role authenticated;
-- 1. usage report
select pg_temp.as_user('a1000000-0000-0000-0000-00000000000b');
select pg_temp.ok('report accepted', (select usage_report('{"store":true,"orders":true,"print":false,"evil":true}', jsonb_build_array(jsonb_build_object('day', current_date, 'sections', '{"orders":5,"analytics":1,"hacked":99}'::jsonb, 'actions', '{"accept":3,"rm -rf":1}'::jsonb)), '1.2.0')));
select usage_report('{"store":true,"orders":true,"print":true}', jsonb_build_array(jsonb_build_object('day', current_date, 'sections', '{"orders":2}'::jsonb, 'actions', '{"accept":-50,"print":1}'::jsonb)));
do $$ begin perform usage_report('{}', '[{},{},{},{}]'); raise notice 'FAIL oversized report accepted'; exception when others then raise notice 'PASS oversized report refused (%)', sqlerrm; end $$;
select usage_report('{}', jsonb_build_array(jsonb_build_object('day', current_date - 30, 'sections', '{"orders":1}'::jsonb), jsonb_build_object('day', 'not a date')));
reset role;
select pg_temp.ok('counts add up, unknown keys dropped, negatives ignored', (select sections = '{"orders": 7, "analytics": 1}'::jsonb and actions = '{"accept": 3, "print": 1}'::jsonb from usage_daily where user_id = 'a1000000-0000-0000-0000-00000000000b' and day = current_date));
select pg_temp.ok('old or broken days not stored', (select count(*) = 1 from usage_daily where user_id = 'a1000000-0000-0000-0000-00000000000b'));
select pg_temp.ok('steps: known only, first time kept', (select steps ?& array['store', 'orders', 'print'] and not steps ? 'evil' from user_progress where user_id = 'a1000000-0000-0000-0000-00000000000b'));
do $$ declare t1 text; t2 text; begin
  select steps->>'store' into t1 from user_progress where user_id = 'a1000000-0000-0000-0000-00000000000b';
  perform pg_sleep(0.05);
  perform set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000000b', false);
  set local role authenticated; perform usage_report('{"store":true}', '[]'); reset role;
  select steps->>'store' into t2 from user_progress where user_id = 'a1000000-0000-0000-0000-00000000000b';
  raise notice '% earliest step time kept', case when t1 = t2 then 'PASS' else 'FAIL' end;
end $$;
-- 20 more active days for «active» (NPS needs 5+)
insert into usage_daily (user_id, day, sections) select 'a1000000-0000-0000-0000-00000000000b', current_date - g, '{"orders": 3}' from generate_series(1, 6) g;
set role anon;
do $$ begin perform usage_report('{}', '[]'); raise notice 'FAIL anonymous reported usage'; exception when others then raise notice 'PASS anonymous cannot report (%)', sqlerrm; end $$;
reset role; set role authenticated;

-- 2. surveys: which one is due
select pg_temp.as_user('a1000000-0000-0000-0000-00000000000b');
select pg_temp.ok('active seller after 14 days → NPS due', (select feedback_due() = 'nps'));
select pg_temp.as_user('a1000000-0000-0000-0000-00000000000c');
select pg_temp.ok('new seller (3 days) → nothing yet', (select feedback_due() is null));
select pg_temp.as_user('a1000000-0000-0000-0000-00000000000d');
select pg_temp.ok('trial ended → «почему не продлеваете» due', (select feedback_due() = 'exit'));
select feedback_submit('exit', null, 'price', 'Дорого для одного магазина');
select pg_temp.ok('exit answered → not asked again', (select feedback_due() is distinct from 'exit'));
select pg_temp.as_user('a1000000-0000-0000-0000-00000000000b');
select feedback_submit('nps', 4, null, '  Не хватает демпинг-бота  ');
select pg_temp.ok('NPS answered → not due for 90 days', (select feedback_due() is null));
do $$ begin perform feedback_submit('nps', 11); raise notice 'FAIL NPS 11 accepted'; exception when others then raise notice 'PASS NPS outside 0..10 refused (%)', sqlerrm; end $$;
do $$ begin perform feedback_submit('csat', 1, null, null, 999999); raise notice 'FAIL csat for a foreign ticket'; exception when others then raise notice 'PASS «ответ помог?» only for own answered tickets (%)', sqlerrm; end $$;
-- csat on an own answered ticket, twice → one row (changed mind)
reset role;
insert into support_tickets (id, user_id, email, topic, message, reply, status, replied_at) values (500, 'a1000000-0000-0000-0000-00000000000b', 'active@example.kz', 'print', 'вопрос', 'ответ', 'answered', now());
set role authenticated;
select pg_temp.as_user('a1000000-0000-0000-0000-00000000000b');
select feedback_submit('csat', 0, null, null, 500);
select feedback_submit('csat', 1, null, null, 500);
reset role;
select pg_temp.ok('«ответ помог?» one answer per ticket, last one wins', (select count(*) = 1 and min(score) = 1 from feedback where kind = 'csat'));
do $$ begin perform 1 from public.feedback; raise notice 'PASS (as postgres)'; end $$;
set role authenticated;
do $$ begin perform 1 from public.feedback; raise notice 'FAIL feedback readable directly'; exception when others then raise notice 'PASS feedback not readable directly (%)', sqlerrm; end $$;
do $$ begin perform 1 from public.usage_daily; raise notice 'FAIL usage readable directly'; exception when others then raise notice 'PASS usage not readable directly (%)', sqlerrm; end $$;

-- 3. the panel
do $$ begin perform admin_insights(); raise notice 'FAIL seller opened the panel'; exception when others then raise notice 'PASS seller cannot open the panel (%)', sqlerrm; end $$;
select pg_temp.as_user('a1000000-0000-0000-0000-00000000000a');
select pg_temp.ok('funnel: 3 sellers (admin not counted), 1 with a store, 1 printed', (select (r->'funnel'->>'accounts')::int = 3 and (r->'funnel'->>'store')::int = 1 and (r->'funnel'->>'print')::int = 1 and (r->'funnel'->>'costs')::int = 0 from (select admin_insights(30) r) x));
select pg_temp.ok('sections: orders used by 1 seller, 25 times', (select r->'sections'->'orders' = '{"users": 1, "times": 25}'::jsonb from (select admin_insights(30) r) x));
select pg_temp.ok('NPS: one detractor → −100, comment with e-mail', (select (r->'nps'->>'score')::int = -100 and r->'nps'->'comments'->0->>'email' = 'active@example.kz' and r->'nps'->'comments'->0->>'comment' = 'Не хватает демпинг-бота' from (select admin_insights(30) r) x));
select pg_temp.ok('exit reasons counted', (select r->'exit'->'reasons' = '{"price": 1}'::jsonb from (select admin_insights(30) r) x));
select pg_temp.ok('«ответ помог?»: 1 of 1', (select r->'csat' = '{"good": 1, "answers": 1}'::jsonb from (select admin_insights(30) r) x));
select pg_temp.ok('risk: stuck (no store), detractor, recently expired; admin not listed', (select
    exists (select 1 from jsonb_array_elements(r->'risk') e where e->>'email' = 'stuck@example.kz' and e->>'reason' = 'noStore')
    and exists (select 1 from jsonb_array_elements(r->'risk') e where e->>'email' = 'active@example.kz' and e->>'reason' = 'detractor')
    and exists (select 1 from jsonb_array_elements(r->'risk') e where e->>'email' = 'gone@example.kz' and e->>'reason' = 'expiredRecently')
    and not exists (select 1 from jsonb_array_elements(r->'risk') e where e->>'email' = 'admin@example.kz')
  from (select admin_insights(30) r) x));
select pg_temp.ok('cohorts: the 20-day-old seller is active in weeks 3 and 4', (select exists (select 1 from jsonb_array_elements(r->'cohorts') c where (c->>'size')::int = 2 and c->'active' = '[0, 0, 1, 1]'::jsonb) from (select admin_insights(30) r) x));
do $$ begin perform add_counts('{}', '{}', 'steps'); raise notice 'FAIL helper callable'; exception when others then raise notice 'PASS internal helper not callable (%)', sqlerrm; end $$;
reset role;
