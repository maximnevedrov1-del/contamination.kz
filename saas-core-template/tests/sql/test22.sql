\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- 025: F1 admin_confirm_invoice expected amount/stores, F2 anon EXECUTE whitelist, admin Storage policies
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'u1@example.kz'),
  ('a0000000-0000-0000-0000-000000000002', 'u2@example.kz'),
  ('a0000000-0000-0000-0000-000000000003', 'u3@example.kz'),
  ('b0000000-0000-0000-0000-000000000001', 'boss@example.kz');
insert into public.admins values ('b0000000-0000-0000-0000-000000000001');
insert into public.accounts (user_id, trial_ends_at) values ('a0000000-0000-0000-0000-000000000001', now() + interval '10 days'), ('a0000000-0000-0000-0000-000000000002', now() + interval '10 days'), ('a0000000-0000-0000-0000-000000000003', now() + interval '10 days') on conflict do nothing;
insert into public.invoices (id, user_id, kind, stores, months, amount, status) overriding system value values
  (9001, 'a0000000-0000-0000-0000-000000000001', 'manual', 3, 1, 12000, 'pending'),
  (9002, 'a0000000-0000-0000-0000-000000000002', 'manual', 3, 1, 12000, 'pending'),
  (9003, 'a0000000-0000-0000-0000-000000000003', 'manual', 3, 1, 12000, 'pending');

-- ===== F1: mutated invoice is refused =====
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
reset role;
update public.invoices set amount = 99000, stores = 20 where id = 9001;   -- "extension licence check" rewrote it after the admin read it
set role authenticated;
do $$ begin perform admin_confirm_invoice(9001, null, 12000, 3); raise notice 'FAIL stale amount confirmed';
  exception when others then raise notice '% stale amount refused (% / %)', case when sqlerrm = 'amount_changed' and sqlstate = '40001' then 'PASS' else 'FAIL' end, sqlstate, sqlerrm; end $$;
do $$ begin perform admin_confirm_invoice(9001, null, 99000, 3); raise notice 'FAIL stale stores confirmed';
  exception when others then raise notice '% stale stores refused', case when sqlerrm = 'amount_changed' then 'PASS' else 'FAIL' end; end $$;
reset role;
select case when (select status from public.invoices where id = 9001) = 'pending' then 'PASS invoice still pending after refusal' else 'FAIL invoice changed by refused confirm' end;
set role authenticated;
-- matching values -> paid
do $$ declare r jsonb; begin r := admin_confirm_invoice(9001, 'ok', 99000, 20); raise notice '% matching expected values confirm', case when r->>'status' = 'paid' then 'PASS' else 'FAIL' end; exception when others then raise notice 'FAIL matching confirm: %', sqlerrm; end $$;
-- nulls -> backwards compatible
do $$ declare r jsonb; begin r := admin_confirm_invoice(9002, 'legacy'); raise notice '% two-argument call still works', case when r->>'status' = 'paid' then 'PASS' else 'FAIL' end; exception when others then raise notice 'FAIL legacy confirm: %', sqlerrm; end $$;
do $$ declare r jsonb; begin r := admin_confirm_invoice(9003, null, null, null); raise notice '% null expected values skip the check', case when r->>'status' = 'paid' then 'PASS' else 'FAIL' end; exception when others then raise notice 'FAIL null confirm: %', sqlerrm; end $$;
-- non-admin still refused
reset role; set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ begin perform admin_confirm_invoice(9001, null, 1, 1); raise notice 'FAIL non-admin confirm'; exception when others then raise notice '% non-admin refused (forbidden)', case when sqlerrm = 'forbidden' then 'PASS' else 'FAIL' end; end $$;
reset role;
-- only one overload left
select case when (select count(*) from pg_proc where proname = 'admin_confirm_invoice' and pronamespace = 'public'::regnamespace) = 1 then 'PASS single admin_confirm_invoice overload' else 'FAIL stale admin_confirm_invoice overload' end;

-- ===== F2: anon may execute only the whitelist =====
do $$ declare bad text; ok text[] := array['get_service_status', 'health'];
begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and p.proname <> all (ok);
  raise notice '% anon cannot execute any public function outside the whitelist%', case when bad is null then 'PASS' else 'FAIL' end, coalesce(': ' || bad, '');
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and has_function_privilege('public', p.oid, 'EXECUTE')
     and p.proname <> all (ok);
  raise notice '% PUBLIC cannot execute any public function outside the whitelist%', case when bad is null then 'PASS' else 'FAIL' end, coalesce(': ' || bad, '');
end $$;
select case when has_function_privilege('anon', 'public.get_service_status()', 'EXECUTE') and has_function_privilege('anon', 'public.health()', 'EXECUTE') then 'PASS anon keeps get_service_status and health' else 'FAIL whitelist lost' end;
select case when not has_function_privilege('anon', 'public.admin_confirm_invoice(bigint,text,int,int)', 'EXECUTE') and has_function_privilege('authenticated', 'public.admin_confirm_invoice(bigint,text,int,int)', 'EXECUTE') then 'PASS admin_confirm_invoice: authenticated only' else 'FAIL admin_confirm_invoice grants' end;
select case when not has_function_privilege('anon', 'public.admin_delete_account(uuid,text)', 'EXECUTE') and has_function_privilege('authenticated', 'public.admin_delete_account(uuid,text)', 'EXECUTE') then 'PASS admin_delete_account: authenticated only' else 'FAIL admin_delete_account grants' end;
set role anon;
do $$ begin perform admin_confirm_invoice(1, null, null, null); raise notice 'FAIL anon confirm'; exception when insufficient_privilege then raise notice 'PASS anon cannot call admin_confirm_invoice'; end $$;
do $$ begin perform get_service_status(); raise notice 'PASS anon can call get_service_status'; exception when others then raise notice 'FAIL anon get_service_status: %', sqlerrm; end $$;
reset role;

-- ===== F3 support: admin Storage policies =====
insert into storage.buckets (id, name, public) values ('pricelists', 'pricelists', true) on conflict do nothing;
insert into storage.objects (bucket_id, name) values ('pricelists', 'c0000000-0000-0000-0000-000000000001/shop1.xml');
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select case when (select count(*) from storage.objects where bucket_id = 'pricelists') = 1 then 'PASS admin sees price-list objects' else 'FAIL admin cannot list objects' end;
do $$ declare n int; begin delete from storage.objects where bucket_id = 'pricelists'; get diagnostics n = row_count; raise notice '% admin deletes price-list object (% rows)', case when n = 1 then 'PASS' else 'FAIL' end, n; end $$;
reset role;
insert into storage.objects (bucket_id, name) values ('pricelists', 'c0000000-0000-0000-0000-000000000002/shop1.xml');
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ declare n int; begin delete from storage.objects where bucket_id = 'pricelists'; get diagnostics n = row_count; raise notice '% non-admin cannot delete foreign price-list object (% rows)', case when n = 0 then 'PASS' else 'FAIL' end, n; end $$;
reset role;
