-- 012_trial_and_rate_hardening.sql  (applied to kaspi-seller-hub 2026-11-21; after 011_security_hardening.sql)
-- Trial / rate hardening (2026-11-21):
--  1. store_claims.user_id is now nullable and its FK is ON DELETE SET NULL (was CASCADE). Deleting the
--     first account used to erase its claims, so the same shop could get a fresh trial on a new email.
--  2. get_license(): the trial-block test uses `sc.user_id is distinct from acc.user_id`, so a claim left
--     by a deleted account (user_id null) still ends any later trial on that shop.
--     The function is redefined via create or replace, which keeps its existing grants.
begin;

alter table public.store_claims alter column user_id drop not null;
alter table public.store_claims drop constraint store_claims_user_id_fkey;
alter table public.store_claims add constraint store_claims_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- a claim left by a deleted account (user_id null) must still end any later trial on that shop
do $$
declare d text := pg_get_functiondef('public.get_license(integer,text[])'::regprocedure);
        old_s text := 'sc.user_id <> acc.user_id';
        new_s text := 'sc.user_id is distinct from acc.user_id';
begin
  if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
    raise exception 'get_license: expected exactly one "%"', old_s;
  end if;
  execute replace(d, old_s, new_s);
end $$;

commit;
