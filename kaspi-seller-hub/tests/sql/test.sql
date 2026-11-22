\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;

insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'seller@example.kz'),
  ('22222222-2222-2222-2222-222222222222', 'other@example.kz'), ('99999999-9999-9999-9999-999999999999', 'owner@example.kz');
insert into public.admins values ('99999999-9999-9999-9999-999999999999');

select pg_temp.ok('trigger creates account with 14-day trial',
  (select trial_ends_at between now() + interval '13 days 23 hours' and now() + interval '14 days 1 hour' from accounts where email = 'seller@example.kz'));

-- ===== as the seller =====
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.ok('license: trial, 3 stores', (select (l->>'status') = 'trial' and (l->>'store_limit')::int = 3 from (select get_license(2) l) x));
select pg_temp.ok('price 3 stores x1 = 20000', billing_price(3, 1) = 20000);
select pg_temp.ok('price 5 stores x1 = 30000', billing_price(5, 1) = 30000);
select pg_temp.ok('price 4 stores x3 = 75000', billing_price(4, 3) = 75000);
do $$ begin perform create_invoice(3, 1, '87011234567'); raise notice 'FAIL invoice before consent accepted'; exception when others then raise notice 'PASS invoice before consent rejected (%)', sqlerrm; end $$;
select pg_temp.ok('accept_terms records current version', (select r->>'version' = '2026-11-16' from (select accept_terms() r) x));
select pg_temp.ok('invoice for 1 store = «Старт» 12 000, 1 store', (select (i->>'amount')::int = 12000 and (i->>'stores')::int = 1 from (select create_invoice(1, 1, '8 701 123 45 67') i) x));
select pg_temp.ok('2 stores = «Мульти» 20 000 for 3', (select (i->>'amount')::int = 20000 and (i->>'stores')::int = 3 from (select create_invoice(2, 1, '8 701 123 45 67') i) x));
select pg_temp.ok('phone normalized', (select phone = '77011234567' from accounts));
select pg_temp.ok('5 stores x2 months = 60000', (select (i->>'amount')::int = 60000 from (select create_invoice(5, 2, '+7 (701) 123-45-67') i) x));
select pg_temp.ok('new invoice replaces the open one', (select count(*) = 1 from invoices where status = 'pending') and (select count(*) = 2 from invoices where status = 'cancelled'));
do $$ begin perform create_invoice(3, 1, '12345'); raise notice 'FAIL bad phone accepted'; exception when others then raise notice 'PASS bad phone rejected (%)', sqlerrm; end $$;
do $$ begin perform create_invoice(3, 99, '87011234567'); raise notice 'FAIL 99 months accepted'; exception when others then raise notice 'PASS 99 months rejected (%)', sqlerrm; end $$;
do $$ begin perform create_invoice(-2, 1, '87011234567'); raise notice 'FAIL negative stores accepted'; exception when others then raise notice 'PASS negative stores rejected (%)', sqlerrm; end $$;
-- client cannot write directly / set its own price or paid_until
do $$ begin insert into invoices (user_id, stores, months, amount, phone) values (auth.uid(), 10, 12, 1, '77011234567'); raise notice 'FAIL direct insert allowed'; exception when others then raise notice 'PASS direct insert denied (%)', sqlerrm; end $$;
do $$ begin update accounts set paid_until = now() + interval '10 years'; if (select paid_until from accounts) is not null then raise notice 'FAIL client extended own subscription'; else raise notice 'PASS client update has no effect/denied'; end if; exception when others then raise notice 'PASS direct update denied (%)', sqlerrm; end $$;
do $$ begin perform admin_confirm_invoice((select id from invoices where status='pending'), null); raise notice 'FAIL non-admin confirmed'; exception when others then raise notice 'PASS non-admin cannot confirm (%)', sqlerrm; end $$;
do $$ begin perform (admin_invoices('all')->'rows'); raise notice 'FAIL non-admin listed invoices'; exception when others then raise notice 'PASS non-admin cannot list invoices (%)', sqlerrm; end $$;
do $$ begin perform 1 from billing_config; raise notice 'FAIL client reads billing_config directly'; exception when others then raise notice 'PASS billing_config not directly readable'; end $$;
select pg_temp.ok('license shows pending invoice', (select (l->'pending_invoice'->>'amount')::int = 60000 from (select get_license(null) l) x));

-- ===== another user cannot see the seller's data =====
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.ok('RLS: other user sees no foreign invoices', (select count(*) = 0 from invoices));
select pg_temp.ok('RLS: other user sees only own account', (select count(*) = 1 and bool_and(email = 'other@example.kz') from accounts));
select pg_temp.ok('other user cannot cancel foreign invoice', not cancel_my_invoice((select max(id) from invoices)));

-- ===== anon (not logged in) =====
reset request.jwt.claim.sub; set role anon;
do $$ begin perform get_license(1); raise notice 'FAIL anon got a license'; exception when others then raise notice 'PASS anon cannot call get_license (%)', sqlerrm; end $$;

-- ===== admin confirms =====
reset role; set role authenticated; set request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';
select pg_temp.ok('admin sees pending invoice with email', (select jsonb_array_length(a) = 1 and a->0->>'email' = 'seller@example.kz' from (select (admin_invoices('pending')->'rows') a) x));
select pg_temp.ok('confirm: paid period starts after the trial (trial not lost)',
  (select (r->>'period_from')::timestamptz >= now() + interval '29 days' and (r->>'period_to')::timestamptz > (r->>'period_from')::timestamptz + interval '58 days'
   from (select admin_confirm_invoice((select ((admin_invoices('pending')->'rows'))->0->>'id')::bigint, 'Kaspi #123') r) x));
do $$ begin perform admin_confirm_invoice((select (((admin_invoices('paid')->'rows'))->0->>'id')::bigint), null); raise notice 'FAIL double confirm'; exception when others then raise notice 'PASS double confirm rejected (%)', sqlerrm; end $$;
select pg_temp.ok('config update by admin', (select (c->>'kaspi_qr_url') = 'https://example.kz/qr.png' from (select admin_update_config('{"kaspi_qr_url":"https://example.kz/qr.png","payment_instructions":"Оплатите по QR"}') c) x));
select pg_temp.ok('admin accounts list', (select jsonb_array_length((admin_accounts()->'rows')) = 3));

-- ===== seller after payment =====
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.ok('paid during trial: active at once with 5 stores, QR from config', (select (l->>'status') = 'active' and (l->>'store_limit')::int = 5 and l->'payment'->>'qr_url' = 'https://example.kz/qr.png' from (select get_license(4) l) x));

-- ===== expiry: move the trial into the past =====
reset role; update accounts set trial_ends_at = now() - interval '1 day', paid_until = null where email = 'other@example.kz';
set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.ok('expired: status expired, store_limit 0', (select (l->>'status') = 'expired' and (l->>'store_limit')::int = 0 from (select get_license(1) l) x));
select accept_terms() is not null;
select create_invoice(3, 1, '87770001122') is not null;
reset role; set role authenticated; set request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';
select pg_temp.ok('confirm for expired user starts now (≈ +1 month)', (select (r->>'period_from')::timestamptz between now() - interval '1 minute' and now() + interval '1 minute'
   from (select admin_confirm_invoice((select (e->>'id')::bigint from jsonb_array_elements((admin_invoices('pending')->'rows')) e where e->>'email' = 'other@example.kz'), null) r) x));
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.ok('after payment: active, 3 stores', (select (l->>'status') = 'active' and (l->>'store_limit')::int = 3 from (select get_license(1) l) x));
reset role;
