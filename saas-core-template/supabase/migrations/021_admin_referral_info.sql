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
