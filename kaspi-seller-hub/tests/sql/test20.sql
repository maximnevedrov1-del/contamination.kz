\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'u1@example.kz'),
  ('a0000000-0000-0000-0000-000000000002', 'u2@example.kz'),
  ('a0000000-0000-0000-0000-000000000003', 'u3@example.kz'),
  ('a0000000-0000-0000-0000-000000000004', 'u4@example.kz'),
  ('a0000000-0000-0000-0000-000000000005', 'u5@example.kz'),
  ('a0000000-0000-0000-0000-000000000006', 'u6@example.kz'),
  ('b0000000-0000-0000-0000-000000000001', 'boss@example.kz');
insert into public.admins values ('b0000000-0000-0000-0000-000000000001');

-- ===== client_errors =====
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ begin perform 1 from client_errors; raise notice 'FAIL authenticated select client_errors'; exception when insufficient_privilege then raise notice 'PASS authenticated select client_errors denied'; end $$;
do $$ begin insert into client_errors (user_id, error_code) values (auth.uid(), 'x'); raise notice 'FAIL authenticated insert client_errors'; exception when insufficient_privilege then raise notice 'PASS authenticated insert client_errors denied'; end $$;
do $$ begin perform 1 from retention_nudges_sent; raise notice 'FAIL authenticated select nudges'; exception when insufficient_privilege then raise notice 'PASS authenticated select retention_nudges_sent denied'; end $$;
do $$ begin insert into retention_nudges_sent (user_id, nudge_key) values (auth.uid(), 'trial_ending_2d'); raise notice 'FAIL authenticated insert nudges'; exception when insufficient_privilege then raise notice 'PASS authenticated insert retention_nudges_sent denied'; end $$;
do $$ begin perform sanitize_client_text('x'); raise notice 'FAIL sanitize callable'; exception when insufficient_privilege then raise notice 'PASS sanitize helper not callable'; end $$;
do $$ begin perform enqueue_retention_nudges(); raise notice 'FAIL authenticated enqueue'; exception when insufficient_privilege then raise notice 'PASS authenticated cannot execute enqueue_retention_nudges'; end $$;
do $$ begin perform admin_client_errors(); raise notice 'FAIL non-admin admin_client_errors'; exception when insufficient_privilege then raise notice 'PASS non-admin admin_client_errors forbidden'; end $$;

select report_client_error('Sync Failed https://kaspi.kz/x?token=abc', 'order 123456789 for a@b.kz', '0.1.0');
select report_client_error('eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuvwxyz.sig', 'Bearer abcdefghijklmnopqrstuvwxyz0123 ok', '0.1.0');
select report_client_error('   ', null, null);
reset role;
select pg_temp.ok('url stripped, code normalized', exists (select 1 from client_errors where error_code = 'sync_failed' and context = 'order # for'));
select pg_temp.ok('no url/email/digits stored', not exists (select 1 from client_errors where error_code ~ 'http|kaspi' or context ~ '[0-9]{4}|@|http'));
select pg_temp.ok('token stripped', not exists (select 1 from client_errors where error_code ~ 'eyj|abcdefghij' or context ~ 'abcdefghij'));
select pg_temp.ok('empty code becomes unknown', exists (select 1 from client_errors where error_code = 'unknown' and context = '' and app_version = ''));
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select report_client_error(repeat('a b ', 100), repeat('word ', 100), '1.2.3');
reset role;
select pg_temp.ok('lengths capped at 120', not exists (select 1 from client_errors where char_length(error_code) > 120 or char_length(context) > 120) and exists (select 1 from client_errors where char_length(context) = 120));
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select report_client_error('dup', 'ctx', '0.1.0'); select report_client_error('dup', 'ctx', '0.2.0'); select report_client_error('dup', 'ctx', '0.3.0');
reset role;
select pg_temp.ok('repeats increment one row', (select count(*) from client_errors where user_id = 'a0000000-0000-0000-0000-000000000002') = 1 and (select occurrences from client_errors where user_id = 'a0000000-0000-0000-0000-000000000002') = 3);
select pg_temp.ok('latest version kept', (select app_version from client_errors where user_id = 'a0000000-0000-0000-0000-000000000002') = '0.3.0');
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000003';
select report_client_error('flood' || i, '', '1') from generate_series(1, 60) i;
select report_client_error('flood1', '', '1');
reset role;
select pg_temp.ok('flood cap keeps 50 distinct rows', (select count(*) from client_errors where user_id = 'a0000000-0000-0000-0000-000000000003') = 50);
select pg_temp.ok('flood cap still increments existing', (select occurrences from client_errors where user_id = 'a0000000-0000-0000-0000-000000000003' and error_code = 'flood1') = 2);
set role anon;
do $$ begin perform report_client_error('x', '', ''); raise notice 'FAIL anon report'; exception when insufficient_privilege then raise notice 'PASS anon cannot execute report_client_error'; end $$;
reset role;
set role authenticated; reset request.jwt.claim.sub;
do $$ begin perform report_client_error('x', '', ''); raise notice 'FAIL null uid report'; exception when others then raise notice '% null uid raises', case when sqlerrm = 'not_authenticated' then 'PASS' else 'FAIL' end; end $$;
set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.ok('admin_client_errors aggregates', (select (e->>'occurrences')::int from jsonb_array_elements(admin_client_errors(500)) e where e->>'error_code' = 'dup') = 3);
select pg_temp.ok('admin_client_errors limit', jsonb_array_length(admin_client_errors(5)) = 5);
reset role;
-- a second user hitting the same error counts as 2 users
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select report_client_error('dup', 'ctx', '0.1.0');
set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.ok('admin_client_errors counts users', (select (e->>'users')::int from jsonb_array_elements(admin_client_errors(500)) e where e->>'error_code' = 'dup') = 2);
reset role;

