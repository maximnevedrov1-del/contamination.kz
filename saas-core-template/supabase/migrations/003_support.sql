-- {{APP_NAME}} — support without the owner sitting at the computer (run after 001 and 002).
-- Safe to re-run.
--
-- 1. Service status: one message the owner writes in the admin page («Внешний сервис не отвечает,
--    чиним»). Every client sees it in the extension, so 200 people do not write the same question.
-- 2. Support tickets: the seller writes from «Помощь» with a technical report attached
--    (version, settings summary, last errors; no buyers' data, no tokens). The owner answers in
--    the admin page; the answer appears in the extension.
-- 3. API health: every 15 minutes the extension sends COUNTS of marketplace API calls
--    (how many worked, how many failed and why: server, network, timeout…). No orders, no
--    URLs, no tokens. When many clients fail at once, an upstream marketplace is down or changed
--    its API — the owner gets a Telegram message before the clients start writing.
-- 4. ops_digest(key): one call for a scheduled job (GitHub Actions, see tools/ops-alert.mjs):
--    API alerts + new tickets + new invoices since the last call → Telegram.

-- ---------- 1. service status ----------
create table if not exists public.service_status (
  id         int primary key default 1 check (id = 1),
  level      text not null default 'ok' check (level in ('ok', 'info', 'warn', 'down')),
  message    text not null default '' check (length(message) <= 300),
  until      timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.service_status (id) values (1) on conflict (id) do nothing;
alter table public.service_status enable row level security;
revoke all on public.service_status from public, anon, authenticated;

-- Anyone (even before login) may read the status: it is a public notice.
create or replace function public.get_service_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select case
    when s.level = 'ok' or btrim(s.message) = '' or (s.until is not null and s.until < now()) then jsonb_build_object('level', 'ok')
    else jsonb_build_object('level', s.level, 'message', s.message, 'updated_at', s.updated_at, 'until', s.until)
  end
  from public.service_status s where s.id = 1;
$$;

create or replace function public.admin_set_status(p_level text, p_message text, p_hours int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_level not in ('ok', 'info', 'warn', 'down') then raise exception 'invalid_level'; end if;
  update public.service_status set
    level = p_level,
    message = left(btrim(coalesce(p_message, '')), 300),
    until = case when p_hours between 1 and 720 then now() + make_interval(hours => p_hours) end,
    updated_at = now()
  where id = 1;
  return public.get_service_status();
end $$;

-- ---------- 2. support tickets ----------
create table if not exists public.support_tickets (
  id          bigserial primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  email       text,
  topic       text not null check (topic in ('connect', 'orders', 'print', 'payment', 'warehouse', 'idea', 'other')),
  message     text not null check (length(btrim(message)) between 1 and 2000),
  report      text check (length(report) <= 8000),
  version     text check (length(version) <= 40),
  status      text not null default 'open' check (status in ('open', 'answered', 'closed')),
  reply       text check (length(reply) <= 2000),
  created_at  timestamptz not null default now(),
  replied_at  timestamptz,
  seen_at     timestamptz
);
create index if not exists support_tickets_user on public.support_tickets (user_id, created_at desc);
create index if not exists support_tickets_status on public.support_tickets (status, created_at);
alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from public, anon, authenticated;
revoke all on sequence public.support_tickets_id_seq from public, anon, authenticated;

create or replace function public.ticket_json(t public.support_tickets, p_admin boolean default false)
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', t.id, 'topic', t.topic, 'message', t.message, 'status', t.status, 'reply', t.reply,
    'created_at', t.created_at, 'replied_at', t.replied_at,
    'unread', t.replied_at is not null and (t.seen_at is null or t.seen_at < t.replied_at))
  || case when p_admin then jsonb_build_object('email', t.email, 'report', t.report, 'version', t.version, 'user_id', t.user_id) else '{}'::jsonb end;
$$;

create or replace function public.ticket_create(p_topic text, p_message text, p_report text default null, p_version text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); t public.support_tickets;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  -- a stuck button or a script must not flood the owner's inbox
  if (select count(*) from public.support_tickets where user_id = uid and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.support_tickets where user_id = uid and created_at > now() - interval '1 day') >= 20 then
    raise exception 'ticket_limit';
  end if;
  insert into public.support_tickets (user_id, email, topic, message, report, version)
  values (uid, (select email from auth.users where id = uid),
          case when p_topic in ('connect', 'orders', 'print', 'payment', 'warehouse', 'idea', 'other') then p_topic else 'other' end,
          left(btrim(p_message), 2000), left(p_report, 8000), left(p_version, 40))
  returning * into t;
  return public.ticket_json(t);
end $$;

create or replace function public.my_tickets()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.ticket_json(t) order by t.created_at desc), '[]'::jsonb)
  from (select * from public.support_tickets where user_id = auth.uid() order by created_at desc limit 20) t;
