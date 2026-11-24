\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'ref@example.kz'),
  ('a0000000-0000-0000-0000-000000000002', 'friend@example.kz'),
  ('b0000000-0000-0000-0000-000000000001', 'boss@example.kz');
insert into public.admins values ('b0000000-0000-0000-0000-000000000001');
update accounts set referred_by = 'a0000000-0000-0000-0000-000000000001' where email = 'friend@example.kz';
insert into invoices (user_id, kind, stores, months, amount) values ('a0000000-0000-0000-0000-000000000002', 'manual', 1, 1, 10000);
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select set_config('t.inv', admin_invoices('pending')::text, false) is not null;
select set_config('t.acc', admin_accounts()::text, false) is not null;
reset role;
select pg_temp.ok('admin_invoices: referral fields', (select (r->>'referred')::bool and r->>'referrer_email' = 'ref@example.kz' and (r->>'referral_will_reward')::bool and not (r->>'referral_rewarded')::bool from jsonb_array_elements(current_setting('t.inv')::jsonb->'rows') r limit 1));
select pg_temp.ok('admin_accounts: referred friend', (select (r->>'referred')::bool and r->>'referrer_email' = 'ref@example.kz' from jsonb_array_elements(current_setting('t.acc')::jsonb->'rows') r where r->>'email' = 'friend@example.kz'));
select pg_temp.ok('admin_accounts: referrer code/count/bonus', (select r->>'referral_code' is not null and r->>'referrals_count' = '0' and r->>'referral_bonus_days' = '0' from jsonb_array_elements(current_setting('t.acc')::jsonb->'rows') r where r->>'email' = 'ref@example.kz'));
update accounts set frozen_until = now() + interval '5 days' where email = 'ref@example.kz';
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.ok('frozen referrer: will_reward false', (select not (r->>'referral_will_reward')::bool from jsonb_array_elements(admin_invoices('pending')->'rows') r limit 1));
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
do $$ begin perform admin_invoices('pending'); raise notice 'FAIL non-admin admin_invoices'; exception when insufficient_privilege then raise notice 'PASS non-admin admin_invoices forbidden'; end $$;
do $$ begin perform admin_accounts(); raise notice 'FAIL non-admin admin_accounts'; exception when insufficient_privilege then raise notice 'PASS non-admin admin_accounts forbidden'; end $$;
reset role;
