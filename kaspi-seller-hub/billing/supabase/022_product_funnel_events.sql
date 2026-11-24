-- Seller Hub: product funnel events (one row per user per milestone, no business data). Safe to run again. Apply AFTER 021_admin_referral_info.sql.
-- Events: onboarding_completed, first_sync_done, trial_expired_view, invoice_created, referral_shared.
-- The extension calls track_funnel_event(event) once per event; admins read counts via admin_funnel_events().
begin;

create table if not exists public.funnel_events (
  user_id uuid not null references auth.users on delete cascade,
  event text not null check (event in ('onboarding_completed', 'first_sync_done', 'trial_expired_view', 'invoice_created', 'referral_shared')),
  created_at timestamptz default now(),
  primary key (user_id, event)
);
alter table public.funnel_events enable row level security;
revoke all on public.funnel_events from public, anon, authenticated;

create or replace function public.track_funnel_event(p_event text)
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n int;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_event is null or p_event not in ('onboarding_completed', 'first_sync_done', 'trial_expired_view', 'invoice_created', 'referral_shared') then
    raise exception 'bad_event';
  end if;
  insert into public.funnel_events (user_id, event) values (uid, p_event) on conflict do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- admin only: how many accounts reached each milestone
create or replace function public.admin_funnel_events()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_object_agg(event, c) from (select event, count(*) c from public.funnel_events group by event) x), '{}'::jsonb);
end $$;

revoke execute on function public.track_funnel_event(text), public.admin_funnel_events() from public, anon, authenticated;
grant execute on function public.track_funnel_event(text), public.admin_funnel_events() to authenticated;

commit;
