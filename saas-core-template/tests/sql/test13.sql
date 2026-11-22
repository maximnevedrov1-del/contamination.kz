\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- 014: invoices and consents survive account deletion; admin_delete_account; purge_expired
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'Seller@Example.kz'),
  ('99999999-9999-9999-9999-999999999999', 'admin@example.kz');
insert into public.admins values ('99999999-9999-9999-9999-999999999999');
-- seller: one paid and one pending invoice, a consent, an answered old ticket and a fresh open one
insert into public.invoices (user_id, kind, stores, months, amount, status, phone, paid_at)
  values ('11111111-1111-1111-1111-111111111111', 'manual', 1, 1, 12000, 'paid', '77011234567', now() - interval '40 days'),
         ('11111111-1111-1111-1111-111111111111', 'renewal', 1, 1, 12000, 'pending', '77011234567', null);
insert into public.consents (user_id, version, ip, user_agent) values ('11111111-1111-1111-1111-111111111111', '2026-11-16', '10.0.0.1', 'UA');
insert into public.support_tickets (user_id, email, topic, message, status, created_at, replied_at)
  values ('11111111-1111-1111-1111-111111111111', 'x@example.kz', 'other', 'old', 'answered', now() - interval '400 days', now() - interval '399 days'),
         ('11111111-1111-1111-1111-111111111111', 'x@example.kz', 'other', 'new', 'open', now(), null),
         ('99999999-9999-9999-9999-999999999999', 'a@example.kz', 'other', 'old open', 'open', now() - interval '500 days', null);

-- permissions
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ begin perform public.admin_delete_account('11111111-1111-1111-1111-111111111111', 'seller@example.kz'); raise notice 'FAIL non-admin deleted an account';
exception when others then raise notice 'PASS non-admin cannot delete accounts (%)', sqlerrm; end $$;
do $$ begin perform public.purge_expired(); raise notice 'FAIL client called purge_expired';
exception when others then raise notice 'PASS client cannot call purge_expired (%)', sqlerrm; end $$;
do $$ begin perform public.admin_purge_expired(); raise notice 'FAIL non-admin purged';
exception when others then raise notice 'PASS non-admin cannot call admin_purge_expired (%)', sqlerrm; end $$;

set request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';
do $$ begin perform public.admin_delete_account('11111111-1111-1111-1111-111111111111', 'wrong@example.kz'); raise notice 'FAIL deleted with a wrong email';
exception when others then raise notice 'PASS wrong confirmation email refused (%)', sqlerrm; end $$;
do $$ begin perform public.admin_delete_account('99999999-9999-9999-9999-999999999999', 'admin@example.kz'); raise notice 'FAIL admin deleted itself';
exception when others then raise notice 'PASS admin cannot delete an admin (%)', sqlerrm; end $$;
select pg_temp.ok('delete: email match ignores case and spaces, 2 invoices and 1 consent kept',
  (select (r->>'deleted')::boolean and (r->>'invoices_kept')::int = 2 and (r->>'consents_kept')::int = 1
   from (select public.admin_delete_account('11111111-1111-1111-1111-111111111111', '  seller@example.KZ ') r) x));
reset role;
select pg_temp.ok('user and account are gone', not exists (select 1 from auth.users where id = '11111111-1111-1111-1111-111111111111')
  and not exists (select 1 from public.accounts where user_id = '11111111-1111-1111-1111-111111111111'));
select pg_temp.ok('invoices survive with user_id null and account_ref = hash of email',
  (select count(*) = 2 and bool_and(user_id is null) and bool_and(account_ref = public.account_ref('seller@example.kz')) from public.invoices));
select pg_temp.ok('paid invoice keeps amount and phone', exists (select 1 from public.invoices where status = 'paid' and amount = 12000 and phone = '77011234567'));
select pg_temp.ok('pending invoice was cancelled', not exists (select 1 from public.invoices where status = 'pending'));
select pg_temp.ok('consent survives with ip, user agent and account_ref',
  (select user_id is null and ip = '10.0.0.1' and user_agent = 'UA' and account_ref is not null from public.consents));
select pg_temp.ok('the seller''s tickets are deleted with the account', not exists (select 1 from public.support_tickets where message in ('old', 'new')));

set role authenticated; set request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';
select pg_temp.ok('admin_invoices lists invoices of a deleted account', (select (r->>'total')::int = 2 from (select public.admin_invoices('all') r) x));
select pg_temp.ok('admin_invoices finds them by the old email', (select (r->>'total')::int = 2 from (select public.admin_invoices('all', 'Seller@example.kz') r) x));
reset role;

-- plain deletion (without the admin function) also keeps invoices and consents
insert into auth.users (id, email) values ('22222222-2222-2222-2222-222222222222', 'two@example.kz');
insert into public.invoices (user_id, kind, stores, months, amount, status) values ('22222222-2222-2222-2222-222222222222', 'manual', 1, 1, 12000, 'paid');
insert into public.consents (user_id, version) values ('22222222-2222-2222-2222-222222222222', '2026-11-16');
delete from auth.users where id = '22222222-2222-2222-2222-222222222222';
select pg_temp.ok('direct user deletion: invoice and consent are kept', (select count(*) = 3 from public.invoices) and (select count(*) = 2 from public.consents));

-- retention
insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'three@example.kz');
insert into public.support_tickets (user_id, email, topic, message, status, created_at, replied_at)
  values ('33333333-3333-3333-3333-333333333333', 't@example.kz', 'other', 'answered long ago', 'answered', now() - interval '400 days', now() - interval '380 days'),
         ('33333333-3333-3333-3333-333333333333', 't@example.kz', 'other', 'closed recently', 'closed', now() - interval '400 days', now() - interval '10 days');
insert into public.tg_sent (user_id, kind, key, sent_at) values ('33333333-3333-3333-3333-333333333333', 'digest', 'old', now() - interval '200 days'),
  ('33333333-3333-3333-3333-333333333333', 'digest', 'new', now());
set role authenticated; set request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';
select pg_temp.ok('admin_purge_expired removes 1 old answered ticket and 1 old tg_sent row',
  (select (r->>'tickets')::int = 1 and (r->>'tg_sent')::int = 1 from (select public.admin_purge_expired() r) x));
reset role;
select pg_temp.ok('recent and open tickets are kept', (select count(*) = 2 from public.support_tickets where message in ('closed recently', 'old open')));
select pg_temp.ok('fresh tg_sent row kept', exists (select 1 from public.tg_sent where key = 'new'));
select pg_temp.ok('last_purge_at recorded', (select last_purge_at > now() - interval '1 minute' from public.ops_settings));

-- ops_digest runs the purge at most once a day
update public.ops_settings set key_hash = encode(sha256(convert_to(repeat('k', 40), 'utf8')), 'hex'), last_purge_at = now() - interval '2 days' where id = 1;
set role anon;
set role service_role; select pg_temp.ok('ops_digest runs the daily purge when it is due', (select r ? 'purged' and r->'purged' <> 'null'::jsonb from (select public.ops_digest(repeat('k', 40)) r) x)); set role anon;
set role service_role; select pg_temp.ok('ops_digest does not purge again the same day', (select r->'purged' = 'null'::jsonb from (select public.ops_digest(repeat('k', 40)) r) x)); set role anon;
reset role;
