\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- 030: audit fixes — the retention discount covers one month per invoice and expires; a typed phone never confirms a payment
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
create or replace function pg_temp.as_user(id text) returns boolean language sql as $$ select set_config('request.jwt.claim.sub', id, false) is not null $$;
insert into auth.users (id, email) values
  ('d1000000-0000-0000-0000-00000000000a', 'victim@example.kz'),
  ('d1000000-0000-0000-0000-00000000000b', 'attacker@example.kz'),
  ('d1000000-0000-0000-0000-00000000000c', 'payer@example.kz');
update public.accounts set paid_until = now() + interval '20 days', store_limit = 3, terms_version = (select terms_version from billing_config);

-- ===== M-2: discount =====
set role authenticated; select pg_temp.as_user('d1000000-0000-0000-0000-00000000000c');
select pg_temp.ok('no discount: 12 months «Мульти» = 240 000', (select (i->>'amount')::int = 240000 from (select create_invoice(3, 12) i) x));
select pg_temp.ok('discount offer taken', (select (l->'discount'->>'pct')::int = 30 from (select cancel_flow('price', 'discount') l) x));
select pg_temp.ok('12 months with the offer: only the first month is −30 % (14 000 + 11 × 20 000 = 234 000)', (select (i->>'amount')::int = 234000 and (i->>'discount_pct')::int = 30 from (select create_invoice(3, 12) i) x));
select pg_temp.ok('1 month with the offer: 14 000', (select (i->>'amount')::int = 14000 from (select create_invoice(3, 1) i) x));
reset role;
select pg_temp.ok('the offer expires in 60 days', (select discount_until between now() + interval '59 days' and now() + interval '61 days' from accounts where email = 'payer@example.kz'));
update public.accounts set discount_until = now() - interval '1 minute' where email = 'payer@example.kz';
set role authenticated; select pg_temp.as_user('d1000000-0000-0000-0000-00000000000c');
select pg_temp.ok('expired offer: full price again', (select (i->>'amount')::int = 20000 from (select create_invoice(3, 1) i) x));
reset role;

-- ===== M-1: someone else's phone on my invoice does not steal the payment =====
set role authenticated; select pg_temp.as_user('d1000000-0000-0000-0000-00000000000b');
select create_invoice(3, 1, '+7 701 555 44 33') is not null;   -- the attacker types the victim's phone
select pg_temp.as_user('d1000000-0000-0000-0000-00000000000a');
select id as victim_inv from (select (create_invoice(3, 1)->>'id')::bigint id) x \gset
reset role;
set role service_role;
select pg_temp.ok('victim pays 20 000 by QR from +77015554433 (no invoice id) → review, not confirmed', (select r->>'outcome' = 'review' and r->>'reason' = 'phone_only' from (select payment_received('aipay', 'q1', 20000, null, '87015554433') r) x));
reset role;
select pg_temp.ok('the attacker''s invoice stayed unpaid', (select status = 'pending' from invoices i join accounts a using (user_id) where a.email = 'attacker@example.kz' and i.status <> 'cancelled'));
select pg_temp.ok('the review row names the candidate invoice for the admin', (select invoice_id is not null and reason = 'phone_only' from payment_events where payment_id = 'q1'));
set role service_role;
select pg_temp.ok('the same payment with our invoice id → confirmed', (select r->>'outcome' = 'confirmed' from (select payment_received('aipay', 'q2', 20000, :victim_inv) r) x));
reset role;
select pg_temp.ok('the victim''s invoice is paid', (select status = 'paid' from invoices where id = :victim_inv));
select pg_temp.ok('new reason is allowed by the check constraint', (select count(*) = 1 from payment_events where reason = 'phone_only'));
