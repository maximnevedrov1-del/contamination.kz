-- 016_system_banner.sql  (after 015_feature_flags.sql)
-- System banner: an announcement the admin can switch on for every extension user (incidents,
-- upstream layout changes). Text only, rendered by the client as plain text.
--  1. ops_settings: banner_active, banner_text (<= 300), banner_type (info|warn|danger), banner_updated_at.
--  2. system_banner(): internal, returns {"active","text","type"}; active only when switched on and text is non-empty.
--  3. get_license() additionally returns `system_banner`; patched via pg_get_functiondef + replace (as in 015).
--  4. admin_set_system_banner / admin_get_system_banner (admin only).
begin;

alter table public.ops_settings
  add column banner_active boolean not null default false,
  add column banner_text text check (banner_text is null or length(banner_text) <= 300),
  add column banner_type text not null default 'info' check (banner_type in ('info', 'warn', 'danger')),
  add column banner_updated_at timestamptz;

create or replace function public.system_banner()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'active', coalesce(o.banner_active and btrim(coalesce(o.banner_text, '')) <> '', false),
    'text', case when o.banner_active and btrim(coalesce(o.banner_text, '')) <> '' then o.banner_text else null end,
    'type', coalesce(o.banner_type, 'info'))
  from (select 1) d left join public.ops_settings o on o.id = 1
$$;
revoke all on function public.system_banner() from public, anon, authenticated;

do $$
declare d text := pg_get_functiondef('public.get_license(integer,text[])'::regprocedure);
        old_s text := '''features'', public.feature_flags_for(acc.user_id, acc.email)';
        new_s text := '''features'', public.feature_flags_for(acc.user_id, acc.email), ''system_banner'', public.system_banner()';
begin
  if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
    raise exception 'get_license: expected exactly one "%"', old_s;
  end if;
  execute replace(d, old_s, new_s);
end $$;

create or replace function public.admin_get_system_banner()
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object('active', banner_active, 'text', banner_text, 'type', banner_type,
                            'updated_at', banner_updated_at)
    into r from public.ops_settings where id = 1;
  return coalesce(r, jsonb_build_object('active', false, 'text', null, 'type', 'info', 'updated_at', null));
end $$;

create or replace function public.admin_set_system_banner(
  p_active boolean, p_text text default null, p_type text default 'info')
returns jsonb language plpgsql security definer set search_path = public as $$
declare t text := nullif(btrim(coalesce(p_text, '')), '');
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_type is null or p_type not in ('info', 'warn', 'danger') then
    raise exception 'type must be info, warn or danger' using errcode = '22023';
  end if;
  if t is not null and length(t) > 300 then
    raise exception 'text must be at most 300 characters' using errcode = '22023';
  end if;
  if coalesce(p_active, false) and t is null then
    raise exception 'text is required for an active banner' using errcode = '22023';
  end if;
  insert into public.ops_settings (id) values (1) on conflict (id) do nothing;
  update public.ops_settings set banner_active = coalesce(p_active, false), banner_text = t,
    banner_type = p_type, banner_updated_at = now() where id = 1;
  return public.admin_get_system_banner();
end $$;

revoke all on function public.admin_get_system_banner() from public, anon;
revoke all on function public.admin_set_system_banner(boolean, text, text) from public, anon;
grant execute on function public.admin_get_system_banner() to authenticated;
grant execute on function public.admin_set_system_banner(boolean, text, text) to authenticated;

commit;