-- ===== retention nudges (superuser = service-side) =====
insert into accounts (user_id, trial_ends_at, paid_until, created_at) values
  ('a0000000-0000-0000-0000-000000000001', now() + interval '10 days', null, now() - interval '3 days'),   -- no first sync
  ('a0000000-0000-0000-0000-000000000002', now() + interval '1 day', null, now() - interval '13 days'),    -- trial ending (+ no first sync)
  ('a0000000-0000-0000-0000-000000000003', now() - interval '2 days', null, now() - interval '16 days'),   -- winback
  ('a0000000-0000-0000-0000-000000000004', now() + interval '1 day', now() + interval '30 days', now() - interval '13 days'), -- paid
  ('a0000000-0000-0000-0000-000000000005', now() + interval '1 day', null, now() - interval '13 days'),    -- not linked
  ('a0000000-0000-0000-0000-000000000006', now() + interval '1 day', null, now() - interval '13 days')     -- blocked
  on conflict (user_id) do update set trial_ends_at = excluded.trial_ends_at, paid_until = excluded.paid_until, created_at = excluded.created_at;
insert into tg_links (user_id, chat_id) values
  ('a0000000-0000-0000-0000-000000000001', 1001), ('a0000000-0000-0000-0000-000000000002', 1002),
  ('a0000000-0000-0000-0000-000000000003', 1003), ('a0000000-0000-0000-0000-000000000004', 1004);
insert into tg_links (user_id, chat_id, blocked_at) values ('a0000000-0000-0000-0000-000000000006', 1006, now());
insert into funnel_events (user_id, event) values ('a0000000-0000-0000-0000-000000000002', 'first_sync_done');
delete from tg_outbox;
select pg_temp.ok('first enqueue queues 1 (onboarding only; trial/payment nudges are off under free access)', enqueue_retention_nudges() = 1);
select pg_temp.ok('outbox has 1 nudge row', (select count(*) from tg_outbox where kind = 'nudge') = 1);
select pg_temp.ok('no_first_sync for u1', exists (select 1 from retention_nudges_sent where user_id = 'a0000000-0000-0000-0000-000000000001' and nudge_key = 'no_first_sync_24h'));
select pg_temp.ok('no trial_ending nudge for u2 (free access)', not exists (select 1 from retention_nudges_sent where user_id = 'a0000000-0000-0000-0000-000000000002' and nudge_key = 'trial_ending_2d'));
select pg_temp.ok('no trial win-back for u3 (free access)', not exists (select 1 from retention_nudges_sent where user_id = 'a0000000-0000-0000-0000-000000000003' and nudge_key = 'trial_expired_winback'));
select pg_temp.ok('paid / unlinked / blocked excluded', not exists (select 1 from retention_nudges_sent where user_id in ('a0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000006')));
select pg_temp.ok('payload has key and text', not exists (select 1 from tg_outbox where kind = 'nudge' and (payload->>'key' is null or length(payload->>'text') < 20)));
select pg_temp.ok('no payment/trial nudge text was queued', not exists (select 1 from tg_outbox where payload->>'key' in ('trial_ending_2d', 'trial_expired_winback')));
select pg_temp.ok('second enqueue dedups to 0', enqueue_retention_nudges() = 0);
select pg_temp.ok('outbox still 1', (select count(*) from tg_outbox where kind = 'nudge') = 1);
update tg_links set blocked_at = null where user_id = 'a0000000-0000-0000-0000-000000000006';
select pg_temp.ok('unblocked user gets the onboarding nudge later', enqueue_retention_nudges() = 1);
