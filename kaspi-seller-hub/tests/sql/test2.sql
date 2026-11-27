-- 026: admin_confirm_invoice needs the expected amount/stores; cf() reads them from the invoice itself
create or replace function pg_temp.cf(p_id bigint, p_note text default null) returns jsonb language plpgsql security definer as $$ declare a int; s int; begin select amount, stores into a, s from public.invoices where id = p_id; return public.admin_confirm_invoice(p_id, p_note, a, s); end $$;
\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'big@example.kz'), ('88888888-8888-8888-8888-888888888888', 'boss@example.kz');
insert into public.admins values ('88888888-8888-8888-8888-888888888888');

-- Stage 03 (free access): invoices are never created automatically any more. What stays under test here is the explicit,
-- user-initiated payment path (create_invoice → admin confirm), its period arithmetic, and that status/limits are only history.
-- (The earlier automatic add-on / renewal / proration scenarios were removed together with that behaviour; test30 covers
-- the no-auto-billing guarantees and the legacy open-invoice cases.)

-- ===== trial, 30 days left =====
reset role; update accounts set trial_ends_at = now() + interval '30 days' where email = 'big@example.kz';
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('no renewal invoice 30 days before the end', ensure_renewal_invoice(3) is null);
select pg_temp.ok('4th store in trial → no add-on invoice (free access)', request_store_addon(4) is null);
select pg_temp.ok('45 stores → still nothing to pay, no limit from the plan', request_store_addon(45) is null and (select (l->>'store_limit')::int = 50 and l->>'status' = 'trial' from (select get_license(45) l) x));
select pg_temp.ok('no open invoice was created', (select count(*) = 0 from invoices));

-- ===== 4 days before the end → still no automatic renewal =====
reset role; update accounts set trial_ends_at = now() + interval '4 days' where email = 'big@example.kz';
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('renewal window: no automatic renewal invoice', ensure_renewal_invoice(45) is null);
select pg_temp.ok('renewal window: add-on request is a no-op too', request_store_addon(47) is null);
select pg_temp.ok('no open invoice was created in the renewal window', (select count(*) = 0 from invoices));

-- ===== explicit payment still works end to end =====
select accept_terms() is not null;
select pg_temp.ok('manual invoice without phone works', (select (i->>'amount')::int = billing_price(47, 1) and (i->>'kind') = 'manual' from (select create_invoice(47, 1, null) i) x));
select pg_temp.ok('open manual invoice is returned untouched by renewal/add-on calls', (select (ensure_renewal_invoice(47)->>'kind') = 'manual' and (request_store_addon(60)->>'kind') = 'manual' and (select count(*) = 1 from invoices where status = 'pending')));
select pg_temp.ok('phone normalized by set_my_phone', set_my_phone('+7 777 000 11 22') = '77770001122');
select pg_temp.ok('phone set later goes onto the open invoice', (select phone = '77770001122' from invoices where status = 'pending'));
do $$ begin perform set_my_phone('abc'); raise notice 'FAIL bad phone accepted'; exception when others then raise notice 'PASS bad phone rejected (%)', sqlerrm; end $$;

set request.jwt.claim.sub = '88888888-8888-8888-8888-888888888888';
select pg_temp.ok('invoice confirmed: paid period starts at the end of trial, +1 month', (select (r->>'period_from')::timestamptz > now() + interval '3 days' and (r->>'period_to')::timestamptz > (r->>'period_from')::timestamptz + interval '27 days' from (select pg_temp.cf((select (e->>'id')::bigint from jsonb_array_elements((admin_invoices('pending')->'rows')) e where e->>'email' = 'big@example.kz'), null) r) x));
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('active; paid stores 47 kept as history, access limit is the cap', (select l->>'status' = 'active' and (l->>'paid_store_limit')::int = 47 and (l->>'store_limit')::int = 50 from (select get_license(47) l) x));

-- ===== paid period with 10 days left: no prorated add-on =====
reset role; update accounts set paid_until = now() + interval '10 days', store_limit = 3 where email = 'big@example.kz';
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('2 extra stores in a paid period → nothing to pay', request_store_addon(5) is null);

-- ===== paid period over: grace, then expired — neither restricts anything =====
reset role; update accounts set paid_until = now() - interval '1 day', trial_ends_at = now() - interval '40 days', store_limit = 47 where email = 'big@example.kz';
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('paid period ended 1 day ago → grace (history), full access', (select l->>'status' = 'grace' and (l->>'store_limit')::int = 50 from (select get_license(47) l) x));
reset role; update accounts set paid_until = now() - interval '5 days' where email = 'big@example.kz';
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('expired: status expired (history), full access', (select l->>'status' = 'expired' and (l->>'store_limit')::int = 50 and (l->>'free_access')::boolean from (select get_license(47) l) x));
select pg_temp.ok('expired: renewal and add-on requests create nothing', ensure_renewal_invoice(47) is null and request_store_addon(47) is null);
select pg_temp.ok('expired: a voluntary manual payment still works', (select (i->>'amount')::int = billing_price(47, 1) from (select create_invoice(47, 1, null) i) x));
set request.jwt.claim.sub = '88888888-8888-8888-8888-888888888888';
select pg_temp.ok('confirm after expiry starts now', (select (r->>'period_from')::timestamptz between now() - interval '1 minute' and now() + interval '1 minute' from (select pg_temp.cf((select (e->>'id')::bigint from jsonb_array_elements((admin_invoices('pending')->'rows')) e where e->>'email' = 'big@example.kz'), null) r) x));
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('active again right after confirmation', (select l->>'status' = 'active' from (select get_license(47) l) x));
reset role;
