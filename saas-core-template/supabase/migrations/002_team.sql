-- SaaS core — staff (packers) of a store owner. Run after 001_billing.sql; safe to re-run.
--
-- The owner adds a packer by e-mail. The packer signs in with a code from a letter (Supabase
-- Auth, as everyone) on the owner's warehouse computer and joins the owner's team. The owner can
-- switch the packer off at any time: the extension asks team_check() every few minutes and
-- logs the packer out when it fails.
--
-- Nothing about orders is stored here: the server only knows who may work for whom and which
-- stores (the extension's local store ids) they may see. Orders stay in the owner's browser.

create table if not exists public.team_members (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.accounts (user_id) on delete cascade,
  email        text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  name         text not null check (length(btrim(name)) between 1 and 60),
  role         text not null default 'packer' check (role in ('packer')),
  shop_ids     text[] not null default '{}' check (cardinality(shop_ids) <= 50),  -- empty = every store
  can_accept   boolean not null default false,                                     -- may press «Принять»
  status       text not null default 'invited' check (status in ('invited', 'active', 'disabled')),
  user_id      uuid references auth.users (id) on delete set null,
  invited_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  disabled_at  timestamptz,
  last_seen_at timestamptz
);
create unique index if not exists team_members_owner_email on public.team_members (owner_id, lower(email));
create index if not exists team_members_user on public.team_members (user_id);
alter table public.team_members enable row level security;
-- no table policies, no table rights: everything goes through the functions below
revoke all on public.team_members from public, anon, authenticated;

create or replace function public.has_access_of(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.accounts a, public.billing_config c
    where a.user_id = p_user and c.id = 1
      and (a.paid_until > now() or a.trial_ends_at > now())
      and a.terms_version is not distinct from c.terms_version);
$$;

create or replace function public.team_row(m public.team_members)
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', m.id, 'email', m.email, 'name', m.name, 'role', m.role, 'shop_ids', to_jsonb(m.shop_ids),
    'can_accept', m.can_accept, 'status', m.status, 'joined', m.user_id is not null,
    'invited_at', m.invited_at, 'accepted_at', m.accepted_at, 'disabled_at', m.disabled_at, 'last_seen_at', m.last_seen_at);
$$;

create or replace function public.clean_shop_ids(p text[])
returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct s), '{}') from unnest(coalesce(p, '{}')) s where s ~ '^[A-Za-z0-9_.:-]{1,64}$';
$$;

-- ---------- owner ----------

create or replace function public.team_invite(p_email text, p_name text, p_shop_ids text[] default '{}', p_can_accept boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); e text := lower(btrim(p_email)); m public.team_members; my_email text;
begin
  perform public.ensure_account();
  if not public.has_access() then raise exception 'subscription_required' using errcode = '42501'; end if;
  select lower(email) into my_email from auth.users where id = uid;
  if e = my_email then raise exception 'invite_self' using errcode = '22023'; end if;
  if (select count(*) from public.team_members where owner_id = uid) >= 20 then raise exception 'team_limit' using errcode = '42501'; end if;
  if (select count(*) from public.team_members where owner_id = uid and invited_at > now() - interval '1 day') >= 30 then
    raise exception 'rate_limited' using errcode = '42501';
  end if;
  select * into m from public.team_members where owner_id = uid and lower(email) = e;
  if found then
    -- invited again (e.g. after being switched off): a fresh invitation, history kept in the dates
    update public.team_members set name = btrim(p_name), shop_ids = public.clean_shop_ids(p_shop_ids), can_accept = coalesce(p_can_accept, false),
      status = 'invited', user_id = null, invited_at = now(), accepted_at = null, disabled_at = null
      where id = m.id returning * into m;
  else
    insert into public.team_members (owner_id, email, name, shop_ids, can_accept)
      values (uid, e, btrim(p_name), public.clean_shop_ids(p_shop_ids), coalesce(p_can_accept, false)) returning * into m;
  end if;
  return public.team_row(m);
