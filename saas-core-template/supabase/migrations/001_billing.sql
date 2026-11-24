-- =====================================================================
-- {{APP_NAME}} — subscriptions & invoices (Supabase / Postgres)
--
-- Run once in Supabase: Dashboard → SQL Editor → paste → Run.
--
-- Model
--   * Every new user (email login) gets an account with a free trial.
--   * Price per month = base_price for up to base_stores stores
--                       + extra_store_price for every store above that.
--     Prices in {{CURRENCY}}. Defaults: 20 000 {{CURRENCY_SYMBOL}} for 3 stores, +5 000 {{CURRENCY_SYMBOL}} per extra store, {{TRIAL_DAYS}}-day trial.
--   * A user creates an invoice (stores, months, phone) from the extension.
--     The amount is computed HERE, never trusted from the client.
--   * The owner sees it in the admin page, sends a remote invoice to
--     that phone (or the client pays by the payment link / QR), and confirms → paid_until moves on.
--
-- Security: Row Level Security on every table; clients only read their own
-- rows; every write goes through SECURITY DEFINER functions that validate input.
-- Admin functions check membership in public.admins.
-- =====================================================================

-- ---------- configuration (single row, editable from the admin page) ----------
create table if not exists public.billing_config (
  id                   int primary key default 1 check (id = 1),
  base_price           int  not null default 20000 check (base_price >= 0),
  base_stores          int  not null default 3     check (base_stores >= 1),
  extra_store_price    int  not null default 5000  check (extra_store_price >= 0),
  trial_days           int  not null default {{TRIAL_DAYS}}    check (trial_days >= 0),
  trial_store_limit    int  not null default 3     check (trial_store_limit >= 1),
  max_months           int  not null default 12    check (max_months between 1 and 24),
  max_stores           int  not null default 200   check (max_stores >= 1),
  remind_days          int  not null default 5     check (remind_days between 1 and 30),
  payment_url         text,          -- public URL of your payment page or QR image
  payment_instructions text,          -- shown to the client next to the amount
  updated_at           timestamptz not null default now()
);
insert into public.billing_config (id) values (1) on conflict (id) do nothing;
-- upgrades of an existing database
alter table public.billing_config add column if not exists remind_days int not null default 5;
-- tariffs (2026-11-18): «Старт» 1 store = start_price; «Мульти» up to base_stores = base_price;
-- every store above base_stores + extra_store_price. start_price 0 = no «Старт» (1 store pays base_price).
alter table public.billing_config add column if not exists start_price int not null default 12000 check (start_price >= 0);
alter table public.billing_config add column if not exists grace_days  int not null default 4  check (grace_days between 0 and 14);
alter table public.billing_config add column if not exists freeze_days int not null default 30 check (freeze_days between 1 and 90);
alter table public.billing_config add column if not exists boost_hours int not null default 24 check (boost_hours between 1 and 168);

-- ---------- accounts ----------
create table if not exists public.accounts (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  email            text,
  phone            text,                       -- normalized 7XXXXXXXXXX, used for remote invoices
  trial_ends_at    timestamptz not null,
  paid_until       timestamptz,
  store_limit      int not null default 3,     -- stores covered now (trial or paid), raised by add-on invoices
  last_store_count int,                        -- reported by the extension (for the admin)
  last_seen_at     timestamptz,
  created_at       timestamptz not null default now()
);

alter table public.accounts add column if not exists boost_until    timestamptz;   -- «3 магазина бесплатно 24 часа» on «Старт»
alter table public.accounts add column if not exists boost_used_at  timestamptz;   -- once per account
alter table public.accounts add column if not exists frozen_until   timestamptz;   -- «заморозка»: no access, paid days kept
alter table public.accounts add column if not exists cancel_at      timestamptz;   -- «отменить подписку»: no renewal, no grace
alter table public.accounts add column if not exists cancel_reason  text;
alter table public.accounts add column if not exists downgrade_next boolean not null default false; -- next period on «Старт»
alter table public.accounts add column if not exists discount_pct   int not null default 0 check (discount_pct between 0 and 90);
alter table public.accounts add column if not exists discount_left  int not null default 0 check (discount_left between 0 and 12); -- invoices it applies to
alter table public.accounts add column if not exists discount_until timestamptz;   -- offer valid until (win-back)

