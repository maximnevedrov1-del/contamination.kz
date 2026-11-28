-- 036: Supporter subscription (5 000 ₸/month, no ads). The subscription decides advertisements ONLY.
-- States, payment confirmation, duplicates, failures, cancellation, expiry, legacy customers, security.
\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values
  ('c0000000-0000-0000-0000-000000000001', 'free@example.kz'),
  ('c0000000-0000-0000-0000-000000000002', 'sup@example.kz'),
  ('c0000000-0000-0000-0000-000000000003', 'legacy@example.kz'),
  ('c0000000-0000-0000-0000-000000000004', 'other@example.kz'),
  ('c0000000-0000-0000-0000-000000000005', 'noterms@example.kz'),
  ('c0000000-0000-0000-0000-000000000009', 'boss@example.kz');
insert into public.admins values ('c0000000-0000-0000-0000-000000000009');
-- accounts are created through accept_terms() (as in test30); everyone but #5 accepts the offer. #5 only gets an account.
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000001', false) is not null; select accept_terms() is not null; reset role;
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', false) is not null; select accept_terms() is not null; reset role;
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000003', false) is not null; select accept_terms() is not null; reset role;
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000004', false) is not null; select accept_terms() is not null; reset role;
insert into public.accounts (user_id, trial_ends_at) values ('c0000000-0000-0000-0000-000000000005', now()) on conflict do nothing;
update accounts set trial_ends_at = now() - interval '90 days';
-- a legacy customer who PAID a whole period through an invoice, and a trial-only/referral account with paid_until but no paid invoice
update accounts set paid_until = now() + interval '40 days', store_limit = 7 where email = 'legacy@example.kz';
insert into public.invoices (user_id, kind, stores, months, amount, status, paid_at, period_from, period_to)
  values ('c0000000-0000-0000-0000-000000000003', 'manual', 7, 2, 40000, 'paid', now() - interval '20 days', now() - interval '20 days', now() + interval '40 days');
update accounts set paid_until = now() + interval '30 days' where email = 'other@example.kz';   -- referral/admin days, never paid

create temp table snap as select a.user_id, to_jsonb(a) - 'last_seen_at' - 'last_store_count' as acc, (select count(*) from invoices i where i.user_id = a.user_id) n_inv from accounts a where email = 'legacy@example.kz';

grant select on snap to public;

-- ===== defaults: free, payments off =====
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('free: status free, ads shown', (select e->>'status' = 'free' and (e->>'show_ads')::boolean and not (e->>'ad_free')::boolean from (select get_entitlements() e) x));
select pg_temp.ok('free: price 5000 KZT, never restricts functionality', (select (e->>'price_month')::int = 5000 and e->>'currency' = 'KZT' and not (e->>'restricts_functionality')::boolean from (select get_entitlements() e) x));
select pg_temp.ok('payments are OFF by default', (select not (get_entitlements()->>'payments_enabled')::boolean));
do $$ begin perform create_supporter_invoice(1); raise notice 'FAIL invoice while payments disabled'; exception when others then raise notice '% invoice refused while payments disabled (%)', case when sqlerrm = 'payments_disabled' then 'PASS' else 'FAIL' end, sqlerrm; end $$;
do $$ begin perform admin_set_supporter_payments(true); raise notice 'FAIL seller switches payments'; exception when others then raise notice '% seller cannot enable payments', case when sqlerrm = 'forbidden' then 'PASS' else 'FAIL' end; end $$;
-- free user: every business function still works (expired trial, no payment)
select pg_temp.ok('free: price-list feed allowed', (select ensure_price_feed('shop-free')->>'feed_id' is not null));
select pg_temp.ok('free: licence not zeroed', (select (get_license(1)->>'store_limit')::int >= 50 from (select 1) x));

