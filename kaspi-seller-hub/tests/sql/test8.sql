\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- Support: service status, tickets, API health counts, the Telegram digest key.
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
create or replace function pg_temp.as_user(id text) returns boolean language sql as $$ select set_config('request.jwt.claim.sub', id, false) is not null $$;
insert into auth.users (id, email) values
  ('e0000000-0000-0000-0000-00000000000a', 'admin@example.kz'),
  ('e0000000-0000-0000-0000-00000000000b', 'seller@example.kz'),
  ('e0000000-0000-0000-0000-00000000000c', 'seller2@example.kz'),
  ('e0000000-0000-0000-0000-00000000000d', 'seller3@example.kz'),
  ('e0000000-0000-0000-0000-00000000000e', 'seller4@example.kz');
insert into public.admins values ('e0000000-0000-0000-0000-00000000000a');

-- 1. status: public read, admin write, expiry
set role anon;
select pg_temp.ok('anonymous reads the status (nothing to show)', (select get_service_status()->>'level' = 'ok'));
do $$ begin perform admin_set_status('down', 'x'); raise notice 'FAIL anonymous set the status'; exception when others then raise notice 'PASS anonymous cannot set the status (%)', sqlerrm; end $$;
reset role; set role authenticated;
select pg_temp.as_user('e0000000-0000-0000-0000-00000000000b');
do $$ begin perform admin_set_status('down', 'взлом'); raise notice 'FAIL seller set the status'; exception when others then raise notice 'PASS seller cannot set the status (%)', sqlerrm; end $$;
select pg_temp.as_user('e0000000-0000-0000-0000-00000000000a');
select pg_temp.ok('admin publishes «Kaspi не отвечает»', (select admin_set_status('warn', '  Kaspi не отвечает, чиним  ', 3)->>'message' = 'Kaspi не отвечает, чиним'));
do $$ begin perform admin_set_status('panic', 'x'); raise notice 'FAIL unknown level accepted'; exception when others then raise notice 'PASS unknown level refused (%)', sqlerrm; end $$;
reset role; set role anon;
select pg_temp.ok('everyone sees the message', (select get_service_status()->>'level' = 'warn'));
reset role;
update public.service_status set until = now() - interval '1 minute';
set role anon;
select pg_temp.ok('expired message disappears by itself', (select get_service_status()->>'level' = 'ok'));
do $$ begin perform 1 from public.service_status; raise notice 'FAIL status table readable directly'; exception when others then raise notice 'PASS status table not readable directly (%)', sqlerrm; end $$;
reset role;

-- 2. tickets
set role authenticated;
select pg_temp.as_user('e0000000-0000-0000-0000-00000000000b');
select pg_temp.ok('seller writes a ticket with a report', (select (r->>'status') = 'open' and r->>'topic' = 'print' and not (r ? 'report') from (select ticket_create('print', 'Принтер печатает пустые листы', 'Версия: 1.0', '1.0.0') r) x));
select pg_temp.ok('unknown topic becomes «other»', (select ticket_create('hack', 'вопрос')->>'topic' = 'other'));
do $$ begin perform ticket_create('other', '   '); raise notice 'FAIL empty ticket accepted'; exception when others then raise notice 'PASS empty ticket refused (%)', sqlerrm; end $$;
do $$ begin for i in 1..10 loop perform ticket_create('other', 'спам ' || i); end loop; raise notice 'FAIL ticket flood allowed'; exception when others then raise notice 'PASS at most 5 tickets an hour (%)', sqlerrm; end $$;
select pg_temp.ok('seller sees own tickets', (select jsonb_array_length(my_tickets()) = 2));
reset role;
select min(id) as tid from public.support_tickets \gset
select set_config('t.tid', :'tid', false) is not null;
set role authenticated;
select pg_temp.as_user('e0000000-0000-0000-0000-00000000000c');
select pg_temp.ok('another seller sees none of them', (select my_tickets() = '[]'::jsonb));
select pg_temp.ok('another seller cannot mark them read', (select ticket_seen(:tid) is null));
do $$ begin perform admin_tickets(); raise notice 'FAIL seller listed all tickets'; exception when others then raise notice 'PASS seller cannot list all tickets (%)', sqlerrm; end $$;
do $$ begin perform 1 from public.support_tickets; raise notice 'FAIL tickets table readable directly'; exception when others then raise notice 'PASS tickets table not readable directly (%)', sqlerrm; end $$;
select pg_temp.as_user('e0000000-0000-0000-0000-00000000000a');
select pg_temp.ok('admin sees open tickets with e-mail and report', (select (r->>'open')::int = 2 and r->'items'->0->>'email' = 'seller@example.kz' and r->'items'->0->>'report' = 'Версия: 1.0' from (select admin_tickets('open') r) x));
select pg_temp.ok('admin answers', (select admin_ticket_reply(:tid, 'Выберите «Этикетка 100×150» в Настройках → Печать')->>'status' = 'answered'));
do $$ begin perform admin_ticket_reply(current_setting('t.tid')::bigint, '  '); raise notice 'FAIL empty answer accepted'; exception when others then raise notice 'PASS empty answer refused (%)', sqlerrm; end $$;
select pg_temp.as_user('e0000000-0000-0000-0000-00000000000b');
select pg_temp.ok('seller sees the answer as unread', (select (t->>'unread')::boolean and t->>'reply' like 'Выберите%' from jsonb_array_elements(my_tickets()) t where t->>'status' = 'answered'));
select ticket_seen(:tid) is not null;
select pg_temp.ok('read after opening', (select not (t->>'unread')::boolean from jsonb_array_elements(my_tickets()) t where t->>'status' = 'answered'));
select pg_temp.ok('seller closes «вопрос решён»', (select ticket_close(:tid)));