-- ---------- invoices ----------
create table if not exists public.invoices (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.accounts (user_id) on delete cascade,
  -- manual  = created by the client on the "Подписка" page
  -- renewal = created automatically remind_days before the end, for ALL connected stores
  -- addon   = extra stores connected mid-period, prorated to the end of the current period
  kind         text not null default 'manual' check (kind in ('manual', 'renewal', 'addon')),
  stores       int  not null check (stores between 1 and 1000),   -- total stores covered after payment
  months       int  not null check (months between 0 and 24),     -- 0 for add-on invoices
  amount       int  not null check (amount > 0),
  phone        text,                                              -- optional: for a remote invoice
  status       text not null default 'pending' check (status in ('pending', 'paid', 'cancelled')),
  created_at   timestamptz not null default now(),
  paid_at      timestamptz,
  period_from  timestamptz,
  period_to    timestamptz,
  confirmed_by uuid,
  admin_note   text
);
-- upgrades of an existing database
alter table public.invoices add column if not exists kind text not null default 'manual';
alter table public.invoices add column if not exists discount_pct int not null default 0;
alter table public.invoices alter column phone drop not null;
alter table public.invoices drop constraint if exists invoices_months_check;
alter table public.invoices add constraint invoices_months_check check (months between 0 and 24);
alter table public.invoices drop constraint if exists invoices_kind_check;
alter table public.invoices add constraint invoices_kind_check check (kind in ('manual', 'renewal', 'addon'));

-- at most one open invoice per user (one amount, one QR)
create unique index if not exists invoices_one_pending on public.invoices (user_id) where status = 'pending';
create index if not exists invoices_status_created on public.invoices (status, created_at desc);
-- Every licence check reads the client's own invoices: without this index each check
-- scans the whole table (measured: 15 ms at 300k invoices → 0.1 ms with it).
create index if not exists invoices_user_created on public.invoices (user_id, created_at desc);

-- ---------- admins (add yourself once, see billing/README.md) ----------
-- ---------- consent to the offer and privacy policy (clickwrap) ----------
-- billing_config.terms_version = the version every client must have accepted.
-- Bump it (admin page → «Цены и QR») after publishing new texts: every client
-- then has to tick the box again before the extension works.
alter table public.billing_config add column if not exists terms_version text not null default '2026-11-16';
alter table public.accounts add column if not exists terms_version text;
alter table public.accounts add column if not exists terms_accepted_at timestamptz;

-- Evidence log: one row per acceptance (never updated or deleted by clients).
create table if not exists public.consents (
  id          bigserial primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  version     text not null,
  accepted_at timestamptz not null default now(),
  ip          text,
  user_agent  text
);
create index if not exists consents_user_idx on public.consents (user_id, accepted_at desc);

-- ---------- anti-abuse: one free trial per workspace ----------
-- The extension reports SHA-256 hashes of the connected stores' external IDs (never the
-- IDs themselves). The first account that shows a store "claims" it; a NEW account that
-- connects a store already claimed by someone else gets no free trial.
create table if not exists public.store_claims (
  store_key  text primary key check (store_key ~ '^[0-9a-f]{64}$'),
  user_id    uuid not null references auth.users (id) on delete cascade,
  claimed_at timestamptz not null default now()
);
alter table public.accounts add column if not exists trial_blocked boolean not null default false;

create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- ---------- row level security ----------
alter table public.billing_config enable row level security;
alter table public.accounts       enable row level security;
alter table public.invoices       enable row level security;
alter table public.admins         enable row level security;
alter table public.consents       enable row level security;
alter table public.store_claims   enable row level security;