$$;

create or replace function public.ticket_seen(p_id bigint)
returns boolean language sql security definer set search_path = public as $$
  update public.support_tickets set seen_at = now() where id = p_id and user_id = auth.uid() returning true;
$$;

-- «Вопрос решён» by the seller
create or replace function public.ticket_close(p_id bigint)
returns boolean language sql security definer set search_path = public as $$
  update public.support_tickets set status = 'closed', seen_at = now() where id = p_id and user_id = auth.uid() returning true;
$$;

create or replace function public.admin_tickets(p_status text default 'open', p_search text default null, p_limit int default 100, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare q text := nullif(btrim(coalesce(p_search, '')), ''); r jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  with f as (
    select * from public.support_tickets t
    where (p_status = 'all' or t.status = p_status)
      and (q is null or t.email ilike '%' || q || '%' or t.message ilike '%' || q || '%' or t.id::text = q)
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'open', (select count(*) from public.support_tickets where status = 'open'),
    'items', coalesce((select jsonb_agg(public.ticket_json(x, true) order by x.created_at)
                       from (select * from f order by created_at limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0)) x), '[]'::jsonb))
  into r;
  return r;
end $$;

create or replace function public.admin_ticket_reply(p_id bigint, p_reply text, p_close boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.support_tickets;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if length(btrim(coalesce(p_reply, ''))) = 0 and not p_close then raise exception 'empty_reply'; end if;
  update public.support_tickets set
    reply = coalesce(nullif(left(btrim(p_reply), 2000), ''), reply),
    status = case when p_close then 'closed' else 'answered' end,
    replied_at = case when length(btrim(coalesce(p_reply, ''))) > 0 then now() else replied_at end
  where id = p_id returning * into t;
  if t.id is null then raise exception 'not_found'; end if;
  return public.ticket_json(t, true);
end $$;

-- ---------- 3. API health (counts only) ----------
create table if not exists public.api_health (
  bucket  timestamptz not null,                  -- start of the hour
  user_id uuid not null references auth.users (id) on delete cascade,
  market  text not null check (market in ('primary', 'secondary', 'tertiary')),
  ok      int not null default 0,
  fail    int not null default 0,
  kinds   jsonb not null default '{}',           -- {"server": 3, "network": 1, …}
  primary key (bucket, user_id, market)
);
create index if not exists api_health_bucket on public.api_health (bucket);
alter table public.api_health enable row level security;
revoke all on public.api_health from public, anon, authenticated;

-- Failures that point at the marketplace, not at one seller (a wrong token is the seller's own problem).
create or replace function public.outage_fails(k jsonb)
returns int language sql immutable as $$
  select coalesce((k->>'server')::int, 0) + coalesce((k->>'network')::int, 0) + coalesce((k->>'timeout')::int, 0)
       + coalesce((k->>'format')::int, 0) + coalesce((k->>'rate')::int, 0);
$$;

-- p: [{"market":"primary","ok":120,"fail":3,"kinds":{"server":2,"network":1}}]
create or replace function public.health_report(p jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); e jsonb; k jsonb; kk text; v int; b timestamptz := date_trunc('hour', now());
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 3 then raise exception 'invalid_report'; end if;
  for e in select * from jsonb_array_elements(p) loop
    continue when coalesce(e->>'market', '') not in ('primary', 'secondary', 'tertiary');
    k := '{}'::jsonb;
    for kk in select unnest(array['auth', 'rate', 'server', 'network', 'timeout', 'format', 'other']) loop
      v := least(greatest(coalesce((e->'kinds'->>kk)::int, 0), 0), 10000);
      if v > 0 then k := k || jsonb_build_object(kk, v); end if;
    end loop;
    insert into public.api_health as h (bucket, user_id, market, ok, fail, kinds)
    values (b, uid, e->>'market', least(greatest(coalesce((e->>'ok')::int, 0), 0), 100000), least(greatest(coalesce((e->>'fail')::int, 0), 0), 10000), k)
    on conflict (bucket, user_id, market) do update set
      ok = least(h.ok + excluded.ok, 1000000),
      fail = least(h.fail + excluded.fail, 1000000),
      kinds = (select coalesce(jsonb_object_agg(key, least(coalesce((h.kinds->>key)::int, 0) + coalesce((excluded.kinds->>key)::int, 0), 1000000)), '{}'::jsonb)
               from (select jsonb_object_keys(h.kinds || excluded.kinds) key) x);
  end loop;
  -- keep two weeks
  delete from public.api_health where bucket < now() - interval '14 days';
  return true;
end $$;

-- Per market for the last p_minutes: clients reporting, clients mostly failing, totals by kind.
-- A client «fails» when ≥ 3 outage-type failures make up ≥ half of its calls.
create or replace function public.health_window(p_minutes int)
returns jsonb language sql stable security definer set search_path = public as $$
  with per_user as (
    select market, user_id, sum(ok) ok, sum(fail) fail, sum(public.outage_fails(kinds)) outage
    from public.api_health where bucket >= date_trunc('hour', now() - make_interval(mins => p_minutes))
    group by market, user_id
  ), kinds as (
    select market, jsonb_object_agg(key, n) k from (
      select market, key, sum(value::int) n from public.api_health, jsonb_each_text(kinds)
      where bucket >= date_trunc('hour', now() - make_interval(mins => p_minutes)) group by market, key) x
    group by market
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'market', u.market, 'users', u.users, 'failing', u.failing,
    'share', round(u.failing::numeric / greatest(u.users, 1), 2), 'ok', u.ok, 'fail', u.fail,
    'kinds', coalesce(k.k, '{}'::jsonb)) order by u.market), '[]'::jsonb)
  from (select market, count(*) users, count(*) filter (where outage >= 3 and outage * 2 >= ok + fail) failing, sum(ok) ok, sum(fail) fail
        from per_user group by market) u
  left join kinds k using (market);
