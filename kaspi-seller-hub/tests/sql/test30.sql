-- 035: free access. Subscription state no longer restricts business functions; identity, tenant isolation,
-- the legal gate (offer accepted), abuse ceilings and billing history stay intact.
\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values
  ('f0000000-0000-0000-0000-000000000001', 'expired@example.kz'),
  ('f0000000-0000-0000-0000-000000000002', 'other@example.kz'),
  ('f0000000-0000-0000-0000-000000000003', 'legacy@example.kz'),
  ('f0000000-0000-0000-0000-000000000004', 'packer@example.kz'),
  ('f0000000-0000-0000-0000-000000000005', 'noterms@example.kz'),
  ('f0000000-0000-0000-0000-000000000009', 'boss@example.kz');
insert into public.admins values ('f0000000-0000-0000-0000-000000000009');

-- ===== expired, never paid, 1-store legacy limit =====
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', false) is not null;
select accept_terms() is not null;
reset role;
update accounts set trial_ends_at = now() - interval '90 days', paid_until = null, store_limit = 1 where email = 'expired@example.kz';
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('expired: billing status is still reported as history', (select l->>'status' = 'expired' from (select get_license(1) l) x));
select pg_temp.ok('expired: free_access flag, store_limit = operational cap 50 (not 0, not the paid number)', (select (l->>'free_access')::boolean and (l->>'store_limit')::int = 50 from (select get_license(1) l) x));
select pg_temp.ok('expired: licence keeps its other keys (features, system_banner, phone_verified)', (select l ? 'features' and l ? 'system_banner' and l ? 'phone_verified' and l ? 'pricing' from (select get_license(1) l) x));
select pg_temp.ok('expired: price-list feed 1', (select ensure_price_feed('shop-a')->>'feed_id' is not null));
select ensure_price_feed('shop-b') is not null; select ensure_price_feed('shop-c') is not null;
select pg_temp.ok('expired + 1-store limit: 4th feed allowed (no plan limit)', (select ensure_price_feed('shop-d')->>'feed_id' is not null));
select set_config('t.feed', (select ensure_price_feed('shop-a')->>'feed_id'), false) is not null;
with x as (insert into storage.objects (bucket_id, name, metadata) values ('pricelists', current_setting('t.feed') || '/shop-a.xml', '{}') returning 1) select pg_temp.ok('expired: upload own price list', count(*) = 1) from x;
with x as (update storage.objects set metadata = '{"v":2}' where name = current_setting('t.feed') || '/shop-a.xml' returning 1) select pg_temp.ok('expired: overwrite own price list', count(*) = 1) from x;
select pg_temp.ok('no automatic billing: renewal request creates nothing', ensure_renewal_invoice(5) is null);
select pg_temp.ok('no automatic billing: add-on request creates nothing', request_store_addon(50) is null);
select pg_temp.ok('no invoice rows were created', jsonb_array_length(get_license(1)->'invoices') = 0);

-- abuse ceiling stays (not a price tier)
reset role;
insert into price_feeds (user_id, shop_key) select 'f0000000-0000-0000-0000-000000000001', 'shop-x' || g from generate_series(1, 45) g;
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('feed 50 allowed', (select ensure_price_feed('shop-last')->>'feed_id' is not null));
do $$ begin perform ensure_price_feed('shop-over'); raise notice 'FAIL 51st feed'; exception when others then raise notice 'PASS 51st feed refused by the abuse ceiling (%)', sqlerrm; end $$;
reset role; update accounts set store_limit = 60 where email = 'expired@example.kz';
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('legacy customer who paid for 60 stores keeps their number (feed 51 allowed)', (select ensure_price_feed('shop-legacy')->>'feed_id' is not null));
select pg_temp.ok('licence store_limit = greatest(cap, paid stores) = 60', (select (l->>'store_limit')::int = 60 from (select get_license(1) l) x));
reset role; update accounts set store_limit = 1 where email = 'expired@example.kz';
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', false) is not null;
do $$ begin perform store_cap(); raise notice 'FAIL client called store_cap'; exception when others then raise notice 'PASS store_cap is not client-callable (%)', sqlerrm; end $$;