end $$;

create or replace function public.team_list()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.team_row(m) order by m.status = 'disabled', m.invited_at desc), '[]')
  from public.team_members m where m.owner_id = auth.uid();
$$;

create or replace function public.team_update(p_id uuid, p_name text, p_shop_ids text[], p_can_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.team_members;
begin
  update public.team_members set name = btrim(p_name), shop_ids = public.clean_shop_ids(p_shop_ids), can_accept = coalesce(p_can_accept, false)
    where id = p_id and owner_id = auth.uid() returning * into m;
  if not found then raise exception 'not_found' using errcode = '42704'; end if;
  return public.team_row(m);
end $$;

-- Switch a packer off (fired) or back on. Takes effect at the packer's next check (≤ a few minutes).
create or replace function public.team_set_enabled(p_id uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.team_members;
begin
  update public.team_members set
      status = case when not p_enabled then 'disabled' when user_id is null then 'invited' else 'active' end,
      disabled_at = case when p_enabled then null else now() end
    where id = p_id and owner_id = auth.uid() returning * into m;
  if not found then raise exception 'not_found' using errcode = '42704'; end if;
  return public.team_row(m);
end $$;

create or replace function public.team_remove(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  delete from public.team_members where id = p_id and owner_id = auth.uid();
  if not found then raise exception 'not_found' using errcode = '42704'; end if;
  return true;
end $$;

-- ---------- packer ----------

-- The packer signed in (code from the letter) on the owner's warehouse computer: join that
-- owner's team. p_owner is the owner signed in to the extension on this computer.
create or replace function public.team_join(p_owner uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); my_email text; m public.team_members;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select lower(email) into my_email from auth.users where id = uid;
  select * into m from public.team_members where owner_id = p_owner and lower(email) = my_email;
  if not found then raise exception 'not_invited' using errcode = '42501'; end if;
  if m.status = 'disabled' then raise exception 'access_disabled' using errcode = '42501'; end if;
  if m.user_id is not null and m.user_id <> uid then raise exception 'not_invited' using errcode = '42501'; end if;
  if not public.has_access_of(p_owner) then raise exception 'owner_subscription_required' using errcode = '42501'; end if;
  update public.team_members set user_id = uid, status = 'active', accepted_at = coalesce(accepted_at, now()), last_seen_at = now()
    where id = m.id returning * into m;
  return public.team_row(m) || jsonb_build_object('owner_id', m.owner_id);
end $$;

-- Every few minutes while the packer works: still allowed? (Switched off → error → logged out.)
create or replace function public.team_check(p_owner uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.team_members;
begin
  select * into m from public.team_members where owner_id = p_owner and user_id = auth.uid();
  if not found or m.status <> 'active' then raise exception 'access_disabled' using errcode = '42501'; end if;
  if not public.has_access_of(p_owner) then raise exception 'owner_subscription_required' using errcode = '42501'; end if;
  update public.team_members set last_seen_at = now() where id = m.id returning * into m;
  return public.team_row(m) || jsonb_build_object('owner_id', m.owner_id);
end $$;

-- Supabase grants EXECUTE on new functions to anon and authenticated by default.
-- Only this file's functions are touched (re-running it never changes 001's grants).
revoke execute on function
  public.has_access_of(uuid), public.team_row(public.team_members), public.clean_shop_ids(text[]),
  public.team_invite(text, text, text[], boolean), public.team_list(), public.team_update(uuid, text, text[], boolean),
  public.team_set_enabled(uuid, boolean), public.team_remove(uuid), public.team_join(uuid), public.team_check(uuid)
from public, anon, authenticated;
grant execute on function
  public.team_invite(text, text, text[], boolean), public.team_list(), public.team_update(uuid, text, text[], boolean),
  public.team_set_enabled(uuid, boolean), public.team_remove(uuid), public.team_join(uuid), public.team_check(uuid)
to authenticated;