$$;

create or replace function public.admin_health(p_hours int default 24)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'now', public.health_window(60),
    'hours', (select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'market', market, 'users', users, 'ok', ok, 'fail', fail, 'outage', outage) order by bucket desc, market), '[]'::jsonb)
              from (select bucket, market, count(*) users, sum(ok) ok, sum(fail) fail, sum(public.outage_fails(kinds)) outage
                    from public.api_health where bucket >= now() - make_interval(hours => least(greatest(p_hours, 1), 336))
                    group by bucket, market) x));
end $$;

-- ---------- 4. digest for the scheduled job (Telegram) ----------
create table if not exists public.ops_settings (
  id             int primary key default 1 check (id = 1),
  key_hash       text check (key_hash ~ '^[0-9a-f]{64}$'),   -- SHA-256 of the job's key; the key itself is never stored
  min_users      int not null default 3 check (min_users between 1 and 1000),
  min_share      numeric not null default 0.3 check (min_share > 0 and min_share <= 1),
  last_digest_at timestamptz,
  alerted        jsonb not null default '{}'               -- {"primary": "2026-11-18T10:00:00Z"} markets currently «down»
);
insert into public.ops_settings (id) values (1) on conflict (id) do nothing;
alter table public.ops_settings enable row level security;
revoke all on public.ops_settings from public, anon, authenticated;

