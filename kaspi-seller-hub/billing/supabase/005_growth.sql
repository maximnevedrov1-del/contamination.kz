-- Kaspi Seller Hub — growth and retention (run after 001–004; safe to re-run).
--
--  * «Старт» → «Мульти»: 24-hour trial boost (3 stores, once), upgrade quote (proration).
--  * Cancellation flow: reason → an offer (30 % for 2 months / «Старт» / 30-day freeze / feedback),
--    or cancel at the end of the period. No renewal reminders after a cancellation.
--  * The seller's Telegram bot: one-time link token, morning digest at 09:00 (Almaty), deadline
--    alerts, «6 days without the cabinet» care message, grace-period reminders, win-back at 30/60 days.
--    The bot (billing/supabase/functions/telegram-bot) calls the bot_* functions with its own key;
--    the service_role key is not used anywhere.
-- What the server learns for the digest: per seller and day — number of orders, their sum, how many
-- were shipped, and order numbers at risk of a late handover with their store's name. No buyers' data.

-- ---------- 1. trial boost and upgrade quote ----------
create or replace function public.start_trial_boost()
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config;
begin
  acc := public.ensure_account();
  select * into c from public.billing_config where id = 1;
  if not (acc.paid_until > now()) then raise exception 'subscription_required'; end if;
  if acc.store_limit >= c.base_stores then raise exception 'boost_not_needed'; end if;
  if acc.boost_used_at is not null then raise exception 'boost_used'; end if;
  update public.accounts set boost_until = now() + make_interval(hours => c.boost_hours), boost_used_at = now()
    where user_id = acc.user_id;
  return public.get_license(null, null);
end $$;

