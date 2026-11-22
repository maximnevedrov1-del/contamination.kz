-- Seller Hub: client error reports (sanitized, aggregated per user) + retention nudges via the Telegram bot. Safe to run again. Apply AFTER 022_product_funnel_events.sql.
-- The extension calls report_client_error(code, context, version); admins read admin_client_errors().
-- The bot (service role) calls enqueue_retention_nudges() at the start of each run; texts go out as tg_outbox kind 'nudge'.
begin;

-- ---------- 1. client errors ----------
create table if not exists public.client_errors (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  error_code text not null check (char_length(error_code) <= 120),
  context text not null default '' check (char_length(context) <= 120),
  app_version text not null default '' check (char_length(app_version) <= 120),
  occurrences int not null default 1,
  last_seen_at timestamptz not null default now(),
  unique (user_id, error_code, context)
);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from public, anon, authenticated;
revoke all on sequence public.client_errors_id_seq from public, anon, authenticated;
create index if not exists client_errors_last_seen_idx on public.client_errors (last_seen_at desc);

-- strips anything that could identify a person or a business object, then limits the length
create or replace function public.sanitize_client_text(t text, n int default 120)
returns text language sql immutable set search_path = public as $$
  select left(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    coalesce(t, ''),
    'https?://\S+', ' ', 'gi'),
    'www\.\S+', ' ', 'gi'),
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+', ' ', 'g'),
    'bearer\s+\S+', ' ', 'gi'),
    'eyJ[A-Za-z0-9_.-]*', ' ', 'g'),
    '[A-Za-z0-9_.-]{24,}', ' ', 'g'),
    '[0-9]{4,}', '#', 'g'),
    '[[:cntrl:]]', ' ', 'g'),
    '\s+', ' ', 'g')), greatest(n, 0))
$$;
revoke execute on function public.sanitize_client_text(text, int) from public, anon, authenticated;

create or replace function public.report_client_error(p_code text, p_context text, p_version text)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  code text; ctx text; ver text; n int;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  code := left(regexp_replace(replace(lower(public.sanitize_client_text(p_code, 120)), ' ', '_'), '[^a-z0-9_.:-]', '', 'g'), 120);
  if code = '' then code := 'unknown'; end if;
  ctx := public.sanitize_client_text(p_context, 120);
  ver := public.sanitize_client_text(p_version, 120);
  update public.client_errors
     set occurrences = least(occurrences + 1, 1000000), last_seen_at = now(), app_version = ver
   where user_id = uid and error_code = code and context = ctx;
  get diagnostics n = row_count;
  if n > 0 then return; end if;
  -- flood cap: a user keeps at most 50 distinct error rows
  if (select count(*) from public.client_errors where user_id = uid) >= 50 then return; end if;
  insert into public.client_errors (user_id, error_code, context, app_version)
  values (uid, code, ctx, ver)
  on conflict (user_id, error_code, context)
  do update set occurrences = least(public.client_errors.occurrences + 1, 1000000), last_seen_at = now(), app_version = excluded.app_version;
end $$;

-- admin only: errors grouped by code + context, newest first
create or replace function public.admin_client_errors(p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.last_seen desc)
    from (
      select error_code, context,
             count(distinct user_id)::int as users,
             sum(occurrences)::bigint as occurrences,
             max(last_seen_at) as last_seen,
             (array_agg(app_version order by last_seen_at desc))[1] as app_version
        from public.client_errors
       group by error_code, context
       order by max(last_seen_at) desc
       limit greatest(least(coalesce(p_limit, 100), 500), 1)
    ) x
  ), '[]'::jsonb);
end $$;

revoke execute on function public.report_client_error(text, text, text), public.admin_client_errors(int) from public, anon, authenticated;
grant execute on function public.report_client_error(text, text, text), public.admin_client_errors(int) to authenticated;

-- ---------- 2. retention nudges ----------
create table if not exists public.retention_nudges_sent (
  user_id uuid not null references auth.users on delete cascade,
  nudge_key text not null check (nudge_key in ('no_first_sync_24h', 'trial_ending_2d', 'trial_expired_winback')),
  sent_at timestamptz not null default now(),
  primary key (user_id, nudge_key)
);
alter table public.retention_nudges_sent enable row level security;
revoke all on public.retention_nudges_sent from public, anon, authenticated;

-- queues each nudge at most once per user (the insert ... returning decides, so parallel runs cannot double-send)
create or replace function public.enqueue_retention_nudges()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with cand as (
    select a.user_id, 'no_first_sync_24h'::text as nudge_key
      from public.accounts a
     where a.created_at < now() - interval '24 hours' and a.created_at > now() - interval '14 days'
       and not exists (select 1 from public.funnel_events f where f.user_id = a.user_id and f.event = 'first_sync_done')
    union all
    select a.user_id, 'trial_ending_2d'
      from public.accounts a
     where a.trial_ends_at between now() and now() + interval '48 hours'
    union all
    select a.user_id, 'trial_expired_winback'
      from public.accounts a
     where a.trial_ends_at between now() - interval '3 days' and now() - interval '1 day'
  ), eligible as (
    select c.user_id, c.nudge_key
      from cand c
      join public.accounts a on a.user_id = c.user_id
      join public.tg_links l on l.user_id = c.user_id and l.blocked_at is null
     where a.paid_until is null or a.paid_until <= now()
  ), ins as (
    insert into public.retention_nudges_sent (user_id, nudge_key)
    select user_id, nudge_key from eligible
    on conflict do nothing
    returning user_id, nudge_key
  ), q as (
    insert into public.tg_outbox (user_id, kind, payload)
    select user_id, 'nudge', jsonb_build_object('key', nudge_key, 'text', case nudge_key
      when 'no_first_sync_24h' then 'Здравствуйте! Вы зарегистрировались в SaudaPulse, но данные из Kaspi ещё не загрузились. Откройте расширение и нажмите «Синхронизировать» — это займёт пару минут. Если что-то не получается, напишите нам, поможем.'
      when 'trial_ending_2d' then 'Пробный период SaudaPulse заканчивается через 2 дня. Чтобы не потерять доступ к заказам, остаткам и истории, оформите подписку в кабинете.'
      else 'Пробный период SaudaPulse закончился, но ваши магазины и данные сохранены. Вернуться можно в любой момент. А если пригласите друга, вы получите +14 дней подписки в подарок.'
    end)
    from ins
    returning 1
  )
  select count(*) into n from q;
  return coalesce(n, 0);
end $$;

revoke execute on function public.enqueue_retention_nudges() from public, anon, authenticated;
grant execute on function public.enqueue_retention_nudges() to service_role;

commit;