-- ===== packers: owner subscription state no longer matters; isolation does =====
select team_invite('packer@example.kz', 'Ерлан', array['A']) is not null;
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000004', false) is not null;
select pg_temp.ok('packer joins an owner whose subscription expired', (select (r->>'status') = 'active' from (select team_join('f0000000-0000-0000-0000-000000000001') r) x));
select pg_temp.ok('packer check keeps working', (select (r->>'status') = 'active' from (select team_check('f0000000-0000-0000-0000-000000000001') r) x));
select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000002', false) is not null;
select accept_terms() is not null;
do $$ begin perform team_join('f0000000-0000-0000-0000-000000000001'); raise notice 'FAIL stranger joined a team'; exception when others then raise notice 'PASS stranger cannot join (%)', sqlerrm; end $$;
do $$ begin perform team_check('f0000000-0000-0000-0000-000000000001'); raise notice 'FAIL stranger checked a team'; exception when others then raise notice 'PASS stranger cannot check (%)', sqlerrm; end $$;
select pg_temp.ok('stranger cannot write into the expired owner''s feed', (select not can_write_feed(current_setting('t.feed') || '/shop-a.xml')));
do $$ begin insert into storage.objects (bucket_id, name) values ('pricelists', current_setting('t.feed') || '/shop-a.xml'); raise notice 'FAIL wrote into another tenant feed'; exception when others then raise notice 'PASS tenant isolation on storage (%)', sqlerrm; end $$;
do $$ declare n int; begin select count(*) into n from public.price_feeds; raise notice '% other tenants'' feeds are invisible', case when n = 0 then 'PASS' else 'FAIL' end; exception when insufficient_privilege then raise notice 'PASS feeds table closed (%)', sqlerrm; end $$;

-- ===== legal gate: no accepted offer → still refused; unauthenticated → no access =====
select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000005', false) is not null;
do $$ begin perform ensure_price_feed('shop-n'); raise notice 'FAIL feed without accepted offer'; exception when others then raise notice 'PASS offer must still be accepted (%)', sqlerrm; end $$;
reset role;
select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000005', false) is not null;
select pg_temp.ok('no accepted offer: has_access() false', not has_access());
select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('expired but offer accepted: has_access() true', has_access());
select set_config('request.jwt.claim.sub', '', false) is not null;
select pg_temp.ok('no identity: has_access() false', not has_access());
select pg_temp.ok('has_access_of: unknown user false', not public.has_access_of('f0000000-0000-0000-0000-0000000000aa'));
select pg_temp.ok('has_access_of: expired but accepted owner true', public.has_access_of('f0000000-0000-0000-0000-000000000001'));

-- ===== legacy paying customer: history untouched, open invoice stays, still confirmable, no refund path =====
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000003', false) is not null;
select accept_terms() is not null;
reset role;
update accounts set paid_until = now() - interval '10 days', trial_ends_at = now() - interval '60 days', store_limit = 3 where email = 'legacy@example.kz';
insert into invoices (user_id, kind, stores, months, amount, status) values ('f0000000-0000-0000-0000-000000000003', 'renewal', 3, 1, 20000, 'pending');
insert into invoices (user_id, kind, stores, months, amount, status, paid_at, period_from, period_to)
  values ('f0000000-0000-0000-0000-000000000003', 'manual', 3, 1, 20000, 'paid', now() - interval '40 days', now() - interval '40 days', now() - interval '10 days');