drop policy if exists accounts_read_own on public.accounts;
create policy accounts_read_own on public.accounts for select to authenticated using (user_id = auth.uid());
drop policy if exists invoices_read_own on public.invoices;
create policy invoices_read_own on public.invoices for select to authenticated using (user_id = auth.uid());
-- billing_config and admins: no policies → no direct access; read through functions.

revoke all on public.billing_config, public.accounts, public.invoices, public.admins, public.consents, public.store_claims from anon, authenticated;
grant select on public.accounts, public.invoices to authenticated;

-- ---------- helpers ----------
create or replace function public.billing_price(p_stores int, p_months int)
returns int language sql stable security definer set search_path = public as $$
  select ((case when p_stores <= 1 and c.start_price > 0 then c.start_price
                else c.base_price + greatest(0, p_stores - c.base_stores) * c.extra_store_price end) * p_months)::int
  from public.billing_config c where c.id = 1;
$$;

-- Stores an invoice covers: «Старт» = 1; anything more is «Мульти» (at least base_stores).
create or replace function public.plan_stores(p_stores int)
returns int language sql stable security definer set search_path = public as $$
  select case when coalesce(p_stores, 1) <= 1 and c.start_price > 0 then 1 else greatest(coalesce(p_stores, 1), c.base_stores) end
  from public.billing_config c where c.id = 1;
$$;

-- Personal discount (cancellation offer, win-back) on the next invoice(s); rounded up to 100 {{CURRENCY_SYMBOL}}.
create or replace function public.discounted(p_amount int, acc public.accounts)
returns int language sql stable as $$
  select case when acc.discount_left > 0 and acc.discount_pct > 0 and (acc.discount_until is null or acc.discount_until > now())
              then greatest(100, (ceil(p_amount * (100 - acc.discount_pct) / 100.0 / 100.0) * 100)::int) else p_amount end;
$$;
create or replace function public.discount_now(acc public.accounts)
returns int language sql stable as $$
  select case when acc.discount_left > 0 and (acc.discount_until is null or acc.discount_until > now()) then acc.discount_pct else 0 end;
$$;

-- Paid period over, not cancelled → grace_days more with full access (renewal is unpaid, not refused).
create or replace function public.grace_until(acc public.accounts)
returns timestamptz language sql stable as $$
  select case when acc.paid_until is not null and acc.cancel_at is null
              then acc.paid_until + make_interval(days => (select grace_days from public.billing_config where id = 1)) end;
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

-- "8 701 123 45 67", "+7 (701) 123-45-67" → "77011234567"; null if not a KZ mobile number
create or replace function public.normalize_phone(p text)
returns text language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if length(d) = 11 and left(d, 1) = '8' then d := '7' || substr(d, 2); end if;
  if length(d) = 10 and left(d, 1) = '7' then d := '7' || d; end if;
  if d ~ '^77\d{9}$' then return d; end if;
  return null;
end $$;

-- account for the current user (created by the trigger; this is a safety net)
create or replace function public.ensure_account()
returns public.accounts language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); acc public.accounts;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  insert into public.accounts (user_id, email, trial_ends_at, store_limit)
    select uid, u.email, now() + make_interval(days => c.trial_days), c.trial_store_limit
    from auth.users u, public.billing_config c where u.id = uid and c.id = 1
  on conflict (user_id) do nothing;
  select * into acc from public.accounts where user_id = uid;
  return acc;
end $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.accounts (user_id, email, trial_ends_at, store_limit)
    select new.id, new.email, now() + make_interval(days => c.trial_days), c.trial_store_limit
    from public.billing_config c where c.id = 1
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- client functions ----------

-- End of what the account has right now: the paid period, else the trial.
create or replace function public.coverage_end(acc public.accounts)
returns timestamptz language sql stable as $$
  select case when acc.paid_until > now() then acc.paid_until else acc.trial_ends_at end;
$$;

