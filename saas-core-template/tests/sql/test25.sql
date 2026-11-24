\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- 028: automatic payment confirmation (payment_received), review queue, refactored admin_confirm_invoice
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'u1@example.kz'),
  ('a0000000-0000-0000-0000-000000000002', 'u2@example.kz'),
  ('a0000000-0000-0000-0000-000000000003', 'u3@example.kz'),
  ('a0000000-0000-0000-0000-000000000004', 'u4@example.kz'),
  ('a0000000-0000-0000-0000-000000000005', 'u5@example.kz'),
  ('a0000000-0000-0000-0000-000000000006', 'u6@example.kz'),
  ('b0000000-0000-0000-0000-000000000001', 'boss@example.kz');
insert into public.admins values ('b0000000-0000-0000-0000-000000000001');
insert into public.accounts (user_id, trial_ends_at)
select ('a0000000-0000-0000-0000-00000000000' || i)::uuid, now() + interval '10 days' from generate_series(1, 6) i on conflict do nothing;
insert into public.invoices (id, user_id, kind, stores, months, amount, phone, status) overriding system value values
  (8001, 'a0000000-0000-0000-0000-000000000001', 'manual', 3, 1, 12000, '77011111111', 'pending'),
  (8002, 'a0000000-0000-0000-0000-000000000002', 'manual', 2, 3, 24000, '77022222222', 'pending'),
  (8003, 'a0000000-0000-0000-0000-000000000003', 'manual', 1, 1, 5000, '77033333333', 'pending'),
  (8004, 'a0000000-0000-0000-0000-000000000004', 'manual', 1, 1, 5000, '77044444444', 'pending'),
  (8005, 'a0000000-0000-0000-0000-000000000006', 'renewal', 1, 1, 5000, '77044444444', 'pending'),
  (8006, 'a0000000-0000-0000-0000-000000000005', 'manual', 1, 1, 5000, '77055555555', 'cancelled'),
  (8007, 'a0000000-0000-0000-0000-000000000005', 'manual', 1, 1, 5000, '77055555555', 'pending');

-- ===== who may call =====
set role anon;
do $$ begin perform payment_received('aipay', 'p0', 12000, 8001); raise notice 'FAIL anon payment_received'; exception when insufficient_privilege then raise notice 'PASS anon cannot call payment_received'; end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ begin perform payment_received('aipay', 'p0', 12000, 8001); raise notice 'FAIL seller confirms own invoice'; exception when insufficient_privilege then raise notice 'PASS seller cannot call payment_received'; end $$;
do $$ begin perform confirm_invoice_core(8001, 'x', null); raise notice 'FAIL seller calls core'; exception when insufficient_privilege then raise notice 'PASS seller cannot call confirm_invoice_core'; end $$;
do $$ begin perform 1 from payment_events; raise notice 'FAIL seller reads payment_events'; exception when insufficient_privilege then raise notice 'PASS payment_events closed to sellers'; end $$;
do $$ begin perform admin_payment_events(); raise notice 'FAIL seller reads queue'; exception when others then raise notice '% seller cannot read the queue', case when sqlerrm = 'forbidden' then 'PASS' else 'FAIL' end; end $$;
reset role;
select pg_temp.ok('nothing changed by refused calls', (select status from invoices where id = 8001) = 'pending' and not exists (select 1 from payment_events));

-- ===== bad input =====
set role service_role;
do $$ begin perform payment_received('Ai Pay', 'p1', 100); raise notice 'FAIL bad provider'; exception when others then raise notice '% bad provider rejected', case when sqlerrm = 'invalid_payment' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform payment_received('aipay', '', 100); raise notice 'FAIL empty id'; exception when others then raise notice '% empty payment id rejected', case when sqlerrm = 'invalid_payment' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform payment_received('aipay', 'p1', 0); raise notice 'FAIL zero amount'; exception when others then raise notice '% zero amount rejected', case when sqlerrm = 'invalid_payment' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform payment_received('aipay', 'p1', -5); raise notice 'FAIL negative amount'; exception when others then raise notice '% negative amount rejected', case when sqlerrm = 'invalid_payment' then 'PASS' else 'FAIL' end; end $$;

-- ===== by invoice id: exact amount → paid =====
select pg_temp.ok('invoice id + exact amount → confirmed', (payment_received('aipay', 'p100', 12000, 8001))->>'outcome' = 'confirmed');
reset role;
select pg_temp.ok('invoice 8001 paid, period set, auto note', (select status = 'paid' and period_to > now() + interval '25 days' and admin_note like 'auto: aipay p100%' and confirmed_by is null from invoices where id = 8001));
select pg_temp.ok('account extended and store limit set', (select paid_until > now() + interval '25 days' and store_limit = 3 from accounts where user_id = 'a0000000-0000-0000-0000-000000000001'));

-- ===== retry of the same payment changes nothing =====
set role service_role;
select pg_temp.ok('same payment again → duplicate, same outcome', (select r->>'outcome' = 'confirmed' and (r->>'duplicate')::boolean from (select payment_received('aipay', 'p100', 12000, 8001) r) x));
reset role;
select pg_temp.ok('one event row per payment', (select count(*) from payment_events where payment_id = 'p100') = 1);
select pg_temp.ok('period not extended twice (trial end + 1 month, not + 2)', (select paid_until < now() + interval '45 days' from accounts where user_id = 'a0000000-0000-0000-0000-000000000001'));

