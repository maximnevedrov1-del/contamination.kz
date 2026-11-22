-- SaudaPulse — the owner's control panel («Пульт»): where sellers get stuck, what they use,
-- who stays, how satisfied they are (NPS), why they leave. Run after 001–003. Safe to re-run.
--
-- What the extension sends (only signed-in sellers, every 15 minutes, as additions):
--   * which of the 5 first steps are done and when (store, orders, print, costs, backup);
--   * how many times per day each section was opened and each action used (numbers only);
--   * survey answers the seller gives: NPS 0–10 + comment, «почему не продлеваете», «ответ помог?».
-- No orders, products, amounts, store names or tokens.

-- ---------- progress and usage ----------
create table if not exists public.user_progress (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  steps          jsonb not null default '{}',     -- {"store": "2026-11-18T10:00:00Z", …} first time each step was seen done
  first_seen_at  timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  version        text check (length(version) <= 40)
);
create table if not exists public.usage_daily (
  user_id  uuid not null references auth.users (id) on delete cascade,
  day      date not null,
  sections jsonb not null default '{}',           -- {"orders": 12, "analytics": 1}
  actions  jsonb not null default '{}',           -- {"accept": 4, "print": 3}
  primary key (user_id, day)
);
create index if not exists usage_daily_day on public.usage_daily (day);
alter table public.user_progress enable row level security;
alter table public.usage_daily enable row level security;
revoke all on public.user_progress, public.usage_daily from public, anon, authenticated;

-- Known names only: a bad client cannot fill the table with junk keys.
create or replace function public.insight_keys(p_kind text)
returns text[] language sql immutable as $$
  select case p_kind
    when 'steps' then array['store', 'orders', 'print', 'costs', 'backup']
    when 'sections' then array['home', 'orders', 'returns', 'refusals', 'payments', 'analytics', 'products', 'catalog', 'chat', 'settings', 'account', 'help']
    when 'actions' then array['accept', 'pack', 'print', 'pickList', 'export', 'publish', 'connect', 'sync', 'ticket', 'invite', 'cost']
  end;
$$;

-- Sum two {key: count} objects, keeping only known keys, each count capped.
create or replace function public.add_counts(a jsonb, b jsonb, p_kind text)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(k, least(coalesce((a->>k)::int, 0) + greatest(least(coalesce((b->>k)::int, 0), 10000), 0), 100000)), '{}'::jsonb)
  from unnest(public.insight_keys(p_kind)) k
  where coalesce((a->>k)::int, 0) + greatest(least(coalesce((b->>k)::int, 0), 10000), 0) > 0;
$$;

-- p_days: [{"day": "2026-11-18", "sections": {...}, "actions": {...}}] (at most 3 days: today and catching up)
create or replace function public.usage_report(p_steps jsonb, p_days jsonb, p_version text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); e jsonb; d date; st jsonb := '{}'; k text;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if jsonb_typeof(coalesce(p_days, '[]')) <> 'array' or jsonb_array_length(coalesce(p_days, '[]')) > 3 then raise exception 'invalid_report'; end if;
  -- steps: only «done» flags; the server stamps the time it first heard of each
  foreach k in array public.insight_keys('steps') loop
    if coalesce((p_steps->>k)::boolean, false) then st := st || jsonb_build_object(k, now()); end if;
  end loop;
  insert into public.user_progress as p (user_id, steps, version) values (uid, st, left(p_version, 40))
  on conflict (user_id) do update set steps = excluded.steps || p.steps,   -- keep the earliest time
                                      last_active_at = now(), version = coalesce(excluded.version, p.version);
  for e in select * from jsonb_array_elements(coalesce(p_days, '[]')) loop
    begin d := (e->>'day')::date; exception when others then continue; end;
    continue when d is null or d < current_date - 2 or d > current_date + 1;
    insert into public.usage_daily as u (user_id, day, sections, actions)
    values (uid, d, public.add_counts('{}', e->'sections', 'sections'), public.add_counts('{}', e->'actions', 'actions'))
    on conflict (user_id, day) do update set
      sections = public.add_counts(u.sections, e->'sections', 'sections'),
      actions = public.add_counts(u.actions, e->'actions', 'actions');
  end loop;
  delete from public.usage_daily where day < current_date - 400;
  return true;
