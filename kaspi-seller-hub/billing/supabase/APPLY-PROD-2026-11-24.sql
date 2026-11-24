-- SaudaPulse: one-time catch-up for the production database (project zraktrilvwrfpcbmkqwi), 24.11.2026.
-- Production has 001–018 and 024. This file applies 019–023, 025–028 and grants.sql, in that order.
-- Checked: the same order on a copy of the schema applies without errors. Backup of functions/invoices/accounts: schema backup_20261124.
-- How: Supabase → SQL Editor → New query → paste the WHOLE file → Run. Expect "Success. No rows returned".
-- If it stops with an error, nothing after that point ran: send the error text to Claude.

-- ==================== 019_referral_program.sql ====================
-- Seller Hub: referral program. Safe to run again. Run after 018_trial_14_days.sql.
-- A friend who registers with an invitation code gets +7 days of trial; whoever invited them gets
-- +14 days of subscription when the friend's first invoice is paid (once per friend).

-- ---------- 1. columns ----------
alter table public.accounts
  add column if not exists referral_code text,
  add column if not exists referred_by uuid references public.accounts(user_id) on delete set null,
  add column if not exists referral_rewarded boolean not null default false,
  add column if not exists referrals_count int not null default 0,
  add column if not exists referral_bonus_days int not null default 0,
  add column if not exists referred_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_not_self_referred') then
    alter table public.accounts add constraint accounts_not_self_referred check (referred_by <> user_id);
  end if;
end $$;

-- SP-XXXXXX from an alphabet without look-alikes (no 0/O, 1/I)
create or replace function public.gen_referral_code()
returns text language plpgsql volatile set search_path = public as $$
declare alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; code text; i int;
begin
  loop
    code := 'SP-';
    for i in 1..6 loop code := code || substr(alphabet, 1 + floor(random() * 32)::int, 1); end loop;
    exit when not exists (select 1 from public.accounts where referral_code = code);
  end loop;
  return code;
end $$;
revoke execute on function public.gen_referral_code() from public, anon, authenticated;

create or replace function public.accounts_set_referral_code()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.referral_code is null then new.referral_code := public.gen_referral_code(); end if;
  return new;
end $$;
drop trigger if exists accounts_referral_code on public.accounts;
create trigger accounts_referral_code before insert on public.accounts
  for each row execute function public.accounts_set_referral_code();

update public.accounts set referral_code = public.gen_referral_code() where referral_code is null;
alter table public.accounts alter column referral_code set not null;
create unique index if not exists accounts_referral_code_key on public.accounts (referral_code);
create index if not exists accounts_referred_by_idx on public.accounts (referred_by) where referred_by is not null;

-- clients only have SELECT on accounts (001): the referral columns cannot be written directly.
revoke insert, update, delete on public.accounts from anon, authenticated;

-- ---------- 2. Telegram notice queue (no client access) ----------
create table if not exists public.tg_outbox (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.tg_outbox enable row level security;
revoke all on public.tg_outbox from public, anon, authenticated;
revoke all on sequence public.tg_outbox_id_seq from public, anon, authenticated;
create index if not exists tg_outbox_pending_idx on public.tg_outbox (user_id) where sent_at is null;

-- ---------- 3. RPC: apply an invitation code ----------
create or replace function public.apply_referral_code(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); acc public.accounts; ref_id uuid; code text := upper(btrim(coalesce(p_code, '')));
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  perform public.ensure_account();
  select * into acc from public.accounts where user_id = uid for update;
  if code !~ '^SP-[A-Z0-9]{6}$' then raise exception 'invalid_code' using errcode = '22023'; end if;
  select user_id into ref_id from public.accounts where referral_code = code;
  if ref_id is null then raise exception 'invalid_code' using errcode = '22023'; end if;
  if ref_id = uid then raise exception 'self_referral' using errcode = '22023'; end if;
  if acc.referred_by is not null then raise exception 'already_referred' using errcode = '22023'; end if;
  if now() - acc.created_at > interval '7 days' then raise exception 'too_late' using errcode = '22023'; end if;
  update public.accounts set referred_by = ref_id, referred_at = now(), trial_ends_at = trial_ends_at + interval '7 days'
    where user_id = uid returning * into acc;
  return jsonb_build_object('ok', true, 'trial_ends_at', acc.trial_ends_at, 'bonus_days', 7);
end $$;
revoke execute on function public.apply_referral_code(text) from public, anon;
grant execute on function public.apply_referral_code(text) to authenticated;

-- ---------- 4. RPC: my referral card ----------
create or replace function public.my_referral()
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); acc public.accounts;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  acc := public.ensure_account();
  return jsonb_build_object('code', acc.referral_code, 'count', acc.referrals_count, 'bonus_days', acc.referral_bonus_days,
    'applied', acc.referred_by is not null,
    'can_apply', acc.referred_by is null and now() - acc.created_at <= interval '7 days');
end $$;
revoke execute on function public.my_referral() from public, anon;
grant execute on function public.my_referral() to authenticated;

