\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values ('a0000000-0000-0000-0000-000000000001', 'first@example.kz'), ('a0000000-0000-0000-0000-000000000002', 'second@example.kz'),
  ('a0000000-0000-0000-0000-000000000003', 'third@example.kz'), ('a0000000-0000-0000-0000-000000000004', 'payer@example.kz');
-- store keys = sha256 of Kaspi store ids
\set k1 '''' `printf ksh:1001 | sha256sum | cut -c1-64` ''''
\set k2 '''' `printf ksh:1002 | sha256sum | cut -c1-64` ''''
\set k3 '''' `printf ksh:1003 | sha256sum | cut -c1-64` ''''

-- ===== direct access with Supabase default grants =====
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ begin perform public.custom_access_token_hook('{"user_id":"a0000000-0000-0000-0000-000000000004","claims":{}}'); raise notice 'FAIL client can call the token hook (reads other accounts)'; exception when others then raise notice 'PASS client cannot call the token hook (%)', sqlerrm; end $$;
do $$ begin perform public.check_invoice_rate('a0000000-0000-0000-0000-000000000001'); raise notice 'FAIL helper callable'; exception when others then raise notice 'PASS internal helpers not callable (%)', sqlerrm; end $$;
do $$ begin perform public.ensure_account(); raise notice 'FAIL ensure_account callable'; exception when others then raise notice 'PASS ensure_account not callable directly (%)', sqlerrm; end $$;
do $$ begin update public.accounts set paid_until = now() + interval '10 years'; if found then raise notice 'FAIL client extended own subscription'; else raise notice 'PASS update of accounts touches nothing'; end if; exception when others then raise notice 'PASS no direct account update (%)', sqlerrm; end $$;
do $$ begin insert into public.admins values ('a0000000-0000-0000-0000-000000000001'); raise notice 'FAIL client made itself admin'; exception when others then raise notice 'PASS cannot become admin (%)', sqlerrm; end $$;
do $$ begin update public.billing_config set base_price = 1; if found then raise notice 'FAIL client changed prices'; else raise notice 'PASS prices untouched'; end if; exception when others then raise notice 'PASS cannot change prices (%)', sqlerrm; end $$;
do $$ begin insert into public.invoices (user_id, kind, stores, months, amount) values ('a0000000-0000-0000-0000-000000000001', 'manual', 3, 1, 1); raise notice 'FAIL client wrote an invoice with its own amount'; exception when others then raise notice 'PASS cannot insert invoices (%)', sqlerrm; end $$;
do $$ begin update public.invoices set status = 'paid'; if found then raise notice 'FAIL client marked invoice paid'; else raise notice 'PASS invoice status untouched'; end if; exception when others then raise notice 'PASS cannot mark invoices paid (%)', sqlerrm; end $$;
do $$ begin insert into public.store_claims values (repeat('a', 64), 'a0000000-0000-0000-0000-000000000002'); raise notice 'FAIL client planted a store claim'; exception when others then raise notice 'PASS cannot plant store claims (%)', sqlerrm; end $$;

-- ===== one trial per store =====
select pg_temp.ok('first account claims stores 1001+1002, keeps trial', (select l->>'status' = 'trial' and not (l->>'trial_blocked')::boolean from (select get_license(2, array[:k1, :k2]) l) x));
select pg_temp.ok('first account sees nothing of the claims table', (select count(*) = 0 from store_claims));
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select pg_temp.ok('second account with a NEW store keeps its trial', (select l->>'status' = 'trial' from (select get_license(1, array[:k3]) l) x));
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000003';
select pg_temp.ok('third account with store 1001 (already used) → no trial, expired', (select l->>'status' = 'expired' and (l->>'trial_blocked')::boolean and (l->>'store_limit')::int = 0 from (select get_license(1, array[:k1]) l) x));
select pg_temp.ok('garbage keys ignored', (select get_license(1, array['not-a-hash', 'x']) is not null));
reset role;
select pg_temp.ok('claims belong to their first account', (select count(*) = 3 and bool_and(user_id <> 'a0000000-0000-0000-0000-000000000003') from store_claims));
select pg_temp.ok('garbage key not stored', (select count(*) = 0 from store_claims where store_key !~ '^[0-9a-f]{64}$'));
update accounts set paid_until = now() + interval '20 days' where email = 'payer@example.kz';
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select pg_temp.ok('a paying account is never blocked by a used store', (select l->>'status' = 'active' and not (l->>'trial_blocked')::boolean from (select get_license(1, array[:k1]) l) x));

-- ===== invoice flood =====
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select accept_terms() is not null;
do $$ declare i int; begin for i in 1..29 loop perform create_invoice(3, 1, null); end loop; raise notice 'PASS 29 invoices fine'; exception when others then raise notice 'FAIL limit too early (%)', sqlerrm; end $$;
do $$ begin perform create_invoice(3, 1, null); perform create_invoice(3, 1, null); raise notice 'FAIL 31st invoice accepted'; exception when others then raise notice 'PASS invoice flood stopped (%)', sqlerrm; end $$;
do $$ declare i int; begin for i in 1..50 loop perform accept_terms(); end loop; end $$;
reset role;
select pg_temp.ok('repeat consent calls keep ONE evidence row', (select count(*) = 1 from consents where user_id = 'a0000000-0000-0000-0000-000000000001'));

-- ===== signed licence claims (as Supabase Auth) =====
set role supabase_auth_admin;
select pg_temp.ok('token hook adds licence claims', (select c->'claims'->'ksh'->>'tsl' = '3' and (c->'claims'->'ksh'->>'pu')::bigint > extract(epoch from now()) and c->'claims'->>'sub' = 'x'
  from (select public.custom_access_token_hook('{"user_id":"a0000000-0000-0000-0000-000000000004","claims":{"sub":"x"}}') c) q));
select pg_temp.ok('blocked trial is visible in the token (te ≤ now)', (select (c->'claims'->'ksh'->>'te')::bigint <= extract(epoch from now()) + 1
  from (select public.custom_access_token_hook('{"user_id":"a0000000-0000-0000-0000-000000000003","claims":{}}') c) q));
select pg_temp.ok('unknown user → claims untouched', (select c = '{"claims":{"a":1}}'::jsonb from (select public.custom_access_token_hook('{"user_id":"a0000000-0000-0000-0000-0000000000ff","claims":{"a":1}}') c) q));
reset role;