-- 3. health counts
select pg_temp.ok('seller reports counts', (select health_report('[{"market":"kaspi","ok":50,"fail":2,"kinds":{"server":2}}]')));
select health_report('[{"market":"kaspi","ok":10,"fail":1,"kinds":{"server":1,"evil":99}}, {"market":"mars","ok":1}]');
reset role;
select pg_temp.ok('counts add up in the hour; unknown kinds and markets dropped', (select ok = 60 and fail = 3 and kinds = '{"server": 3}'::jsonb from public.api_health where user_id = 'e0000000-0000-0000-0000-00000000000b'));
select pg_temp.ok('no unknown market stored', (select count(*) = 0 from public.api_health where market not in ('kaspi', 'ozon', 'wb')));
set role authenticated;
do $$ begin perform health_report('[{"market":"kaspi"},{"market":"kaspi"},{"market":"kaspi"},{"market":"kaspi"}]'); raise notice 'FAIL oversized report accepted'; exception when others then raise notice 'PASS oversized report refused (%)', sqlerrm; end $$;
select health_report('[{"market":"kaspi","ok":-5,"fail":99999999}]');
reset role;
select pg_temp.ok('negative and huge numbers clamped', (select ok >= 60 and fail <= 10003 from public.api_health where user_id = 'e0000000-0000-0000-0000-00000000000b'));
set role anon;
do $$ begin perform health_report('[]'); raise notice 'FAIL anonymous reported health'; exception when others then raise notice 'PASS anonymous cannot report (%)', sqlerrm; end $$;
reset role;

-- 4. digest: key, outage detection, recovery
set role anon;
set role service_role; do $$ begin perform ops_digest('x'); raise notice 'FAIL digest without a key set'; exception when others then raise notice 'PASS digest refused before a key is set (%)', sqlerrm; end $$; set role anon;
reset role; set role authenticated;
select pg_temp.as_user('e0000000-0000-0000-0000-00000000000b');
do $$ begin perform admin_ops_settings(repeat('a', 64)); raise notice 'FAIL seller set the job key'; exception when others then raise notice 'PASS seller cannot set the job key (%)', sqlerrm; end $$;
select pg_temp.as_user('e0000000-0000-0000-0000-00000000000a');
select pg_temp.ok('admin sets the job key (hash only)', (select (admin_ops_settings(encode(sha256(convert_to('test-job-key-0123456789abcdef0123456789', 'utf8')), 'hex'), 3, 0.3)->>'has_key')::boolean));
reset role;
-- three sellers fail at once (Kaspi 502), one works; plus seller 1's own healthy calls
update public.api_health set ok = 100, fail = 0, kinds = '{}' where user_id = 'e0000000-0000-0000-0000-00000000000b';
insert into public.api_health (bucket, user_id, market, ok, fail, kinds) values
  (date_trunc('hour', now()), 'e0000000-0000-0000-0000-00000000000c', 'kaspi', 1, 12, '{"server": 12}'),
  (date_trunc('hour', now()), 'e0000000-0000-0000-0000-00000000000d', 'kaspi', 0, 8, '{"network": 8}'),
  (date_trunc('hour', now()), 'e0000000-0000-0000-0000-00000000000e', 'kaspi', 2, 9, '{"timeout": 5, "server": 4}'),
  (date_trunc('hour', now()), 'e0000000-0000-0000-0000-00000000000a', 'kaspi', 3, 30, '{"auth": 30}');
set role anon;
set role service_role; do $$ begin perform ops_digest('wrong-key-wrong-key-wrong-key-wrong-key'); raise notice 'FAIL wrong key accepted'; exception when others then raise notice 'PASS wrong key refused (%)', sqlerrm; end $$; set role anon;
set role service_role; select pg_temp.ok('outage: 3 of 5 clients failing → alert; a wrong token is not an outage', (select jsonb_array_length(d->'alerts') = 1 and (d->'alerts'->0->>'failing')::int = 3 and (d->'alerts'->0->>'users')::int = 5 and (d->>'open_tickets')::int = 1 from (select ops_digest('test-job-key-0123456789abcdef0123456789') d) x)); set role anon;
set role service_role; select pg_temp.ok('no repeat alert 1 minute later', (select jsonb_array_length(ops_digest('test-job-key-0123456789abcdef0123456789')->'alerts') = 0)); set role anon;
reset role;
update public.api_health set ok = 500, fail = 0, kinds = '{}' where user_id <> 'e0000000-0000-0000-0000-00000000000a';
set role anon;
set role service_role; select pg_temp.ok('recovery reported once', (select d->'recovered' = '["kaspi"]'::jsonb from (select ops_digest('test-job-key-0123456789abcdef0123456789') d) x)); set role anon;
set role service_role; select pg_temp.ok('digest has no client e-mails', (select ops_digest('test-job-key-0123456789abcdef0123456789')::text !~ '@')); set role anon;
do $$ begin perform 1 from public.ops_settings; raise notice 'FAIL ops settings readable'; exception when others then raise notice 'PASS ops settings not readable (%)', sqlerrm; end $$;
reset role; set role authenticated;
select pg_temp.as_user('e0000000-0000-0000-0000-00000000000b');
do $$ begin perform admin_health(); raise notice 'FAIL seller read health'; exception when others then raise notice 'PASS seller cannot read everyone''s health (%)', sqlerrm; end $$;
do $$ begin perform health_window(60); raise notice 'FAIL helper callable'; exception when others then raise notice 'PASS internal helper not callable (%)', sqlerrm; end $$;
select pg_temp.as_user('e0000000-0000-0000-0000-00000000000a');
select pg_temp.ok('admin sees health by hour', (select jsonb_array_length(admin_health(24)->'hours') >= 1));
reset role;
