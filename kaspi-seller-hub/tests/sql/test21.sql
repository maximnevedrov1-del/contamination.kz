\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'u1@example.kz'),
  ('a0000000-0000-0000-0000-000000000002', 'u2@example.kz'),
  ('a0000000-0000-0000-0000-000000000003', 'u3@example.kz'),
  ('b0000000-0000-0000-0000-000000000001', 'boss@example.kz');
insert into public.admins values ('b0000000-0000-0000-0000-000000000001');

-- ===== table is closed =====
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ begin perform 1 from ux_events; raise notice 'FAIL authenticated select ux_events'; exception when insufficient_privilege then raise notice 'PASS authenticated select ux_events denied'; end $$;
do $$ begin insert into ux_events (user_id, event_type, target_key, screen_key) values (auth.uid(), 'screen_view', 'home', 'home'); raise notice 'FAIL authenticated insert ux_events'; exception when insufficient_privilege then raise notice 'PASS authenticated insert ux_events denied'; end $$;
reset role;
set role anon;
do $$ begin perform track_ux_event('screen_view', 'home', 'home'); raise notice 'FAIL anon track'; exception when insufficient_privilege then raise notice 'PASS anon cannot execute track_ux_event'; end $$;
do $$ begin perform admin_ux_summary(); raise notice 'FAIL anon summary'; exception when insufficient_privilege then raise notice 'PASS anon cannot execute admin_ux_summary'; end $$;
reset role;
set role authenticated; reset request.jwt.claim.sub;
do $$ begin perform track_ux_event('screen_view', 'home', 'home'); raise notice 'FAIL null uid'; exception when others then raise notice '% null uid raises not_authenticated', case when sqlerrm = 'not_authenticated' then 'PASS' else 'FAIL' end; end $$;
reset role;

-- ===== whitelist + key rules =====
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ begin perform track_ux_event('keylogger', 'home', 'home'); raise notice 'FAIL unknown event type accepted'; exception when others then raise notice '% unknown event type rejected', case when sqlerrm = 'invalid_ux_event' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform track_ux_event(null, 'home', 'home'); raise notice 'FAIL null event type accepted'; exception when others then raise notice '% null event type rejected', case when sqlerrm = 'invalid_ux_event' then 'PASS' else 'FAIL' end; end $$;
do $$ declare k text; i int := 0; begin
  foreach k in array array['https://kaspi.kz/x', 'kaspi.kz/shop', 'has space', 'Upper', 'a/b', 'a?b=1', '123456', '8000020011', repeat('a', 65), '', 'кнопка', 'a@b.kz', 'x.y']
  loop
    begin perform track_ux_event('action_click', k, 'home'); raise notice 'FAIL bad target key accepted: %', k;
    exception when others then if sqlerrm = 'invalid_ux_key' then i := i + 1; else raise notice 'FAIL wrong error for %: %', k, sqlerrm; end if; end;
    begin perform track_ux_event('action_click', 'nav_home', k); raise notice 'FAIL bad screen key accepted: %', k;
    exception when others then if sqlerrm = 'invalid_ux_key' then i := i + 1; else raise notice 'FAIL wrong error screen %: %', k, sqlerrm; end if; end;
  end loop;
  raise notice '% all 26 bad keys rejected (%)', case when i = 26 then 'PASS' else 'FAIL' end, i;
end $$;
do $$ begin perform track_ux_event('action_click', null, 'home'); raise notice 'FAIL null key accepted'; exception when others then raise notice '% null key rejected', case when sqlerrm = 'invalid_ux_key' then 'PASS' else 'FAIL' end; end $$;
-- valid shapes
select track_ux_event('action_click', 'nav_home', 'home');
select track_ux_event('screen_view', 'orders', 'orders');
select track_ux_event('help_opened', 'help:gif-1', 'settings');
select track_ux_event('form_abandoned', 'a1b2', 'home');
select track_ux_event('rage_click', repeat('a', 64), 'home');
reset role;
select pg_temp.ok('valid events stored', (select count(*) from ux_events where user_id = 'a0000000-0000-0000-0000-000000000001') = 5);
select pg_temp.ok('rejected events stored nothing', not exists (select 1 from ux_events where target_key ~ '[^a-z0-9_:-]'));
select pg_temp.ok('check constraint blocks bad rows even for the owner role', (select count(*) from ux_events where target_key ~ '^[0-9]+$') = 0);
do $$ begin insert into ux_events (user_id, event_type, target_key, screen_key) values ('a0000000-0000-0000-0000-000000000001', 'screen_view', 'https://x', 'home'); raise notice 'FAIL constraint'; exception when check_violation then raise notice 'PASS table check rejects url key'; end $$;

