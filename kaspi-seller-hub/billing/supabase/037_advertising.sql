-- Seller Hub: advertising backend — Stage 05. Safe to run again. Apply AFTER 036_supporter.sql, then grants.sql.
--
-- Model: at most THREE simultaneously active SPONSOR campaigns, one per category (exclusive), plus any number of
-- INTERNAL SaudaPulse campaigns used only as fallback when no sponsor is servable. Ads are shown only to accounts
-- that get_entitlements() (036) says are not ad-free. Advertising never gates anything: get_ads() cannot fail a
-- caller's business flow (it answers an empty list on any internal error), and nothing in this file touches
-- has_access(), store_cap(), ensure_price_feed() or any business table.
--
-- Privacy: no per-user ad data exists. get_ads() logs nothing. ad_record() adds to a DAILY COUNTER per campaign; the
-- caller's id is not stored, nor any order, product, customer, supplier, price, revenue or marketplace data.
-- Clicks go straight to the sponsor's URL (no redirect through us). No third-party scripts or pixels: creatives are
-- plain https images from hosts the owner whitelisted (ad_config.asset_hosts, empty by default = no sponsor image can be
-- activated), no query string, no fragment.
--
-- (a) ad_config: kill switch (ads_enabled = false by default), allowed image hosts, internal destination hosts.
-- (b) ad_campaigns: the data + a guard trigger (the SERVER-SIDE limit, category exclusivity, URL and date rules) that
--     also protects against direct DML by any role.
-- (c) ad_stats: daily aggregate counters.
-- (d) admin_ad_* (is_admin() inside) and the client endpoints get_ads() / ad_record().
begin;

-- ---------- validation helpers (pure) ----------
create or replace function public.ad_valid_url(p text, p_image boolean default false)
returns boolean language sql immutable set search_path = public as $$
  select p is not null
     and length(p) <= 500
     and p like 'https://%'                                  -- the scheme is lowercase literally (host checks below are exact-match)
     and lower(substring(p from '^https://([^/?#]+)')) !~ '\.(local|localhost|internal|lan|corp|home|test|invalid|example)$'
     and length(substring(p from '^https://([^/?#]+)')) <= 253
     -- https only; a DNS name with a letter TLD (so no IP literal, no localhost, no userinfo, no port); no spaces or markup
     and p ~* '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}|xn--[a-z0-9-]{2,20})(/[^\s<>"''\\#]*)?$'
     and (not p_image or p ~* '^https://[^/?#]+/[^?#\s]*\.(png|jpe?g|webp)$')   -- images: no SVG, no query string
$$;

create or replace function public.ad_url_host(p text)
returns text language sql immutable set search_path = public as $$
  select substring(lower(p) from '^https://([^/?#]+)')
$$;

-- ---------- (a) configuration ----------
create table if not exists public.ad_config (
  id             int primary key default 1 check (id = 1),
  ads_enabled    boolean not null default false,
  asset_hosts    text[]  not null default '{}',
  internal_hosts text[]  not null default '{saudapulse.kz,www.saudapulse.kz}',
  updated_at     timestamptz not null default now()
);
insert into public.ad_config (id) values (1) on conflict (id) do nothing;
alter table public.ad_config enable row level security;
revoke all on public.ad_config from public, anon, authenticated;

-- ---------- (b) campaigns ----------
create table if not exists public.ad_campaigns (
  id              bigint generated always as identity primary key,
  kind            text not null default 'sponsor' check (kind in ('sponsor', 'internal')),
  sponsor_name    text not null check (length(btrim(sponsor_name)) between 2 and 80),
  category        text check (category is null or category ~ '^[a-z][a-z0-9_-]{1,31}$'),
  headline        text not null check (length(btrim(headline)) between 2 and 80),
  body            text check (body is null or length(body) <= 200),
  creative_url    text,
  creative_alt    text check (creative_alt is null or length(creative_alt) <= 120),
  destination_url text not null,
  starts_at       timestamptz not null,
  ends_at         timestamptz,
  status          text not null default 'draft' check (status in ('draft', 'active', 'suspended', 'expired')),
  created_at      timestamptz not null default now(),
  created_by      uuid,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  check (kind = 'internal' or (category is not null and creative_url is not null and ends_at is not null)),
  check (ends_at is null or ends_at > starts_at),
  check (ends_at is null or ends_at <= starts_at + interval '366 days'),
  check (kind = 'sponsor' or category is null)
);
alter table public.ad_campaigns enable row level security;
revoke all on public.ad_campaigns from public, anon, authenticated;
create index if not exists ad_campaigns_status on public.ad_campaigns (status, kind);

