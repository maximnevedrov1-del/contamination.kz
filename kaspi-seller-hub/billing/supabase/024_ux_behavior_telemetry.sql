-- Seller Hub: anonymous UX behaviour telemetry (where sellers get stuck). Safe to run again. Apply AFTER 023_client_errors_and_retention.sql.
-- Stores only counters keyed by short whitelisted codes: event type + control key + screen key. No text, URLs, values or Kaspi data.
-- The extension calls track_ux_event(type, target_key, screen_key); admins read admin_ux_summary().
begin;

create table if not exists public.ux_events (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  event_type text not null check (event_type in ('screen_view', 'action_click', 'rage_click', 'form_abandoned', 'help_opened')),
  target_key text not null check (target_key ~ '^[a-z0-9_:-]{1,64}$' and target_key !~ '^[0-9]+$'),
  screen_key text not null check (screen_key ~ '^[a-z0-9_:-]{1,64}$' and screen_key !~ '^[0-9]+$'),
  occurrences int not null default 1 check (occurrences between 1 and 1000000),
  last_seen_at timestamptz not null default now(),
  unique (user_id, event_type, target_key, screen_key)
);
alter table public.ux_events enable row level security;
revoke all on public.ux_events from public, anon, authenticated;
revoke all on sequence public.ux_events_id_seq from public, anon, authenticated;
create index if not exists ux_events_type_idx on public.ux_events (event_type, target_key, screen_key);

-- one row per (type, control, screen) per user; a user keeps at most 100 distinct rows (new ones beyond that are ignored silently)
create or replace function public.track_ux_event(p_event_type text, p_target_key text, p_screen_key text)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  n int;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_event_type is null or p_event_type not in ('screen_view', 'action_click', 'rage_click', 'form_abandoned', 'help_opened') then
    raise exception 'invalid_ux_event' using errcode = '22023';
  end if;
  if p_target_key is null or p_target_key !~ '^[a-z0-9_:-]{1,64}$' or p_target_key ~ '^[0-9]+$'
     or p_screen_key is null or p_screen_key !~ '^[a-z0-9_:-]{1,64}$' or p_screen_key ~ '^[0-9]+$' then
    raise exception 'invalid_ux_key' using errcode = '22023';
  end if;
  update public.ux_events
     set occurrences = least(occurrences + 1, 1000000), last_seen_at = now()
   where user_id = uid and event_type = p_event_type and target_key = p_target_key and screen_key = p_screen_key;
  get diagnostics n = row_count;
  if n > 0 then return; end if;
  if (select count(*) from public.ux_events where user_id = uid) >= 100 then return; end if;
  insert into public.ux_events (user_id, event_type, target_key, screen_key)
  values (uid, p_event_type, p_target_key, p_screen_key)
  on conflict (user_id, event_type, target_key, screen_key)
  do update set occurrences = least(public.ux_events.occurrences + 1, 1000000), last_seen_at = now();
end $$;

-- admin only: friction points (rage clicks, abandoned forms, help opened) and most / least viewed screens
create or replace function public.admin_ux_summary()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'friction', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.occurrences desc, x.users desc)
      from (
        select event_type, target_key, screen_key,
               count(distinct user_id)::int as users, sum(occurrences)::bigint as occurrences
          from public.ux_events
         where event_type in ('rage_click', 'form_abandoned', 'help_opened')
         group by event_type, target_key, screen_key
         order by sum(occurrences) desc, count(distinct user_id) desc
         limit 50
      ) x), '[]'::jsonb),
    'top_screens', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.views desc)
      from (
        select screen_key, count(distinct user_id)::int as users, sum(occurrences)::bigint as views
          from public.ux_events where event_type = 'screen_view'
         group by screen_key order by sum(occurrences) desc limit 10
      ) x), '[]'::jsonb),
    'least_screens', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.views asc)
      from (
        select screen_key, count(distinct user_id)::int as users, sum(occurrences)::bigint as views
          from public.ux_events where event_type = 'screen_view'
         group by screen_key order by sum(occurrences) asc limit 10
      ) x), '[]'::jsonb)
  );
end $$;

revoke execute on function public.track_ux_event(text, text, text), public.admin_ux_summary() from public, anon, authenticated;
grant execute on function public.track_ux_event(text, text, text), public.admin_ux_summary() to authenticated;

commit;
