-- =====================================================================
-- Kaspi Seller Hub — subscriptions & Kaspi invoices (Supabase / Postgres)
--
-- Run once in Supabase: Dashboard → SQL Editor → paste → Run.
--
-- Model
--   * Every new user (email login) gets an account with a free trial.
--   * Price per month = base_price for up to base_stores stores
--                       + extra_store_price for every store above that.
--     Defaults: 20 000 ₸ for 3 stores, +5 000 ₸ per extra store, 30-day trial.
--   * A user creates an invoice (stores, months, phone) from the extension.
--     The amount is computed HERE, never trusted from the client.
--   * The owner sees it in the admin page, sends a Kaspi Pay remote invoice to
--     that phone (or the client pays by QR), and confirms → paid_until moves on.
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
  trial_days           int  not null default 30    check (trial_days >= 0),
  trial_store_limit    int  not null default 3     check (trial_store_limit >= 1),
  max_months           int  not null default 12    check (max_months between 1 and 24),
  max_stores           int  not null default 50    check (max_stores >= 1),
  kaspi_qr_url         text,          -- public URL of your Kaspi Pay QR image
  payment_instructions text,          -- shown to the client next to the amount
  updated_at           timestamptz not null default now()
);
insert into public.billing_config (id) values (1) on conflict (id) do nothing;

-- ---------- accounts ----------
create table if not exists public.accounts (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  email            text,
  phone            text,                       -- normalized 7XXXXXXXXXX, used for Kaspi invoices
  trial_ends_at    timestamptz not null,
  paid_until       timestamptz,
  store_limit      int not null default 3,     -- stores covered by the last paid invoice
  last_store_count int,                        -- reported by the extension (for the admin)
  last_seen_at     timestamptz,
  created_at       timestamptz not null default now()
);

-- ---------- invoices ----------
create table if not exists public.invoices (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.accounts (user_id) on delete cascade,
  stores       int  not null check (stores between 1 and 1000),
  months       int  not null check (months between 1 and 24),
  amount       int  not null check (amount > 0),
  phone        text not null,
  status       text not null default 'pending' check (status in ('pending', 'paid', 'cancelled')),
  created_at   timestamptz not null default now(),
  paid_at      timestamptz,
  period_from  timestamptz,
  period_to    timestamptz,
  confirmed_by uuid,
  admin_note   text
);
-- at most one open invoice per user
create unique index if not exists invoices_one_pending on public.invoices (user_id) where status = 'pending';
create index if not exists invoices_status_created on public.invoices (status, created_at desc);

-- ---------- admins (add yourself once, see billing/README.md) ----------
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- ---------- row level security ----------
alter table public.billing_config enable row level security;
alter table public.accounts       enable row level security;
alter table public.invoices       enable row level security;
alter table public.admins         enable row level security;

drop policy if exists accounts_read_own on public.accounts;
create policy accounts_read_own on public.accounts for select to authenticated using (user_id = auth.uid());
drop policy if exists invoices_read_own on public.invoices;
create policy invoices_read_own on public.invoices for select to authenticated using (user_id = auth.uid());
-- billing_config and admins: no policies → no direct access; read through functions.

revoke all on public.billing_config, public.accounts, public.invoices, public.admins from anon, authenticated;
grant select on public.accounts, public.invoices to authenticated;

-- ---------- helpers ----------
create or replace function public.billing_price(p_stores int, p_months int)
returns int language sql stable security definer set search_path = public as $$
  select ((c.base_price + greatest(0, p_stores - c.base_stores) * c.extra_store_price) * p_months)::int
  from public.billing_config c where c.id = 1;
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

