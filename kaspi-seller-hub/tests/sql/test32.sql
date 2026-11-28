-- 037: advertising backend. Campaign lifecycle, the 3-sponsor cap, category exclusivity, admin authorization, URL/asset
-- validation, eligibility (free vs supporter), fallback, failure isolation, privacy of the counters.
\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
-- runs a statement, PASS when it raises exactly `expected` (message), FAIL otherwise
create or replace function pg_temp.raises(name text, stmt text, expected text) returns text language plpgsql as $$
begin execute stmt; return 'FAIL ' || name || ' (no error)';
exception when others then return case when sqlerrm like expected || '%' or (expected = 'denied' and sqlstate = '42501') then 'PASS ' else 'FAIL ' end || name || ' [' || sqlerrm || ']'; end $$;
insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-000000000001', 'free@example.kz'),
  ('d0000000-0000-0000-0000-000000000002', 'sup@example.kz'),
  ('d0000000-0000-0000-0000-000000000009', 'boss@example.kz');
insert into public.admins values ('d0000000-0000-0000-0000-000000000009');
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null; select accept_terms() is not null; reset role;
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', false) is not null; select accept_terms() is not null; reset role;
update accounts set trial_ends_at = now() - interval '90 days';
-- the supporter has paid through a real (confirmed) supporter period
update accounts set supporter_until = now() + interval '20 days' where email = 'sup@example.kz';

-- ===== defaults: ads off, nothing served =====
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('default: ad system disabled → empty list for a free user', (select (g->'ads') = '[]'::jsonb and (g->>'show_ads')::boolean from (select get_ads() g) x));

-- ===== authorization =====
select pg_temp.raises('seller cannot list campaigns', 'select admin_ad_list()', 'forbidden');
select pg_temp.raises('seller cannot create a campaign', $$select admin_ad_save(null, '{"sponsor_name":"X"}'::jsonb)$$, 'forbidden');
select pg_temp.raises('seller cannot change status', 'select admin_ad_set_status(1, ''active'')', 'forbidden');
select pg_temp.raises('seller cannot change config', 'select admin_ad_config(true)', 'forbidden');
select pg_temp.raises('seller cannot read stats', 'select admin_ad_stats()', 'forbidden');
select pg_temp.raises('seller cannot read campaign table', 'select * from ad_campaigns', 'denied');
select pg_temp.raises('seller cannot write campaign table', $$insert into ad_campaigns (sponsor_name, headline, destination_url, starts_at) values ('A','B','https://a.kz', now())$$, 'denied');
select pg_temp.raises('seller cannot read ad_config', 'select * from ad_config', 'denied');
select pg_temp.raises('seller cannot read ad_stats', 'select * from ad_stats', 'denied');
select pg_temp.raises('seller cannot call expire_ad_campaigns', 'select expire_ad_campaigns()', 'denied');
select pg_temp.raises('seller cannot call the guard helpers', 'select ad_valid_url(''https://a.kz'')', 'denied');
reset role;
set role anon;
select pg_temp.raises('anon cannot get_ads', 'select get_ads()', 'denied');
select pg_temp.raises('anon cannot ad_record', 'select ad_record(1, ''click'')', 'denied');
select pg_temp.raises('anon cannot administer', 'select admin_ad_list()', 'denied');
reset role;

-- ===== configuration (admin) =====
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000009', false) is not null;
select pg_temp.raises('config: bad host refused', 'select admin_ad_config(null, array[''not a host''])', 'invalid_host');
select pg_temp.raises('config: IP literal refused', 'select admin_ad_config(null, array[''10.0.0.1''])', 'invalid_host');
select pg_temp.raises('config: host with scheme refused', 'select admin_ad_config(null, array[''https://cdn.example.kz''])', 'invalid_host');
select pg_temp.ok('config: whitelist set (lowercase DNS names only)', (admin_ad_config(false, array['cdn.example.kz'])->'asset_hosts') = '["cdn.example.kz"]'::jsonb);