-- ===== second, different payment for an already paid invoice → review =====
set role service_role;
select pg_temp.ok('second payment for paid invoice → review invoice_not_pending', (select r->>'outcome' = 'review' and r->>'reason' = 'invoice_not_pending' from (select payment_received('aipay', 'p101', 12000, 8001) r) x));

-- ===== amount must match to the tenge =====
select pg_temp.ok('underpaid → review amount_mismatch', (select r->>'reason' = 'amount_mismatch' from (select payment_received('aipay', 'p200', 23999, 8002) r) x));
select pg_temp.ok('overpaid → review amount_mismatch', (select r->>'reason' = 'amount_mismatch' from (select payment_received('aipay', 'p201', 24001, 8002) r) x));
reset role;
select pg_temp.ok('mismatched amounts left the invoice pending', (select status from invoices where id = 8002) = 'pending');

-- ===== unknown invoice id =====
set role service_role;
select pg_temp.ok('unknown invoice id → review invoice_not_found', (select r->>'reason' = 'invoice_not_found' from (select payment_received('aipay', 'p300', 5000, 999999) r) x));

-- ===== by phone + amount =====
select pg_temp.ok('phone in any format + amount, one pending invoice → confirmed', (payment_received('aipay', 'p400', 5000, null, '8 (703) 333-33-33'))->>'outcome' = 'confirmed');
reset role;
select pg_temp.ok('invoice 8003 paid by phone match', (select status from invoices where id = 8003) = 'paid');
set role service_role;
select pg_temp.ok('two pending invoices (two accounts, one phone) with this amount → review ambiguous', (select r->>'reason' = 'ambiguous' from (select payment_received('aipay', 'p500', 5000, null, '+77044444444') r) x));
select pg_temp.ok('cancelled invoice is ignored, the pending one matches', (payment_received('aipay', 'p600', 5000, null, '77055555555'))->>'outcome' = 'confirmed');
select pg_temp.ok('phone with no invoice → review no_match', (select r->>'reason' = 'no_match' from (select payment_received('aipay', 'p700', 5000, null, '77099999999') r) x));
select pg_temp.ok('no phone and no invoice id → review no_match', (select r->>'reason' = 'no_match' from (select payment_received('aipay', 'p701', 5000) r) x));
select pg_temp.ok('phone matches but amount differs → no_match', (select r->>'reason' = 'no_match' from (select payment_received('aipay', 'p702', 24500, null, '77022222222') r) x));
select pg_temp.ok('same payment id from another provider is a different payment', (select r->>'duplicate' = 'false' from (select payment_received('generic', 'p100', 5000) r) x));
reset role;
select pg_temp.ok('ambiguous invoices both still pending', (select count(*) from invoices where id in (8004, 8005) and status = 'pending') = 2);
select pg_temp.ok('cancelled invoice stayed cancelled', (select status from invoices where id = 8006) = 'cancelled' and (select status from invoices where id = 8007) = 'paid');

-- ===== admin review queue =====
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.ok('queue lists only review events', (select bool_and(e->>'outcome' = 'review') and count(*) = 9 from jsonb_array_elements(admin_payment_events()) e));
select pg_temp.ok('full history lists all 12 events', jsonb_array_length(admin_payment_events(false)) = 12);
select pg_temp.ok('queue shows the invoice amount next to the paid amount', (select (e->>'invoice_amount')::int = 24000 from jsonb_array_elements(admin_payment_events()) e where e->>'payment_id' = 'p200'));
reset role;
select id as ev200 from payment_events where payment_id = 'p200' \gset
select id as ev100 from payment_events where payment_id = 'p100' and provider = 'aipay' \gset
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.ok('resolve an event', (admin_resolve_payment_event(:ev200, 'client paid 1 tenge less, confirmed by hand'))->>'outcome' = 'resolved');
set t.ev200 = :ev200; set t.ev100 = :ev100;
do $$ begin perform admin_resolve_payment_event(current_setting('t.ev200')::bigint); raise notice 'FAIL resolved twice'; exception when others then raise notice '% resolved event cannot be resolved again', case when sqlerrm = 'not_found' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform admin_resolve_payment_event(current_setting('t.ev100')::bigint); raise notice 'FAIL confirmed event resolved'; exception when others then raise notice '% confirmed event is not in the queue', case when sqlerrm = 'not_found' then 'PASS' else 'FAIL' end; end $$;
select pg_temp.ok('queue now 8', jsonb_array_length(admin_payment_events()) = 8);

-- ===== refactored admin_confirm_invoice still works and keeps its checks =====
do $$ begin perform admin_confirm_invoice(8002, null, 1, 2); raise notice 'FAIL stale amount'; exception when others then raise notice '% admin confirm still checks the amount', case when sqlerrm = 'amount_changed' then 'PASS' else 'FAIL' end; end $$;
select pg_temp.ok('admin confirm by hand after review', (admin_confirm_invoice(8002, 'checked', 24000, 2))->>'status' = 'paid');
reset role;
select pg_temp.ok('admin confirm records the admin', (select confirmed_by = 'b0000000-0000-0000-0000-000000000001' and months = 3 and period_to > now() + interval '85 days' from invoices where id = 8002));
select pg_temp.ok('core is not executable by authenticated', not has_function_privilege('authenticated', 'public.confirm_invoice_core(bigint,text,uuid)', 'execute'));
select pg_temp.ok('payment_received executable only by service_role', has_function_privilege('service_role', 'public.payment_received(text,text,int,bigint,text)', 'execute') and not has_function_privilege('authenticated', 'public.payment_received(text,text,int,bigint,text)', 'execute') and not has_function_privilege('anon', 'public.payment_received(text,text,int,bigint,text)', 'execute'));