-- ===== owner switch: refused without payment configuration (BLOCKED) =====
reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000009', false) is not null;
do $$ begin perform admin_set_supporter_payments(true); raise notice 'FAIL enabled without config'; exception when others then raise notice '% payments cannot be enabled without QR/instructions (%)', case when sqlerrm = 'payment_config_missing' then 'PASS' else 'FAIL' end, sqlerrm; end $$;
reset role; select pg_temp.ok('payments stay disabled after the refusal', not (select payments_enabled from supporter_config));
update billing_config set kaspi_qr_url = 'https://example.kz/qr.png';
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000009', false) is not null;
select pg_temp.ok('admin enables payments once configured', (admin_set_supporter_payments(true)->>'payments_enabled')::boolean);
reset role;
-- config removed again later → readiness follows the data, not the flag
update billing_config set kaspi_qr_url = null, payment_instructions = null;
select pg_temp.ok('flag on but config removed: payments not ready', not public.supporter_payments_ready());
update billing_config set kaspi_qr_url = 'https://example.kz/qr.png';

-- ===== activation =====
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', false) is not null;
do $$ begin perform create_supporter_invoice(0); raise notice 'FAIL 0 months'; exception when others then raise notice '% 0 months refused', case when sqlerrm = 'invalid_months' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform create_supporter_invoice(13); raise notice 'FAIL 13 months'; exception when others then raise notice '% 13 months refused', case when sqlerrm = 'invalid_months' then 'PASS' else 'FAIL' end; end $$;
select set_config('t.inv', create_supporter_invoice(1, '+7 701 222 3344')->>'id', false) is not null;
select pg_temp.ok('invoice: 5000 KZT, kind supporter, 1 month', (select amount = 5000 and kind = 'supporter' and months = 1 and status = 'pending' from invoices where id = current_setting('t.inv')::bigint));
select pg_temp.ok('same request again → same invoice (no duplicates)', create_supporter_invoice(1)->>'id' = current_setting('t.inv'));
select pg_temp.ok('client cannot see ads off yet: still free until paid', get_entitlements()->>'status' = 'free');
-- a different length replaces the open invoice, amount is server-computed
select set_config('t.inv3', create_supporter_invoice(3)->>'id', false) is not null;
select pg_temp.ok('3 months = 15000, old invoice cancelled', (select amount = 15000 from invoices where id = current_setting('t.inv3')::bigint) and (select status = 'cancelled' from invoices where id = current_setting('t.inv')::bigint));
select set_config('t.inv', create_supporter_invoice(1)->>'id', false) is not null;
select pg_temp.ok('only one open supporter invoice', (select count(*) = 1 from invoices where user_id = 'c0000000-0000-0000-0000-000000000002' and status = 'pending'));
-- clients cannot mark anything paid or grant themselves a period
do $$ begin update accounts set supporter_until = now() + interval '1 year' where user_id = auth.uid(); raise notice 'FAIL client wrote supporter_until'; exception when insufficient_privilege then raise notice 'PASS client cannot write supporter_until'; end $$;
do $$ begin update invoices set status = 'paid' where id = current_setting('t.inv')::bigint; raise notice 'FAIL client marked invoice paid'; exception when insufficient_privilege then raise notice 'PASS client cannot mark invoice paid'; end $$;
do $$ begin perform payment_received('generic', 'x', 5000, current_setting('t.inv')::bigint); raise notice 'FAIL client calls payment_received'; exception when insufficient_privilege then raise notice 'PASS client cannot call payment_received'; end $$;
do $$ begin perform payment_failed('generic', 'x', 5000, null); raise notice 'FAIL client calls payment_failed'; exception when insufficient_privilege then raise notice 'PASS client cannot call payment_failed'; end $$;
do $$ begin perform confirm_invoice_core(current_setting('t.inv')::bigint, 'x', null); raise notice 'FAIL client calls confirm_invoice_core'; exception when insufficient_privilege then raise notice 'PASS client cannot call confirm_invoice_core'; end $$;
do $$ begin perform confirm_legacy_invoice_core(current_setting('t.inv')::bigint, 'x', null); raise notice 'FAIL client calls legacy core'; exception when insufficient_privilege then raise notice 'PASS client cannot call the legacy core'; end $$;
reset role;
set role anon;
do $$ begin perform get_entitlements(); raise notice 'FAIL anon get_entitlements'; exception when insufficient_privilege then raise notice 'PASS anon cannot read entitlements'; end $$;
do $$ begin perform create_supporter_invoice(1); raise notice 'FAIL anon create'; exception when insufficient_privilege then raise notice 'PASS anon cannot create invoices'; end $$;
reset role;