-- Every write passes here: URL rules always, and — whenever a row is (or becomes) ACTIVE — the date window, the image host
-- whitelist, the cap of three active sponsors and the one-active-campaign-per-category rule. A row whose end has passed
-- is expired first, so a forgotten campaign never blocks a new one. Serialised by an advisory lock (no race to a 4th).
create or replace function public.ad_campaigns_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare c public.ad_config; n int;
begin
  new.sponsor_name := btrim(new.sponsor_name);
  new.headline := btrim(new.headline);
  new.category := nullif(lower(btrim(coalesce(new.category, ''))), '');
  new.updated_at := now();
  -- suspending or expiring must always succeed (also when the owner changed the host lists meanwhile), as long as the creative is untouched
  if tg_op = 'UPDATE' and new.status in ('suspended', 'expired') and new.destination_url = old.destination_url
     and new.creative_url is not distinct from old.creative_url then
    return new;
  end if;
  if not public.ad_valid_url(new.destination_url) then raise exception 'invalid_destination_url' using errcode = '22023'; end if;
  if new.creative_url is not null and not public.ad_valid_url(new.creative_url, true) then raise exception 'invalid_creative_url' using errcode = '22023'; end if;
  select * into c from public.ad_config where id = 1;
  if new.kind = 'internal' and not coalesce(public.ad_url_host(new.destination_url) = any (c.internal_hosts), false) then
    raise exception 'internal_destination_not_allowed' using errcode = '22023';
  end if;
  if new.status = 'active' then
    perform pg_advisory_xact_lock(hashtext('ad_campaigns_active'));
    update public.ad_campaigns set status = 'expired', updated_at = now()
      where status = 'active' and ends_at is not null and ends_at <= now() and id is distinct from new.id;
    if new.ends_at is not null and new.ends_at <= now() then raise exception 'campaign_window_over' using errcode = '22023'; end if;
    if new.creative_url is not null and not coalesce(public.ad_url_host(new.creative_url) = any (c.asset_hosts), false) then
      raise exception 'creative_host_not_allowed' using errcode = '22023';
    end if;
    if new.kind = 'sponsor' then
      select count(*) into n from public.ad_campaigns where kind = 'sponsor' and status = 'active' and id is distinct from new.id;
      if n >= 3 then raise exception 'max_active_campaigns' using errcode = '23P01'; end if;
      if exists (select 1 from public.ad_campaigns where kind = 'sponsor' and status = 'active' and category = new.category and id is distinct from new.id) then
        raise exception 'category_conflict' using errcode = '23P01';
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ad_campaigns_guard on public.ad_campaigns;
create trigger ad_campaigns_guard before insert or update on public.ad_campaigns for each row execute function public.ad_campaigns_guard();

-- Expiry: called by every admin read and by get_ads(); also safe to schedule (pg_cron / the ops job).
create or replace function public.expire_ad_campaigns()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.ad_campaigns set status = 'expired', updated_at = now()
    where status in ('active', 'suspended') and ends_at is not null and ends_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.expire_ad_campaigns() from public, anon, authenticated;
grant execute on function public.expire_ad_campaigns() to service_role;

-- ---------- (c) aggregate counters ----------
-- Counters are INDICATIVE: any ad-eligible user can add to them (no per-user limit exists, by design, for privacy). Do not bill on them.
create table if not exists public.ad_stats (
  campaign_id bigint not null references public.ad_campaigns (id) on delete cascade,
  day         date   not null,
  impressions bigint not null default 0 check (impressions >= 0),
  clicks      bigint not null default 0 check (clicks >= 0),
  primary key (campaign_id, day)
);
alter table public.ad_stats alter column impressions type bigint, alter column clicks type bigint;   -- older copies of this file used int
alter table public.ad_stats enable row level security;
revoke all on public.ad_stats from public, anon, authenticated;

-- ---------- (d) administration ----------
create or replace function public.ad_row_json(c public.ad_campaigns)
returns jsonb language sql stable set search_path = public as $$
  select to_jsonb(c) - 'created_by' - 'updated_by' || jsonb_build_object('servable', c.status = 'active' and c.starts_at <= now() and (c.ends_at is null or c.ends_at > now()))
$$;
revoke execute on function public.ad_row_json(public.ad_campaigns) from public, anon, authenticated;