-- ===== validation of URLs and assets =====
create or replace function pg_temp.ad(over jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('sponsor_name','Sponsor','category','finance','headline','Fast loans','body','b','creative_url','https://cdn.example.kz/a.png','creative_alt','a',
    'destination_url','https://a.example.kz/promo?x=1','starts_at', now() - interval '1 day', 'ends_at', now() + interval '30 days') || over $$;
grant execute on function pg_temp.ad(jsonb) to public;
select pg_temp.ok('valid sponsor draft is created', (select (admin_ad_save(null, pg_temp.ad())->>'status') = 'draft'));
select pg_temp.raises('destination http refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"http://a.example.kz/"}')), 'invalid_destination_url');
select pg_temp.raises('destination javascript: refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"javascript:alert(1)"}')), 'invalid_destination_url');
select pg_temp.raises('destination data: refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"data:text/html,x"}')), 'invalid_destination_url');
select pg_temp.raises('destination IP literal refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"https://127.0.0.1/x"}')), 'invalid_destination_url');
select pg_temp.raises('destination localhost refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"https://localhost/x"}')), 'invalid_destination_url');
select pg_temp.raises('destination with userinfo refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"https://good.kz@evil.kz/"}')), 'invalid_destination_url');
select pg_temp.raises('destination with port refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"https://a.example.kz:8443/"}')), 'invalid_destination_url');
select pg_temp.raises('destination with fragment refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"https://a.example.kz/#x"}')), 'invalid_destination_url');
select pg_temp.raises('destination with whitespace refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"https://a.example.kz/a b"}')), 'invalid_destination_url');
select pg_temp.raises('destination over 500 chars refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad(jsonb_build_object('destination_url', 'https://a.example.kz/' || repeat('x', 500)))), 'invalid_destination_url');
select pg_temp.raises('destination with uppercase scheme refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"HTTPS://a.example.kz/x"}')), 'invalid_destination_url');
select pg_temp.raises('creative with uppercase scheme refused (whitelist bypass)', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"creative_url":"HTTPS://tracker.evil.com/p.png"}')), 'invalid_creative_url');
select pg_temp.raises('destination on a local TLD refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"https://intranet.local/x"}')), 'invalid_destination_url');
select pg_temp.raises('destination .localhost refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"https://a.localhost/x"}')), 'invalid_destination_url');
select pg_temp.raises('destination with trailing dot host refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"destination_url":"https://a.example.kz./x"}')), 'invalid_destination_url');
select pg_temp.raises('destination with newline refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad(jsonb_build_object('destination_url', E'https://a.example.kz/x\nHost: evil'))), 'invalid_destination_url');
select pg_temp.raises('creative svg refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"creative_url":"https://cdn.example.kz/a.svg"}')), 'invalid_creative_url');
select pg_temp.raises('creative with query string refused (tracking pixel)', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"creative_url":"https://cdn.example.kz/a.png?u=1"}')), 'invalid_creative_url');
select pg_temp.raises('creative over http refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"creative_url":"http://cdn.example.kz/a.png"}')), 'invalid_creative_url');
select pg_temp.raises('creative without image extension refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"creative_url":"https://cdn.example.kz/a.html"}')), 'invalid_creative_url');
select pg_temp.raises('creative data: URI refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"creative_url":"data:image/png;base64,AAAA"}')), 'invalid_creative_url');
select pg_temp.raises('sponsor without creative refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"creative_url":""}')), 'new row for relation "ad_campaigns" violates check constraint');
select pg_temp.raises('sponsor without category refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"category":""}')), 'new row for relation "ad_campaigns" violates check constraint');
select pg_temp.raises('category format enforced', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"category":"Bad Cat!"}')), 'new row for relation "ad_campaigns" violates check constraint');
select pg_temp.raises('end before start refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad(jsonb_build_object('ends_at', now() - interval '5 days'))), 'new row for relation "ad_campaigns" violates check constraint');
select pg_temp.raises('window over a year refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad(jsonb_build_object('ends_at', now() + interval '400 days'))), 'new row for relation "ad_campaigns" violates check constraint');
select pg_temp.raises('unknown kind refused', format('select admin_ad_save(null, %L::jsonb)', pg_temp.ad('{"kind":"evil"}')), 'new row for relation "ad_campaigns" violates check constraint');
select pg_temp.raises('non-object payload refused', 'select admin_ad_save(null, ''[1]''::jsonb)', 'invalid_payload');
select pg_temp.ok('status cannot be set through save (stays draft)', (select (admin_ad_save(null, pg_temp.ad('{"status":"active","category":"zz1"}'))->>'status') = 'draft'));
reset role;
select pg_temp.ok('draft rows do not count: nothing active yet', (select count(*) = 0 from ad_campaigns where status = 'active'));
-- keep exactly the campaigns the tests below use
delete from ad_campaigns;
alter table ad_campaigns alter column id restart with 100;

-- ===== activation, the cap of 3, category exclusivity =====
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000009', false) is not null;
select set_config('t.a', admin_ad_save(null, pg_temp.ad('{"sponsor_name":"Fin Co","category":"finance"}'))->>'id', false) is not null;
select set_config('t.b', admin_ad_save(null, pg_temp.ad('{"sponsor_name":"Fin Two","category":"finance"}'))->>'id', false) is not null;
select set_config('t.c', admin_ad_save(null, pg_temp.ad('{"sponsor_name":"Logi","category":"logistics"}'))->>'id', false) is not null;
select set_config('t.d', admin_ad_save(null, pg_temp.ad('{"sponsor_name":"Pack","category":"packaging"}'))->>'id', false) is not null;
select set_config('t.e', admin_ad_save(null, pg_temp.ad('{"sponsor_name":"Mkt","category":"marketing"}'))->>'id', false) is not null;
select pg_temp.ok('activate A (finance)', (admin_ad_set_status(current_setting('t.a')::bigint, 'active')->>'status') = 'active');
select pg_temp.raises('category conflict: second active finance refused', format('select admin_ad_set_status(%s, ''active'')', current_setting('t.b')), 'category_conflict');
select pg_temp.ok('activate C (logistics)', (admin_ad_set_status(current_setting('t.c')::bigint, 'active')->>'status') = 'active');
select pg_temp.ok('activate D (packaging) = third sponsor', (admin_ad_set_status(current_setting('t.d')::bigint, 'active')->>'status') = 'active');
select pg_temp.raises('cap: fourth active sponsor refused', format('select admin_ad_set_status(%s, ''active'')', current_setting('t.e')), 'max_active_campaigns');
select pg_temp.raises('edit active: moving D into the finance category refused', format('select admin_ad_save(%s, ''{"category":"finance"}'')', current_setting('t.d')), 'category_conflict');
select pg_temp.raises('edit active: invalid destination refused', format('select admin_ad_save(%s, ''{"destination_url":"http://x.kz"}'')', current_setting('t.d')), 'invalid_destination_url');
select pg_temp.ok('edit active: harmless text change allowed', (admin_ad_save(current_setting('t.d')::bigint, '{"headline":"New headline"}')->>'headline') = 'New headline');
select pg_temp.ok('suspend D frees a slot', (admin_ad_set_status(current_setting('t.d')::bigint, 'suspended')->>'status') = 'suspended');
select pg_temp.ok('E (marketing) can now be activated', (admin_ad_set_status(current_setting('t.e')::bigint, 'active')->>'status') = 'active');
select pg_temp.raises('resume D: cap again', format('select admin_ad_set_status(%s, ''active'')', current_setting('t.d')), 'max_active_campaigns');
select pg_temp.raises('invalid transition: suspend a draft', format('select admin_ad_set_status(%s, ''suspended'')', current_setting('t.b')), 'invalid_transition');
select pg_temp.raises('unknown status refused', format('select admin_ad_set_status(%s, ''deleted'')', current_setting('t.b')), 'invalid_status');
select pg_temp.raises('unknown campaign', 'select admin_ad_set_status(999999, ''active'')', 'not_found');
-- an image host that is not whitelisted cannot go live
select set_config('t.f', admin_ad_save(null, pg_temp.ad('{"sponsor_name":"Odd","category":"other1","creative_url":"https://evil.example.org/a.png"}'))->>'id', false) is not null;
select pg_temp.raises('creative host not whitelisted cannot be activated', format('select admin_ad_set_status(%s, ''active'')', current_setting('t.f')), 'creative_host_not_allowed');
reset role;
select pg_temp.raises('hard cap holds against direct SQL too (trigger): 4th active insert refused', $$insert into ad_campaigns (sponsor_name, category, headline, creative_url, destination_url, starts_at, ends_at, status) values ('Z','zzz','Zed','https://cdn.example.kz/z.png','https://z.example.kz', now(), now() + interval '5 days', 'active')$$, 'max_active_campaigns');
select pg_temp.raises('direct SQL: switching an active campaign to a non-whitelisted image host refused', format('update ad_campaigns set creative_url = ''https://evil.example.org/a.png'' where id = %s', current_setting('t.c')), 'creative_host_not_allowed');
select pg_temp.raises('direct SQL: javascript: destination refused', $$insert into ad_campaigns (sponsor_name, category, headline, creative_url, destination_url, starts_at, ends_at) values ('Z','zzz','Zed','https://cdn.example.kz/z.png','javascript:alert(1)', now(), now() + interval '5 days')$$, 'invalid_destination_url');
select pg_temp.ok('exactly 3 active sponsors', (select count(*) = 3 from ad_campaigns where kind = 'sponsor' and status = 'active'));
select pg_temp.ok('active categories are distinct', (select count(distinct category) = 3 from ad_campaigns where kind = 'sponsor' and status = 'active'));

-- ===== serving =====
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('ads disabled globally: still empty', jsonb_array_length(get_ads()->'ads') = 0);
reset role;
update ad_config set ads_enabled = true;
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('free user gets the 3 sponsor campaigns', (select (g->>'show_ads')::boolean and jsonb_array_length(g->'ads') = 3 and not (g->>'fallback')::boolean from (select get_ads() g) x));
select pg_temp.ok('payload carries display fields only', (select not exists (select 1 from jsonb_array_elements(get_ads()->'ads') a, jsonb_object_keys(a) k where k not in ('id','kind','sponsor_name','headline','body','creative_url','creative_alt','destination_url'))));
select pg_temp.ok('payload never exposes admin fields / category / status', (select not (get_ads()::text ~ '(created_by|updated_by|status|category)')));
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', false) is not null;
select pg_temp.ok('active supporter receives no ads', (select (g->'ads') = '[]'::jsonb and not (g->>'show_ads')::boolean from (select get_ads() g) x));
reset role;
-- supporter whose period ended is a free user again
update accounts set supporter_until = now() - interval '1 day' where email = 'sup@example.kz';
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', false) is not null;
select pg_temp.ok('expired supporter receives ads again', jsonb_array_length(get_ads()->'ads') = 3);
reset role;
update accounts set supporter_until = now() + interval '20 days' where email = 'sup@example.kz';

-- a scheduled (future) campaign is not served yet
reset role; alter table ad_campaigns disable trigger ad_campaigns_guard;
update ad_campaigns set starts_at = now() + interval '2 days', ends_at = now() + interval '30 days' where id = current_setting('t.e')::bigint;
alter table ad_campaigns enable trigger ad_campaigns_guard;
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('not-yet-started campaign is not served', (select jsonb_array_length(get_ads()->'ads') = 2));
reset role;

-- ===== expiration =====
alter table ad_campaigns disable trigger ad_campaigns_guard;
update ad_campaigns set starts_at = now() - interval '10 days', ends_at = now() - interval '1 minute' where id = current_setting('t.a')::bigint;
alter table ad_campaigns enable trigger ad_campaigns_guard;
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('an ended campaign is not served even before the sweep', (select jsonb_array_length(get_ads()->'ads') = 1));
reset role;
select pg_temp.ok('get_ads swept it: status expired', (select status = 'expired' from ad_campaigns where id = current_setting('t.a')::bigint));
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000009', false) is not null;
select pg_temp.raises('expired campaign cannot be reactivated', format('select admin_ad_set_status(%s, ''active'')', current_setting('t.a')), 'campaign_expired');
select pg_temp.raises('expired campaign cannot be edited', format('select admin_ad_save(%s, ''{"headline":"zz"}'')', current_setting('t.a')), 'campaign_expired');
select pg_temp.ok('expiry frees the category and the slot: B (finance) activates', (admin_ad_set_status(current_setting('t.b')::bigint, 'active')->>'status') = 'active');
select pg_temp.ok('admin list shows expired + counts config', (select (l->>'max_active_sponsors')::int = 3 and exists (select 1 from jsonb_array_elements(l->'campaigns') c where (c->>'status') = 'expired') from (select admin_ad_list() l) x));
select pg_temp.ok('admin can end a campaign early', (admin_ad_set_status(current_setting('t.b')::bigint, 'expired')->>'status') = 'expired');
reset role;
-- a stale ACTIVE row never blocks a new activation (the guard sweeps it)
alter table ad_campaigns disable trigger ad_campaigns_guard;
update ad_campaigns set ends_at = now() - interval '1 minute', starts_at = now() - interval '3 days' where id = current_setting('t.c')::bigint;
alter table ad_campaigns enable trigger ad_campaigns_guard;
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000009', false) is not null;
select pg_temp.ok('stale active row swept by the guard: logistics category free again', (select (admin_ad_set_status(current_setting('t.d')::bigint, 'active')->>'status') = 'active'));
reset role;

-- ===== fallback =====
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000009', false) is not null;
select pg_temp.raises('internal ad: foreign destination refused', $$select admin_ad_save(null, '{"kind":"internal","sponsor_name":"SaudaPulse","headline":"Referral","destination_url":"https://evil.example.org/x","starts_at":"2020-01-01T00:00:00Z"}')$$, 'internal_destination_not_allowed');
select set_config('t.i', admin_ad_save(null, '{"kind":"internal","sponsor_name":"SaudaPulse","headline":"Invite a friend","body":"Get +14 days","destination_url":"https://saudapulse.kz/ref","starts_at":"2020-01-01T00:00:00Z"}')->>'id', false) is not null;
select pg_temp.ok('internal campaign needs no category/asset/end date, activates', (admin_ad_set_status(current_setting('t.i')::bigint, 'active')->>'status') = 'active');
reset role;
select pg_temp.ok('internal campaigns do not count towards the sponsor cap', (select count(*) filter (where kind = 'internal' and status = 'active') = 1 and count(*) filter (where kind = 'sponsor' and status = 'active') = 2 from ad_campaigns));
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('sponsors available → no internal fallback in the list', (select not (g->>'fallback')::boolean and not exists (select 1 from jsonb_array_elements(g->'ads') a where a->>'kind' = 'internal') from (select get_ads() g) x));
reset role;
update ad_campaigns set status = 'suspended' where kind = 'sponsor' and status = 'active';
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('no sponsor servable → internal fallback served', (select (g->>'fallback')::boolean and jsonb_array_length(g->'ads') = 1 and g->'ads'->0->>'kind' = 'internal' from (select get_ads() g) x));
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', false) is not null;
select pg_temp.ok('supporter gets no fallback either', (select (g->'ads') = '[]'::jsonb from (select get_ads() g) x));
reset role;

-- ===== counters: aggregate only, eligible users only =====
update ad_campaigns set status = 'active' where id = current_setting('t.d')::bigint;
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('impression counted for a free user', ad_record(current_setting('t.d')::bigint, 'impression'));
select pg_temp.ok('click counted for a free user', ad_record(current_setting('t.d')::bigint, 'click'));
select pg_temp.raises('unknown event refused', format('select ad_record(%s, ''hover'')', current_setting('t.d')), 'invalid_event');
select pg_temp.ok('inactive/unknown campaign: not counted, no error', not ad_record(999999, 'click') and not ad_record(current_setting('t.b')::bigint, 'click'));
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', false) is not null;
select pg_temp.ok('supporter events are ignored', not ad_record(current_setting('t.d')::bigint, 'impression'));
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000009', false) is not null;
reset role; update ad_config set ads_enabled = false;
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('kill switch off: counters do not move', not ad_record(current_setting('t.d')::bigint, 'impression'));
reset role; update ad_config set ads_enabled = true;
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000009', false) is not null;
select pg_temp.ok('admin sees the aggregate: 1 impression, 1 click', (select (s->0->>'impressions')::int = 1 and (s->0->>'clicks')::int = 1 from (select admin_ad_stats(current_setting('t.d')::bigint) s) x));
reset role;
select pg_temp.ok('counters hold no user or business data (columns are exactly campaign_id, day, impressions, clicks)', (select array_agg(column_name::text order by column_name) = array['campaign_id','clicks','day','impressions'] from information_schema.columns where table_name = 'ad_stats' and table_schema = 'public'));
select pg_temp.ok('campaign table holds no user data columns except admin audit ids', (select not exists (select 1 from information_schema.columns where table_name = 'ad_campaigns' and table_schema = 'public' and column_name ~ '(user|order|customer|product|supplier|price|revenue|token|email)')));

-- ===== failure isolation: advertising errors never reach the caller; business functions are unaffected =====
alter table ad_campaigns rename column headline to headline_x;   -- break the ad backend on purpose
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('broken ad backend: get_ads answers an empty list, no exception', (select g->>'error' = 'unavailable' and (g->'ads') = '[]'::jsonb from (select get_ads() g) x));
reset role; alter table ad_stats rename column day to day_x; set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('broken ad backend: ad_record answers false, no exception', not ad_record(current_setting('t.d')::bigint, 'click'));
reset role; alter table ad_stats rename column day_x to day; set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('broken ad backend: price-list feed (business function) still works', (select ensure_price_feed('shop-ads1')->>'feed_id' is not null));
select pg_temp.ok('broken ad backend: licence + entitlements still work', get_license(1) is not null and get_entitlements()->>'status' = 'free');
reset role;
alter table ad_campaigns rename column headline_x to headline;
-- with ads fully active, business functions are identical for free and supporter
set role authenticated; select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', false) is not null;
select pg_temp.ok('free user with ads on: all business functions available', (select ensure_price_feed('shop-ads2')->>'feed_id' is not null));
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', false) is not null;
select pg_temp.ok('supporter: same business functions', (select ensure_price_feed('shop-ads3')->>'feed_id' is not null));
reset role;