-- offer not accepted
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000005', false) is not null;
do $$ begin perform create_supporter_invoice(1); raise notice 'FAIL no terms'; exception when others then raise notice '% invoice needs the accepted offer', case when sqlerrm = 'terms_required' then 'PASS' else 'FAIL' end; end $$;
reset role;

-- ===== provider notifications (service role) =====
select set_config('t.uid', 'c0000000-0000-0000-0000-000000000002', false) is not null;
set role service_role;
-- wrong amount: stored for review, no entitlement
select pg_temp.ok('wrong amount → review, nothing confirmed', (select r->>'outcome' = 'review' and r->>'reason' = 'amount_mismatch' from (select payment_received('generic', 'pay-wrong', 4999, current_setting('t.inv')::bigint) r) x));
-- provider says the payment failed: recorded, invoice stays open
select pg_temp.ok('failed payment recorded', (select r->>'outcome' = 'failed' and not (r->>'duplicate')::boolean from (select payment_failed('generic', 'pay-fail-1', 5000, current_setting('t.inv')::bigint) r) x));
select pg_temp.ok('failed payment: duplicate notification is a no-op', (select (r->>'duplicate')::boolean from (select payment_failed('generic', 'pay-fail-1', 5000, current_setting('t.inv')::bigint) r) x));
select pg_temp.ok('failed payment: unknown invoice does not crash', (select r->>'outcome' = 'failed' from (select payment_failed('generic', 'pay-fail-2', 5000, 999999) r) x));
reset role;
select pg_temp.ok('after failure/mismatch: invoice pending, no supporter period', (select status = 'pending' from invoices where id = current_setting('t.inv')::bigint) and (select supporter_until is null from accounts where user_id = current_setting('t.uid')::uuid));
set role service_role;
select pg_temp.ok('paid → confirmed', (select r->>'outcome' = 'confirmed' and not (r->>'duplicate')::boolean from (select payment_received('generic', 'pay-ok-1', 5000, current_setting('t.inv')::bigint) r) x));
select pg_temp.ok('duplicate notification (retry) → same answer, flagged duplicate', (select r->>'outcome' = 'confirmed' and (r->>'duplicate')::boolean from (select payment_received('generic', 'pay-ok-1', 5000, current_setting('t.inv')::bigint) r) x));
select pg_temp.ok('second payment id for the same, already paid invoice → review, not extended', (select r->>'outcome' = 'review' and r->>'reason' = 'invoice_not_pending' from (select payment_received('generic', 'pay-ok-2', 5000, current_setting('t.inv')::bigint) r) x));
reset role;
select pg_temp.ok('exactly one month granted (not 2)', (select supporter_until between now() + interval '27 days' and now() + interval '32 days' from accounts where user_id = current_setting('t.uid')::uuid));
select pg_temp.ok('invoice paid with period', (select status = 'paid' and period_to = (select supporter_until from accounts where user_id = current_setting('t.uid')::uuid) from invoices where id = current_setting('t.inv')::bigint));
select pg_temp.ok('events: 1 confirmed, 2 review, 2 failed rows, one per payment', (select count(*) filter (where outcome = 'confirmed') = 1 and count(*) filter (where outcome = 'review') = 2 and count(*) filter (where outcome = 'failed') = 2 and count(*) = 5 from payment_events));
select pg_temp.ok('supporter payment did not touch the business columns', (select paid_until is null and store_limit = 3 from accounts where user_id = current_setting('t.uid')::uuid));
select set_config('t.until1', (select supporter_until::text from accounts where user_id = current_setting('t.uid')::uuid), false) is not null;

set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', false) is not null;
select pg_temp.ok('supporter: no ads, status supporter', (select e->>'status' = 'supporter' and (e->>'ad_free')::boolean and not (e->>'show_ads')::boolean from (select get_entitlements() e) x));
select pg_temp.ok('supporter gets exactly the same functions as free (feed + access + limit)', (select ensure_price_feed('shop-sup')->>'feed_id' is not null) and (select (get_license(1)->>'store_limit')::int = 50 from (select 1) x));