create or replace function public.admin_ad_list(p_status text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public.expire_ad_campaigns();
  return jsonb_build_object(
    'config', (select jsonb_build_object('ads_enabled', ads_enabled, 'asset_hosts', asset_hosts, 'internal_hosts', internal_hosts) from public.ad_config where id = 1),
    'max_active_sponsors', 3,
    'campaigns', coalesce((select jsonb_agg(public.ad_row_json(c) order by c.id desc) from public.ad_campaigns c where p_status is null or c.status = p_status), '[]'::jsonb));
end $$;

-- Create (p_id null) or edit. Only whitelisted keys are read; status is NOT settable here (admin_ad_set_status).
-- A new row is a draft. Editing an ACTIVE row re-runs every activation rule (the trigger).
create or replace function public.admin_ad_save(p_id bigint, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.ad_campaigns;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_payload' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('ad_campaigns_active'));   -- same order as the guard trigger: no admin/admin deadlock
  perform public.expire_ad_campaigns();
  if p_id is null then
    insert into public.ad_campaigns (kind, sponsor_name, category, headline, body, creative_url, creative_alt, destination_url, starts_at, ends_at, created_by, updated_by)
    values (coalesce(p->>'kind', 'sponsor'), p->>'sponsor_name', p->>'category', p->>'headline', p->>'body', nullif(p->>'creative_url', ''), p->>'creative_alt',
            p->>'destination_url', (p->>'starts_at')::timestamptz, nullif(p->>'ends_at', '')::timestamptz, auth.uid(), auth.uid())
    returning * into r;
  else
    select * into r from public.ad_campaigns where id = p_id for update;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
    if r.status = 'expired' then raise exception 'campaign_expired' using errcode = '22023'; end if;
    update public.ad_campaigns set
      kind = coalesce(p->>'kind', kind),
      sponsor_name = coalesce(p->>'sponsor_name', sponsor_name),
      category = case when p ? 'category' then p->>'category' else category end,
      headline = coalesce(p->>'headline', headline),
      body = case when p ? 'body' then p->>'body' else body end,
      creative_url = case when p ? 'creative_url' then nullif(p->>'creative_url', '') else creative_url end,
      creative_alt = case when p ? 'creative_alt' then p->>'creative_alt' else creative_alt end,
      destination_url = coalesce(p->>'destination_url', destination_url),
      starts_at = coalesce((p->>'starts_at')::timestamptz, starts_at),
      ends_at = case when p ? 'ends_at' then nullif(p->>'ends_at', '')::timestamptz else ends_at end,
      updated_by = auth.uid()
    where id = p_id returning * into r;
  end if;
  return public.ad_row_json(r);
end $$;

-- draft|suspended → active; active → suspended; draft|active|suspended → expired. Expired is final (create a new campaign).
create or replace function public.admin_ad_set_status(p_id bigint, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.ad_campaigns;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('active', 'suspended', 'expired') then raise exception 'invalid_status' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('ad_campaigns_active'));
  perform public.expire_ad_campaigns();
  select * into r from public.ad_campaigns where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.status = 'expired' then raise exception 'campaign_expired' using errcode = '22023'; end if;
  if (p_status = 'active' and r.status not in ('draft', 'suspended')) or (p_status = 'suspended' and r.status <> 'active') then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  update public.ad_campaigns set status = p_status, updated_by = auth.uid() where id = p_id returning * into r;  -- guard trigger enforces the rules
  return public.ad_row_json(r);
end $$;

create or replace function public.admin_ad_config(p_enabled boolean default null, p_asset_hosts text[] default null, p_internal_hosts text[] default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare h text;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  foreach h in array coalesce(p_asset_hosts, '{}') || coalesce(p_internal_hosts, '{}') loop
    if h is null or h !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}|xn--[a-z0-9-]{2,20})$' then raise exception 'invalid_host' using errcode = '22023'; end if;
  end loop;
  update public.ad_config set
    ads_enabled = coalesce(p_enabled, ads_enabled),
    asset_hosts = coalesce(p_asset_hosts, asset_hosts),
    internal_hosts = coalesce(p_internal_hosts, internal_hosts),
    updated_at = now()
  where id = 1;
  return (select jsonb_build_object('ads_enabled', ads_enabled, 'asset_hosts', asset_hosts, 'internal_hosts', internal_hosts) from public.ad_config where id = 1);
end $$;

create or replace function public.admin_ad_stats(p_id bigint default null, p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('campaign_id', campaign_id, 'impressions', i, 'clicks', k) order by campaign_id)
    from (select campaign_id, sum(impressions) i, sum(clicks) k from public.ad_stats
           where (p_id is null or campaign_id = p_id) and day >= current_date - least(greatest(coalesce(p_days, 30), 1), 366)
           group by campaign_id) x), '[]'::jsonb);
