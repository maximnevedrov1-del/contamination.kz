-- 014_retention_and_deletion.sql  (after 013_account_sharing.sql)
-- 1. Invoices and consents survive account deletion.
--    Before: deleting a user cascaded to public.invoices (via accounts) and public.consents,
--    so payment records and the evidence of accepting the offer were lost with the account.
--    Now: user_id becomes NULL (ON DELETE SET NULL) and the row keeps account_ref =
--    SHA-256 of the lower-cased email, so a payment can still be matched to a returning
--    client without keeping the email itself. Phone, amount, dates, IP and user agent stay
--    (payment and acceptance evidence; how long to keep them is the lawyer's/accountant's call).
-- 2. admin_delete_account(user, email): deletes an account on the client's request
--    (offer: «в течение 30 дней после запроса»). Admin only; the email must match as a
--    confirmation; admins cannot be deleted this way. Pending invoices are cancelled first.
--    Returns the price-feed ids whose Storage files must be removed through the Storage API
--    (direct deletes from storage.objects are not allowed in Supabase).
-- 3. purge_expired(): removes data past its retention period in one place:
--    support tickets answered/closed more than ops_settings.ticket_keep_days ago (default 365),
--    digest_stats > 30 days, tg_sent > 120 days, api_health > 14 days, usage_daily > 400 days,
--    expired tg_link_tokens. Runs at most once a day from ops_digest (called every 10 minutes
--    by the ops-alert job), and can be called by an admin or by pg_cron later.
-- 4. admin_invoices lists invoices of deleted accounts too (left join; email shown as null).
begin;

-- ---------- 1. keep invoices and consents ----------
alter table public.invoices add column if not exists account_ref text check (account_ref ~ '^[0-9a-f]{64}$');
alter table public.consents add column if not exists account_ref text check (account_ref ~ '^[0-9a-f]{64}$');

do $$
declare r record;
begin
  for r in select conname, conrelid::regclass::text tbl from pg_constraint
           where contype = 'f' and conrelid in ('public.invoices'::regclass, 'public.consents'::regclass)
             and conkey = array[(select attnum from pg_attribute where attrelid = conrelid and attname = 'user_id')]
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

alter table public.invoices alter column user_id drop not null;
alter table public.consents alter column user_id drop not null;
alter table public.invoices add constraint invoices_user_id_fkey
  foreign key (user_id) references public.accounts (user_id) on delete set null;
alter table public.consents add constraint consents_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;

create or replace function public.account_ref(p_email text)
returns text language sql immutable set search_path = public as $$
  select case when nullif(btrim(coalesce(p_email, '')), '') is null then null
              else encode(sha256(convert_to('ksh-acc:' || lower(btrim(p_email)), 'utf8')), 'hex') end;
$$;
revoke all on function public.account_ref(text) from public, anon, authenticated;

-- ---------- 2. delete an account on request ----------
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
  delete from auth.users where id = p_user;   -- cascades to accounts, tickets, usage, Telegram links…
  return jsonb_build_object('deleted', true, 'account_ref', ref, 'invoices_kept', n_inv,
                            'consents_kept', n_cons, 'price_feeds_to_remove', feeds);
end $$;
revoke all on function public.admin_delete_account(uuid, text) from public, anon;
grant execute on function public.admin_delete_account(uuid, text) to authenticated;

-- ---------- 3. retention ----------
alter table public.ops_settings add column if not exists ticket_keep_days int not null default 365
  check (ticket_keep_days between 30 and 3650);
alter table public.ops_settings add column if not exists last_purge_at timestamptz;

-- Internal: no permission check. Callers: ops_digest (key-checked), admin_purge_expired (admin).
create or replace function public.purge_expired()
returns jsonb language plpgsql security definer set search_path = public as $$
declare keep int; n_t int; n_d int; n_s int; n_h int; n_u int; n_k int;
begin
  select ticket_keep_days into keep from public.ops_settings where id = 1;
  delete from public.support_tickets
    where status in ('answered', 'closed') and coalesce(replied_at, created_at) < now() - make_interval(days => coalesce(keep, 365));
  get diagnostics n_t = row_count;
  delete from public.digest_stats where day < current_date - 30;      get diagnostics n_d = row_count;
  delete from public.tg_sent where sent_at < now() - interval '120 days'; get diagnostics n_s = row_count;
  delete from public.api_health where bucket < now() - interval '14 days'; get diagnostics n_h = row_count;
  delete from public.usage_daily where day < current_date - 400;      get diagnostics n_u = row_count;
  delete from public.tg_link_tokens where expires_at < now();         get diagnostics n_k = row_count;
  update public.ops_settings set last_purge_at = now() where id = 1;
  return jsonb_build_object('tickets', n_t, 'digest_stats', n_d, 'tg_sent', n_s,
                            'api_health', n_h, 'usage_daily', n_u, 'tg_link_tokens', n_k);
end $$;
revoke all on function public.purge_expired() from public, anon, authenticated;

create or replace function public.admin_purge_expired()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return public.purge_expired();
end $$;
revoke all on function public.admin_purge_expired() from public, anon;
grant execute on function public.admin_purge_expired() to authenticated;

-- ops_digest as in 011, plus a daily purge_expired().
create or replace function public.ops_digest(p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.ops_settings; kh text; w jsonb; e jsonb; alerts jsonb := '[]'; recovered jsonb := '[]'; down jsonb; since timestamptz;
        purged jsonb;
begin
  -- verify the key without a lock
  select key_hash into kh from public.ops_settings where id = 1;
  if kh is null or p_key is null or length(p_key) < 32
     or encode(sha256(convert_to(p_key, 'utf8')), 'hex') <> kh then
    perform pg_sleep(0.5);
    raise exception 'bad_key';
  end if;
  select * into o from public.ops_settings where id = 1 for update;
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
  if o.last_purge_at is null or o.last_purge_at < now() - interval '1 day' then
    purged := public.purge_expired();
  end if;
  return jsonb_build_object(
    'alerts', alerts,
    'recovered', recovered,
    'new_tickets', (select count(*) from public.support_tickets where created_at > since),
    'open_tickets', (select count(*) from public.support_tickets where status = 'open'),
    'new_invoices', (select count(*) from public.invoices where created_at > since and status = 'pending'),
    'pending_invoices', (select count(*) from public.invoices where status = 'pending'),
    'pending_sum', (select coalesce(sum(amount), 0) from public.invoices where status = 'pending'),
    'purged', purged);
end
$$;
revoke all on function public.ops_digest(text) from public;
grant execute on function public.ops_digest(text) to anon, authenticated;

-- ---------- 4. admin_invoices: include deleted accounts ----------
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
      from public.invoices i left join public.accounts a on a.user_id = i.user_id
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

commit;