-- ===== dedup / increment =====
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select track_ux_event('rage_click', 'btn_sync', 'orders'); select track_ux_event('rage_click', 'btn_sync', 'orders'); select track_ux_event('rage_click', 'btn_sync', 'orders');
select track_ux_event('rage_click', 'btn_sync', 'home');
select track_ux_event('screen_view', 'orders', 'orders');
reset role;
select pg_temp.ok('repeats increment one row', (select count(*) from ux_events where user_id = 'a0000000-0000-0000-0000-000000000002' and event_type = 'rage_click' and screen_key = 'orders') = 1 and (select occurrences from ux_events where user_id = 'a0000000-0000-0000-0000-000000000002' and event_type = 'rage_click' and screen_key = 'orders') = 3);
select pg_temp.ok('different screen is a different row', (select count(*) from ux_events where user_id = 'a0000000-0000-0000-0000-000000000002') = 3);
update ux_events set occurrences = 1000000 where user_id = 'a0000000-0000-0000-0000-000000000002' and screen_key = 'home';
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select track_ux_event('rage_click', 'btn_sync', 'home');
reset role;
select pg_temp.ok('occurrences capped at 1000000', (select occurrences from ux_events where user_id = 'a0000000-0000-0000-0000-000000000002' and screen_key = 'home') = 1000000);

-- ===== 100-row cap =====
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000003';
select track_ux_event('action_click', 'btn_' || i, 'home') from generate_series(1, 120) i;
select track_ux_event('action_click', 'btn_1', 'home');
reset role;
select pg_temp.ok('cap keeps 100 distinct rows', (select count(*) from ux_events where user_id = 'a0000000-0000-0000-0000-000000000003') = 100);
select pg_temp.ok('cap still increments existing rows', (select occurrences from ux_events where user_id = 'a0000000-0000-0000-0000-000000000003' and target_key = 'btn_1') = 2);
select pg_temp.ok('rows beyond the cap were ignored silently', not exists (select 1 from ux_events where user_id = 'a0000000-0000-0000-0000-000000000003' and target_key = 'btn_101'));

-- ===== admin summary =====
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ begin perform admin_ux_summary(); raise notice 'FAIL non-admin summary'; exception when insufficient_privilege then raise notice 'PASS non-admin admin_ux_summary forbidden'; end $$;
select track_ux_event('rage_click', 'btn_sync', 'orders');
set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.ok('summary has the three lists', (select (admin_ux_summary()) ?& array['friction', 'top_screens', 'least_screens']));
select pg_temp.ok('friction aggregates users and occurrences', (select (e->>'users')::int = 2 and (e->>'occurrences')::int = 4 from jsonb_array_elements(admin_ux_summary()->'friction') e where e->>'event_type' = 'rage_click' and e->>'target_key' = 'btn_sync' and e->>'screen_key' = 'orders'));
select pg_temp.ok('friction excludes plain clicks and views', not exists (select 1 from jsonb_array_elements(admin_ux_summary()->'friction') e where e->>'event_type' in ('action_click', 'screen_view')));
select pg_temp.ok('friction sorted by occurrences', (admin_ux_summary()->'friction'->0->>'occurrences')::bigint >= (admin_ux_summary()->'friction'->1->>'occurrences')::bigint);
select pg_temp.ok('top screens: orders viewed by 2 users', (select (e->>'users')::int = 2 and (e->>'views')::int = 2 from jsonb_array_elements(admin_ux_summary()->'top_screens') e where e->>'screen_key' = 'orders'));
select pg_temp.ok('least screens ascending', (select (admin_ux_summary()->'least_screens'->0->>'views')::int <= (admin_ux_summary()->'least_screens'->-1->>'views')::int));
reset role;