end $$;

-- ---------- client endpoints ----------
-- What may be shown to THIS user right now. Eligibility comes from the existing supporter entitlement (get_entitlements);
-- an active supporter, a disabled ad system, or any internal error answers an empty list. Sponsors (≤ 3) first; internal
-- campaigns only when no sponsor is servable. Output carries display fields only.
create or replace function public.get_ads()
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); on_ boolean; sp jsonb; res jsonb;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  begin
    select ads_enabled into on_ from public.ad_config where id = 1;
    if not coalesce(on_, false) or not coalesce((public.get_entitlements()->>'show_ads')::boolean, true) then
      return jsonb_build_object('show_ads', coalesce((public.get_entitlements()->>'show_ads')::boolean, true), 'ads', '[]'::jsonb, 'fallback', false);
    end if;
    perform public.expire_ad_campaigns();
    select coalesce(jsonb_agg(x order by x.id), '[]'::jsonb) into sp from (
      select id, kind, sponsor_name, headline, body, creative_url, creative_alt, destination_url
        from public.ad_campaigns
       where kind = 'sponsor' and status = 'active' and starts_at <= now() and ends_at > now() order by id limit 3) x;
    if jsonb_array_length(sp) > 0 then
      return jsonb_build_object('show_ads', true, 'ads', sp, 'fallback', false);
    end if;
    select coalesce(jsonb_agg(x order by x.id), '[]'::jsonb) into res from (
      select id, kind, sponsor_name, headline, body, creative_url, creative_alt, destination_url
        from public.ad_campaigns
       where kind = 'internal' and status = 'active' and starts_at <= now() and (ends_at is null or ends_at > now()) order by id limit 3) x;
    return jsonb_build_object('show_ads', true, 'ads', res, 'fallback', jsonb_array_length(res) > 0);
  exception when others then
    -- advertising must never break the caller
    return jsonb_build_object('show_ads', true, 'ads', '[]'::jsonb, 'fallback', false, 'error', 'unavailable');
  end;
end $$;

-- A shown / clicked ad: +1 on the campaign's daily counter. Nothing about the caller is stored. Only servable campaigns
-- and only for accounts that are eligible for ads count, so a supporter or a stale id changes nothing.
create or replace function public.ad_record(p_campaign bigint, p_event text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_event is null or p_event not in ('impression', 'click') then raise exception 'invalid_event' using errcode = '22023'; end if;
  begin
    if not coalesce((select ads_enabled from public.ad_config where id = 1), false) then return false; end if;
    if not coalesce((public.get_entitlements()->>'show_ads')::boolean, true) then return false; end if;
    if not exists (select 1 from public.ad_campaigns c where c.id = p_campaign and c.status = 'active' and c.starts_at <= now() and (c.ends_at is null or c.ends_at > now())) then return false; end if;
    insert into public.ad_stats (campaign_id, day, impressions, clicks)
    values (p_campaign, current_date, (p_event = 'impression')::int, (p_event = 'click')::int)
    on conflict (campaign_id, day) do update set impressions = ad_stats.impressions + excluded.impressions, clicks = ad_stats.clicks + excluded.clicks;
    return true;
  exception when others then
    return false;   -- a counter must never break the caller
  end;
end $$;

revoke execute on function public.ad_valid_url(text, boolean), public.ad_url_host(text), public.ad_campaigns_guard() from public, anon, authenticated;
revoke execute on function public.admin_ad_list(text), public.admin_ad_save(bigint, jsonb), public.admin_ad_set_status(bigint, text),
  public.admin_ad_config(boolean, text[], text[]), public.admin_ad_stats(bigint, int), public.get_ads(), public.ad_record(bigint, text) from public, anon;
grant execute on function public.admin_ad_list(text), public.admin_ad_save(bigint, jsonb), public.admin_ad_set_status(bigint, text),
  public.admin_ad_config(boolean, text[], text[]), public.admin_ad_stats(bigint, int), public.get_ads(), public.ad_record(bigint, text) to authenticated;  -- admin_*: is_admin() inside

commit;