-- Licence for the extension: status, limits, pricing, payment details, open invoice.
create or replace function public.get_license(p_store_count int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config; st text; lim int;
begin
  acc := public.ensure_account();
  update public.accounts set last_store_count = coalesce(p_store_count, last_store_count), last_seen_at = now()
    where user_id = acc.user_id;
  select * into c from public.billing_config where id = 1;
  st := case when acc.paid_until > now() then 'active' when acc.trial_ends_at > now() then 'trial' else 'expired' end;
  lim := case when st = 'active' then acc.store_limit when st = 'trial' then c.trial_store_limit else 0 end;
  return jsonb_build_object(
    'status', st,
    'email', acc.email,
    'phone', acc.phone,
    'trial_ends_at', acc.trial_ends_at,
    'paid_until', acc.paid_until,
    'store_limit', lim,
    'paid_store_limit', acc.store_limit,
    'server_time', now(),
    'pricing', jsonb_build_object('base_price', c.base_price, 'base_stores', c.base_stores,
                                  'extra_store_price', c.extra_store_price, 'max_months', c.max_months, 'max_stores', c.max_stores),
    'payment', jsonb_build_object('qr_url', c.kaspi_qr_url, 'instructions', c.payment_instructions),
    'pending_invoice', (select to_jsonb(i) - 'confirmed_by' - 'admin_note' from public.invoices i
                        where i.user_id = acc.user_id and i.status = 'pending'),
    'invoices', coalesce((select jsonb_agg(to_jsonb(i) - 'confirmed_by' - 'admin_note' order by i.created_at desc)
                          from (select * from public.invoices where user_id = acc.user_id order by created_at desc limit 12) i), '[]'::jsonb)
  );
end $$;

-- New invoice (replaces an open one). Amount is computed server-side.
create or replace function public.create_invoice(p_stores int, p_months int, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config; ph text; n_stores int; inv public.invoices;
begin
  acc := public.ensure_account();
  select * into c from public.billing_config where id = 1;
  if p_months is null or p_months < 1 or p_months > c.max_months then raise exception 'invalid_months' using errcode = '22023'; end if;
  if p_stores is null or p_stores < 1 or p_stores > c.max_stores then raise exception 'invalid_stores' using errcode = '22023'; end if;
  ph := public.normalize_phone(p_phone);
  if ph is null then raise exception 'invalid_phone' using errcode = '22023'; end if;
  n_stores := greatest(p_stores, c.base_stores);   -- the base price already covers base_stores
  update public.invoices set status = 'cancelled', admin_note = coalesce(admin_note, 'replaced by client')
    where user_id = acc.user_id and status = 'pending';
  insert into public.invoices (user_id, stores, months, amount, phone)
    values (acc.user_id, n_stores, p_months, public.billing_price(n_stores, p_months), ph)
    returning * into inv;
  update public.accounts set phone = ph where user_id = acc.user_id;
  return to_jsonb(inv) - 'confirmed_by' - 'admin_note';
end $$;

create or replace function public.cancel_my_invoice(p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.invoices set status = 'cancelled', admin_note = 'cancelled by client'
    where id = p_id and user_id = auth.uid() and status = 'pending';
  return found;
end $$;

-- ---------- admin functions ----------
create or replace function public.admin_invoices(p_status text default 'pending')
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(i) || jsonb_build_object('email', a.email, 'paid_until', a.paid_until,
                     'trial_ends_at', a.trial_ends_at, 'last_store_count', a.last_store_count) order by i.created_at desc)
    from public.invoices i join public.accounts a using (user_id)
    where p_status = 'all' or i.status = p_status
  ), '[]'::jsonb);
end $$;

-- Payment received in Kaspi Pay → extend the subscription.
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
  start_at := greatest(now(), coalesce(acc.paid_until, now()), acc.trial_ends_at);
  end_at := start_at + make_interval(months => inv.months);
  update public.accounts set paid_until = end_at, store_limit = inv.stores where user_id = inv.user_id;
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

create or replace function public.admin_accounts()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'user_id', a.user_id, 'email', a.email, 'phone', a.phone, 'trial_ends_at', a.trial_ends_at,
      'paid_until', a.paid_until, 'store_limit', a.store_limit, 'last_store_count', a.last_store_count,
      'last_seen_at', a.last_seen_at, 'created_at', a.created_at,
      'status', case when a.paid_until > now() then 'active' when a.trial_ends_at > now() then 'trial' else 'expired' end
    ) order by a.created_at desc) from public.accounts a), '[]'::jsonb);
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
    kaspi_qr_url         = case when p ? 'kaspi_qr_url' then nullif(p->>'kaspi_qr_url', '') else kaspi_qr_url end,
    payment_instructions = case when p ? 'payment_instructions' then nullif(p->>'payment_instructions', '') else payment_instructions end,
    updated_at           = now()
  where id = 1;
  return public.admin_get_config();
end $$;

-- ---------- who may call what ----------
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.get_license(int), public.create_invoice(int, int, text), public.cancel_my_invoice(bigint),
  public.billing_price(int, int), public.is_admin(),
  public.admin_invoices(text), public.admin_confirm_invoice(bigint, text), public.admin_cancel_invoice(bigint, text),
  public.admin_accounts(), public.admin_grant_days(uuid, int, int), public.admin_get_config(), public.admin_update_config(jsonb)
to authenticated;