-- ---------- 5. admin_confirm_invoice + referral reward ----------
create or replace function public.admin_confirm_invoice(p_id bigint, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; acc public.accounts; start_at timestamptz; end_at timestamptz; ref public.accounts;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into inv from public.invoices where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if inv.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
  select * into acc from public.accounts where user_id = inv.user_id for update;
  if inv.kind = 'addon' then
    -- extra stores for the rest of the current period; the end date does not move
    start_at := now();
    end_at := public.coverage_end(acc);
    update public.accounts set store_limit = greatest(store_limit, inv.stores) where user_id = inv.user_id;
  else
    start_at := greatest(now(), coalesce(acc.paid_until, now()), acc.trial_ends_at);
    end_at := start_at + make_interval(months => inv.months);
    -- paying again = staying: a cancellation or «перейти на Старт» is done; a discount is used up
    update public.accounts set paid_until = end_at, store_limit = inv.stores, cancel_at = null, cancel_reason = null, downgrade_next = false,
           boost_until = null where user_id = inv.user_id;
  end if;
  if inv.discount_pct > 0 then
    update public.accounts set discount_left = greatest(0, discount_left - 1) where user_id = inv.user_id;
  end if;
  update public.invoices set status = 'paid', paid_at = now(), period_from = start_at, period_to = end_at,
         confirmed_by = auth.uid(), admin_note = p_note
    where id = p_id returning * into inv;

  -- referral reward: the first paid invoice of an invited friend gives the inviter +14 days, once
  if acc.referred_by is not null and not acc.referral_rewarded
     and not exists (select 1 from public.invoices where user_id = inv.user_id and status = 'paid' and id <> inv.id) then
    select * into ref from public.accounts where user_id = acc.referred_by for update;
    if found then
      update public.accounts set
        paid_until = greatest(now(), coalesce(paid_until, now()), trial_ends_at) + interval '14 days',
        referrals_count = referrals_count + 1, referral_bonus_days = referral_bonus_days + 14
      where user_id = ref.user_id;
      if exists (select 1 from public.tg_links where user_id = ref.user_id and blocked_at is null) then
        insert into public.tg_outbox (user_id, kind, payload) values (ref.user_id, 'referral', jsonb_build_object('days', 14));
      end if;
    end if;
    update public.accounts set referral_rewarded = true where user_id = inv.user_id;
  end if;
  return to_jsonb(inv);
end $$;

-- ---------- 6. bot_jobs: + queued notices (everything else as in 007) ----------
create or replace function public.bot_jobs(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare batch constant int := 300; c public.billing_config; yday date := (now() at time zone 'Asia/Almaty')::date - 1; r jsonb;
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
    union all
    -- queued one-off notices (tg_outbox): key = outbox id, so tg_sent dedupes it
    select o.user_id, l.chat_id, o.kind, o.id::text, coalesce(o.payload, '{}'::jsonb)
      from public.tg_outbox o join public.tg_links l on l.user_id = o.user_id
      where o.sent_at is null and l.blocked_at is null and o.created_at > now() - interval '30 days'
  )
  select coalesce(jsonb_agg(jsonb_build_object('user_id', i.user_id, 'chat_id', i.chat_id, 'kind', i.kind, 'key', i.key, 'data', i.data)), '[]')
    into r
  from (
    select * from items i
    where not exists (select 1 from public.tg_sent s where s.user_id = i.user_id and s.kind = i.kind and s.key = i.key)
    -- time-sensitive first: the morning digest, then the grace warning
    order by case i.kind when 'morning' then 0 when 'grace' then 1 when 'referral' then 2 else 3 end, i.user_id
    limit batch
  ) i;
  return jsonb_build_object('items', r, 'batch', batch, 'app_url', c.app_url, 'support_url', c.support_url);
end $$;

-- ==================== 020_security_hardening_fixes.sql ====================
-- Seller Hub: security/reliability fixes. Safe to run again.
-- MUST be applied AFTER 019_referral_program.sql (redefines its admin_confirm_invoice, reasserts its revokes).
-- 1. Referral reward only for subscription invoices (manual/renewal), never for add-on (extra stores) invoices,
--    and not to an inviter whose account is frozen or blocked (trial_blocked) or deleted.
-- 2. Sellers can no longer read invoices.admin_note / confirmed_by / account_ref (the client reads invoices only
--    through get_license, which already strips them; no client code selects the table directly).
-- 3. Reassert: no client access to tg_outbox, gen_referral_code, writes on accounts.

-- ---------- 1. admin_confirm_invoice ----------
create or replace function public.admin_confirm_invoice(p_id bigint, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; acc public.accounts; start_at timestamptz; end_at timestamptz; ref public.accounts;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into inv from public.invoices where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if inv.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
  select * into acc from public.accounts where user_id = inv.user_id for update;
  if inv.kind = 'addon' then
    -- extra stores for the rest of the current period; the end date does not move
    start_at := now();
    end_at := public.coverage_end(acc);
    update public.accounts set store_limit = greatest(store_limit, inv.stores) where user_id = inv.user_id;
  else
    start_at := greatest(now(), coalesce(acc.paid_until, now()), acc.trial_ends_at);
    end_at := start_at + make_interval(months => inv.months);
    -- paying again = staying: a cancellation or «перейти на Старт» is done; a discount is used up
    update public.accounts set paid_until = end_at, store_limit = inv.stores, cancel_at = null, cancel_reason = null, downgrade_next = false,
           boost_until = null where user_id = inv.user_id;
  end if;
  if inv.discount_pct > 0 then
    update public.accounts set discount_left = greatest(0, discount_left - 1) where user_id = inv.user_id;
  end if;
  update public.invoices set status = 'paid', paid_at = now(), period_from = start_at, period_to = end_at,
         confirmed_by = auth.uid(), admin_note = p_note
    where id = p_id returning * into inv;

  -- referral reward: the first paid invoice of an invited friend gives the inviter +14 days, once
  if inv.kind <> 'addon' and acc.referred_by is not null and not acc.referral_rewarded
     and not exists (select 1 from public.invoices where user_id = inv.user_id and status = 'paid' and kind <> 'addon' and id <> inv.id) then
    select * into ref from public.accounts where user_id = acc.referred_by for update;
    -- inviter gone (deleted → not found), frozen or blocked: no reward (the friend is still marked as rewarded)
    if found and coalesce(ref.frozen_until, '-infinity') < now() and not ref.trial_blocked then
      update public.accounts set
        paid_until = greatest(now(), coalesce(paid_until, now()), trial_ends_at) + interval '14 days',
        referrals_count = referrals_count + 1, referral_bonus_days = referral_bonus_days + 14
      where user_id = ref.user_id;
      if exists (select 1 from public.tg_links where user_id = ref.user_id and blocked_at is null) then
        insert into public.tg_outbox (user_id, kind, payload) values (ref.user_id, 'referral', jsonb_build_object('days', 14));
      end if;
    end if;
    update public.accounts set referral_rewarded = true where user_id = inv.user_id;
  end if;
  return to_jsonb(inv);
end $$;

-- ---------- 2. column-level read on invoices ----------
revoke select on public.invoices from authenticated;
grant select (id, user_id, kind, stores, months, amount, phone, status, created_at, paid_at, period_from, period_to, discount_pct)
  on public.invoices to authenticated;

-- ---------- 3. reassert revokes ----------
revoke all on public.tg_outbox from public, anon, authenticated;
revoke all on sequence public.tg_outbox_id_seq from public, anon, authenticated;
revoke execute on function public.gen_referral_code() from public, anon, authenticated;
revoke insert, update, delete on public.accounts from anon, authenticated;
revoke execute on function public.admin_confirm_invoice(bigint, text) from public, anon;
grant execute on function public.admin_confirm_invoice(bigint, text) to authenticated;  -- is_admin() inside

-- ==================== 021_admin_referral_info.sql ====================
-- Seller Hub: referral info for the admin panel. Safe to run again. Apply AFTER 019_referral_program.sql and 020_security_hardening_fixes.sql.
-- admin_invoices: rows get referred, referrer_email, referral_rewarded, referral_will_reward.
-- admin_accounts: rows get referred, referrer_email, referrals_count, referral_bonus_days, referral_code.
begin;

create or replace function public.admin_invoices(p_status text default 'pending', p_search text default null,
                                                 p_limit int default 100, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q text := nullif(btrim(coalesce(p_search, '')), ''); digits text;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  -- phone search only for queries that look like a phone number (≥ 4 digits, nothing else)
  if q ~ '^[+0-9 ()-]+$' then digits := nullif(regexp_replace(q, '\D', '', 'g'), ''); end if;
  if length(digits) < 4 then digits := null; end if;
  return (
    with f as (
      select i.*, a.email, a.paid_until as acc_paid_until, a.trial_ends_at, a.last_store_count,
             (a.referred_by is not null) as referred, r.email as referrer_email,
             coalesce(a.referral_rewarded, false) as referral_rewarded,
             (a.referred_by is not null and not a.referral_rewarded and i.kind <> 'addon' and i.status = 'pending'
              and r.user_id is not null and coalesce(r.frozen_until, '-infinity') < now() and not r.trial_blocked
              and not exists (select 1 from public.invoices p where p.user_id = i.user_id and p.status = 'paid' and p.kind <> 'addon' and p.id <> i.id)) as referral_will_reward
      from public.invoices i left join public.accounts a on a.user_id = i.user_id
           left join public.accounts r on r.user_id = a.referred_by
      where (p_status = 'all' or i.status = p_status)
        and (q is null or a.email ilike '%' || q || '%' or (digits is not null and i.phone like '%' || digits || '%')
             or i.id::text = q or i.account_ref = public.account_ref(q))
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) - 'acc_paid_until' || jsonb_build_object('paid_until', x.acc_paid_until) order by x.created_at desc)
                        from (select * from f order by created_at desc
                              limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb))
  );
end $$;

create or replace function public.admin_accounts(p_search text default null, p_status text default 'all',
                                                 p_limit int default 100, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q text := nullif(btrim(coalesce(p_search, '')), ''); digits text;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  -- phone search only for queries that look like a phone number (≥ 4 digits, nothing else)
  if q ~ '^[+0-9 ()-]+$' then digits := nullif(regexp_replace(q, '\D', '', 'g'), ''); end if;
  if length(digits) < 4 then digits := null; end if;
  return (
    with s as (
      select a.*, r.email as referrer_email, case when a.paid_until > now() then 'active' when a.trial_ends_at > now() then 'trial' else 'expired' end as st
      from public.accounts a left join public.accounts r on r.user_id = a.referred_by
    ), f as (
      select * from s
      where (p_status = 'all' or st = p_status)
        and (q is null or email ilike '%' || q || '%' or (digits is not null and phone like '%' || digits || '%'))
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'totals', (select jsonb_build_object('all', count(*), 'trial', count(*) filter (where st = 'trial'),
                        'active', count(*) filter (where st = 'active'), 'expired', count(*) filter (where st = 'expired')) from s),
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'user_id', x.user_id, 'email', x.email, 'phone', x.phone, 'trial_ends_at', x.trial_ends_at,
          'paid_until', x.paid_until, 'store_limit', x.store_limit, 'last_store_count', x.last_store_count,
          'last_seen_at', x.last_seen_at, 'created_at', x.created_at,
          'terms_version', x.terms_version, 'terms_accepted_at', x.terms_accepted_at, 'trial_blocked', x.trial_blocked,
          'status', x.st, 'referred', x.referred_by is not null, 'referrer_email', x.referrer_email,
          'referrals_count', x.referrals_count, 'referral_bonus_days', x.referral_bonus_days, 'referral_code', x.referral_code) order by x.created_at desc)
        from (select * from f order by created_at desc
              limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb))
  );