-- Licence for the extension: status, limits, pricing, payment details, open invoice.
drop function if exists public.get_license(int);
create or replace function public.get_license(p_store_count int default null, p_store_keys text[] default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config; st text; lim int;
begin
  acc := public.ensure_account();
  update public.accounts set last_store_count = coalesce(p_store_count, last_store_count), last_seen_at = now()
    where user_id = acc.user_id;
  select * into c from public.billing_config where id = 1;
  if p_store_keys is not null and cardinality(p_store_keys) between 1 and 500 then
    insert into public.store_claims (store_key, user_id)
      select distinct k, acc.user_id from unnest(p_store_keys) k where k ~ '^[0-9a-f]{64}$'
    on conflict (store_key) do nothing;
    -- never paid + still on trial + a store already used by another account → trial is over
    if acc.paid_until is null and acc.trial_ends_at > now() and exists (
         select 1 from public.store_claims sc where sc.store_key = any (p_store_keys) and sc.user_id <> acc.user_id) then
      update public.accounts set trial_ends_at = now(), trial_blocked = true where user_id = acc.user_id returning * into acc;
    end if;
  end if;
  st := case when acc.frozen_until > now() then 'frozen'
             when acc.paid_until > now() then 'active'
             when acc.trial_ends_at > now() then 'trial'
             when public.grace_until(acc) > now() then 'grace'
             else 'expired' end;
  lim := case when st in ('active', 'grace') then acc.store_limit
              when st = 'trial' then greatest(c.trial_store_limit, acc.store_limit)
              else 0 end;
  if st in ('active', 'grace') and acc.boost_until > now() then lim := greatest(lim, c.base_stores); end if;
  return jsonb_build_object(
    'status', st,
    'email', acc.email,
    'phone', acc.phone,
    'trial_ends_at', acc.trial_ends_at,
    'paid_until', acc.paid_until,
    'coverage_end', public.coverage_end(acc),
    'remind_days', c.remind_days,
    'terms_version', acc.terms_version,
    'terms_accepted_at', acc.terms_accepted_at,
    'terms_required', c.terms_version,
    'trial_blocked', acc.trial_blocked,
    'store_limit', lim,
    'paid_store_limit', acc.store_limit,
    'server_time', now(),
    'plan', case when acc.store_limit <= 1 then 'start' else 'multi' end,
    'boost_until', acc.boost_until,
    'can_boost', st = 'active' and acc.store_limit < c.base_stores and acc.boost_used_at is null,
    'grace_until', public.grace_until(acc),
    'frozen_until', acc.frozen_until,
    'cancel_at', acc.cancel_at,
    'downgrade_next', acc.downgrade_next,
    'discount', jsonb_build_object('pct', public.discount_now(acc), 'left', acc.discount_left, 'until', acc.discount_until),
    'pricing', jsonb_build_object('base_price', c.base_price, 'base_stores', c.base_stores, 'start_price', c.start_price,
                                  'extra_store_price', c.extra_store_price, 'max_months', c.max_months, 'max_stores', c.max_stores,
                                  'grace_days', c.grace_days, 'freeze_days', c.freeze_days, 'boost_hours', c.boost_hours),
    'payment', jsonb_build_object('payment_url', c.payment_url, 'instructions', c.payment_instructions),
    'pending_invoice', (select to_jsonb(i) - 'confirmed_by' - 'admin_note' from public.invoices i
                        where i.user_id = acc.user_id and i.status = 'pending'),
    'invoices', coalesce((select jsonb_agg(to_jsonb(i) - 'confirmed_by' - 'admin_note' order by i.created_at desc)
                          from (select * from public.invoices where user_id = acc.user_id order by created_at desc limit 12) i), '[]'::jsonb)
  );
end $$;

-- Optional phone: empty → keep the account's phone; given but invalid → error.
create or replace function public.phone_or_account(p_phone text, acc public.accounts)
returns text language plpgsql stable as $$
declare ph text;
begin
  if p_phone is null or btrim(p_phone) = '' then return acc.phone; end if;
  ph := public.normalize_phone(p_phone);
  if ph is null then raise exception 'invalid_phone' using errcode = '22023'; end if;
  return ph;
end $$;

-- At most 30 invoices per client per 24 h (stops scripts flooding the table).
create or replace function public.check_invoice_rate(p_user uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if (select count(*) from public.invoices where user_id = p_user and created_at > now() - interval '24 hours') >= 30 then
    raise exception 'rate_limited' using errcode = '54000';
  end if;
end $$;

-- New invoice chosen by the client (replaces an open one). Amount is computed server-side.
create or replace function public.create_invoice(p_stores int, p_months int, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config; ph text; n_stores int; inv public.invoices;
begin
  acc := public.ensure_account();
  select * into c from public.billing_config where id = 1;
  if acc.terms_version is distinct from c.terms_version then raise exception 'terms_required' using errcode = '42501'; end if;
  if p_months is null or p_months < 1 or p_months > c.max_months then raise exception 'invalid_months' using errcode = '22023'; end if;
  if p_stores is null or p_stores < 1 or p_stores > c.max_stores then raise exception 'invalid_stores' using errcode = '22023'; end if;
  ph := public.phone_or_account(p_phone, acc);
  n_stores := public.plan_stores(p_stores);        -- 1 = «Старт»; more = «Мульти» (base price covers base_stores)
  perform public.check_invoice_rate(acc.user_id);
  update public.invoices set status = 'cancelled', admin_note = coalesce(admin_note, 'replaced by client')
    where user_id = acc.user_id and status = 'pending';
  insert into public.invoices (user_id, kind, stores, months, amount, phone, discount_pct)
    values (acc.user_id, 'manual', n_stores, p_months, public.discounted(public.billing_price(n_stores, p_months), acc), ph, public.discount_now(acc))
    returning * into inv;
  if ph is not null then update public.accounts set phone = ph where user_id = acc.user_id; end if;
  return to_jsonb(inv) - 'confirmed_by' - 'admin_note';
end $$;

-- Renewal: from remind_days before the end (or once expired) there is exactly ONE open
-- invoice covering ALL connected stores for 1 month — one amount, one QR.
-- Idempotent: called on every licence check; returns the open invoice or null.
create or replace function public.ensure_renewal_invoice(p_stores int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config; pend public.invoices; n int; amt int;
begin
  acc := public.ensure_account();
  select * into c from public.billing_config where id = 1;
  if public.coverage_end(acc) > now() + make_interval(days => c.remind_days) then return null; end if;
  if acc.cancel_at is not null or acc.frozen_until > now() then return null; end if;   -- cancelled / frozen: no reminders
  -- all connected stores; a paying client keeps at least the plan they paid for (unless «перейти на Старт»)
  n := least(c.max_stores, public.plan_stores(case when acc.downgrade_next then 1
            else greatest(coalesce(p_stores, 0), case when acc.paid_until is not null then acc.store_limit else 1 end, 1) end));
  amt := public.discounted(public.billing_price(n, 1), acc);
  select * into pend from public.invoices where user_id = acc.user_id and status = 'pending' for update;
  if found and pend.kind in ('manual') then
    return to_jsonb(pend) - 'confirmed_by' - 'admin_note';            -- the client already chose a plan
  end if;
  if found and pend.kind = 'renewal' then
    if pend.stores <> n or pend.amount <> amt then                     -- stores added/removed → same invoice, new total
      update public.invoices set stores = n, amount = amt, discount_pct = public.discount_now(acc) where id = pend.id returning * into pend;
    end if;
    return to_jsonb(pend) - 'confirmed_by' - 'admin_note';
  end if;
  if found then                                                        -- an add-on is folded into the renewal
    update public.invoices set status = 'cancelled', admin_note = 'merged into renewal' where id = pend.id;
  end if;
  insert into public.invoices (user_id, kind, stores, months, amount, phone, discount_pct)
    values (acc.user_id, 'renewal', n, 1, amt, acc.phone, public.discount_now(acc)) returning * into pend;
  return to_jsonb(pend) - 'confirmed_by' - 'admin_note';
end $$;

-- Extra stores connected mid-period: pay only the price difference for the days left in the
-- current period, rounded up to 100 {{CURRENCY_SYMBOL}}, so every store renews on the same date:
--   upgrade_cost = (price(new stores) − price(covered stores)) / 30 × remaining_days
-- «Старт» → 2nd store = (20 000 − 12 000) / 30 × days; 3 → 4 stores = 5 000 / 30 × days. Near the end (renewal window) or after expiry the stores go into
-- the renewal invoice instead. Returns the open invoice, or null if nothing to pay.
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

-- Phone for a remote invoice (optional; QR works without it).
create or replace function public.set_my_phone(p_phone text)
returns text language plpgsql security definer set search_path = public as $$
declare acc public.accounts; ph text;
begin
  acc := public.ensure_account();
  ph := public.normalize_phone(p_phone);
  if ph is null then raise exception 'invalid_phone' using errcode = '22023'; end if;
  update public.accounts set phone = ph where user_id = acc.user_id;
  update public.invoices set phone = ph where user_id = acc.user_id and status = 'pending';
  return ph;
end $$;

create or replace function public.cancel_my_invoice(p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.invoices set status = 'cancelled', admin_note = 'cancelled by client'
    where id = p_id and user_id = auth.uid() and status = 'pending';
  return found;
end $$;

-- The client ticked «Принимаю оферту и политику» → record the CURRENT version
-- (the server decides which version that is), the time, IP and browser.
create or replace function public.accept_terms()
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config; hdr jsonb; ip text; ua text;
begin
  acc := public.ensure_account();
  select * into c from public.billing_config where id = 1;
  begin
    hdr := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then hdr := null;
  end;
  ip := left(btrim(split_part(coalesce(hdr->>'x-forwarded-for', hdr->>'x-real-ip', ''), ',', 1)), 64);
  ua := left(hdr->>'user-agent', 300);
  -- one evidence row per version (repeat calls cannot flood the table)
  if not exists (select 1 from public.consents where user_id = acc.user_id and version = c.terms_version) then
    insert into public.consents (user_id, version, ip, user_agent) values (acc.user_id, c.terms_version, nullif(ip, ''), ua);
  end if;
  update public.accounts set terms_version = c.terms_version, terms_accepted_at = now() where user_id = acc.user_id;
  return jsonb_build_object('version', c.terms_version, 'accepted_at', now());
end $$;

-- ---------- admin functions ----------
-- Pages of at most 500 rows (the admin page asks for 100): with tens of thousands of
-- clients a full list would be tens of megabytes per refresh.
drop function if exists public.admin_invoices(text);
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
      select i.*, a.email, a.paid_until as acc_paid_until, a.trial_ends_at, a.last_store_count
      from public.invoices i join public.accounts a using (user_id)
      where (p_status = 'all' or i.status = p_status)
        and (q is null or a.email ilike '%' || q || '%' or (digits is not null and i.phone like '%' || digits || '%')
             or i.id::text = q)
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) - 'acc_paid_until' || jsonb_build_object('paid_until', x.acc_paid_until) order by x.created_at desc)
                        from (select * from f order by created_at desc
                              limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb))
  );
end $$;

-- Payment received via the payment provider → extend the subscription.
-- A payment made during the trial starts after the trial (the trial is not lost).
create or replace function public.admin_confirm_invoice(p_id bigint, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; acc public.accounts; start_at timestamptz; end_at timestamptz;
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
  return to_jsonb(inv);
end $$;

create or replace function public.admin_cancel_invoice(p_id bigint, p_note text default null)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.invoices set status = 'cancelled', admin_note = coalesce(p_note, 'cancelled by admin'), confirmed_by = auth.uid()
    where id = p_id and status = 'pending';
  return found;
end $$;

drop function if exists public.admin_accounts();
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
      select a.*, case when a.paid_until > now() then 'active' when a.trial_ends_at > now() then 'trial' else 'expired' end as st
      from public.accounts a
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
          'status', x.st) order by x.created_at desc)
        from (select * from f order by created_at desc
              limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb))
  );
