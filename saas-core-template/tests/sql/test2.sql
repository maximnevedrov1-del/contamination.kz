\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'big@example.kz'), ('88888888-8888-8888-8888-888888888888', 'boss@example.kz');
insert into public.admins values ('88888888-8888-8888-8888-888888888888');

-- ===== trial, 30 days left =====
reset role; update accounts set trial_ends_at = now() + interval '30 days' where email = 'big@example.kz';
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('no renewal invoice 30 days before the end', ensure_renewal_invoice(3) is null);
select pg_temp.ok('4th store in trial → add-on 5 000 {{CURRENCY_SYMBOL}} (30 days left)', (select i->>'kind' = 'addon' and (i->>'amount')::int = 5000 and (i->>'stores')::int = 4 and (i->>'months')::int = 0 from (select request_store_addon(4) i) x));
select pg_temp.ok('45 stores → same add-on updated to 42 × 5 000 = 210 000', (select (i->>'amount')::int = 210000 and (i->>'stores')::int = 45 from (select request_store_addon(45) i) x));
select pg_temp.ok('still exactly one open invoice', (select count(*) = 1 from invoices where status = 'pending'));
select pg_temp.ok('stores already covered → nothing to pay (returns the open one)', (select (i->>'stores')::int = 45 from (select request_store_addon(3) i) x));
select pg_temp.ok('licence shows the add-on with remind_days and coverage_end', (select l->'pending_invoice'->>'kind' = 'addon' and (l->>'remind_days')::int = 5 and l->>'coverage_end' is not null from (select get_license(45) l) x));

-- admin confirms add-on → 45 stores now, end date unchanged
set request.jwt.claim.sub = '88888888-8888-8888-8888-888888888888';
select pg_temp.ok('admin confirms add-on', (select r->>'status' = 'paid' from (select admin_confirm_invoice((select (e->>'id')::bigint from jsonb_array_elements((admin_invoices('pending')->'rows')) e where e->>'email' = 'big@example.kz'), 'addon') r) x));
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('after add-on: trial, 45 stores, paid_until still empty', (select l->>'status' = 'trial' and (l->>'store_limit')::int = 45 and l->>'paid_until' is null from (select get_license(45) l) x));

-- ===== 4 days before the end → one renewal invoice for ALL stores =====
reset role; update accounts set trial_ends_at = now() + interval '4 days' where email = 'big@example.kz';
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('renewal for 45 stores = 20 000 + 42 × 5 000 = 230 000', (select i->>'kind' = 'renewal' and (i->>'amount')::int = 230000 and (i->>'stores')::int = 45 and (i->>'months')::int = 1 from (select ensure_renewal_invoice(45) i) x));
select pg_temp.ok('renewal is idempotent (same id)', (select count(*) = 1 from invoices where status = 'pending' and kind = 'renewal') and (select (ensure_renewal_invoice(45)->>'id') = (select id::text from invoices where status = 'pending')));
select pg_temp.ok('store added in the renewal window → SAME invoice, 47 stores = 240 000', (select i->>'kind' = 'renewal' and (i->>'amount')::int = 240000 and (i->>'stores')::int = 47 from (select request_store_addon(47) i) x));
select pg_temp.ok('one open invoice, one amount, one QR', (select count(*) = 1 from invoices where status = 'pending'));
select pg_temp.ok('phone normalized by set_my_phone', set_my_phone('+7 777 000 11 22') = '77770001122');
select pg_temp.ok('phone set later goes onto the open invoice', (select phone = '77770001122' from invoices where status = 'pending'));
do $$ begin perform set_my_phone('abc'); raise notice 'FAIL bad phone accepted'; exception when others then raise notice 'PASS bad phone rejected (%)', sqlerrm; end $$;

set request.jwt.claim.sub = '88888888-8888-8888-8888-888888888888';
select pg_temp.ok('renewal confirmed: paid period starts at the end of trial, +1 month', (select (r->>'period_from')::timestamptz > now() + interval '3 days' and (r->>'period_to')::timestamptz > (r->>'period_from')::timestamptz + interval '27 days' from (select admin_confirm_invoice((select (e->>'id')::bigint from jsonb_array_elements((admin_invoices('pending')->'rows')) e where e->>'email' = 'big@example.kz'), null) r) x));
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('active, 47 stores', (select l->>'status' = 'active' and (l->>'store_limit')::int = 47 from (select get_license(47) l) x));

-- ===== prorated add-on in a paid period with 15 days left =====
reset role; update accounts set paid_until = now() + interval '15 days', store_limit = 3 where email = 'big@example.kz';
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('2 extra stores, 15 days left → 2 × 5 000 × 15/30 = 5 000', (select (i->>'amount')::int = 5000 and i->>'kind' = 'addon' from (select request_store_addon(5) i) x));
reset role; update invoices set status = 'cancelled' where status = 'pending';
update accounts set paid_until = now() + interval '10 days' where email = 'big@example.kz';
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('1 extra store, 10 days left → 5 000 × 10/30 = 1 667 → rounded up to 1 700', (select (i->>'amount')::int = 1700 from (select request_store_addon(4) i) x));

-- ===== expired → renewal for all stores, confirm → active from now =====
reset role; update invoices set status = 'cancelled' where status = 'pending';
update accounts set paid_until = now() - interval '1 day', trial_ends_at = now() - interval '40 days', store_limit = 47 where email = 'big@example.kz';
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('paid period ended 1 day ago → grace: still works with 47 stores', (select l->>'status' = 'grace' and (l->>'store_limit')::int = 47 from (select get_license(47) l) x));
reset role; update accounts set paid_until = now() - interval '5 days' where email = 'big@example.kz';
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('expired: status expired', (select l->>'status' = 'expired' and (l->>'store_limit')::int = 0 from (select get_license(47) l) x));
select pg_temp.ok('expired: add-on request becomes the renewal for all 47 stores', (select i->>'kind' = 'renewal' and (i->>'amount')::int = 240000 from (select request_store_addon(47) i) x));
set request.jwt.claim.sub = '88888888-8888-8888-8888-888888888888';
select pg_temp.ok('confirm after expiry starts now', (select (r->>'period_from')::timestamptz between now() - interval '1 minute' and now() + interval '1 minute' from (select admin_confirm_invoice((select (e->>'id')::bigint from jsonb_array_elements((admin_invoices('pending')->'rows')) e where e->>'email' = 'big@example.kz'), null) r) x));
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('active again right after confirmation', (select l->>'status' = 'active' from (select get_license(47) l) x));
select accept_terms() is not null;
select pg_temp.ok('manual invoice without phone works', (select (i->>'amount')::int = billing_price(3, 1) from (select create_invoice(3, 1, null) i) x));
select pg_temp.ok('renewal window keeps a client-chosen manual plan', (select ensure_renewal_invoice(47) is null or (ensure_renewal_invoice(47)->>'kind') in ('manual')));
reset role;