-- ===== renewal stacks onto the end of the period =====
select set_config('t.inv2', create_supporter_invoice(2)->>'id', false) is not null;
reset role; set role service_role;
select pg_temp.ok('renewal paid → confirmed', (select r->>'outcome' = 'confirmed' from (select payment_received('generic', 'pay-ok-3', 10000, current_setting('t.inv2')::bigint) r) x));
reset role;
select pg_temp.ok('renewal adds 2 months to the existing end', (select supporter_until = current_setting('t.until1')::timestamptz + interval '2 months' from accounts where user_id = current_setting('t.uid')::uuid));

-- ===== cancellation =====
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', false) is not null;
select set_config('t.inv4', create_supporter_invoice(1)->>'id', false) is not null;
select pg_temp.ok('cancel: still ad-free until the end, marked ending', (select e->>'status' = 'supporter_ending' and (e->>'ad_free')::boolean and e->>'cancel_at' is not null from (select cancel_supporter() e) x));
select pg_temp.ok('cancel withdrew the open invoice', (select status = 'cancelled' from invoices where id = current_setting('t.inv4')::bigint));
select pg_temp.ok('resume clears the cancellation', (select e->>'status' = 'supporter' and e->>'cancel_at' is null from (select resume_supporter() e) x));
select cancel_supporter() is not null;
select set_config('t.inv5', create_supporter_invoice(1)->>'id', false) is not null;
reset role; set role service_role;
select payment_received('generic', 'pay-ok-4', 5000, current_setting('t.inv5')::bigint) is not null;
reset role;
select pg_temp.ok('paying again withdraws the cancellation', (select supporter_cancel_at is null from accounts where user_id = current_setting('t.uid')::uuid));

-- ===== expiration =====
update accounts set supporter_until = now() - interval '1 day', supporter_cancel_at = null where user_id = current_setting('t.uid')::uuid;
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', false) is not null;
select pg_temp.ok('expired supporter: ads back, status expired', (select e->>'status' = 'expired' and (e->>'show_ads')::boolean and not (e->>'ad_free')::boolean from (select get_entitlements() e) x));
select pg_temp.ok('expired supporter: every business function still works', (select ensure_price_feed('shop-sup2')->>'feed_id' is not null) and (select ensure_price_feed('shop-sup')->>'feed_id' is not null));
select pg_temp.ok('expired supporter: can subscribe again', (select (create_supporter_invoice(1)->>'amount')::int = 5000));
reset role;

-- ===== admin confirmation path =====
select set_config('t.aid', (select id::text from invoices where user_id = current_setting('t.uid')::uuid and status = 'pending'), false) is not null;
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000009', false) is not null;
select pg_temp.ok('admin confirms a supporter invoice with the displayed amount', (select admin_confirm_invoice(current_setting('t.aid')::bigint, 'bank transfer seen', 5000, 1)->>'status' = 'paid'));
do $$ begin perform admin_confirm_invoice(current_setting('t.aid')::bigint, 'again', 5000, 1); raise notice 'FAIL double confirm'; exception when others then raise notice '% second confirmation refused', case when sqlerrm = 'not_pending' then 'PASS' else 'FAIL' end; end $$;
reset role;
select pg_temp.ok('admin confirmation restored ads-off', (select supporter_until > now() + interval '27 days' from accounts where user_id = current_setting('t.uid')::uuid));

