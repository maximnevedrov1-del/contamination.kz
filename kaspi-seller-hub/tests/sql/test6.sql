\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values ('c0000000-0000-0000-0000-000000000001', 'a@example.kz'), ('c0000000-0000-0000-0000-000000000002', 'b@example.kz');
select pg_temp.ok('bucket created: public, 5 MB, XML only', (select public and file_size_limit = 5242880 and allowed_mime_types @> array['application/xml'] from storage.buckets where id = 'pricelists'));

set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000001', false) is not null;
do $$ begin perform ensure_price_feed('shop-abc'); raise notice 'FAIL feed without accepted offer'; exception when others then raise notice 'PASS no feed before the offer is accepted (%)', sqlerrm; end $$;
select accept_terms() is not null;
select pg_temp.ok('feed created', (select ensure_price_feed('shop-abc')->>'feed_id' is not null));
select pg_temp.ok('same store → same feed', (select ensure_price_feed('shop-abc') = ensure_price_feed('shop-abc')));
do $$ begin perform ensure_price_feed('../etc'); raise notice 'FAIL bad shop key'; exception when others then raise notice 'PASS bad shop key rejected (%)', sqlerrm; end $$;
select ensure_price_feed('shop-two') is not null; select ensure_price_feed('shop-three') is not null;
do $$ begin perform ensure_price_feed('shop-four'); raise notice 'FAIL 4th feed on a 3-store trial'; exception when others then raise notice 'PASS 4th store over the limit refused (%)', sqlerrm; end $$;

-- writes into storage, through the real policies
select set_config('t.feed', (select ensure_price_feed('shop-abc')->>'feed_id'), false) is not null;
with x as (insert into storage.objects (bucket_id, name, metadata) values ('pricelists', current_setting('t.feed') || '/shop-abc.xml', '{}') returning 1) select pg_temp.ok('upload own price list', count(*) = 1) from x;
with x as (update storage.objects set metadata = '{"v":2}' where bucket_id = 'pricelists' and name = current_setting('t.feed') || '/shop-abc.xml' returning 1) select pg_temp.ok('overwrite (upsert) own price list', count(*) = 1) from x;
do $$ begin insert into storage.objects (bucket_id, name) values ('pricelists', current_setting('t.feed') || '/shop-other.xml'); raise notice 'FAIL wrong file name in own folder'; exception when others then raise notice 'PASS only <shop_key>.xml in own folder (%)', sqlerrm; end $$;
do $$ begin insert into storage.objects (bucket_id, name) values ('pricelists', 'anything.xml'); raise notice 'FAIL file outside a feed'; exception when others then raise notice 'PASS no files outside a feed (%)', sqlerrm; end $$;

-- another client
select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', false) is not null;
select accept_terms() is not null;
do $$ begin insert into storage.objects (bucket_id, name) values ('pricelists', current_setting('t.feed') || '/shop-abc.xml'); raise notice 'FAIL wrote into another client''s feed'; exception when others then raise notice 'PASS cannot write into another client''s feed (%)', sqlerrm; end $$;
with x as (update storage.objects set metadata = '{"hacked":1}' where name like current_setting('t.feed') || '%' returning 1) select pg_temp.ok('cannot overwrite another client''s price list', count(*) = 0) from x;
with x as (delete from storage.objects where name like current_setting('t.feed') || '%' returning 1) select pg_temp.ok('cannot delete another client''s price list', count(*) = 0) from x;
do $$ declare n int; begin select count(*) into n from public.price_feeds; raise notice '% cannot see other clients feeds', case when n = 0 then 'PASS' else 'FAIL' end; exception when insufficient_privilege then raise notice 'PASS cannot see other clients feeds (no table rights)'; end $$;

-- subscription over → uploads stop (the last file stays where Kaspi reads it)
reset role;
update accounts set trial_ends_at = now() - interval '1 minute' where email = 'a@example.kz';
set role authenticated; select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000001', false) is not null;
with x as (update storage.objects set metadata = '{"v":3}' where name = current_setting('t.feed') || '/shop-abc.xml' returning 1) select pg_temp.ok('expired: update refused', count(*) = 0) from x;
do $$ begin perform ensure_price_feed('shop-new'); raise notice 'FAIL feed while expired'; exception when others then raise notice 'PASS no new feed while expired (%)', sqlerrm; end $$;
reset role;
select pg_temp.ok('file still there for Kaspi', (select count(*) = 1 from storage.objects where bucket_id = 'pricelists'));
