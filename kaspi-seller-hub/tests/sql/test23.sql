\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- 026: strict admin_confirm_invoice, pending_storage_cleanups queue, cleanup RPCs
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'u1@example.kz'),
  ('a0000000-0000-0000-0000-000000000002', 'u2@example.kz'),
  ('b0000000-0000-0000-0000-000000000001', 'boss@example.kz');
insert into public.admins values ('b0000000-0000-0000-0000-000000000001');
insert into public.accounts (user_id, trial_ends_at) values ('a0000000-0000-0000-0000-000000000001', now() + interval '10 days'), ('a0000000-0000-0000-0000-000000000002', now() + interval '10 days') on conflict do nothing;
insert into public.invoices (id, user_id, kind, stores, months, amount, status) overriding system value values
  (9101, 'a0000000-0000-0000-0000-000000000001', 'manual', 3, 1, 12000, 'pending');

-- ===== strict confirmation =====
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
do $$ begin perform admin_confirm_invoice(9101, 'x'); raise notice 'FAIL 2-arg call confirmed';
  exception when others then raise notice '% 2-arg legacy call refused (% / %)', case when sqlerrm = 'expected_values_required' and sqlstate = '22023' then 'PASS' else 'FAIL' end, sqlstate, sqlerrm; end $$;
do $$ begin perform admin_confirm_invoice(9101, null, null, null); raise notice 'FAIL all-null confirmed';
  exception when others then raise notice '% all-null refused', case when sqlerrm = 'expected_values_required' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform admin_confirm_invoice(9101, null, 12000, null); raise notice 'FAIL null stores confirmed';
  exception when others then raise notice '% null stores refused', case when sqlerrm = 'expected_values_required' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform admin_confirm_invoice(9101, null, null, 3); raise notice 'FAIL null amount confirmed';
  exception when others then raise notice '% null amount refused', case when sqlerrm = 'expected_values_required' then 'PASS' else 'FAIL' end; end $$;
reset role;
select case when (select status from public.invoices where id = 9101) = 'pending' then 'PASS invoice still unpaid after refusals' else 'FAIL invoice changed by refused call' end;
set role authenticated;
do $$ declare r jsonb; begin r := admin_confirm_invoice(9101, 'ok', 12000, 3); raise notice '% correct values -> paid', case when r->>'status' = 'paid' then 'PASS' else 'FAIL' end; exception when others then raise notice 'FAIL correct confirm: %', sqlerrm; end $$;
reset role;

-- ===== admin_delete_account enqueues the Storage cleanup =====
insert into public.price_feeds (feed_id, user_id, shop_key) values
  ('c0000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-000000000002', 'shop-1'),
  ('c0000000-0000-0000-0000-0000000000a2', 'a0000000-0000-0000-0000-000000000002', 'shop-2');
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
do $$ declare r jsonb; begin r := admin_delete_account('a0000000-0000-0000-0000-000000000002', 'u2@example.kz');
  raise notice '% delete_account keeps its return shape (% feeds)', case when (r->>'deleted')::boolean and jsonb_array_length(r->'price_feeds_to_remove') = 2 then 'PASS' else 'FAIL' end, jsonb_array_length(r->'price_feeds_to_remove');
  exception when others then raise notice 'FAIL delete_account: %', sqlerrm; end $$;
reset role;
select case when (select count(*) from public.pending_storage_cleanups where bucket = 'pricelists' and object_path in ('c0000000-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-0000000000a2')) = 2 then 'PASS one cleanup row per feed' else 'FAIL cleanup rows missing' end;

-- ===== admin RPCs =====
select set_config('t.id1', min(id)::text, false) from public.pending_storage_cleanups \g /dev/null
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
do $$ declare r jsonb; begin r := admin_list_storage_cleanups(); raise notice '% list returns the 2 pending rows', case when jsonb_array_length(r) = 2 then 'PASS' else 'FAIL' end; end $$;
do $$ declare r jsonb; id1 bigint := current_setting('t.id1')::bigint; begin
  -- the table itself is reachable only through the RPCs
  r := admin_fail_storage_cleanup(id1, 'boom');
  raise notice '% fail RPC updates the row', case when (r->>'updated')::boolean then 'PASS' else 'FAIL' end;
  r := admin_list_storage_cleanups();
  raise notice '% attempts incremented and last_error stored', case when (r->0->>'attempts')::int = 1 and r->0->>'last_error' = 'boom' then 'PASS' else 'FAIL' end;
  r := admin_resolve_storage_cleanup(id1);
  raise notice '% resolve RPC deletes the row', case when (r->>'resolved')::boolean and jsonb_array_length(admin_list_storage_cleanups()) = 1 then 'PASS' else 'FAIL' end;
end $$;
reset role;

-- ===== non-admin and anon are denied =====
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ begin perform count(*) from public.pending_storage_cleanups; raise notice 'FAIL non-admin selected the table';
  exception when insufficient_privilege then raise notice 'PASS non-admin cannot select pending_storage_cleanups'; end $$;
do $$ begin perform admin_list_storage_cleanups(); raise notice 'FAIL non-admin list'; exception when others then raise notice '% non-admin cannot list cleanups', case when sqlerrm = 'forbidden' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform admin_resolve_storage_cleanup(1); raise notice 'FAIL non-admin resolve'; exception when others then raise notice '% non-admin cannot resolve', case when sqlerrm = 'forbidden' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform admin_fail_storage_cleanup(1, 'x'); raise notice 'FAIL non-admin fail'; exception when others then raise notice '% non-admin cannot fail-mark', case when sqlerrm = 'forbidden' then 'PASS' else 'FAIL' end; end $$;
reset role;
select case when (select count(*) from public.pending_storage_cleanups) = 1 then 'PASS non-admin calls changed nothing' else 'FAIL cleanup table changed by non-admin' end;
set role anon;
do $$ begin perform admin_list_storage_cleanups(); raise notice 'FAIL anon list'; exception when insufficient_privilege then raise notice 'PASS anon cannot call admin_list_storage_cleanups'; end $$;
do $$ begin perform admin_resolve_storage_cleanup(1); raise notice 'FAIL anon resolve'; exception when insufficient_privilege then raise notice 'PASS anon cannot call admin_resolve_storage_cleanup'; end $$;
do $$ begin perform admin_fail_storage_cleanup(1, 'x'); raise notice 'FAIL anon fail'; exception when insufficient_privilege then raise notice 'PASS anon cannot call admin_fail_storage_cleanup'; end $$;
do $$ begin perform count(*) from public.pending_storage_cleanups; raise notice 'FAIL anon selected table'; exception when insufficient_privilege then raise notice 'PASS anon cannot select pending_storage_cleanups'; end $$;
reset role;
