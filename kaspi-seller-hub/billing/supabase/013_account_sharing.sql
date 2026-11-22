-- 013_account_sharing.sql  (applied to kaspi-seller-hub 2026-11-21; after 012_trial_and_rate_hardening.sql)
-- One login shared between several sellers' computers.
-- Before: the store limit was checked only against the stores in the current browser, so
-- three computers on a 1-store plan, each with a different shop, all worked.
-- Now: every get_license call marks the account's own claimed stores as seen.
-- `shared_stores` = this account's stores seen on other devices in the last 2 hours
-- (keys not in this request). The extension subtracts it from its store limit, so all
-- devices together stay within the paid limit. The same shop on several devices counts once.
-- Moving a shop to another one on the same device frees the old slot after at most 2 hours.
-- create or replace keeps the function's grants (authenticated only).
begin;

alter table public.store_claims add column if not exists last_seen_at timestamptz not null default now();
create index if not exists store_claims_user_seen on public.store_claims (user_id, last_seen_at);

create or replace function public.get_license(p_store_count integer default null, p_store_keys text[] default null)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare acc public.accounts; c public.billing_config; st text; lim int; keys text[]; shared int := 0;
begin
  acc := public.ensure_account();
  update public.accounts set last_store_count = coalesce(p_store_count, last_store_count), last_seen_at = now()
    where user_id = acc.user_id;
  select * into c from public.billing_config where id = 1;
  if p_store_keys is not null and cardinality(p_store_keys) between 1 and 500 then
    keys := array(select distinct k from unnest(p_store_keys) k where k ~ '^[0-9a-f]{64}$');
    -- a new store is claimed; a store this account already owns is marked as seen; another account's store is left alone
    insert into public.store_claims as sc (store_key, user_id)
      select k, acc.user_id from unnest(keys) k
    on conflict (store_key) do update set last_seen_at = now() where sc.user_id = excluded.user_id;
    -- never paid + still on trial + a store already used by another account → trial is over
    if acc.paid_until is null and acc.trial_ends_at > now() and exists (
         select 1 from public.store_claims sc where sc.store_key = any (p_store_keys) and sc.user_id is distinct from acc.user_id) then
      update public.accounts set trial_ends_at = now(), trial_blocked = true where user_id = acc.user_id returning * into acc;
    end if;
  end if;
  -- this account's stores in use on other devices right now (not in this request);
  -- only known when the caller sent its stores (calls without keys, e.g. after an invoice action, report 0)
  if keys is not null then
    select count(*) into shared from public.store_claims sc
      where sc.user_id = acc.user_id and sc.last_seen_at > now() - interval '2 hours'
        and not (sc.store_key = any (keys));
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
    'shared_stores', shared,
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
    'payment', jsonb_build_object('qr_url', c.kaspi_qr_url, 'instructions', c.payment_instructions),
    'pending_invoice', (select to_jsonb(i) - 'confirmed_by' - 'admin_note' from public.invoices i
                        where i.user_id = acc.user_id and i.status = 'pending'),
    'invoices', coalesce((select jsonb_agg(to_jsonb(i) - 'confirmed_by' - 'admin_note' order by i.created_at desc)
                          from (select * from public.invoices where user_id = acc.user_id order by created_at desc limit 12) i), '[]'::jsonb)
  );
end $function$;

commit;
