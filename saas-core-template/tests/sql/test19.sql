\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'u1@example.kz'),
  ('b0000000-0000-0000-0000-000000000001', 'boss@example.kz');
insert into public.admins values ('b0000000-0000-0000-0000-000000000001');
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select pg_temp.ok('valid event returns true', track_funnel_event('first_sync_done'));
select pg_temp.ok('duplicate returns false', not track_funnel_event('first_sync_done'));
do $$ begin perform track_funnel_event('hacked'); raise notice 'FAIL unknown event accepted'; exception when others then raise notice '% unknown event raises', case when sqlerrm = 'bad_event' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform track_funnel_event(null); raise notice 'FAIL null event accepted'; exception when others then raise notice '% null event raises', case when sqlerrm = 'bad_event' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform 1 from funnel_events; raise notice 'FAIL authenticated select'; exception when insufficient_privilege then raise notice 'PASS authenticated select denied'; end $$;
do $$ begin insert into funnel_events (user_id, event) values (auth.uid(), 'invoice_created'); raise notice 'FAIL authenticated insert'; exception when insufficient_privilege then raise notice 'PASS authenticated insert denied'; end $$;
do $$ begin perform admin_funnel_events(); raise notice 'FAIL non-admin admin_funnel_events'; exception when insufficient_privilege then raise notice 'PASS non-admin admin_funnel_events forbidden'; end $$;
set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.ok('admin_funnel_events counts', (admin_funnel_events()->>'first_sync_done') = '1');
reset request.jwt.claim.sub;
do $$ begin perform track_funnel_event('first_sync_done'); raise notice 'FAIL null uid accepted'; exception when others then raise notice '% null uid raises', case when sqlerrm = 'not_authenticated' then 'PASS' else 'FAIL' end; end $$;
reset role;
select pg_temp.ok('row count stays 1', (select count(*) from funnel_events where user_id = 'a0000000-0000-0000-0000-000000000001') = 1);
set role anon;
do $$ begin perform 1 from funnel_events; raise notice 'FAIL anon select'; exception when insufficient_privilege then raise notice 'PASS anon select denied'; end $$;
do $$ begin insert into funnel_events (user_id, event) values ('a0000000-0000-0000-0000-000000000001', 'invoice_created'); raise notice 'FAIL anon insert'; exception when insufficient_privilege then raise notice 'PASS anon insert denied'; end $$;
do $$ begin perform track_funnel_event('first_sync_done'); raise notice 'FAIL anon execute'; exception when insufficient_privilege then raise notice 'PASS anon cannot execute track_funnel_event'; end $$;
reset role;
