\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- Staff (packers): invite, join, switch off, and attempts to get around the rules.
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
create or replace function pg_temp.as_user(id text) returns boolean language sql as $$ select set_config('request.jwt.claim.sub', id, false) is not null $$;
insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-00000000000a', 'owner@example.kz'),
  ('d0000000-0000-0000-0000-00000000000b', 'owner2@example.kz'),
  ('d0000000-0000-0000-0000-00000000000c', 'packer@example.kz'),
  ('d0000000-0000-0000-0000-00000000000d', 'stranger@example.kz');

set role authenticated;
-- owner without the accepted offer cannot invite
select pg_temp.as_user('d0000000-0000-0000-0000-00000000000a');
do $$ begin perform team_invite('packer@example.kz', 'Ерлан'); raise notice 'FAIL invite before the offer is accepted'; exception when others then raise notice 'PASS invite needs an active account (%)', sqlerrm; end $$;
select accept_terms() is not null;
select pg_temp.ok('owner invites a packer (stores A,B; no «Принять»)', (select (r->>'status') = 'invited' and r->'shop_ids' = '["A", "B"]' and (r->>'can_accept')::boolean = false from (select team_invite(' Packer@Example.kz ', 'Ерлан', array['A', 'B', 'A'], false) r) x));
select pg_temp.ok('e-mail normalised, duplicates in stores removed', (select team_list()->0->>'email' = 'packer@example.kz' and jsonb_array_length(team_list()->0->'shop_ids') = 2));
do $$ begin perform team_invite('owner@example.kz', 'Я'); raise notice 'FAIL owner invited himself'; exception when others then raise notice 'PASS cannot invite yourself (%)', sqlerrm; end $$;
do $$ begin perform team_invite('not-an-email', 'X'); raise notice 'FAIL bad e-mail accepted'; exception when others then raise notice 'PASS bad e-mail refused (%)', sqlerrm; end $$;
do $$ begin perform team_invite('x@example.kz', ''); raise notice 'FAIL empty name accepted'; exception when others then raise notice 'PASS empty name refused (%)', sqlerrm; end $$;
select pg_temp.ok('store ids with odd characters dropped', (select team_invite('y@example.kz', 'Y', array['ok-1', '<script>', 'x y'])->'shop_ids' = '["ok-1"]'));

-- a packer of another owner, or a stranger, cannot join this team
select pg_temp.as_user('d0000000-0000-0000-0000-00000000000d');
do $$ begin perform team_join('d0000000-0000-0000-0000-00000000000a'); raise notice 'FAIL stranger joined'; exception when others then raise notice 'PASS stranger not invited (%)', sqlerrm; end $$;
select pg_temp.ok('stranger sees no team rows', (select team_list() = '[]'::jsonb));
do $$ begin perform team_set_enabled((select id from public.team_members limit 1), false); raise notice 'FAIL stranger switched a packer off'; exception when others then raise notice 'PASS stranger cannot manage the team (%)', sqlerrm; end $$;
do $$ begin perform 1 from public.team_members; raise notice 'FAIL table readable directly'; exception when others then raise notice 'PASS table not readable directly (%)', sqlerrm; end $$;

-- the packer joins with the code from the letter (signed in as packer@example.kz)
select pg_temp.as_user('d0000000-0000-0000-0000-00000000000c');
select pg_temp.ok('packer joins the owner''s team', (select (r->>'status') = 'active' and r->>'owner_id' = 'd0000000-0000-0000-0000-00000000000a' and r->>'name' = 'Ерлан' from (select team_join('d0000000-0000-0000-0000-00000000000a') r) x));
select pg_temp.ok('packer check works while active', (select team_check('d0000000-0000-0000-0000-00000000000a')->>'status' = 'active'));
do $$ begin perform team_join('d0000000-0000-0000-0000-00000000000b'); raise notice 'FAIL joined an owner who did not invite'; exception when others then raise notice 'PASS cannot join an owner who did not invite (%)', sqlerrm; end $$;
select pg_temp.ok('packer does not see the owner''s team list', (select team_list() = '[]'::jsonb));
do $$ begin perform team_update((select id from public.team_members limit 1), 'Хакер', '{}', true); raise notice 'FAIL packer gave himself rights'; exception when others then raise notice 'PASS packer cannot change his own rights (%)', sqlerrm; end $$;
do $$ begin perform get_license(1, null); raise notice 'PASS packer has his own (separate) account'; exception when others then raise notice 'PASS packer license call handled (%)', sqlerrm; end $$;