end $$;

-- Gift / compensation: add days to a client's paid period.
create or replace function public.admin_grant_days(p_user uuid, p_days int, p_stores int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_days is null or p_days < 1 or p_days > 366 then raise exception 'invalid_days' using errcode = '22023'; end if;
  update public.accounts
     set paid_until = greatest(now(), coalesce(paid_until, now()), trial_ends_at) + make_interval(days => p_days),
         store_limit = coalesce(p_stores, store_limit)
   where user_id = p_user returning * into acc;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  return to_jsonb(acc);
end $$;

create or replace function public.admin_get_config()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select to_jsonb(c) from public.billing_config c where id = 1);
end $$;

create or replace function public.admin_update_config(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.billing_config set
    base_price           = coalesce((p->>'base_price')::int, base_price),
    base_stores          = coalesce((p->>'base_stores')::int, base_stores),
    extra_store_price    = coalesce((p->>'extra_store_price')::int, extra_store_price),
    trial_days           = coalesce((p->>'trial_days')::int, trial_days),
    trial_store_limit    = coalesce((p->>'trial_store_limit')::int, trial_store_limit),
    max_months           = coalesce((p->>'max_months')::int, max_months),
    remind_days          = coalesce((p->>'remind_days')::int, remind_days),
    start_price          = coalesce((p->>'start_price')::int, start_price),
    grace_days           = coalesce((p->>'grace_days')::int, grace_days),
    freeze_days          = coalesce((p->>'freeze_days')::int, freeze_days),
    terms_version        = coalesce(nullif(btrim(p->>'terms_version'), ''), terms_version),
    payment_url         = case when p ? 'payment_url' then nullif(p->>'payment_url', '') else payment_url end,
    payment_instructions = case when p ? 'payment_instructions' then nullif(p->>'payment_instructions', '') else payment_instructions end,
    updated_at           = now()
  where id = 1;
  return public.admin_get_config();
end $$;

-- ---------- signed licence (Supabase Auth → Hooks → Custom Access Token) ----------
-- Puts the licence into the user's access token. Supabase Auth signs the token with
-- the project's asymmetric key (ES256); the extension checks that signature with the
-- PUBLIC key from shared/billing-config.js. Editing the browser storage or faking the
-- server's answer therefore cannot extend a subscription.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config; claims jsonb := coalesce(event->'claims', '{}'::jsonb);
begin
  select * into acc from public.accounts where user_id = (event->>'user_id')::uuid;
  select * into c from public.billing_config where id = 1;
  if acc.user_id is not null then
    claims := jsonb_set(claims, '{app}', jsonb_build_object(
      'pu',  floor(extract(epoch from acc.paid_until)),      -- paid until (unix s) or null
      'te',  floor(extract(epoch from acc.trial_ends_at)),   -- trial ends (unix s)
      'sl',  acc.store_limit,                                 -- paid store limit
      'tsl', c.trial_store_limit,                             -- stores during the trial
      'tv',  acc.terms_version,                               -- accepted offer version
      'tr',  c.terms_version,                                 -- required offer version
      'bu',  floor(extract(epoch from acc.boost_until)),      -- «3 магазина на 24 часа» until
      'bs',  c.base_stores,                                   -- stores of «Мульти» (the boost)
      'gu',  floor(extract(epoch from public.grace_until(acc))), -- grace after the paid period (null = none)
      'fu',  floor(extract(epoch from acc.frozen_until))      -- frozen until
    ));
  end if;
  return jsonb_build_object('claims', claims);
end $$;

-- ---------- public file feeds (automatic upload by URL) ----------
-- Each connected store gets a secret feed id. The extension uploads the store's XML
-- file to Storage at  pricelists/<feed_id>/<shop_key>.xml ; the client pastes the
-- public URL once into the external system, which re-reads it periodically. The URL holds only the feed file.
create table if not exists public.price_feeds (
  feed_id    uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  shop_key   text not null check (shop_key ~ '^shop-[a-z0-9]{1,13}$'),
  created_at timestamptz not null default now(),
  unique (user_id, shop_key)
);
alter table public.price_feeds enable row level security;
revoke all on public.price_feeds from anon, authenticated;   -- read and written only through the functions below

-- Trial or paid, and the current offer accepted.
create or replace function public.has_access()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.accounts a, public.billing_config c
    where a.user_id = auth.uid() and c.id = 1
      and (a.paid_until > now() or a.trial_ends_at > now())
      and a.terms_version is not distinct from c.terms_version);