-- ===== legacy customers =====
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000003', false) is not null;
select pg_temp.ok('legacy paid period → ad-free until its end, nothing charged', (select e->>'status' = 'supporter' and (e->>'ad_free')::boolean and e->>'supporter_until' is null and (e->>'legacy_paid_until')::timestamptz > now() + interval '39 days' from (select get_entitlements() e) x));
select pg_temp.ok('legacy customer: reading entitlements created no invoice', (select count(*) = (select n_inv from snap) from invoices where user_id = auth.uid()));
select pg_temp.ok('legacy licence: store limit = operational cap', (select (get_license(1)->>'store_limit')::int = 50 from (select 1) x));
select pg_temp.ok('legacy: no automatic renewal invoice', ensure_renewal_invoice(7) is null);
reset role;
select pg_temp.ok('legacy account row bit-for-bit unchanged', (select to_jsonb(a) - 'last_seen_at' - 'last_store_count' = (select acc from snap) from accounts a where email = 'legacy@example.kz'));
-- the legacy period has run out → ads return, no charge happened
update invoices set period_to = now() - interval '1 day' where user_id = 'c0000000-0000-0000-0000-000000000003';
update accounts set paid_until = now() - interval '1 day' where email = 'legacy@example.kz';
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000003', false) is not null;
select pg_temp.ok('legacy period over → ads, still full functionality', (select e->>'status' = 'expired' and (e->>'show_ads')::boolean from (select get_entitlements() e) x) and (select ensure_price_feed('shop-leg')->>'feed_id' is not null));
reset role;
-- paid_until from a referral/admin grant (no paid invoice) is not an ads-off entitlement
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000004', false) is not null;
select pg_temp.ok('referral/admin days without a paid invoice do not switch ads off', (select e->>'status' = 'free' and (e->>'show_ads')::boolean from (select get_entitlements() e) x));

-- ===== isolation & coexistence with the legacy invoice =====
select set_config('t.inv_o', create_supporter_invoice(1)->>'id', false) is not null;
select pg_temp.ok('legacy create_invoice does not cancel the supporter invoice', (select (create_invoice(1, 1)->>'kind') = 'manual') and (select status = 'pending' from invoices where id = current_setting('t.inv_o')::bigint));
select pg_temp.ok('both open invoices coexist', (select count(*) = 2 from invoices where user_id = auth.uid() and status = 'pending'));
select pg_temp.ok('get_license still works with a legacy AND a supporter invoice open (reports only the legacy one)', (select l->'pending_invoice'->>'kind' = 'manual' from (select get_license(1) l) x));
select pg_temp.ok('pending_invoice in entitlements is own and supporter-only', get_entitlements()->'pending_invoice'->>'id' = current_setting('t.inv_o') and not (get_entitlements()->'pending_invoice' ? 'admin_note'));
select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('another tenant cannot cancel/see it (cancel_my_invoice by id is owner-only)', not cancel_my_invoice(current_setting('t.inv_o')::bigint));
select pg_temp.ok('another tenant: own entitlements only', get_entitlements()->'pending_invoice' = 'null'::jsonb);
select cancel_supporter() is not null;
reset role;
select pg_temp.ok('another tenant: cancel_supporter leaves others alone', (select status = 'pending' from invoices where id = current_setting('t.inv_o')::bigint));

-- ===== reversal of a confirmed payment, id collisions =====
set role service_role;
select pg_temp.ok('provider reports failure for an already CONFIRMED payment → admin review (reversed), entitlement untouched by it', (select r->>'outcome' = 'review' and r->>'reason' = 'reversed' from (select payment_failed('generic', 'pay-ok-1', 5000, null) r) x));
do $$ begin perform payment_received('generic', 'failed:pay-x', 5000, 1); raise notice 'FAIL payment id with the reserved prefix accepted'; exception when check_violation then raise notice 'PASS payment id with the reserved failed: prefix is refused'; end $$;
reset role;
select pg_temp.ok('reversal is queued for review with the confirmed invoice', (select count(*) = 1 from payment_events where outcome = 'review' and reason = 'reversed' and invoice_id = current_setting('t.inv')::bigint));

-- ===== phone-only path never confirms a supporter invoice on a typed phone =====
set role service_role;
select pg_temp.ok('phone-only match for an unverified phone → review (no guess)', (select r->>'outcome' = 'review' from (select payment_received('generic', 'pay-phone-1', 5000, null, '+77012223344') r) x));
reset role;
select pg_temp.ok('supporter_config readable only through functions', (select count(*) = 1 from supporter_config));
set role authenticated;
do $$ begin perform 1 from supporter_config; raise notice 'FAIL client reads supporter_config'; exception when insufficient_privilege then raise notice 'PASS supporter_config closed to clients'; end $$;
reset role;
