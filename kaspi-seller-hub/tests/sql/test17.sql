-- 026: admin_confirm_invoice needs the expected amount/stores; cf() reads them from the invoice itself
create or replace function pg_temp.cf(p_id bigint, p_note text default null) returns jsonb language plpgsql security definer as $$ declare a int; s int; begin select amount, stores into a, s from public.invoices where id = p_id; return public.admin_confirm_invoice(p_id, p_note, a, s); end $$;
\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'ref@example.kz'),
  ('a0000000-0000-0000-0000-000000000002', 'friend@example.kz'),
  ('a0000000-0000-0000-0000-000000000004', 'ref2@example.kz'),
  ('a0000000-0000-0000-0000-000000000005', 'friend2@example.kz'),
  ('b0000000-0000-0000-0000-000000000001', 'boss@example.kz');
insert into public.admins values ('b0000000-0000-0000-0000-000000000001');
update accounts set referred_by = 'a0000000-0000-0000-0000-000000000001' where email = 'friend@example.kz';
update accounts set referred_by = 'a0000000-0000-0000-0000-000000000004', frozen_until = null where email = 'friend2@example.kz';
-- referrer 1: paid_until long expired
update accounts set paid_until = now() - interval '90 days', trial_ends_at = now() - interval '100 days' where email = 'ref@example.kz';
-- friend 1 is paid, then buys an add-on first
update accounts set paid_until = now() + interval '20 days', store_limit = 1 where email = 'friend@example.kz';
insert into invoices (user_id, kind, stores, months, amount) values ('a0000000-0000-0000-0000-000000000002', 'addon', 2, 0, 1000);
select set_config('test.inv1', (select max(id)::text from invoices), false) is not null;
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.cf(current_setting('test.inv1')::bigint) is not null;
reset role;
select pg_temp.ok('addon invoice: no referral reward', (select referrals_count = 0 and not (select referral_rewarded from accounts where email = 'friend@example.kz') from accounts where email = 'ref@example.kz'));
-- first subscription invoice after the add-on: reward, expired paid_until -> now()+14d
insert into invoices (user_id, kind, stores, months, amount) values ('a0000000-0000-0000-0000-000000000002', 'manual', 2, 1, 10000);
select set_config('test.inv2', (select max(id)::text from invoices), false) is not null;
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.cf(current_setting('test.inv2')::bigint) is not null;
reset role;
select pg_temp.ok('subscription after addon: reward, expired paid_until -> now()+14d', (select referrals_count = 1 and abs(extract(epoch from paid_until - (now() + interval '14 days'))) < 10 from accounts where email = 'ref@example.kz'));
-- frozen referrer: no reward
update accounts set frozen_until = now() + interval '10 days' where email = 'ref2@example.kz';
insert into invoices (user_id, kind, stores, months, amount) values ('a0000000-0000-0000-0000-000000000005', 'manual', 1, 1, 10000);
select set_config('test.inv3', (select max(id)::text from invoices), false) is not null;
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.cf(current_setting('test.inv3')::bigint) is not null;
reset role;
select pg_temp.ok('frozen referrer: no reward, no outbox', (select referrals_count = 0 and referral_bonus_days = 0 from accounts where email = 'ref2@example.kz'));
select pg_temp.ok('frozen referrer: friend still marked rewarded', (select referral_rewarded from accounts where email = 'friend2@example.kz'));
-- non-admin cannot confirm
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
do $$ begin perform pg_temp.cf(1); raise notice 'FAIL non-admin confirmed'; exception when others then raise notice '% non-admin forbidden (%)', case when sqlerrm = 'forbidden' then 'PASS' else 'FAIL' end, sqlerrm; end $$;
-- column privileges on invoices
do $$ begin perform admin_note from invoices; raise notice 'FAIL seller read admin_note'; exception when others then raise notice 'PASS seller cannot read admin_note (%)', sqlerrm; end $$;
do $$ begin perform confirmed_by from invoices; raise notice 'FAIL seller read confirmed_by'; exception when others then raise notice 'PASS seller cannot read confirmed_by (%)', sqlerrm; end $$;
select pg_temp.ok('seller reads own invoice columns', (select count(*) >= 1 from (select id, status, amount, kind from invoices) x));
reset role;
set role anon;
do $$ begin perform 1 from tg_outbox; raise notice 'FAIL anon read tg_outbox'; exception when others then raise notice 'PASS anon cannot read tg_outbox'; end $$;
reset role;
set role authenticated;
do $$ begin perform 1 from tg_outbox; raise notice 'FAIL auth read tg_outbox'; exception when others then raise notice 'PASS authenticated cannot read tg_outbox'; end $$;
do $$ begin perform gen_referral_code(); raise notice 'FAIL auth ran gen_referral_code'; exception when others then raise notice 'PASS authenticated cannot run gen_referral_code'; end $$;
reset role;
