\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- 027_ux_events_batch.sql: track_ux_events(jsonb) — one request per batch, same rules as track_ux_event.
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'u1@example.kz'),
  ('a0000000-0000-0000-0000-000000000002', 'u2@example.kz'),
  ('a0000000-0000-0000-0000-000000000003', 'u3@example.kz');

-- ===== access =====
set role anon;
do $$ begin perform track_ux_events('[]'); raise notice 'FAIL anon batch'; exception when insufficient_privilege then raise notice 'PASS anon cannot execute track_ux_events'; end $$;
reset role;
set role authenticated; reset request.jwt.claim.sub;
do $$ begin perform track_ux_events('[]'); raise notice 'FAIL null uid'; exception when others then raise notice '% null uid raises not_authenticated', case when sqlerrm = 'not_authenticated' then 'PASS' else 'FAIL' end; end $$;
reset role;

-- ===== batch shape =====
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ declare b jsonb; begin
  foreach b in array array['{"t":"screen_view"}'::jsonb, '"x"'::jsonb, 'null'::jsonb,
    (select jsonb_agg(jsonb_build_object('t','screen_view','k','home','s','home')) from generate_series(1, 51))]
  loop
    begin perform track_ux_events(b); raise notice 'FAIL bad batch accepted: %', left(b::text, 40);
    exception when others then raise notice '% bad batch rejected (%)', case when sqlerrm = 'invalid_ux_batch' then 'PASS' else 'FAIL' end, left(b::text, 30); end;
  end loop;
end $$;
do $$ begin perform track_ux_events(null); raise notice 'FAIL null batch'; exception when others then raise notice '% null batch rejected', case when sqlerrm = 'invalid_ux_batch' then 'PASS' else 'FAIL' end; end $$;
select pg_temp.ok('empty batch → 0', track_ux_events('[]') = 0);
select pg_temp.ok('50 items allowed', track_ux_events((select jsonb_agg(jsonb_build_object('t','screen_view','k','home','s','home')) from generate_series(1, 50))) = 1);
reset role;
select pg_temp.ok('50 repeats of one event → one row, 50 occurrences', (select occurrences from ux_events where user_id = 'a0000000-0000-0000-0000-000000000001' and target_key = 'home') = 50);

-- ===== bad items skipped, good ones counted; n clamped to 1..5 =====
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select pg_temp.ok('mixed batch: 3 good of 11', track_ux_events('[
  {"t":"rage_click","k":"btn_sync","s":"orders","n":3},
  {"t":"rage_click","k":"btn_sync","s":"orders","n":2},
  {"t":"action_click","k":"nav_home","s":"home","n":999},
  {"t":"help_opened","k":"help:gif-1","s":"settings","n":0},
  {"t":"keylogger","k":"home","s":"home"},
  {"t":"action_click","k":"https://kaspi.kz/x","s":"home"},
  {"t":"action_click","k":"8000020011","s":"home"},
  {"t":"action_click","k":"nav","s":"Upper"},
  {"t":"action_click","s":"home"},
  "string item",
  42
]'::jsonb) = 3);
reset role;
select pg_temp.ok('duplicates summed (3+2)', (select occurrences from ux_events where user_id = 'a0000000-0000-0000-0000-000000000002' and target_key = 'btn_sync') = 5);
select pg_temp.ok('n above 5 clamped to 5', (select occurrences from ux_events where user_id = 'a0000000-0000-0000-0000-000000000002' and target_key = 'nav_home') = 5);
select pg_temp.ok('n 0 clamped to 1', (select occurrences from ux_events where user_id = 'a0000000-0000-0000-0000-000000000002' and target_key = 'help:gif-1') = 1);
select pg_temp.ok('only 3 rows stored', (select count(*) from ux_events where user_id = 'a0000000-0000-0000-0000-000000000002') = 3);
select pg_temp.ok('no bad key stored', not exists (select 1 from ux_events where target_key ~ '[^a-z0-9_:-]' or target_key ~ '^[0-9]+$' or screen_key ~ '[A-Z]'));
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select track_ux_events('[{"t":"rage_click","k":"btn_sync","s":"orders","n":1}]');
select track_ux_event('rage_click', 'btn_sync', 'orders');
reset role;
select pg_temp.ok('batch and single call share the row', (select occurrences from ux_events where user_id = 'a0000000-0000-0000-0000-000000000002' and target_key = 'btn_sync') = 7);
select pg_temp.ok('other users untouched', (select count(*) from ux_events where user_id = 'a0000000-0000-0000-0000-000000000001') = 1);

-- ===== 100 distinct rows per user, counted inside one batch too =====
insert into ux_events (user_id, event_type, target_key, screen_key)
select 'a0000000-0000-0000-0000-000000000003', 'action_click', 'k' || i, 'home' from generate_series(1, 98) i;
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000003';
select pg_temp.ok('2 new of 5 fit under the cap, existing still counted', track_ux_events('[
  {"t":"screen_view","k":"a1","s":"home"},{"t":"screen_view","k":"a2","s":"home"},{"t":"screen_view","k":"a3","s":"home"},
  {"t":"screen_view","k":"a4","s":"home"},{"t":"action_click","k":"k1","s":"home","n":4}]'::jsonb) = 3);
reset role;
select pg_temp.ok('user capped at 100 rows', (select count(*) from ux_events where user_id = 'a0000000-0000-0000-0000-000000000003') = 100);
select pg_temp.ok('existing row incremented past the cap', (select occurrences from ux_events where user_id = 'a0000000-0000-0000-0000-000000000003' and target_key = 'k1') = 5);

-- ===== occurrences never overflow =====
update ux_events set occurrences = 999999 where user_id = 'a0000000-0000-0000-0000-000000000002' and target_key = 'btn_sync';
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select track_ux_events('[{"t":"rage_click","k":"btn_sync","s":"orders","n":5}]');
reset role;
select pg_temp.ok('occurrences capped at 1000000', (select occurrences from ux_events where user_id = 'a0000000-0000-0000-0000-000000000002' and target_key = 'btn_sync') = 1000000);
select pg_temp.ok('function is security definer with fixed search_path', (select prosecdef and proconfig @> array['search_path=public'] from pg_proc where proname = 'track_ux_events'));
