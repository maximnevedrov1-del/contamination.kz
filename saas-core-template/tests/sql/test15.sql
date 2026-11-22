\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- 016: system banner
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'seller@example.kz'),
  ('99999999-9999-9999-9999-999999999999', 'admin@example.kz');
insert into public.admins values ('99999999-9999-9999-9999-999999999999');

set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ begin perform public.admin_set_system_banner(true, 'x'); raise notice 'FAIL non-admin set banner';
exception when others then raise notice 'PASS non-admin cannot admin_set_system_banner (%)', sqlerrm; end $$;
do $$ begin perform public.admin_get_system_banner(); raise notice 'FAIL non-admin read banner admin RPC';
exception when others then raise notice 'PASS non-admin cannot admin_get_system_banner (%)', sqlerrm; end $$;
do $$ begin perform public.system_banner(); raise notice 'FAIL client called system_banner';
exception when others then raise notice 'PASS client cannot call system_banner (%)', sqlerrm; end $$;
select pg_temp.ok('get_license: system_banner inactive by default',
  (select (l->'system_banner'->>'active')::boolean = false and l->'system_banner'->>'type' = 'info' from (select public.get_license() l) x));

set request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';
do $$ begin perform public.admin_set_system_banner(true, 'x', 'bad'); raise notice 'FAIL invalid type accepted';
exception when others then raise notice 'PASS invalid type rejected (%)', sqlerrm; end $$;
do $$ begin perform public.admin_set_system_banner(true, repeat('a', 301), 'info'); raise notice 'FAIL 301 chars accepted';
exception when others then raise notice 'PASS text > 300 rejected (%)', sqlerrm; end $$;
do $$ begin perform public.admin_set_system_banner(true, '   ', 'info'); raise notice 'FAIL empty active banner accepted';
exception when others then raise notice 'PASS active banner without text rejected (%)', sqlerrm; end $$;
select pg_temp.ok('admin sets banner (trimmed, 300 chars ok)',
  (select (r->>'active')::boolean and r->>'text' = 'Сервис изменил вёрстку' and r->>'type' = 'warn' and r->>'updated_at' is not null
   from (select public.admin_set_system_banner(true, '  Сервис изменил вёрстку ', 'warn') r) x));
select pg_temp.ok('300 chars accepted', (select length(r->>'text') = 300 from (select public.admin_set_system_banner(true, repeat('a', 300), 'danger') r) x));
select public.admin_set_system_banner(true, 'Сервис изменил вёрстку', 'warn');
select pg_temp.ok('admin_get_system_banner returns it', (select r->>'text' = 'Сервис изменил вёрстку' and r->>'type' = 'warn' from (select public.admin_get_system_banner() r) x));

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.ok('get_license shows active banner with text and type',
  (select (l->'system_banner'->>'active')::boolean and l->'system_banner'->>'text' = 'Сервис изменил вёрстку' and l->'system_banner'->>'type' = 'warn' from (select public.get_license() l) x));
select pg_temp.ok('old keys still present (status, features, server_time)',
  (select l ? 'status' and l ? 'features' and l ? 'server_time' and l ? 'shared_stores' from (select public.get_license() l) x));

set request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';
select pg_temp.ok('deactivate keeps text but active=false',
  (select not (r->>'active')::boolean from (select public.admin_set_system_banner(false, 'old text', 'info') r) x));
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.ok('get_license: deactivated banner inactive, no text',
  (select not (l->'system_banner'->>'active')::boolean and l->'system_banner'->>'text' is null from (select public.get_license() l) x));
