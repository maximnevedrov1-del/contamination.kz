-- 035_free_access.sql — SaudaPulse Stage 03: all released business functionality is free.
-- Safe to run again. Apply AFTER 033 (034_tariffs_v2.sql is an unreviewed draft and is NOT required).
--
-- What changes
--   * has_access() / has_access_of(): no longer look at paid_until / trial_ends_at. What remains is the
--     LEGAL gate (the current offer/terms must be accepted) and the identity gate (auth.uid() must own an
--     account row). An expired or never-paid account keeps its price-list feeds, packers, digests, etc.
--   * get_license(): `store_limit` is now the operational ceiling store_cap() for every status (it used to be
--     0 for expired/frozen and the paid/trial number otherwise); a new key `free_access` = true tells clients
--     not to gate anything on status. `status`, `paid_until`, `paid_store_limit`, `trial_ends_at`, `invoices`,
--     `pending_invoice` ... are returned unchanged: they are billing HISTORY, not entitlements.
--   * ensure_price_feed(): the per-plan feed count is replaced by store_cap().
--   * ensure_renewal_invoice() / request_store_addon(): no longer CREATE or EDIT invoices (nothing is billed
--     automatically any more). They return the already-open invoice, if any, untouched.
--
-- What deliberately does NOT change (legacy customers: no charge, no refund, no data rewrite)
--   * invoices, payment_events, accounts.paid_until / store_limit / trial_ends_at / cancel_* / discount_*: not
--     touched. An invoice that is still pending stays pending and can still be paid and confirmed through
--     confirm_invoice_core / payment_received / admin_confirm_invoice; nothing is cancelled or refunded here.
--   * Trial anti-abuse bookkeeping (store_claims, trial_blocked) is still RECORDED and visible to admins, but with free
--     access it no longer blocks anything (there is no server-side "blocked" state). Invoice rate limits, the 20-member team ceiling,
--     ticket limits, bot rate limits, RLS, grants, is_admin(), custom_access_token_hook.
--   * create_invoice() still exists for an explicit, user-initiated payment, but no client code calls it any more.
--   * accounts.store_limit / billing_config.* prices stay as inert history; a later stage may drop them.
begin;

-- Operational (abuse / storage-cost) ceiling on stores per account: not a price tier. Fixed, not admin-editable, so that a
-- price form can never become a store limit again. A legacy customer who already paid for more stores keeps their
-- number: the effective ceiling is greatest(store_cap(), accounts.store_limit).
create or replace function public.store_cap()
returns int language sql immutable set search_path = public as $$ select 50 $$;
revoke execute on function public.store_cap() from public, anon, authenticated;

-- Identity + legal gate only (offer accepted). Was: also (paid_until > now() or trial_ends_at > now()).
create or replace function public.has_access()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.accounts a, public.billing_config c
    where a.user_id = auth.uid() and c.id = 1
      and a.terms_version is not distinct from c.terms_version);
$$;

create or replace function public.has_access_of(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.accounts a, public.billing_config c
    where a.user_id = p_user and c.id = 1
      and a.terms_version is not distinct from c.terms_version);
$$;

-- Feed for one store; at most greatest(store_cap(), paid store_limit) stores per account.
create or replace function public.ensure_price_feed(p_shop_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; f public.price_feeds;
begin
  acc := public.ensure_account();
  if not public.has_access() then raise exception 'subscription_required' using errcode = '42501'; end if;   -- offer not accepted
  if p_shop_key is null or p_shop_key !~ '^shop-[a-z0-9]{1,13}$' then raise exception 'invalid_shop' using errcode = '22023'; end if;
  select * into f from public.price_feeds where user_id = acc.user_id and shop_key = p_shop_key;
  if found then return jsonb_build_object('feed_id', f.feed_id, 'shop_key', f.shop_key); end if;
  if (select count(*) from public.price_feeds where user_id = acc.user_id) >= greatest(public.store_cap(), acc.store_limit) then
    raise exception 'store_limit' using errcode = '42501';
  end if;
  insert into public.price_feeds (user_id, shop_key) values (acc.user_id, p_shop_key) returning * into f;
  return jsonb_build_object('feed_id', f.feed_id, 'shop_key', f.shop_key);
end $$;

-- No automatic billing: return the invoice that is already open (if any) exactly as it is.
create or replace function public.ensure_renewal_invoice(p_stores int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; pend public.invoices;
begin
  acc := public.ensure_account();
  select * into pend from public.invoices where user_id = acc.user_id and status = 'pending';
  return case when found then to_jsonb(pend) - 'confirmed_by' - 'admin_note' end;
end $$;

create or replace function public.request_store_addon(p_total_stores int)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return public.ensure_renewal_invoice(p_total_stores);
end $$;

-- get_license is patched in place (015/016/031 did the same), so `features`, `system_banner`, `phone_verified`
-- and every other key survive.
do $$
declare d text := pg_get_functiondef('public.get_license(integer,text[])'::regprocedure);
        old_s text := '''store_limit'', lim,';
        new_s text := '''store_limit'', greatest(public.store_cap(), acc.store_limit), ''free_access'', true,';
begin
  if position('free_access' in d) = 0 then
    if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
      raise exception 'get_license: expected exactly one "%"', old_s;
    end if;
    execute replace(d, old_s, new_s);
  end if;
end $$;

-- The Telegram bot must not push payment prompts at free users: no «grace» renewal reminders and no win-back
-- offers (the 50 % offer is granted when it is sent). Morning digest, care and queued outbox notices stay.
do $$
declare d text := pg_get_functiondef('public.bot_jobs(text)'::regprocedure);
        olds text[] := array['from due where (acc).paid_until <= now() and public.grace_until(acc) > now()',
                             'and not_frozen and c.whats_new is not null',
                             'now() - interval ''60 days'' and not_frozen'];
        o text;
begin
  if position('free_access_off' in d) = 0 then
    foreach o in array olds loop
      if (length(d) - length(replace(d, o, ''))) / length(o) <> 1 then raise exception 'bot_jobs: expected exactly one "%"', o; end if;
      d := replace(d, o, o || ' and false /* free_access_off */');
    end loop;
    execute d;
  end if;
end $$;

-- Same for the retention nudges: «trial ends in 2 days» and the trial win-back (+14 days) are payment prompts.
-- «no_first_sync_24h» (onboarding help) stays.
do $$
declare d text := pg_get_functiondef('public.enqueue_retention_nudges()'::regprocedure);
        olds text[] := array['where a.trial_ends_at between now() and now() + interval ''48 hours''',
                             'where a.trial_ends_at between now() - interval ''3 days'' and now() - interval ''1 day'''];
        o text;
begin
  if position('free_access_off' in d) = 0 then
    foreach o in array olds loop
      if (length(d) - length(replace(d, o, ''))) / length(o) <> 1 then raise exception 'enqueue_retention_nudges: expected exactly one "%"', o; end if;
      d := replace(d, o, o || ' and false /* free_access_off */');
    end loop;
    execute d;
  end if;
end $$;

commit;