$$;

-- Feed for one store; at most as many stores as the subscription covers.
create or replace function public.ensure_price_feed(p_shop_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config; f public.price_feeds; lim int;
begin
  acc := public.ensure_account();
  if not public.has_access() then raise exception 'subscription_required' using errcode = '42501'; end if;
  if p_shop_key is null or p_shop_key !~ '^shop-[a-z0-9]{1,13}$' then raise exception 'invalid_shop' using errcode = '22023'; end if;
  select * into f from public.price_feeds where user_id = acc.user_id and shop_key = p_shop_key;
  if found then return jsonb_build_object('feed_id', f.feed_id, 'shop_key', f.shop_key); end if;
  select * into c from public.billing_config where id = 1;
  lim := case when acc.paid_until > now() then acc.store_limit else greatest(c.trial_store_limit, acc.store_limit) end;
  if (select count(*) from public.price_feeds where user_id = acc.user_id) >= lim then
    raise exception 'store_limit' using errcode = '42501';
  end if;
  insert into public.price_feeds (user_id, shop_key) values (acc.user_id, p_shop_key) returning * into f;
  return jsonb_build_object('feed_id', f.feed_id, 'shop_key', f.shop_key);
end $$;

-- Storage rule: "<feed_id>/<shop_key>.xml" of the caller's own feed, while subscribed.
create or replace function public.can_write_feed(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(coalesce(p_name, ''), '/');
begin
  if array_length(parts, 1) <> 2 or parts[1] !~ '^[0-9a-f-]{36}$' then return false; end if;
  return public.has_access() and exists (
    select 1 from public.price_feeds f
    where f.feed_id = parts[1]::uuid and f.user_id = auth.uid() and parts[2] = f.shop_key || '.xml');
end $$;

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    -- public bucket = files readable by URL without a key (external systems fetch them); 5 MB, XML only
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('pricelists', 'pricelists', true, 5242880, array['application/xml', 'text/xml'])
      on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = array['application/xml', 'text/xml'];
    drop policy if exists "pricelists insert own" on storage.objects;
    drop policy if exists "pricelists update own" on storage.objects;
    drop policy if exists "pricelists select own" on storage.objects;
    drop policy if exists "pricelists delete own" on storage.objects;
    create policy "pricelists insert own" on storage.objects for insert to authenticated
      with check (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists update own" on storage.objects for update to authenticated
      using (bucket_id = 'pricelists' and public.can_write_feed(name))
      with check (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists select own" on storage.objects for select to authenticated
      using (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists delete own" on storage.objects for delete to authenticated
      using (bucket_id = 'pricelists' and public.can_write_feed(name));
  end if;
end $$;

-- ---------- who may call what ----------
-- Supabase grants EXECUTE on new functions to anon AND authenticated by default:
-- take it away from everyone, then allow only the client API below.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.get_license(int, text[]), public.create_invoice(int, int, text), public.cancel_my_invoice(bigint),
  public.ensure_renewal_invoice(int), public.request_store_addon(int), public.set_my_phone(text), public.accept_terms(), public.ensure_price_feed(text), public.can_write_feed(text),
  public.billing_price(int, int), public.is_admin(),
  public.admin_invoices(text, text, int, int), public.admin_confirm_invoice(bigint, text), public.admin_cancel_invoice(bigint, text),
  public.admin_accounts(text, text, int, int), public.admin_grant_days(uuid, int, int), public.admin_get_config(), public.admin_update_config(jsonb)
to authenticated;

-- Only Supabase Auth may run the access-token hook.
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema public to supabase_auth_admin;
    grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
  end if;
end $$;