-- What moving to p_stores costs now (same formula as request_store_addon), without creating anything.
create or replace function public.upgrade_quote(p_stores int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config; covered int; n int; days int; total_days int := 30;
begin
  select * into acc from public.accounts where user_id = auth.uid();
  if acc.user_id is null then raise exception 'not_authenticated'; end if;
  select * into c from public.billing_config where id = 1;
  covered := case when acc.paid_until > now() then acc.store_limit else greatest(c.trial_store_limit, acc.store_limit) end;
  n := public.plan_stores(least(c.max_stores, greatest(coalesce(p_stores, 1), 1)));
  days := greatest(1, ceil(extract(epoch from (public.coverage_end(acc) - now())) / 86400.0)::int);
  return jsonb_build_object(
    'stores', n, 'covered', covered,
    'monthly_now', public.billing_price(covered, 1), 'monthly_new', public.billing_price(n, 1),
    'monthly_diff', public.billing_price(n, 1) - public.billing_price(covered, 1),
    'remaining_days', days, 'total_days', total_days,
    'upgrade_cost', case when n <= covered then 0
                         else greatest(100, (ceil((public.billing_price(n, 1) - public.billing_price(covered, 1)) * days / total_days::numeric / 100) * 100)::int) end,
    'can_boost', acc.paid_until > now() and acc.store_limit < c.base_stores and acc.boost_used_at is null);
end $$;

-- ---------- 2. cancellation flow ----------
create table if not exists public.cancellations (
  id          bigserial primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  reason      text not null check (reason in ('price', 'closed', 'missing', 'other')),
  comment     text check (length(comment) <= 1000),
  outcome     text not null check (outcome in ('discount', 'downgrade', 'freeze', 'cancelled')),
  created_at  timestamptz not null default now()
);
create index if not exists cancellations_created on public.cancellations (created_at);
alter table public.cancellations enable row level security;
revoke all on public.cancellations from public, anon, authenticated;
revoke all on sequence public.cancellations_id_seq from public, anon, authenticated;

-- One call per decision in the flow:
--   discount  — 30 % on the next 2 invoices (once per account in 180 days)
--   downgrade — next period on «Старт» (1 store)
--   freeze    — 30 days without access and without losing paid days (once in 180 days)
--   cancelled — no renewal; access until the end of the paid period, no grace
create or replace function public.cancel_flow(p_reason text, p_outcome text, p_comment text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config; recent int;
begin
  acc := public.ensure_account();
  select * into c from public.billing_config where id = 1;
  if p_reason not in ('price', 'closed', 'missing', 'other') or p_outcome not in ('discount', 'downgrade', 'freeze', 'cancelled') then
    raise exception 'invalid_choice';
  end if;
  if acc.paid_until is null then raise exception 'subscription_required'; end if;
  select count(*) into recent from public.cancellations where user_id = acc.user_id and outcome = p_outcome and created_at > now() - interval '180 days';
  if p_outcome in ('discount', 'freeze') and recent > 0 then raise exception 'offer_used'; end if;
  if p_outcome = 'discount' then
    update public.accounts set discount_pct = 30, discount_left = 2, discount_until = null, cancel_at = null, cancel_reason = null where user_id = acc.user_id;
  elsif p_outcome = 'downgrade' then
    update public.accounts set downgrade_next = true, cancel_at = null, cancel_reason = null where user_id = acc.user_id;
  elsif p_outcome = 'freeze' then
    -- the paid days are moved past the freeze; nothing works until it ends (or «Разморозить»)
    update public.accounts set frozen_until = now() + make_interval(days => c.freeze_days),
           paid_until = greatest(paid_until, now()) + make_interval(days => c.freeze_days), cancel_at = null where user_id = acc.user_id;
  else
    update public.accounts set cancel_at = now(), cancel_reason = p_reason where user_id = acc.user_id;
    update public.invoices set status = 'cancelled', admin_note = 'subscription cancelled' where user_id = acc.user_id and status = 'pending';
  end if;
  insert into public.cancellations (user_id, reason, comment, outcome) values (acc.user_id, p_reason, nullif(left(btrim(coalesce(p_comment, '')), 1000), ''), p_outcome);
  -- «не хватает функций»: the comment goes to support as a question the owner sees
  if p_reason = 'missing' and length(btrim(coalesce(p_comment, ''))) > 0 then
    insert into public.support_tickets (user_id, email, topic, message) values (acc.user_id, acc.email, 'idea', left('Отмена подписки, не хватает: ' || btrim(p_comment), 2000));
  end if;
  -- the reason also feeds «Почему не продлевают» in «Пульт»
  insert into public.feedback (user_id, kind, reason, comment)
    values (acc.user_id, 'exit', case p_reason when 'price' then 'price' when 'closed' then 'closed' when 'missing' then 'missing' else 'other' end, nullif(left(btrim(coalesce(p_comment, '')), 1000), ''));
  return public.get_license(null, null);
end $$;

-- Changed their mind: renewal back on; frozen early → the unused freeze days are taken back.
create or replace function public.resume_subscription()
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; left_ interval;
begin
  acc := public.ensure_account();
  if acc.frozen_until > now() then
    left_ := acc.frozen_until - now();
    update public.accounts set paid_until = paid_until - left_, frozen_until = now() where user_id = acc.user_id;
  end if;
  update public.accounts set cancel_at = null, cancel_reason = null where user_id = acc.user_id;
  return public.get_license(null, null);
end $$;

-- ---------- 3. Telegram: link, settings ----------
alter table public.billing_config add column if not exists bot_username text check (bot_username ~ '^[A-Za-z0-9_]{5,32}$');
alter table public.billing_config add column if not exists support_url text check (support_url ~ '^https://');
alter table public.billing_config add column if not exists app_url text check (app_url ~ '^https://');
alter table public.billing_config add column if not exists whats_new text check (length(whats_new) <= 1500);
alter table public.ops_settings add column if not exists bot_key_hash text check (bot_key_hash ~ '^[0-9a-f]{64}$');

create table if not exists public.tg_links (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  chat_id    bigint not null unique,
  tg_name    text check (length(tg_name) <= 64),
  digest     boolean not null default true,
  alerts     boolean not null default true,
  linked_at  timestamptz not null default now(),
  blocked_at timestamptz                              -- the seller blocked the bot → nothing is sent
);
create table if not exists public.tg_link_tokens (
  token_hash text primary key,                         -- SHA-256 of the one-time token
  user_id    uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null
);
create table if not exists public.tg_sent (            -- one message per seller, kind and key (day, order…)
  user_id uuid not null references auth.users (id) on delete cascade,
  kind    text not null,
  key     text not null,
  sent_at timestamptz not null default now(),
  error   text,
  primary key (user_id, kind, key)
);
create index if not exists tg_sent_at on public.tg_sent (sent_at);
create table if not exists public.digest_stats (
  user_id     uuid not null references auth.users (id) on delete cascade,
  day         date not null,
  stats       jsonb not null,
  reported_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.tg_links enable row level security;
alter table public.tg_link_tokens enable row level security;
alter table public.tg_sent enable row level security;
alter table public.digest_stats enable row level security;
revoke all on public.tg_links, public.tg_link_tokens, public.tg_sent, public.digest_stats from public, anon, authenticated;

-- «Подключить Telegram»: a one-time token (15 minutes) → t.me/<bot>?start=<token>
create or replace function public.tg_link_create()
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; tok text; bot text;
begin
  acc := public.ensure_account();
  select bot_username into bot from public.billing_config where id = 1;
  if bot is null then raise exception 'bot_not_configured'; end if;
  if (select count(*) from public.tg_link_tokens where user_id = acc.user_id and expires_at > now() - interval '1 hour') >= 10 then raise exception 'rate_limited'; end if;
  tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');   -- 244 random bits, no extension needed
  delete from public.tg_link_tokens where expires_at < now();
  insert into public.tg_link_tokens values (encode(sha256(convert_to(tok, 'utf8')), 'hex'), acc.user_id, now() + interval '15 minutes');
  return jsonb_build_object('url', 'https://t.me/' || bot || '?start=' || tok, 'expires_in', 900);
end $$;

create or replace function public.tg_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('linked', l.user_id is not null and l.blocked_at is null, 'blocked', l.blocked_at is not null,
                            'name', l.tg_name, 'digest', coalesce(l.digest, true), 'alerts', coalesce(l.alerts, true),
                            'bot', (select bot_username from public.billing_config where id = 1))
  from (select 1) x left join public.tg_links l on l.user_id = auth.uid();
$$;
create or replace function public.tg_settings(p_digest boolean, p_alerts boolean)
returns jsonb language sql security definer set search_path = public as $$
  update public.tg_links set digest = coalesce(p_digest, digest), alerts = coalesce(p_alerts, alerts) where user_id = auth.uid();
  select public.tg_status();
$$;
create or replace function public.tg_unlink()
returns jsonb language sql security definer set search_path = public as $$
  delete from public.tg_links where user_id = auth.uid();
  select public.tg_status();
$$;

-- ---------- 4. digest numbers and alerts from the extension ----------
-- p_stats: {"orders": 24, "sum": 412000, "shipped": 22, "at_risk": [{"code": "123", "shop": "Магазин А", "minutes": 40}], "shops": ["Магазин А"]}
create or replace function public.digest_report(p_day date, p_stats jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); clean jsonb;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_day is null or p_day < current_date - 2 or p_day > current_date + 1 then return false; end if;
  clean := jsonb_build_object(
    'orders', least(greatest(coalesce((p_stats->>'orders')::int, 0), 0), 100000),
    'sum', least(greatest(coalesce((p_stats->>'sum')::bigint, 0), 0), 100000000000),
    'shipped', least(greatest(coalesce((p_stats->>'shipped')::int, 0), 0), 100000),
    'at_risk', coalesce((select jsonb_agg(jsonb_build_object('code', left(e->>'code', 20), 'shop', left(e->>'shop', 60), 'minutes', least(greatest(coalesce((e->>'minutes')::int, 0), -100000), 100000)))
                         from (select e from jsonb_array_elements(case when jsonb_typeof(p_stats->'at_risk') = 'array' then p_stats->'at_risk' else '[]' end) e limit 20) x), '[]'),
    'shops', coalesce((select jsonb_agg(left(s, 60)) from (select jsonb_array_elements_text(case when jsonb_typeof(p_stats->'shops') = 'array' then p_stats->'shops' else '[]' end) s limit 50) y), '[]'));
  insert into public.digest_stats (user_id, day, stats) values (uid, p_day, clean)
    on conflict (user_id, day) do update set stats = excluded.stats, reported_at = now();
  delete from public.digest_stats where day < current_date - 30;
  return true;
end $$;

-- A deadline alert: returns the chat to send to (once per order and kind), or null.
-- Called by the bot function with the SELLER's token (it checks who is asking).
create or replace function public.alert_create(p_code text, p_shop text, p_minutes int, p_kind text default 'deadline')
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); l public.tg_links;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_kind not in ('deadline', 'cancelled') or coalesce(p_code, '') !~ '^[0-9A-Za-z-]{1,20}$' then raise exception 'invalid_alert'; end if;
  if not public.has_access_of(uid) then return null; end if;
  select * into l from public.tg_links where user_id = uid and blocked_at is null and alerts;
  if l.user_id is null then return null; end if;
  if (select count(*) from public.tg_sent where user_id = uid and kind = 'alert' and sent_at > now() - interval '1 hour') >= 30 then return null; end if;
  insert into public.tg_sent (user_id, kind, key) values (uid, 'alert', p_kind || ':' || p_code) on conflict do nothing;
  if not found then return null; end if;                        -- already alerted for this order
  return jsonb_build_object('chat_id', l.chat_id, 'code', p_code, 'shop', left(p_shop, 60), 'minutes', p_minutes, 'kind', p_kind,
                            'app_url', (select app_url from public.billing_config where id = 1), 'support_url', (select support_url from public.billing_config where id = 1));
end $$;

-- ---------- 5. functions for the bot (its own key; never the service_role key) ----------
create or replace function public.bot_key_ok(p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_key is not null and length(p_key) >= 32 and encode(sha256(convert_to(p_key, 'utf8')), 'hex') = (select bot_key_hash from public.ops_settings where id = 1);
$$;

-- /start <token>: link this chat to the account; returns the store names for the confirmation.
create or replace function public.bot_link(p_key text, p_token text, p_chat_id bigint, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.tg_link_tokens;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  delete from public.tg_link_tokens where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex') returning * into t;
  if t.user_id is null or t.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'token_expired'); end if;
  delete from public.tg_links where chat_id = p_chat_id and user_id <> t.user_id;   -- one chat = one account
  insert into public.tg_links (user_id, chat_id, tg_name) values (t.user_id, p_chat_id, left(p_name, 64))
    on conflict (user_id) do update set chat_id = excluded.chat_id, tg_name = excluded.tg_name, linked_at = now(), blocked_at = null;
  return jsonb_build_object('ok', true, 'shops', coalesce((select stats->'shops' from public.digest_stats where user_id = t.user_id order by day desc limit 1), '[]'),
                            'app_url', (select app_url from public.billing_config where id = 1));
end $$;

-- /stop, or Telegram answered 403 (bot blocked): stop sending to this chat.
create or replace function public.bot_unlink(p_key text, p_chat_id bigint, p_blocked boolean default false)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.bot_key_ok(p_key) then raise exception 'bad_key'; end if;
  if p_blocked then update public.tg_links set blocked_at = now() where chat_id = p_chat_id;
  else delete from public.tg_links where chat_id = p_chat_id; end if;
  return true;
end $$;

-- Messages due now, for the scheduled run (09:00 Almaty). Each item is sent at most once
-- (key = day or offer); the bot reports the result with bot_sent().
--   morning — yesterday's numbers (+ orders at risk) for sellers with access and the digest on
--   care    — paying, no activity for 6 days (once per 14 days)
--   grace   — paid period over, renewal unpaid: one reminder per grace day
--   winback30 / winback60 — cancelled or expired: what's new / 50 % for the first month (valid 30 days)
create or replace function public.bot_jobs(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.billing_config; yday date := (now() at time zone 'Asia/Almaty')::date - 1; r jsonb;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  select * into c from public.billing_config where id = 1;
  -- the win-back offer is granted when it is sent (valid 30 days)
  with due as (
    select l.user_id, l.chat_id, l.digest, coalesce(l.tg_name, '') name, a acc, p.last_active_at, ds.stats, ds.reported_at,
           greatest(a.trial_ends_at, coalesce(a.paid_until, a.trial_ends_at)) ended,
           coalesce(a.frozen_until, '-infinity') < now() not_frozen
    from public.tg_links l join public.accounts a using (user_id)
    left join public.user_progress p using (user_id)
    left join public.digest_stats ds on ds.user_id = l.user_id and ds.day = yday
    where l.blocked_at is null
  ), items as (
    select user_id, chat_id, 'morning' kind, yday::text key,
           jsonb_build_object('name', name, 'day', yday, 'stats', stats, 'as_of', reported_at) data
      from due where digest and public.has_access_of(user_id) and stats is not null
    union all
    select user_id, chat_id, 'care', to_char(now(), 'IYYY-IW'), jsonb_build_object('name', name)
      from due where (acc).paid_until > now() and not_frozen
       and coalesce(last_active_at, (acc).last_seen_at, (acc).created_at) < now() - interval '6 days'
       and not exists (select 1 from public.tg_sent s where s.user_id = due.user_id and s.kind = 'care' and s.sent_at > now() - interval '14 days')
    union all
    select user_id, chat_id, 'grace', (now() at time zone 'Asia/Almaty')::date::text,
           jsonb_build_object('name', name, 'until', public.grace_until(acc), 'days_left', ceil(extract(epoch from public.grace_until(acc) - now()) / 86400))
      from due where (acc).paid_until <= now() and public.grace_until(acc) > now()
    union all
    select user_id, chat_id, 'winback30', ended::date::text, jsonb_build_object('name', name, 'whats_new', c.whats_new)
      from due where ended between now() - interval '45 days' and now() - interval '30 days' and not_frozen and c.whats_new is not null
    union all
    select user_id, chat_id, 'winback60', ended::date::text, jsonb_build_object('name', name, 'pct', 50)
      from due where ended between now() - interval '75 days' and now() - interval '60 days' and not_frozen
  )
  select coalesce(jsonb_agg(jsonb_build_object('user_id', i.user_id, 'chat_id', i.chat_id, 'kind', i.kind, 'key', i.key, 'data', i.data)), '[]')
    into r
  from items i
  where not exists (select 1 from public.tg_sent s where s.user_id = i.user_id and s.kind = i.kind and s.key = i.key);
  return jsonb_build_object('items', r, 'app_url', c.app_url, 'support_url', c.support_url);
end $$;

-- Results of a run: [{user_id, kind, key, ok, error, blocked}]
create or replace function public.bot_sent(p_key text, p_results jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare e jsonb; n int := 0;
begin
  if not public.bot_key_ok(p_key) then raise exception 'bad_key'; end if;
  for e in select * from jsonb_array_elements(coalesce(p_results, '[]')) loop
    insert into public.tg_sent (user_id, kind, key, error)
      values ((e->>'user_id')::uuid, left(e->>'kind', 20), left(e->>'key', 60), case when (e->>'ok')::boolean then null else left(e->>'error', 200) end)
      on conflict (user_id, kind, key) do update set error = excluded.error, sent_at = now();
    if (e->>'blocked')::boolean then update public.tg_links set blocked_at = now() where user_id = (e->>'user_id')::uuid; end if;
    -- the 60-day offer is real: 50 % on the next invoice, valid 30 days
    if e->>'kind' = 'winback60' and (e->>'ok')::boolean then
      update public.accounts set discount_pct = 50, discount_left = 1, discount_until = now() + interval '30 days', cancel_at = null
        where user_id = (e->>'user_id')::uuid;
    end if;
    n := n + 1;
  end loop;
  delete from public.tg_sent where sent_at < now() - interval '120 days';
  return n;
end $$;

-- ---------- 6. admin ----------
create or replace function public.admin_growth_settings(p jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p ? 'bot_key_hash' and coalesce(p->>'bot_key_hash', '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_key'; end if;
  update public.billing_config set
    bot_username = case when p ? 'bot_username' then nullif(btrim(p->>'bot_username', ' @'), '') else bot_username end,
    support_url  = case when p ? 'support_url' then nullif(btrim(p->>'support_url'), '') else support_url end,
    app_url      = case when p ? 'app_url' then nullif(btrim(p->>'app_url'), '') else app_url end,
    whats_new    = case when p ? 'whats_new' then nullif(btrim(p->>'whats_new'), '') else whats_new end
  where id = 1;
  if p ? 'bot_key_hash' then update public.ops_settings set bot_key_hash = p->>'bot_key_hash' where id = 1; end if;
  return (select jsonb_build_object('bot_username', bot_username, 'support_url', support_url, 'app_url', app_url, 'whats_new', whats_new,
            'has_bot_key', (select bot_key_hash is not null from public.ops_settings where id = 1),
            'linked', (select count(*) from public.tg_links where blocked_at is null),
            'blocked', (select count(*) from public.tg_links where blocked_at is not null),
            'cancellations', (select coalesce(jsonb_object_agg(outcome, n), '{}') from (select outcome, count(*) n from public.cancellations where created_at > now() - interval '90 days' group by outcome) x))
          from public.billing_config where id = 1);
end $$;

-- ---------- who may call what ----------
revoke execute on function
  public.start_trial_boost(), public.upgrade_quote(int), public.cancel_flow(text, text, text), public.resume_subscription(),
  public.tg_link_create(), public.tg_status(), public.tg_settings(boolean, boolean), public.tg_unlink(),
  public.digest_report(date, jsonb), public.alert_create(text, text, int, text),
  public.bot_key_ok(text), public.bot_link(text, text, bigint, text), public.bot_unlink(text, bigint, boolean), public.bot_jobs(text), public.bot_sent(text, jsonb),
  public.admin_growth_settings(jsonb)
from public, anon, authenticated;
grant execute on function
  public.start_trial_boost(), public.upgrade_quote(int), public.cancel_flow(text, text, text), public.resume_subscription(),
  public.tg_link_create(), public.tg_status(), public.tg_settings(boolean, boolean), public.tg_unlink(),
  public.digest_report(date, jsonb), public.alert_create(text, text, int, text), public.admin_growth_settings(jsonb)
to authenticated;
grant execute on function public.bot_link(text, text, bigint, text), public.bot_unlink(text, bigint, boolean), public.bot_jobs(text), public.bot_sent(text, jsonb) to anon, authenticated;