end $$;

-- ---------- surveys ----------
create table if not exists public.feedback (
  id         bigserial primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('nps', 'exit', 'csat')),
  score      int,                                 -- nps 0..10, csat 0/1, null = «не сейчас»
  reason     text check (reason in ('price', 'notUsing', 'missing', 'bugs', 'closed', 'competitor', 'other')),
  comment    text check (length(comment) <= 1000),
  ticket_id  bigint references public.support_tickets (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'nps' and (score is null or score between 0 and 10)) or (kind = 'csat' and score in (0, 1)) or kind = 'exit')
);
create index if not exists feedback_user on public.feedback (user_id, kind, created_at desc);
create unique index if not exists feedback_csat_once on public.feedback (ticket_id) where kind = 'csat';
alter table public.feedback enable row level security;
revoke all on public.feedback from public, anon, authenticated;
revoke all on sequence public.feedback_id_seq from public, anon, authenticated;

-- Which survey to show now, if any:
--  nps  — after 14 days with the account and 5+ active days; then every 90 days; «не сейчас» → 30 days;
--  exit — subscription (trial or paid) ended within 30 days and no answer since it ended.
create or replace function public.feedback_due()
returns text language sql stable security definer set search_path = public as $$
  with a as (select * from public.accounts where user_id = auth.uid()),
       -- only someone who actually had a period (a refused repeat trial is not «не продлеваете»)
       e as (select greatest(a.trial_ends_at, coalesce(a.paid_until, a.trial_ends_at)) ended from a
             where greatest(a.trial_ends_at, coalesce(a.paid_until, a.trial_ends_at)) > a.created_at + interval '1 day')
  select case
    when exists (select 1 from e where e.ended < now() and e.ended > now() - interval '30 days')
         and not exists (select 1 from public.feedback f, e where f.user_id = auth.uid() and f.kind = 'exit' and f.created_at > e.ended) then 'exit'
    when exists (select 1 from a where a.created_at < now() - interval '14 days')
         and (select count(*) from public.usage_daily where user_id = auth.uid()) >= 5
         and not exists (select 1 from public.feedback f where f.user_id = auth.uid() and f.kind = 'nps'
                           and f.created_at > now() - case when f.score is null then interval '30 days' else interval '90 days' end) then 'nps'
  end;
$$;