-- the owner switches the packer off (fired) → the next check fails
select pg_temp.as_user('d0000000-0000-0000-0000-00000000000a');
select pg_temp.ok('owner sees the packer as joined and active', (select (r->>'joined')::boolean and r->>'status' = 'active' from jsonb_array_elements(team_list()) r where r->>'email' = 'packer@example.kz'));
select pg_temp.ok('owner switches the packer off', (select team_set_enabled((select (r->>'id')::uuid from jsonb_array_elements(team_list()) r where r->>'email' = 'packer@example.kz'), false)->>'status' = 'disabled'));
select pg_temp.as_user('d0000000-0000-0000-0000-00000000000c');
do $$ begin perform team_check('d0000000-0000-0000-0000-00000000000a'); raise notice 'FAIL switched-off packer still allowed'; exception when others then raise notice 'PASS switched-off packer is logged out at the next check (%)', sqlerrm; end $$;
do $$ begin perform team_join('d0000000-0000-0000-0000-00000000000a'); raise notice 'FAIL switched-off packer re-joined'; exception when others then raise notice 'PASS switched-off packer cannot re-join (%)', sqlerrm; end $$;

-- back on → works again; rights changed by the owner arrive at the next check
select pg_temp.as_user('d0000000-0000-0000-0000-00000000000a');
select pg_temp.ok('owner switches the packer back on', (select team_set_enabled((select (r->>'id')::uuid from jsonb_array_elements(team_list()) r where r->>'email' = 'packer@example.kz'), true)->>'status' = 'active'));
select team_update((select (r->>'id')::uuid from jsonb_array_elements(team_list()) r where r->>'email' = 'packer@example.kz'), 'Ерлан', array['A'], true) is not null;
select pg_temp.as_user('d0000000-0000-0000-0000-00000000000c');
select pg_temp.ok('new rights at the next check (store A only, may accept)', (select r->'shop_ids' = '["A"]' and (r->>'can_accept')::boolean from (select team_check('d0000000-0000-0000-0000-00000000000a') r) x));

-- owner's subscription over → the packer cannot work either
reset role;
update public.accounts set trial_ends_at = now() - interval '1 minute', paid_until = null where user_id = 'd0000000-0000-0000-0000-00000000000a';
set role authenticated;
select pg_temp.as_user('d0000000-0000-0000-0000-00000000000c');
do $$ begin perform team_check('d0000000-0000-0000-0000-00000000000a'); raise notice 'FAIL packer works without the owner''s subscription'; exception when others then raise notice 'PASS packer stops when the owner''s subscription ends (%)', sqlerrm; end $$;
reset role;
update public.accounts set trial_ends_at = now() + interval '10 days' where user_id = 'd0000000-0000-0000-0000-00000000000a';
set role authenticated;

-- removal; anonymous callers; internal helpers not callable
select pg_temp.as_user('d0000000-0000-0000-0000-00000000000a');
select pg_temp.ok('owner removes an invitation', (select team_remove((select (r->>'id')::uuid from jsonb_array_elements(team_list()) r where r->>'email' = 'y@example.kz'))));
select pg_temp.ok('removed invitation gone', (select not exists (select 1 from jsonb_array_elements(team_list()) r where r->>'email' = 'y@example.kz')));
reset role;
set role anon;
do $$ begin perform team_list(); raise notice 'FAIL anonymous called team_list'; exception when others then raise notice 'PASS anonymous cannot call team functions (%)', sqlerrm; end $$;
reset role;
set role authenticated;
do $$ begin perform has_access_of('d0000000-0000-0000-0000-00000000000a'); raise notice 'FAIL helper has_access_of callable'; exception when others then raise notice 'PASS internal helper not callable (%)', sqlerrm; end $$;
-- limit: 20 people per owner
select pg_temp.as_user('d0000000-0000-0000-0000-00000000000b');
select accept_terms() is not null;
do $$ begin for i in 1..20 loop perform team_invite('p' || i || '@example.kz', 'P' || i); end loop; perform team_invite('p21@example.kz', 'P21'); raise notice 'FAIL 21st person invited'; exception when others then raise notice 'PASS at most 20 people per team (%)', sqlerrm; end $$;
reset role;
