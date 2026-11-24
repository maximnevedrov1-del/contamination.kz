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