create or replace function public.feedback_submit(p_kind text, p_score int default null, p_reason text default null, p_comment text default null, p_ticket bigint default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if (select count(*) from public.feedback where user_id = uid and created_at > now() - interval '1 day') >= 10 then raise exception 'rate_limited'; end if;
  if p_kind = 'csat' and not exists (select 1 from public.support_tickets where id = p_ticket and user_id = uid and reply is not null) then raise exception 'not_found'; end if;
  insert into public.feedback (user_id, kind, score, reason, comment, ticket_id)
  values (uid, p_kind, p_score, case when p_kind = 'exit' then coalesce(p_reason, 'other') end,
          nullif(left(btrim(coalesce(p_comment, '')), 1000), ''), case when p_kind = 'csat' then p_ticket end)
  on conflict (ticket_id) where kind = 'csat' do update set score = excluded.score, comment = coalesce(excluded.comment, public.feedback.comment), created_at = now();
  return true;
end $$;

-- ---------- the owner's panel ----------
-- «Чем пользуются»: one pass over the usage table with one column per known key, folded per seller.
-- (Unpacking every {key: count} pair took ~5 s for 10 000 sellers × a year; this takes < 1 s.)
-- The query text is built only from insight_keys() — fixed names, no user input.
create or replace function public.usage_summary(p_since date, out sections jsonb, out actions jsonb)
language plpgsql stable security definer set search_path = public as $$
declare s text[] := public.insight_keys('sections'); a text[] := public.insight_keys('actions'); cols text; outs text;
begin
  cols := concat_ws(', ',
    (select string_agg(format('sum((sections->>%L)::int) s%s', s[i], i), ', ') from generate_series(1, cardinality(s)) i),
    (select string_agg(format('sum((actions->>%L)::int) a%s', a[i], i), ', ') from generate_series(1, cardinality(a)) i));
  outs := format('jsonb_strip_nulls(jsonb_build_object(%s)), jsonb_strip_nulls(jsonb_build_object(%s))',
    (select string_agg(format('%L, case when count(s%s) > 0 then jsonb_build_object(''users'', count(s%s), ''times'', sum(s%s)) end', s[i], i, i, i), ', ') from generate_series(1, cardinality(s)) i),
    (select string_agg(format('%L, case when count(a%s) > 0 then jsonb_build_object(''users'', count(a%s), ''times'', sum(a%s)) end', a[i], i, i, i), ', ') from generate_series(1, cardinality(a)) i));
  execute format('select %s from (select user_id, %s from public.usage_daily where day >= $1 group by user_id) x', outs, cols)
    into sections, actions using p_since;
end $$;

create or replace function public.admin_insights(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare since timestamptz := now() - make_interval(days => least(greatest(p_days, 1), 365)); r jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  with acc as (
    select a.*, p.steps, p.last_active_at,
           exists (select 1 from public.invoices i where i.user_id = a.user_id and i.status = 'paid') paid
    from public.accounts a left join public.user_progress p using (user_id)
    where a.created_at >= since and not exists (select 1 from public.admins ad where ad.user_id = a.user_id)
  ), nps as (
    select score from public.feedback where kind = 'nps' and score is not null and created_at > now() - interval '90 days'
  ), cohorts as (
    select date_trunc('week', a.created_at)::date wk, a.user_id from public.accounts a where a.created_at > now() - interval '10 weeks' and not exists (select 1 from public.admins ad where ad.user_id = a.user_id)
  )
  select jsonb_build_object(
    'days', p_days,
    -- 1. funnel of the accounts created in the period
    'funnel', jsonb_build_object(
      'accounts', (select count(*) from acc),
      'store', (select count(*) from acc where steps ? 'store'),
      'orders', (select count(*) from acc where steps ? 'orders'),
      'print', (select count(*) from acc where steps ? 'print'),
      'costs', (select count(*) from acc where steps ? 'costs'),
      'backup', (select count(*) from acc where steps ? 'backup'),
      'paid', (select count(*) from acc where paid)),
    -- median hours from sign-up to each step
    'hoursTo', (select jsonb_object_agg(k, h) from (
        select k, round((percentile_cont(0.5) within group (order by extract(epoch from ((steps->>k)::timestamptz - created_at)) / 3600))::numeric, 1) h
        from acc, unnest(public.insight_keys('steps')) k where steps ? k group by k) x),
    -- 2. sections and actions: how many sellers used each, how many times
    'sections', u.sections,
    'actions', u.actions,
    'activeUsers', (select count(distinct user_id) from public.usage_daily where day >= since::date),
    'activeWeek', (select count(distinct user_id) from public.usage_daily where day >= current_date - 6),
    -- 3. retention: weekly sign-up cohorts, share active in week 0..4 after sign-up
    'cohorts', (select coalesce(jsonb_agg(jsonb_build_object('week', wk, 'size', size, 'active', active) order by wk desc), '[]'::jsonb) from (
        select c.wk, count(*) size,
               (select jsonb_agg(n order by w) from (
                  select w, count(distinct u.user_id) n from generate_series(0, 4) w
                  left join cohorts c2 on c2.wk = c.wk
                  left join public.usage_daily u on u.user_id = c2.user_id and u.day >= c.wk + w * 7 and u.day < c.wk + (w + 1) * 7
                  where c.wk + w * 7 <= current_date group by w) z) active
        from cohorts c group by c.wk) y),
    -- 4. satisfaction
    'nps', jsonb_build_object(
      'answers', (select count(*) from nps),
      'promoters', (select count(*) from nps where score >= 9),
      'passives', (select count(*) from nps where score between 7 and 8),
      'detractors', (select count(*) from nps where score <= 6),
      'score', (select case when count(*) = 0 then null else round(100.0 * (count(*) filter (where score >= 9) - count(*) filter (where score <= 6)) / count(*)) end from nps),
      'comments', (select coalesce(jsonb_agg(jsonb_build_object('score', f.score, 'comment', f.comment, 'email', a.email, 'at', f.created_at) order by f.created_at desc), '[]'::jsonb)
                   from (select * from public.feedback where kind = 'nps' and comment is not null order by created_at desc limit 30) f left join public.accounts a using (user_id))),
    'csat', (select jsonb_build_object('answers', count(*), 'good', count(*) filter (where score = 1)) from public.feedback where kind = 'csat' and created_at >= since),
    'exit', jsonb_build_object(
      'reasons', (select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb) from (select reason, count(*) n from public.feedback where kind = 'exit' and created_at >= since group by reason) x),
      'comments', (select coalesce(jsonb_agg(jsonb_build_object('reason', f.reason, 'comment', f.comment, 'email', a.email, 'at', f.created_at) order by f.created_at desc), '[]'::jsonb)
                   from (select * from public.feedback where kind = 'exit' and comment is not null order by created_at desc limit 30) f left join public.accounts a using (user_id))),
    -- 5. who to write to first (with access now, or trial ended recently)
    'risk', (select coalesce(jsonb_agg(x order by x->>'prio', x->>'email'), '[]'::jsonb) from (
        select jsonb_build_object('email', a.email, 'user_id', a.user_id, 'reason', r.reason, 'prio', r.prio, 'created_at', a.created_at,
                                  'last_active_at', p.last_active_at, 'trial_ends_at', a.trial_ends_at, 'paid_until', a.paid_until) x
        from public.accounts a left join public.user_progress p using (user_id)
        cross join lateral (
          select * from (values
            ('detractor', 1, exists (select 1 from public.feedback f where f.user_id = a.user_id and f.kind = 'nps' and f.score <= 6 and f.created_at > now() - interval '30 days')),
            ('trialEndsNoStore', 1, a.paid_until is null and a.trial_ends_at between now() and now() + interval '5 days' and not coalesce(p.steps ? 'store', false)),
            ('noStore', 2, a.created_at < now() - interval '2 days' and a.trial_ends_at > now() and not coalesce(p.steps ? 'store', false)),
            ('inactive', 2, (a.trial_ends_at > now() or a.paid_until > now()) and coalesce(p.last_active_at, a.created_at) < now() - interval '7 days'),
            ('noPrint', 3, coalesce(p.steps ? 'orders', false) and not (p.steps ? 'print') and (p.steps->>'orders')::timestamptz < now() - interval '3 days'),
            ('expiredRecently', 3, greatest(a.trial_ends_at, coalesce(a.paid_until, a.trial_ends_at)) between now() - interval '14 days' and now())
          ) v(reason, prio, hit) where hit order by prio limit 1
        ) r
        where not exists (select 1 from public.admins ad where ad.user_id = a.user_id)
        limit 300) y)
  ) into r
  from public.usage_summary(since::date) u;
  return r;
end $$;

-- ---------- who may call what ----------
revoke execute on function
  public.insight_keys(text), public.add_counts(jsonb, jsonb, text), public.usage_report(jsonb, jsonb, text), public.usage_summary(date),
  public.feedback_due(), public.feedback_submit(text, int, text, text, bigint), public.admin_insights(int)
from public, anon, authenticated;
grant execute on function
  public.usage_report(jsonb, jsonb, text), public.feedback_due(), public.feedback_submit(text, int, text, text, bigint), public.admin_insights(int)
to authenticated;