end $$;

commit;

-- ==================== 022_product_funnel_events.sql ====================
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

-- ==================== 023_client_errors_and_retention.sql ====================
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

-- ==================== 025_audit_hardening_f1_f2.sql ====================
-- Seller Hub: audit hardening F1 + F2 (+ admin Storage cleanup policy). Safe to run again.
-- MUST be applied AFTER 024_ux_behavior_telemetry.sql.
-- F1. admin_confirm_invoice gets optional p_expected_amount / p_expected_stores: the admin page passes what it
--     displayed; if the open invoice was rewritten meanwhile (extension licence checks can change amount/stores
--     of an open invoice) the confirmation is refused with 'amount_changed' (errcode 40001) and nothing is paid.
--     NULL = old behaviour (no check).
-- F2. Privilege hardening: EXECUTE on public functions is taken away from PUBLIC and anon; only the explicit
--     anonymous RPCs below are granted back. Same list lives in grants.sql (apply it after a restore).
-- F3 (support). Admins may list and delete price-list objects in Storage (the client deletes feeds of a removed
--     account through the Storage API; direct deletes from storage.objects are not possible in Supabase).
begin;

-- ---------- F1. admin_confirm_invoice with expected amount / stores ----------
drop function if exists public.admin_confirm_invoice(bigint, text);
create or replace function public.admin_confirm_invoice(p_id bigint, p_note text default null, p_expected_amount int default null, p_expected_stores int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; acc public.accounts; start_at timestamptz; end_at timestamptz; ref public.accounts;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into inv from public.invoices where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if inv.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
  -- the invoice changed after the admin looked at it: refuse, the admin reloads and checks the new amount
  if (p_expected_amount is not null and p_expected_amount is distinct from inv.amount)
     or (p_expected_stores is not null and p_expected_stores is distinct from inv.stores) then
    raise exception 'amount_changed' using errcode = '40001';
  end if;
  select * into acc from public.accounts where user_id = inv.user_id for update;
  if inv.kind = 'addon' then
    -- extra stores for the rest of the current period; the end date does not move
    start_at := now();
    end_at := public.coverage_end(acc);
    update public.accounts set store_limit = greatest(store_limit, inv.stores) where user_id = inv.user_id;
  else
    start_at := greatest(now(), coalesce(acc.paid_until, now()), acc.trial_ends_at);
    end_at := start_at + make_interval(months => inv.months);
    -- paying again = staying: a cancellation or «перейти на Старт» is done; a discount is used up
    update public.accounts set paid_until = end_at, store_limit = inv.stores, cancel_at = null, cancel_reason = null, downgrade_next = false,
           boost_until = null where user_id = inv.user_id;
  end if;
  if inv.discount_pct > 0 then
    update public.accounts set discount_left = greatest(0, discount_left - 1) where user_id = inv.user_id;
  end if;
  update public.invoices set status = 'paid', paid_at = now(), period_from = start_at, period_to = end_at,
         confirmed_by = auth.uid(), admin_note = p_note
    where id = p_id returning * into inv;

  -- referral reward: the first paid invoice of an invited friend gives the inviter +14 days, once
  if inv.kind <> 'addon' and acc.referred_by is not null and not acc.referral_rewarded
     and not exists (select 1 from public.invoices where user_id = inv.user_id and status = 'paid' and kind <> 'addon' and id <> inv.id) then
    select * into ref from public.accounts where user_id = acc.referred_by for update;
    -- inviter gone (deleted → not found), frozen or blocked: no reward (the friend is still marked as rewarded)
    if found and coalesce(ref.frozen_until, '-infinity') < now() and not ref.trial_blocked then
      update public.accounts set
        paid_until = greatest(now(), coalesce(paid_until, now()), trial_ends_at) + interval '14 days',
        referrals_count = referrals_count + 1, referral_bonus_days = referral_bonus_days + 14
      where user_id = ref.user_id;
      if exists (select 1 from public.tg_links where user_id = ref.user_id and blocked_at is null) then
        insert into public.tg_outbox (user_id, kind, payload) values (ref.user_id, 'referral', jsonb_build_object('days', 14));
      end if;
    end if;
    update public.accounts set referral_rewarded = true where user_id = inv.user_id;
  end if;
  return to_jsonb(inv);
end $$;
revoke execute on function public.admin_confirm_invoice(bigint, text, int, int) from public, anon;
grant execute on function public.admin_confirm_invoice(bigint, text, int, int) to authenticated;  -- is_admin() inside

-- ---------- F3 support: admins may list / delete price-list objects (account deletion cleanup) ----------
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    drop policy if exists "pricelists admin select" on storage.objects;
    drop policy if exists "pricelists admin delete" on storage.objects;
    create policy "pricelists admin select" on storage.objects for select to authenticated
      using (bucket_id = 'pricelists' and public.is_admin());
    create policy "pricelists admin delete" on storage.objects for delete to authenticated
      using (bucket_id = 'pricelists' and public.is_admin());
  end if;
end $$;

-- ---------- F2. privilege hardening ----------
-- Functions created after 001 got Supabase's default EXECUTE for anon / PUBLIC: take it away everywhere,
-- then grant back only what the extension / site / admin page call without a login. Keep in sync with grants.sql.
-- Audit follow-up: a stale add-on reconcile (client race) must not cancel an unpaid manual plan that already covers all connected stores.
create or replace function public.request_store_addon(p_total_stores int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config; pend public.invoices; covered int; extra int; days int; amt int; n int;
begin
  acc := public.ensure_account();
  select * into c from public.billing_config where id = 1;
  n := least(c.max_stores, coalesce(p_total_stores, 0));
  if public.coverage_end(acc) <= now() + make_interval(days => c.remind_days) then
    return public.ensure_renewal_invoice(n);
  end if;
  covered := case when acc.paid_until > now() then acc.store_limit else greatest(c.trial_store_limit, acc.store_limit) end;
  extra := n - covered;
  n := public.plan_stores(n);
  select * into pend from public.invoices where user_id = acc.user_id and status = 'pending' for update;
  if extra <= 0 then
    return case when found then to_jsonb(pend) - 'confirmed_by' - 'admin_note' end;
  end if;
  days := greatest(1, ceil(extract(epoch from (public.coverage_end(acc) - now())) / 86400.0)::int);
  amt := greatest(100, (ceil((public.billing_price(n, 1) - public.billing_price(covered, 1)) * days / 30.0 / 100.0) * 100)::int);
  if found and pend.kind = 'manual' and pend.stores >= n then       -- the client's own unpaid plan already covers every store:
    return to_jsonb(pend) - 'confirmed_by' - 'admin_note';             -- a late/stale reconcile must not replace it with an add-on
  end if;
  if found and pend.kind = 'addon' then
    update public.invoices set stores = n, amount = amt where id = pend.id returning * into pend;
    return to_jsonb(pend) - 'confirmed_by' - 'admin_note';
  end if;
  perform public.check_invoice_rate(acc.user_id);
  if found then                                                        -- replace an unpaid manual plan
    update public.invoices set status = 'cancelled', admin_note = 'replaced by add-on' where id = pend.id;
  end if;
  insert into public.invoices (user_id, kind, stores, months, amount, phone)
    values (acc.user_id, 'addon', n, 0, amt, acc.phone) returning * into pend;
  return to_jsonb(pend) - 'confirmed_by' - 'admin_note';
end $$;

revoke execute on all functions in schema public from public, anon;
alter default privileges in schema public revoke execute on functions from public, anon;
grant execute on function public.get_service_status(), public.health() to anon;

commit;

-- ==================== 026_strict_invoice_and_cleanup.sql ====================
-- Seller Hub: strict invoice confirmation + durable Storage cleanup queue. Safe to run again.
-- MUST be applied AFTER 025_audit_hardening_f1_f2.sql.
-- (a) admin_confirm_invoice now REQUIRES p_expected_amount and p_expected_stores ('expected_values_required',
--     errcode 22023, raised before anything is updated). The admin page always sends them; old 2-argument
--     and all-NULL calls no longer mark an invoice paid.
-- (b) public.pending_storage_cleanups: price-list files of a deleted account that still have to be removed from
--     Storage. admin_delete_account fills it in the same transaction; the admin page removes the files and then
--     calls admin_resolve_storage_cleanup (or admin_fail_storage_cleanup); leftovers are shown there and retried.
begin;

-- ---------- (a) strict admin_confirm_invoice ----------
create or replace function public.admin_confirm_invoice(p_id bigint, p_note text default null, p_expected_amount int default null, p_expected_stores int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; acc public.accounts; start_at timestamptz; end_at timestamptz; ref public.accounts;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  -- the admin page always sends what it displayed; a call without both values is refused before anything changes
  if p_expected_amount is null or p_expected_stores is null then raise exception 'expected_values_required' using errcode = '22023'; end if;
  select * into inv from public.invoices where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if inv.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
  -- the invoice changed after the admin looked at it: refuse, the admin reloads and checks the new amount
  if p_expected_amount is distinct from inv.amount or p_expected_stores is distinct from inv.stores then
    raise exception 'amount_changed' using errcode = '40001';
  end if;
  select * into acc from public.accounts where user_id = inv.user_id for update;
  if inv.kind = 'addon' then
    -- extra stores for the rest of the current period; the end date does not move
    start_at := now();
    end_at := public.coverage_end(acc);
    update public.accounts set store_limit = greatest(store_limit, inv.stores) where user_id = inv.user_id;
  else
    start_at := greatest(now(), coalesce(acc.paid_until, now()), acc.trial_ends_at);
    end_at := start_at + make_interval(months => inv.months);
    -- paying again = staying: a cancellation or «перейти на Старт» is done; a discount is used up
    update public.accounts set paid_until = end_at, store_limit = inv.stores, cancel_at = null, cancel_reason = null, downgrade_next = false,
           boost_until = null where user_id = inv.user_id;
  end if;
  if inv.discount_pct > 0 then
    update public.accounts set discount_left = greatest(0, discount_left - 1) where user_id = inv.user_id;
  end if;
  update public.invoices set status = 'paid', paid_at = now(), period_from = start_at, period_to = end_at,
         confirmed_by = auth.uid(), admin_note = p_note
    where id = p_id returning * into inv;

  -- referral reward: the first paid invoice of an invited friend gives the inviter +14 days, once
  if inv.kind <> 'addon' and acc.referred_by is not null and not acc.referral_rewarded
     and not exists (select 1 from public.invoices where user_id = inv.user_id and status = 'paid' and kind <> 'addon' and id <> inv.id) then
    select * into ref from public.accounts where user_id = acc.referred_by for update;
    -- inviter gone (deleted → not found), frozen or blocked: no reward (the friend is still marked as rewarded)
    if found and coalesce(ref.frozen_until, '-infinity') < now() and not ref.trial_blocked then
      update public.accounts set
        paid_until = greatest(now(), coalesce(paid_until, now()), trial_ends_at) + interval '14 days',
        referrals_count = referrals_count + 1, referral_bonus_days = referral_bonus_days + 14
      where user_id = ref.user_id;
      if exists (select 1 from public.tg_links where user_id = ref.user_id and blocked_at is null) then
        insert into public.tg_outbox (user_id, kind, payload) values (ref.user_id, 'referral', jsonb_build_object('days', 14));
      end if;
    end if;
    update public.accounts set referral_rewarded = true where user_id = inv.user_id;
  end if;
  return to_jsonb(inv);
end $$;
revoke execute on function public.admin_confirm_invoice(bigint, text, int, int) from public, anon;
grant execute on function public.admin_confirm_invoice(bigint, text, int, int) to authenticated;  -- is_admin() inside

-- ---------- (b) cleanup queue ----------
create table if not exists public.pending_storage_cleanups (
  id          bigserial primary key,
  bucket      text not null default 'pricelists',
  object_path text not null,
  created_at  timestamptz not null default now(),
  attempts    int not null default 0,
  last_error  text,
  unique (bucket, object_path)
);
alter table public.pending_storage_cleanups enable row level security;
drop policy if exists "pending_storage_cleanups admin" on public.pending_storage_cleanups;
create policy "pending_storage_cleanups admin" on public.pending_storage_cleanups for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.pending_storage_cleanups from public, anon, authenticated;   -- reached only through the RPCs below
revoke all on sequence public.pending_storage_cleanups_id_seq from public, anon, authenticated;

-- ---------- (c) admin_delete_account also queues the Storage cleanup ----------
create or replace function public.admin_delete_account(p_user uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare em text; ref text; feeds jsonb; n_inv int; n_cons int;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_user is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_user = auth.uid() or exists (select 1 from public.admins where user_id = p_user) then
    raise exception 'cannot_delete_admin' using errcode = '42501';
  end if;
  select email into em from auth.users where id = p_user for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if lower(btrim(coalesce(p_email, ''))) is distinct from lower(btrim(coalesce(em, ''))) or em is null then
    raise exception 'email_mismatch' using errcode = '22023';
  end if;
  ref := public.account_ref(em);
  update public.invoices set status = 'cancelled', admin_note = 'account deleted', confirmed_by = auth.uid()
    where user_id = p_user and status = 'pending';
  update public.invoices set account_ref = ref where user_id = p_user;
  get diagnostics n_inv = row_count;
  update public.consents set account_ref = ref where user_id = p_user;
  get diagnostics n_cons = row_count;
  select coalesce(jsonb_agg(feed_id), '[]'::jsonb) into feeds from public.price_feeds where user_id = p_user;
  -- Storage files of the removed feeds are deleted by the admin page through the Storage API; remember them
  -- in the same transaction so a failed or interrupted cleanup can be retried (admin_list_storage_cleanups)
  insert into public.pending_storage_cleanups (bucket, object_path)
    select 'pricelists', f.feed_id::text from public.price_feeds f where f.user_id = p_user
    on conflict (bucket, object_path) do nothing;
  delete from auth.users where id = p_user;   -- cascades to accounts, tickets, usage, Telegram links…
  return jsonb_build_object('deleted', true, 'account_ref', ref, 'invoices_kept', n_inv,
                            'consents_kept', n_cons, 'price_feeds_to_remove', feeds);
end $$;
revoke all on function public.admin_delete_account(uuid, text) from public, anon;
grant execute on function public.admin_delete_account(uuid, text) to authenticated;

-- ---------- (d) cleanup RPCs ----------
create or replace function public.admin_list_storage_cleanups()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.pending_storage_cleanups c), '[]'::jsonb);
end $$;

create or replace function public.admin_resolve_storage_cleanup(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.pending_storage_cleanups where id = p_id;
  get diagnostics n = row_count;
  return jsonb_build_object('resolved', n > 0);
end $$;

create or replace function public.admin_fail_storage_cleanup(p_id bigint, p_error text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.pending_storage_cleanups set attempts = attempts + 1, last_error = left(p_error, 500) where id = p_id;
  get diagnostics n = row_count;
  return jsonb_build_object('updated', n > 0);
end $$;

revoke execute on function public.admin_list_storage_cleanups(), public.admin_resolve_storage_cleanup(bigint), public.admin_fail_storage_cleanup(bigint, text) from public, anon;
grant execute on function public.admin_list_storage_cleanups(), public.admin_resolve_storage_cleanup(bigint), public.admin_fail_storage_cleanup(bigint, text) to authenticated;  -- is_admin() inside

commit;

-- ==================== 027_ux_events_batch.sql ====================
-- Seller Hub: UX telemetry in one request per batch. Safe to run again. Apply AFTER 026_strict_invoice_and_cleanup.sql
-- and BEFORE releasing the extension version that calls track_ux_events (older versions keep using track_ux_event).
--
-- Before: the extension called track_ux_event once per event and per repeat (up to 5 × 50 = 250 HTTP requests per
-- batch, a batch per minute while the dashboard is in use). Now: one call with the whole batch.
--   p_events: [{"t": event_type, "k": target_key, "s": screen_key, "n": 1..5}, …], at most 50 items.
-- Same rules as track_ux_event: whitelisted types, short keys, at most 100 distinct rows per user.
-- Invalid items are skipped (the rest of the batch still counts); a wrong shape of the whole batch raises.
-- Returns how many items were counted.
begin;

create or replace function public.track_ux_events(p_events jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  rows_now int;
  applied int := 0;
  r record;
  hit int;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 50 then
    raise exception 'invalid_ux_batch' using errcode = '22023';
  end if;
  select count(*) into rows_now from public.ux_events where user_id = uid;

  for r in
    with items as (
      select e->>'t' as t, e->>'k' as k, e->>'s' as s,
             case when jsonb_typeof(e->'n') = 'number' then least(greatest(floor((e->>'n')::numeric)::int, 1), 5) else 1 end as n
        from jsonb_array_elements(p_events) e
       where jsonb_typeof(e) = 'object'
    )
    select t, k, s, least(sum(n), 1000000)::int as n
      from items
     where t in ('screen_view', 'action_click', 'rage_click', 'form_abandoned', 'help_opened')
       and k ~ '^[a-z0-9_:-]{1,64}$' and k !~ '^[0-9]+$'
       and s ~ '^[a-z0-9_:-]{1,64}$' and s !~ '^[0-9]+$'
     group by t, k, s
     order by t, k, s
  loop
    update public.ux_events
       set occurrences = least(occurrences + r.n, 1000000), last_seen_at = now()
     where user_id = uid and event_type = r.t and target_key = r.k and screen_key = r.s;
    get diagnostics hit = row_count;
    if hit > 0 then
      applied := applied + 1;
    elsif rows_now < 100 then
      insert into public.ux_events (user_id, event_type, target_key, screen_key, occurrences)
      values (uid, r.t, r.k, r.s, r.n)
      on conflict (user_id, event_type, target_key, screen_key)
      do update set occurrences = least(public.ux_events.occurrences + r.n, 1000000), last_seen_at = now();
      rows_now := rows_now + 1;
      applied := applied + 1;
    end if;
  end loop;
  return applied;
end $$;

revoke execute on function public.track_ux_events(jsonb) from public, anon, authenticated;
grant execute on function public.track_ux_events(jsonb) to authenticated;

commit;

-- ==================== 028_payment_autoconfirm.sql ====================
-- Seller Hub: automatic payment confirmation (payment provider webhook → invoice paid). Safe to run again.
-- Apply AFTER 027_ux_events_batch.sql, then grants.sql.
--
-- (a) confirm_invoice_core(id, note, by): the one place that marks an invoice paid (subscription period, store limit,
--     discount, referral reward). admin_confirm_invoice keeps its checks (is_admin, expected amount/stores) and calls it.
-- (b) payment_events: every payment notification, once per (provider, payment_id) — webhook retries are harmless.
-- (c) payment_received(...): service_role only (the payment-webhook Edge Function). Finds the invoice
--     (by our invoice id, else the ONE pending invoice with this phone and exactly this amount) and confirms it only
--     when it is pending and the amount matches to the tenge. Anything else is stored with outcome 'review' and a reason
--     for the admin: nothing is ever confirmed on a guess.
-- (d) admin_payment_events / admin_resolve_payment_event: the review queue in the admin page.
begin;

-- ---------- (a) one confirmation path ----------
create or replace function public.confirm_invoice_core(p_id bigint, p_note text, p_by uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; acc public.accounts; start_at timestamptz; end_at timestamptz; ref public.accounts;
begin
  select * into inv from public.invoices where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if inv.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
  select * into acc from public.accounts where user_id = inv.user_id for update;
  if inv.kind = 'addon' then
    -- extra stores for the rest of the current period; the end date does not move
    start_at := now();
    end_at := public.coverage_end(acc);
    update public.accounts set store_limit = greatest(store_limit, inv.stores) where user_id = inv.user_id;
  else
    start_at := greatest(now(), coalesce(acc.paid_until, now()), acc.trial_ends_at);
    end_at := start_at + make_interval(months => inv.months);
    -- paying again = staying: a cancellation or «перейти на Старт» is done; a discount is used up
    update public.accounts set paid_until = end_at, store_limit = inv.stores, cancel_at = null, cancel_reason = null, downgrade_next = false,
           boost_until = null where user_id = inv.user_id;
  end if;
  if inv.discount_pct > 0 then
    update public.accounts set discount_left = greatest(0, discount_left - 1) where user_id = inv.user_id;
  end if;
  update public.invoices set status = 'paid', paid_at = now(), period_from = start_at, period_to = end_at,
         confirmed_by = p_by, admin_note = p_note
    where id = p_id returning * into inv;

  -- referral reward: the first paid invoice of an invited friend gives the inviter +14 days, once
  if inv.kind <> 'addon' and acc.referred_by is not null and not acc.referral_rewarded
     and not exists (select 1 from public.invoices where user_id = inv.user_id and status = 'paid' and kind <> 'addon' and id <> inv.id) then
    select * into ref from public.accounts where user_id = acc.referred_by for update;
    -- inviter gone (deleted → not found), frozen or blocked: no reward (the friend is still marked as rewarded)
    if found and coalesce(ref.frozen_until, '-infinity') < now() and not ref.trial_blocked then
      update public.accounts set
        paid_until = greatest(now(), coalesce(paid_until, now()), trial_ends_at) + interval '14 days',
        referrals_count = referrals_count + 1, referral_bonus_days = referral_bonus_days + 14
      where user_id = ref.user_id;
      if exists (select 1 from public.tg_links where user_id = ref.user_id and blocked_at is null) then
        insert into public.tg_outbox (user_id, kind, payload) values (ref.user_id, 'referral', jsonb_build_object('days', 14));
      end if;
    end if;
    update public.accounts set referral_rewarded = true where user_id = inv.user_id;
  end if;
  return to_jsonb(inv);
end $$;
revoke execute on function public.confirm_invoice_core(bigint, text, uuid) from public, anon, authenticated;

create or replace function public.admin_confirm_invoice(p_id bigint, p_note text default null, p_expected_amount int default null, p_expected_stores int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  -- the admin page always sends what it displayed; a call without both values is refused before anything changes
  if p_expected_amount is null or p_expected_stores is null then raise exception 'expected_values_required' using errcode = '22023'; end if;
  select * into inv from public.invoices where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if inv.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
  -- the invoice changed after the admin looked at it: refuse, the admin reloads and checks the new amount
  if p_expected_amount is distinct from inv.amount or p_expected_stores is distinct from inv.stores then
    raise exception 'amount_changed' using errcode = '40001';
  end if;
  return public.confirm_invoice_core(p_id, p_note, auth.uid());
end $$;
revoke execute on function public.admin_confirm_invoice(bigint, text, int, int) from public, anon;
grant execute on function public.admin_confirm_invoice(bigint, text, int, int) to authenticated;  -- is_admin() inside

-- ---------- (b) payment notifications ----------
create table if not exists public.payment_events (
  id          bigserial primary key,
  provider    text not null check (provider ~ '^[a-z0-9_-]{2,32}$'),
  payment_id  text not null check (length(payment_id) between 1 and 128),
  invoice_id  bigint references public.invoices (id) on delete set null,
  amount      int not null check (amount > 0),
  phone       text,
  outcome     text not null default 'processing' check (outcome in ('processing', 'confirmed', 'review', 'resolved')),
  reason      text check (reason is null or reason in ('no_match', 'ambiguous', 'amount_mismatch', 'invoice_not_pending', 'invoice_not_found')),
  received_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  admin_note  text,
  unique (provider, payment_id)
);
alter table public.payment_events enable row level security;
revoke all on public.payment_events from public, anon, authenticated;
revoke all on sequence public.payment_events_id_seq from public, anon, authenticated;
create index if not exists payment_events_review_idx on public.payment_events (received_at desc) where outcome = 'review';
create index if not exists invoices_pending_phone_amount on public.invoices (phone, amount) where status = 'pending';

-- ---------- (c) the webhook entry point ----------
create or replace function public.payment_received(p_provider text, p_payment_id text, p_amount int,
                                                   p_invoice_id bigint default null, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.payment_events; inv public.invoices; ph text; n int; why text;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_-]{2,32}$' or p_payment_id is null or length(p_payment_id) not between 1 and 128
     or p_amount is null or p_amount <= 0 then
    raise exception 'invalid_payment' using errcode = '22023';
  end if;
  ph := public.normalize_phone(p_phone);
  insert into public.payment_events (provider, payment_id, amount, phone)
  values (p_provider, p_payment_id, p_amount, ph)
  on conflict (provider, payment_id) do nothing
  returning * into ev;
  if not found then
    -- the provider sent the same payment again (retry): answer what was decided the first time, change nothing
    select * into ev from public.payment_events where provider = p_provider and payment_id = p_payment_id;
    return jsonb_build_object('outcome', ev.outcome, 'reason', ev.reason, 'invoice_id', ev.invoice_id, 'duplicate', true);
  end if;

  if p_invoice_id is not null then
    select * into inv from public.invoices where id = p_invoice_id for update;
    if not found then why := 'invoice_not_found'; end if;
  elsif ph is not null then
    select count(*) into n from public.invoices where status = 'pending' and phone = ph and amount = p_amount;
    if n = 1 then
      select * into inv from public.invoices where status = 'pending' and phone = ph and amount = p_amount for update;
    elsif n = 0 then why := 'no_match';
    else why := 'ambiguous';
    end if;
  else
    why := 'no_match';
  end if;

  if why is null and inv.status <> 'pending' then why := 'invoice_not_pending'; end if;
  if why is null and inv.amount <> p_amount then why := 'amount_mismatch'; end if;

  if why is null then
    perform public.confirm_invoice_core(inv.id, left('auto: ' || p_provider || ' ' || p_payment_id, 200), null);
    update public.payment_events set outcome = 'confirmed', invoice_id = inv.id where id = ev.id returning * into ev;
  else
    update public.payment_events set outcome = 'review', reason = why, invoice_id = inv.id where id = ev.id returning * into ev;
  end if;
  return jsonb_build_object('outcome', ev.outcome, 'reason', ev.reason, 'invoice_id', ev.invoice_id, 'duplicate', false);
end $$;
revoke execute on function public.payment_received(text, text, int, bigint, text) from public, anon, authenticated;
grant execute on function public.payment_received(text, text, int, bigint, text) to service_role;

-- ---------- (d) review queue for the admin ----------
create or replace function public.admin_payment_events(p_only_review boolean default true, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.received_at desc)
      from (select e.id, e.provider, e.payment_id, e.invoice_id, e.amount, e.phone, e.outcome, e.reason, e.received_at,
                   e.resolved_at, e.admin_note, i.status as invoice_status, i.amount as invoice_amount
              from public.payment_events e left join public.invoices i on i.id = e.invoice_id
             where not p_only_review or e.outcome = 'review'
             order by e.received_at desc
             limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end $$;

create or replace function public.admin_resolve_payment_event(p_id bigint, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.payment_events;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.payment_events set outcome = 'resolved', resolved_at = now(), resolved_by = auth.uid(), admin_note = left(p_note, 500)
   where id = p_id and outcome = 'review' returning * into ev;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  return to_jsonb(ev);
end $$;
revoke execute on function public.admin_payment_events(boolean, int), public.admin_resolve_payment_event(bigint, text) from public, anon;
grant execute on function public.admin_payment_events(boolean, int), public.admin_resolve_payment_event(bigint, text) to authenticated;  -- is_admin() inside

commit;

-- ==================== grants.sql ====================
-- Seller Hub: function, table and Storage privileges, deterministic and idempotent.
-- Apply AFTER restoring a dump (pg_restore --no-owner ...):
--   psql "$TARGET_DB_URL" -f kaspi-seller-hub/billing/supabase/grants.sql
-- Mirrors the grants of migrations 001..026 (verified against a database built from them).
-- Keep in sync: when a migration adds a function or changes who may call it, update this file too.

-- 1. everything closed first (also for future functions)
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

-- 2. anonymous: the service-status banner (extension, admin page) and the health probe
grant execute on function public.get_service_status(), public.health() to anon, authenticated;

-- 3. signed-in sellers and admins (admin_* functions check is_admin() inside)
grant execute on function
  public.accept_terms(),
  public.admin_accounts(text,text,int,int),
  public.admin_cancel_invoice(bigint,text),
  public.admin_client_errors(int),
  public.admin_confirm_invoice(bigint,text,int,int),
  public.admin_payment_events(boolean,int),
  public.admin_resolve_payment_event(bigint,text),
  public.admin_delete_account(uuid,text),
  public.admin_delete_feature_flag(text),
  public.admin_fail_storage_cleanup(bigint,text),
  public.admin_funnel_events(),
  public.admin_get_config(),
  public.admin_get_system_banner(),
  public.admin_grant_days(uuid,int,int),
  public.admin_growth_settings(jsonb),
  public.admin_health(int),
  public.admin_insights(int),
  public.admin_invoices(text,text,int,int),
  public.admin_list_feature_flags(),
  public.admin_list_storage_cleanups(),
  public.admin_ops_settings(text,int,numeric),
  public.admin_purge_expired(),
  public.admin_resolve_storage_cleanup(bigint),
  public.admin_set_feature_flag(text,boolean,int,text[],text),
  public.admin_set_status(text,text,int),
  public.admin_set_system_banner(boolean,text,text),
  public.admin_ticket_reply(bigint,text,boolean),
  public.admin_tickets(text,text,int,int),
  public.admin_update_config(jsonb),
  public.admin_ux_summary(),
  public.alert_create(text,text,int,text),
  public.apply_referral_code(text),
  public.billing_price(int,int),
  public.can_write_feed(text),
  public.cancel_flow(text,text,text),
  public.cancel_my_invoice(bigint),
  public.create_invoice(int,int,text),
  public.digest_report(date,jsonb),
  public.ensure_price_feed(text),
  public.ensure_renewal_invoice(int),
  public.feedback_due(),
  public.feedback_submit(text,int,text,text,bigint),
  public.get_license(int,text[]),
  public.health_report(jsonb),
  public.is_admin(),
  public.my_referral(),
  public.my_tickets(),
  public.report_client_error(text,text,text),
  public.request_store_addon(int),
  public.resume_subscription(),
  public.set_my_phone(text),
  public.start_trial_boost(),
  public.team_check(uuid),
  public.team_invite(text,text,text[],boolean),
  public.team_join(uuid),
  public.team_list(),
  public.team_remove(uuid),
  public.team_set_enabled(uuid,boolean),
  public.team_update(uuid,text,text[],boolean),
  public.tg_link_create(),
  public.tg_settings(boolean,boolean),
  public.tg_status(),
  public.tg_unlink(),
  public.ticket_close(bigint),
  public.ticket_create(text,text,text,text),
  public.ticket_seen(bigint),
  public.track_funnel_event(text),
  public.track_ux_event(text,text,text),
  public.track_ux_events(jsonb),
  public.upgrade_quote(int),
  public.usage_report(jsonb,jsonb,text)
to authenticated;

-- 4. server side only (Telegram bot Edge Function, ops-alert job, retention job): service_role
grant execute on function
  public.bot_link(text, text, bigint, text), public.bot_unlink(text, bigint, boolean), public.bot_jobs(text), public.bot_sent(text, jsonb),
  public.bot_lock(text, text, int), public.bot_unlock(text, text), public.bot_key_ok(text), public.ops_digest(text),
  public.enqueue_retention_nudges(), public.payment_received(text,text,int,bigint,text)
to service_role;

-- 5. only Supabase Auth may run the access-token hook
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema public to supabase_auth_admin;
    grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
  end if;
end $$;

-- ---------- 6. tables and sequences (restore drill 2026-11-23) ----------
-- A restore into a Supabase project runs CREATE TABLE under Supabase's default privileges
-- (ALL to anon/authenticated); the dump's GRANTs only add on top. Close everything, then
-- re-grant exactly what the migrations grant: clients read their own account row (RLS) and
-- the public invoice columns of their own invoices (RLS); everything else goes through RPCs.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
grant select on public.accounts to authenticated;
grant select (id, user_id, kind, stores, months, amount, phone, status, created_at, paid_at, period_from, period_to, discount_pct)
  on public.invoices to authenticated;

-- ---------- 7. Storage: price-list bucket and its rules (schema storage is NOT in the dump) ----------
-- The files themselves live in Supabase Storage, outside the database dump: after a restore the
-- extension re-uploads a feed only when its prices/stock change or on a forced re-publish (same feed_id → same URL
-- on the same project; a new project has a new URL that the seller must paste into Kaspi again).
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('pricelists', 'pricelists', true, 5242880, array['application/xml', 'text/xml'])
      on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = array['application/xml', 'text/xml'];
    drop policy if exists "pricelists insert own" on storage.objects;
    drop policy if exists "pricelists update own" on storage.objects;
    drop policy if exists "pricelists select own" on storage.objects;
    drop policy if exists "pricelists delete own" on storage.objects;
    drop policy if exists "pricelists admin select" on storage.objects;
    drop policy if exists "pricelists admin delete" on storage.objects;
    create policy "pricelists insert own" on storage.objects for insert to authenticated
      with check (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists update own" on storage.objects for update to authenticated
      using (bucket_id = 'pricelists' and public.can_write_feed(name))
      with check (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists select own" on storage.objects for select to authenticated
      using (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists delete own" on storage.objects for delete to authenticated
      using (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists admin select" on storage.objects for select to authenticated
      using (bucket_id = 'pricelists' and public.is_admin());
    create policy "pricelists admin delete" on storage.objects for delete to authenticated
      using (bucket_id = 'pricelists' and public.is_admin());
  end if;
end $$;
