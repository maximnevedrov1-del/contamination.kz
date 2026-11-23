-- 026: admin_confirm_invoice needs the expected amount/stores; cf() reads them from the invoice itself
create or replace function pg_temp.cf(p_id bigint, p_note text default null) returns jsonb language plpgsql security definer as $$ declare a int; s int; begin select amount, stores into a, s from public.invoices where id = p_id; return public.admin_confirm_invoice(p_id, p_note, a, s); end $$;
\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'ref@example.kz'),
  ('a0000000-0000-0000-0000-000000000002', 'friend@example.kz'),
  ('a0000000-0000-0000-0000-000000000003', 'old@example.kz'),
  ('b0000000-0000-0000-0000-000000000001', 'boss@example.kz');
insert into public.admins values ('b0000000-0000-0000-0000-000000000001');
update accounts set created_at = now() - interval '10 days' where email = 'old@example.kz';
insert into tg_links (user_id, chat_id) values ('a0000000-0000-0000-0000-000000000001', 111);
select pg_temp.ok('codes auto-generated, format SP-XXXXXX', (select count(*) = 4 and bool_and(referral_code ~ '^SP-[A-Z0-9]{6}$') from accounts));
select pg_temp.ok('codes unique', (select count(distinct referral_code) = 4 from accounts));
select pg_temp.ok('no look-alike chars', (select bool_and(substr(referral_code, 4) !~ '[01IO]') from accounts));
select set_config('test.code', (select referral_code from accounts where email = 'ref@example.kz'), false) is not null;
select set_config('test.trial', (select trial_ends_at::text from accounts where email = 'friend@example.kz'), false) is not null;

set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select pg_temp.ok('my_referral: can_apply, not applied', (select (r->>'can_apply')::boolean and not (r->>'applied')::boolean and r->>'code' ~ '^SP-' from (select my_referral() r) x));
do $$ begin perform apply_referral_code('SP-ZZZZZZ'); raise notice 'FAIL unknown code accepted'; exception when others then raise notice '% invalid_code (%)', case when sqlerrm = 'invalid_code' then 'PASS' else 'FAIL' end, sqlerrm; end $$;
do $$ begin perform apply_referral_code('garbage'); raise notice 'FAIL garbage accepted'; exception when others then raise notice '% garbage -> invalid_code (%)', case when sqlerrm = 'invalid_code' then 'PASS' else 'FAIL' end, sqlerrm; end $$;
do $$ begin perform apply_referral_code((select referral_code from accounts where user_id = auth.uid())); raise notice 'FAIL self referral'; exception when others then raise notice '% self_referral (%)', case when sqlerrm = 'self_referral' then 'PASS' else 'FAIL' end, sqlerrm; end $$;
select pg_temp.ok('apply valid code (lower case, spaces) ok', (select (r->>'ok')::boolean and (r->>'bonus_days')::int = 7 from (select apply_referral_code(' ' || lower(current_setting('test.code')) || ' ') r) x));
select pg_temp.ok('trial +7 days, referred_by set', (select trial_ends_at = current_setting('test.trial')::timestamptz + interval '7 days' and referred_by = 'a0000000-0000-0000-0000-000000000001' and referred_at is not null from accounts where user_id = auth.uid()));
do $$ begin perform apply_referral_code(current_setting('test.code')); raise notice 'FAIL applied twice'; exception when others then raise notice '% already_referred (%)', case when sqlerrm = 'already_referred' then 'PASS' else 'FAIL' end, sqlerrm; end $$;
do $$ begin update accounts set referral_bonus_days = 999; raise notice 'FAIL client updated accounts'; exception when others then raise notice 'PASS client cannot update accounts (%)', sqlerrm; end $$;
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000003';
select pg_temp.ok('my_referral: old account cannot apply', (select not (r->>'can_apply')::boolean from (select my_referral() r) x));
do $$ begin perform apply_referral_code(current_setting('test.code')); raise notice 'FAIL too late accepted'; exception when others then raise notice '% too_late (%)', case when sqlerrm = 'too_late' then 'PASS' else 'FAIL' end, sqlerrm; end $$;
reset role;
set role anon;
do $$ begin perform apply_referral_code(current_setting('test.code')); raise notice 'FAIL anon executed'; exception when others then raise notice 'PASS anon cannot execute (%)', sqlerrm; end $$;
reset role;

-- rewards
insert into invoices (user_id, kind, stores, months, amount) values
  ('a0000000-0000-0000-0000-000000000002', 'manual', 1, 1, 10000);
select set_config('test.inv1', (select max(id)::text from invoices), false) is not null;
select set_config('test.before', (select greatest(now(), coalesce(paid_until, now()), trial_ends_at)::text from accounts where email = 'ref@example.kz'), false) is not null;
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.cf(current_setting('test.inv1')::bigint) is not null;
reset role;
select pg_temp.ok('referrer paid_until +14d', (select abs(extract(epoch from paid_until - (current_setting('test.before')::timestamptz + interval '14 days'))) < 5 from accounts where email = 'ref@example.kz'));
select pg_temp.ok('referrer counters 1 / 14', (select referrals_count = 1 and referral_bonus_days = 14 from accounts where email = 'ref@example.kz'));
select pg_temp.ok('payer referral_rewarded', (select referral_rewarded from accounts where email = 'friend@example.kz'));
select pg_temp.ok('outbox row created', (select count(*) = 1 and bool_and(kind = 'referral' and (payload->>'days')::int = 14 and sent_at is null) from tg_outbox where user_id = 'a0000000-0000-0000-0000-000000000001'));
update ops_settings set bot_key_hash = encode(sha256(convert_to(repeat('k', 32), 'utf8')), 'hex') where id = 1;
select pg_temp.ok('bot_jobs returns referral item', (select exists (select 1 from jsonb_array_elements(bot_jobs(repeat('k', 32))->'items') i where i->>'kind' = 'referral' and (i->>'chat_id')::bigint = 111)) );
insert into invoices (user_id, kind, stores, months, amount) values ('a0000000-0000-0000-0000-000000000002', 'manual', 1, 1, 10000);
select set_config('test.inv2', (select max(id)::text from invoices), false) is not null;
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.cf(current_setting('test.inv2')::bigint) is not null;
reset role;
select pg_temp.ok('second invoice: no extra reward', (select referrals_count = 1 and referral_bonus_days = 14 and abs(extract(epoch from paid_until - (current_setting('test.before')::timestamptz + interval '14 days'))) < 5 from accounts where email = 'ref@example.kz'));
select pg_temp.ok('second invoice: no extra outbox', (select count(*) = 1 from tg_outbox));
