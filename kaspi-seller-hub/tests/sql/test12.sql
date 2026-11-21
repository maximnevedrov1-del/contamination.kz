\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- 013: one login shared between computers; 012: claims survive account deletion; 011: bot_key_ok fails closed
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
\set ka '''' `printf '%064d' 1` ''''
\set kb '''' `printf '%064d' 2` ''''
\set kc '''' `printf '%064d' 3` ''''
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'seller@example.kz'),
  ('22222222-2222-2222-2222-222222222222', 'other@example.kz');
-- paid plan with 1 store for the seller
update public.accounts set paid_until = now() + interval '30 days', store_limit = 1 where user_id = '11111111-1111-1111-1111-111111111111';

set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.ok('computer A, store A: limit 1, nothing shared', (select (l->>'store_limit')::int = 1 and (l->>'shared_stores')::int = 0 from (select get_license(1, array[:ka]) l) x));
select pg_temp.ok('computer A again: own store is not counted as shared', (select (l->>'shared_stores')::int = 0 from (select get_license(1, array[:ka]) l) x));
select pg_temp.ok('computer B, store B: store A is in use elsewhere → shared 1', (select (l->>'shared_stores')::int = 1 from (select get_license(1, array[:kb]) l) x));
select pg_temp.ok('computer C, same store A as computer A: counted once', (select (l->>'shared_stores')::int = 1 from (select get_license(1, array[:ka]) l) x));
select pg_temp.ok('call without store keys reports 0 (unknown, never blocks)', (select (l->>'shared_stores')::int = 0 from (select get_license(null, null) l) x));
reset role;
update public.store_claims set last_seen_at = now() - interval '3 hours' where store_key = :kb;
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.ok('store B unseen for 3 hours → slot is free again', (select (l->>'shared_stores')::int = 0 from (select get_license(1, array[:ka]) l) x));

-- another account's store is never touched or counted
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.ok('other account using seller''s store A: not counted as its own shared store', (select (l->>'shared_stores')::int = 0 from (select get_license(1, array[:ka, :kc]) l) x));
reset role;
select pg_temp.ok('store A still owned by the seller', (select user_id = '11111111-1111-1111-1111-111111111111' from public.store_claims where store_key = :ka));

-- 012: deleting the first account keeps its claim, so the shop gets no new trial
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select pg_temp.ok('claim survives account deletion (user_id null)', (select user_id is null from public.store_claims where store_key = :ka));
insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'new@example.kz');
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok('new email with the orphaned store → trial ends', (select (l->>'trial_blocked')::boolean and l->>'status' = 'expired' from (select get_license(1, array[:ka]) l) x));
reset role;

-- 011: bot key check fails closed when no key hash is stored
update public.ops_settings set bot_key_hash = null where id = 1;
select pg_temp.ok('bot_key_ok is false (not null) without a stored hash', (select public.bot_key_ok(repeat('x', 40)) is false));