create or replace function public.admin_ops_settings(p_key_hash text default null, p_min_users int default null, p_min_share numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.ops_settings;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_key_hash is not null and p_key_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_key'; end if;
  update public.ops_settings set
    key_hash = coalesce(p_key_hash, key_hash),
    min_users = coalesce(p_min_users, min_users),
    min_share = coalesce(p_min_share, min_share)
  where id = 1 returning * into o;
  return jsonb_build_object('has_key', o.key_hash is not null, 'min_users', o.min_users, 'min_share', o.min_share, 'last_digest_at', o.last_digest_at);
end $$;

-- Called by the scheduled job with its own key (no admin login, no service_role key needed).
-- Returns only counts and market names — nothing about clients.
create or replace function public.ops_digest(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.ops_settings; w jsonb; e jsonb; alerts jsonb := '[]'; recovered jsonb := '[]'; down jsonb; since timestamptz;
begin
  select * into o from public.ops_settings where id = 1 for update;
  if o.key_hash is null or p_key is null or length(p_key) < 32
     or encode(sha256(convert_to(p_key, 'utf8')), 'hex') <> o.key_hash then
    perform pg_sleep(0.5);
    raise exception 'bad_key';
  end if;
  since := coalesce(o.last_digest_at, now() - interval '1 hour');
  down := o.alerted;
  w := public.health_window(60);
  for e in select * from jsonb_array_elements(w) loop
    if (e->>'failing')::int >= o.min_users and (e->>'share')::numeric >= o.min_share then
      -- new outage, or a reminder every 2 hours while it lasts
      if not (down ? (e->>'market')) or (down->>(e->>'market'))::timestamptz < now() - interval '2 hours' then
        alerts := alerts || jsonb_build_array(e);
        down := down || jsonb_build_object(e->>'market', now());
      end if;
    elsif down ? (e->>'market') and (e->>'share')::numeric < o.min_share / 2 then
      recovered := recovered || to_jsonb(e->>'market');
      down := down - (e->>'market');
    end if;
  end loop;
  update public.ops_settings set last_digest_at = now(), alerted = down where id = 1;
  return jsonb_build_object(
    'alerts', alerts,
    'recovered', recovered,
    'new_tickets', (select count(*) from public.support_tickets where created_at > since),
    'open_tickets', (select count(*) from public.support_tickets where status = 'open'),
    'new_invoices', (select count(*) from public.invoices where created_at > since and status = 'pending'),
    'pending_invoices', (select count(*) from public.invoices where status = 'pending'),
    'pending_sum', (select coalesce(sum(amount), 0) from public.invoices where status = 'pending'));
end $$;

-- ---------- who may call what ----------
-- Only this file's functions are touched (re-running it never changes 001/002 grants).
revoke execute on function
  public.get_service_status(), public.admin_set_status(text, text, int),
  public.ticket_json(public.support_tickets, boolean), public.ticket_create(text, text, text, text), public.my_tickets(), public.ticket_seen(bigint), public.ticket_close(bigint),
  public.admin_tickets(text, text, int, int), public.admin_ticket_reply(bigint, text, boolean),
  public.outage_fails(jsonb), public.health_report(jsonb), public.health_window(int), public.admin_health(int),
  public.admin_ops_settings(text, int, numeric), public.ops_digest(text)
from public, anon, authenticated;
grant execute on function public.get_service_status(), public.ops_digest(text) to anon, authenticated;
grant execute on function
  public.admin_set_status(text, text, int),
  public.ticket_create(text, text, text, text), public.my_tickets(), public.ticket_seen(bigint), public.ticket_close(bigint),
  public.admin_tickets(text, text, int, int), public.admin_ticket_reply(bigint, text, boolean),
  public.health_report(jsonb), public.admin_health(int), public.admin_ops_settings(text, int, numeric)
to authenticated;
