\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) select md5('p' || g)::uuid, 'client' || g || '@example.kz' from generate_series(1, 250) g;
insert into auth.users (id, email) values ('b0000000-0000-0000-0000-000000000001', 'boss@example.kz');
insert into public.admins values ('b0000000-0000-0000-0000-000000000001');
update accounts set phone = '7701000' || lpad(substring(email from '\d+'), 4, '0') where email like 'client%';
insert into invoices (user_id, kind, stores, months, amount, phone) select md5('p' || g)::uuid, 'manual', 3, 1, 20000, '7701000' || lpad(g::text, 4, '0') from generate_series(1, 250) g;
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.ok('pending page: 100 rows, total 250', (select jsonb_array_length(r->'rows') = 100 and (r->>'total')::int = 250 from (select admin_invoices('pending') r) x));
select pg_temp.ok('page 3 has the last 50', (select jsonb_array_length(r->'rows') = 50 from (select admin_invoices('pending', null, 100, 200) r) x));
select pg_temp.ok('limit capped at 500', (select jsonb_array_length(r->'rows') = 250 from (select admin_invoices('all', null, 100000, 0) r) x));
select pg_temp.ok('search by e-mail', (select (r->>'total')::int = 1 and r->'rows'->0->>'email' = 'client123@example.kz' from (select admin_invoices('pending', 'client123@') r) x));
select pg_temp.ok('search by phone digits (+7 701 000 01 23)', (select (r->>'total')::int = 1 from (select admin_invoices('pending', '+7 701 000 01 23') r) x));
select pg_temp.ok('invoice rows carry email and paid_until', (select r->'rows'->0 ? 'email' and r->'rows'->0 ? 'paid_until' from (select admin_invoices('pending') r) x));
select pg_temp.ok('accounts: page of 100, totals by status', (select jsonb_array_length(r->'rows') = 100 and (r->'totals'->>'all')::int = 251 and (r->'totals'->>'trial')::int = 251 from (select admin_accounts() r) x));
select pg_temp.ok('accounts search', (select (r->>'total')::int = 1 from (select admin_accounts('client7@') r) x));
select pg_temp.ok('accounts status filter', (select (r->>'total')::int = 0 from (select admin_accounts(null, 'active') r) x));
select set_config('request.jwt.claim.sub', md5('p1')::uuid::text, false) is not null;
do $$ begin perform admin_accounts(); raise notice 'FAIL client listed accounts'; exception when others then raise notice 'PASS client cannot list accounts (%)', sqlerrm; end $$;