create temp table before_acc as select paid_until, store_limit, trial_ends_at from accounts where email = 'legacy@example.kz';
create temp table before_inv as select id, amount, stores, status, kind from invoices where user_id = 'f0000000-0000-0000-0000-000000000003';
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000003', false) is not null;
select pg_temp.ok('legacy: full access, status history = expired/grace unchanged', (select l->>'status' in ('grace', 'expired') and (l->>'free_access')::boolean and (l->>'paid_store_limit')::int = 3 from (select get_license(3) l) x));
select pg_temp.ok('legacy: open invoice is returned as it was (not edited, not merged)', (select (i->>'amount')::int = 20000 and (i->>'stores')::int = 3 and i->>'kind' = 'renewal' from (select ensure_renewal_invoice(30) i) x));
select pg_temp.ok('legacy: add-on request does not touch the open invoice', (select (i->>'amount')::int = 20000 from (select request_store_addon(30) i) x));
select pg_temp.ok('legacy: both invoices still listed in the licence', (select jsonb_array_length(l->'invoices') = 2 from (select get_license(3) l) x));
reset role;
select pg_temp.ok('legacy: accounts row byte-identical (paid_until, store_limit, trial_ends_at)', (select (a.paid_until, a.store_limit, a.trial_ends_at) is not distinct from (b.paid_until, b.store_limit, b.trial_ends_at) from accounts a, before_acc b where a.email = 'legacy@example.kz'));
select pg_temp.ok('legacy: invoices unchanged (ids, amounts, statuses)', (select count(*) = 0 from (select * from before_inv except select id, amount, stores, status, kind from invoices where user_id = 'f0000000-0000-0000-0000-000000000003') d));
select pg_temp.ok('no refund/cancel happened to the paid invoice', (select count(*) = 1 from invoices where user_id = 'f0000000-0000-0000-0000-000000000003' and status = 'paid'));
select set_config('t.inv', (select id::text from invoices where user_id = 'f0000000-0000-0000-0000-000000000003' and status = 'pending'), false) is not null;
set role authenticated; select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000009', false) is not null;
select pg_temp.ok('admin can still confirm the pending invoice (billing records stay operable)', (select r->>'status' = 'paid' from (select admin_confirm_invoice(current_setting('t.inv')::bigint, 'legacy', 20000, 3) r) x));
select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000002', false) is not null;
do $$ begin perform admin_confirm_invoice(1, 'x', 1, 1); raise notice 'FAIL non-admin confirmed an invoice'; exception when others then raise notice 'PASS non-admin still cannot confirm (%)', sqlerrm; end $$;

-- ===== the bot pushes no payment prompts: no grace reminder, no win-back offers, no trial nudges =====
reset role;
update public.ops_settings set bot_key_hash = encode(sha256(convert_to('bot-key-0123456789abcdef0123456789abcdef', 'utf8')), 'hex');
update public.billing_config set whats_new = 'Новое';
insert into tg_links (user_id, chat_id) values ('f0000000-0000-0000-0000-000000000001', 7001);
update accounts set paid_until = now() - interval '1 day', trial_ends_at = now() - interval '90 days', frozen_until = null where email = 'expired@example.kz';
set role service_role;
select pg_temp.ok('bot: no «grace» renewal reminder', (select not exists (select 1 from jsonb_array_elements(bot_jobs('bot-key-0123456789abcdef0123456789abcdef')->'items') e where e->>'kind' = 'grace')));
reset role;
update accounts set paid_until = now() - interval '35 days' where email = 'expired@example.kz';
set role service_role;
select pg_temp.ok('bot: no win-back (30 d)', (select not exists (select 1 from jsonb_array_elements(bot_jobs('bot-key-0123456789abcdef0123456789abcdef')->'items') e where e->>'kind' like 'winback%')));
reset role;
update accounts set paid_until = now() - interval '65 days' where email = 'expired@example.kz';
set role service_role;
select pg_temp.ok('bot: no win-back with the 50 % offer (60 d)', (select not exists (select 1 from jsonb_array_elements(bot_jobs('bot-key-0123456789abcdef0123456789abcdef')->'items') e where e->>'kind' like 'winback%')));
reset role;
update accounts set trial_ends_at = now() + interval '1 day', paid_until = null where email = 'expired@example.kz';
delete from tg_outbox;
select pg_temp.ok('retention: no «trial ends in 2 days» nudge', (select enqueue_retention_nudges() >= 0 and not exists (select 1 from tg_outbox where payload->>'key' in ('trial_ending_2d', 'trial_expired_winback'))));
