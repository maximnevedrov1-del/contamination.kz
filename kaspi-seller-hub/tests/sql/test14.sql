\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- 015: remote feature flags
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'seller@example.kz'),
  ('22222222-2222-2222-2222-222222222222', 'other@example.kz'),
  ('99999999-9999-9999-9999-999999999999', 'admin@example.kz');
insert into public.admins values ('99999999-9999-9999-9999-999999999999');

set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ begin perform public.admin_set_feature_flag('x_flag', true); raise notice 'FAIL non-admin set a flag';
exception when others then raise notice 'PASS non-admin cannot admin_set_feature_flag (%)', sqlerrm; end $$;
do $$ begin perform public.admin_list_feature_flags(); raise notice 'FAIL non-admin listed flags';
exception when others then raise notice 'PASS non-admin cannot admin_list_feature_flags (%)', sqlerrm; end $$;
do $$ begin perform public.admin_delete_feature_flag('x_flag'); raise notice 'FAIL non-admin deleted a flag';
exception when others then raise notice 'PASS non-admin cannot admin_delete_feature_flag (%)', sqlerrm; end $$;
do $$ begin perform 1 from public.feature_flags; raise notice 'FAIL client selected feature_flags';
exception when others then raise notice 'PASS client cannot select feature_flags (%)', sqlerrm; end $$;
do $$ begin insert into public.feature_flags (flag_key) values ('hack'); raise notice 'FAIL client inserted a flag';
exception when others then raise notice 'PASS client cannot insert feature_flags (%)', sqlerrm; end $$;
do $$ begin perform public.feature_flags_for(auth.uid(), 'x'); raise notice 'FAIL client called feature_flags_for';
exception when others then raise notice 'PASS client cannot call feature_flags_for (%)', sqlerrm; end $$;

set request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';
do $$ begin perform public.admin_set_feature_flag('Bad-Key', true); raise notice 'FAIL invalid key accepted';
exception when others then raise notice 'PASS invalid key rejected (%)', sqlerrm; end $$;
do $$ begin perform public.admin_set_feature_flag('good_key', false, 101); raise notice 'FAIL rollout 101 accepted';
exception when others then raise notice 'PASS rollout 101 rejected (%)', sqlerrm; end $$;
do $$ begin perform public.admin_set_feature_flag('good_key', false, -1); raise notice 'FAIL rollout -1 accepted';
exception when others then raise notice 'PASS rollout -1 rejected (%)', sqlerrm; end $$;
select pg_temp.ok('admin creates a flag, returns the row', (select r->>'flag_key' = 'f_off' and (r->>'enabled')::boolean = false from (select public.admin_set_feature_flag('f_off', false, 0, '{}', 'off flag') r) x));
select pg_temp.ok('enabled flag', (select (r->>'enabled')::boolean from (select public.admin_set_feature_flag('f_on', true) r) x));
select pg_temp.ok('emails normalized (lower, trim, dedupe, no empty)',
  (select r->'allow_emails' = '["a@example.kz","seller@example.kz"]'::jsonb from (select public.admin_set_feature_flag('f_mail', false, 0, array[' Seller@Example.kz ', 'seller@example.kz', '', 'A@example.kz'], 'mail') r) x));
select public.admin_set_feature_flag('f_r100', false, 100);
select public.admin_set_feature_flag('f_r0', false, 0);
select public.admin_set_feature_flag('f_r50', false, 50);
select pg_temp.ok('admin lists 6 flags ordered by key',
  (select jsonb_array_length(r) = 6 and r->0->>'flag_key' = 'f_mail' and r->5->>'flag_key' = 'f_r50' from (select public.admin_list_feature_flags() r) x));

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.ok('get_license returns features object', (select jsonb_typeof(public.get_license()->'features') = 'object'));
select pg_temp.ok('get_license keeps old keys', (select l ? 'status' and l ? 'shared_stores' and l ? 'server_time' and l ? 'email' from (select public.get_license() l) x));
select pg_temp.ok('disabled flag is false', (select (public.get_license()->'features'->>'f_off')::boolean = false));
select pg_temp.ok('enabled flag is true', (select (public.get_license()->'features'->>'f_on')::boolean));
select pg_temp.ok('allow_emails: true for Seller@Example.kz account (case-insensitive)', (select (public.get_license()->'features'->>'f_mail')::boolean));
select pg_temp.ok('rollout 100 true, rollout 0 false', (select (f->>'f_r100')::boolean and not (f->>'f_r0')::boolean from (select public.get_license()->'features' f) x));
select pg_temp.ok('rollout 50 deterministic and matches formula',
  (select (a->>'f_r50')::boolean = (b->>'f_r50')::boolean
     and (a->>'f_r50')::boolean = (((hashtext('11111111-1111-1111-1111-111111111111')::bigint % 100 + 100) % 100) < 50)
   from (select public.get_license()->'features' a, public.get_license()->'features' b) x));
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.ok('allow_emails: false for another email', (select not (public.get_license()->'features'->>'f_mail')::boolean));
select pg_temp.ok('other user: rollout 50 matches formula',
  (select (public.get_license()->'features'->>'f_r50')::boolean = (((hashtext('22222222-2222-2222-2222-222222222222')::bigint % 100 + 100) % 100) < 50)));

set request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';
select pg_temp.ok('admin deletes a flag', (select public.admin_delete_feature_flag('f_off') and not public.admin_delete_feature_flag('f_off')));
reset role;
select pg_temp.ok('feature_flags has RLS enabled', (select relrowsecurity from pg_class where oid = 'public.feature_flags'::regclass));
delete from public.feature_flags;
select pg_temp.ok('feature_flags_for with no flags is {}', public.feature_flags_for('11111111-1111-1111-1111-111111111111', null) = '{}'::jsonb);
