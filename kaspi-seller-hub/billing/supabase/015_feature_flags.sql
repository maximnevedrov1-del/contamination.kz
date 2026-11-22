-- 015_feature_flags.sql  (after 014_retention_and_deletion.sql)
-- Remote feature flags (UX gating only: not signed, not a security boundary — paid features and
-- limits stay on the signed licence and server checks).
--  1. public.feature_flags: key, enabled, rollout_percent (0..100), allow_emails, description.
--     No direct access for clients; admins work through the admin_*_feature_flag(s) RPCs.
--  2. feature_flags_for(user, email): internal; a flag is on when enabled, or the email is in
--     allow_emails, or the user falls into the rollout bucket (stable hash of the user id).
--  3. get_license() additionally returns `features` ({key: boolean}); all old keys stay unchanged.
--     Patched via pg_get_functiondef + replace (as in 012), so grants and the live body are kept.
--  4. admin_set_feature_flag / admin_list_feature_flags / admin_delete_feature_flag (admin only).
begin;

create table public.feature_flags (
  flag_key        text primary key check (flag_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  enabled         boolean not null default false,
  rollout_percent integer not null default 0 check (rollout_percent between 0 and 100),
  allow_emails    text[] not null default '{}',
  description     text,
  updated_at      timestamptz not null default now()
);
alter table public.feature_flags enable row level security;
revoke all on public.feature_flags from public, anon, authenticated;

-- Bucket = ((hashtext(user)::bigint % 100) + 100) % 100. The bigint form is used instead of
-- abs(hashtext(..)) % 100 because abs(-2147483648) overflows int4 and would raise an error.
create or replace function public.feature_flags_for(p_user uuid, p_email text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(flag_key,
    enabled
    or lower(coalesce(p_email, '')) = any(allow_emails)
    or (rollout_percent > 0 and ((hashtext(p_user::text)::bigint % 100 + 100) % 100) < rollout_percent)
  ), '{}'::jsonb)
  from public.feature_flags
$$;
revoke all on function public.feature_flags_for(uuid, text) from public, anon, authenticated;

do $$
declare d text := pg_get_functiondef('public.get_license(integer,text[])'::regprocedure);
        old_s text := '''server_time'', now()';
        new_s text := '''server_time'', now(), ''features'', public.feature_flags_for(acc.user_id, acc.email)';
begin
  if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
    raise exception 'get_license: expected exactly one "%"', old_s;
  end if;
  execute replace(d, old_s, new_s);
end $$;

create or replace function public.admin_set_feature_flag(
  p_key text, p_enabled boolean, p_rollout_percent int default 0,
  p_allow_emails text[] default '{}', p_description text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare emails text[]; r public.feature_flags;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_key is null or p_key !~ '^[a-z][a-z0-9_]{1,62}$' then
    raise exception 'invalid flag key' using errcode = '22023';
  end if;
  if p_rollout_percent is null or p_rollout_percent not between 0 and 100 then
    raise exception 'rollout_percent must be 0..100' using errcode = '22023';
  end if;
  select coalesce(array_agg(e order by e), '{}') into emails from (
    select distinct lower(btrim(x)) e from unnest(coalesce(p_allow_emails, '{}')) x
    where btrim(coalesce(x, '')) <> '' limit 200) s;
  insert into public.feature_flags (flag_key, enabled, rollout_percent, allow_emails, description, updated_at)
  values (p_key, coalesce(p_enabled, false), p_rollout_percent, emails, nullif(btrim(p_description), ''), now())
  on conflict (flag_key) do update set enabled = excluded.enabled, rollout_percent = excluded.rollout_percent,
    allow_emails = excluded.allow_emails, description = excluded.description, updated_at = now()
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.admin_list_feature_flags()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(f) order by f.flag_key) from public.feature_flags f), '[]'::jsonb);
end $$;

create or replace function public.admin_delete_feature_flag(p_key text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.feature_flags where flag_key = p_key;
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function public.admin_set_feature_flag(text, boolean, int, text[], text) from public, anon;
revoke all on function public.admin_list_feature_flags() from public, anon;
revoke all on function public.admin_delete_feature_flag(text) from public, anon;
grant execute on function public.admin_set_feature_flag(text, boolean, int, text[], text) to authenticated;
grant execute on function public.admin_list_feature_flags() to authenticated;
grant execute on function public.admin_delete_feature_flag(text) to authenticated;

commit;
