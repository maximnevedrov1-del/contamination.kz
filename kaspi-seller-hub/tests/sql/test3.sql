\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values ('44444444-4444-4444-4444-444444444444', 'c@example.kz'), ('55555555-5555-5555-5555-555555555555', 'd@example.kz'), ('88888888-8888-8888-8888-888888888888', 'boss@example.kz');
insert into public.admins values ('88888888-8888-8888-8888-888888888888');

set role authenticated; set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select pg_temp.ok('new account: terms not accepted, required = 2026-11-16', (select l->>'terms_version' is null and l->>'terms_required' = '2026-11-16' from (select get_license(1) l) x));
set request.headers = '{"x-forwarded-for": "5.76.1.2, 10.0.0.1", "user-agent": "Mozilla/5.0 Chrome/130"}';
select pg_temp.ok('accept_terms ok', (select r->>'version' = '2026-11-16' from (select accept_terms() r) x));
select pg_temp.ok('licence now shows accepted version + time', (select l->>'terms_version' = '2026-11-16' and l->>'terms_accepted_at' is not null from (select get_license(1) l) x));
select pg_temp.ok('client cannot read consents table directly', (select count(*) = 0 from public.consents));
do $$ begin insert into public.consents (user_id, version) values ('55555555-5555-5555-5555-555555555555', 'fake'); raise notice 'FAIL client forged a consent row'; exception when others then raise notice 'PASS client cannot forge consent rows (%)', sqlerrm; end $$;
do $$ begin update public.accounts set terms_version = 'x'; raise notice 'FAIL client updated own terms_version directly'; exception when others then raise notice 'PASS no direct account update (%)', sqlerrm; end $$;
select pg_temp.ok('invoice allowed after consent', (select (create_invoice(3, 1, null)->>'amount')::int = 20000));

reset role;
select pg_temp.ok('evidence row: IP = first forwarded hop, UA kept', (select ip = '5.76.1.2' and user_agent like 'Mozilla%' and version = '2026-11-16' from consents where user_id = '44444444-4444-4444-4444-444444444444'));
reset request.headers;

-- second client accepts without request headers (e.g. SQL editor) → still recorded
set role authenticated; set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
select pg_temp.ok('accept without headers works', (select accept_terms()->>'version' = '2026-11-16'));
do $$ begin perform admin_update_config('{"terms_version":"2027-01-01"}'); raise notice 'FAIL client changed terms version'; exception when others then raise notice 'PASS client cannot bump terms version (%)', sqlerrm; end $$;

-- admin publishes new texts → everyone must accept again
set request.jwt.claim.sub = '88888888-8888-8888-8888-888888888888';
select pg_temp.ok('admin bumps version', (select admin_update_config('{"terms_version":"2027-01-01"}')->>'terms_version' = '2027-01-01'));
select pg_temp.ok('blank version ignored', (select admin_update_config('{"terms_version":"  "}')->>'terms_version' = '2027-01-01'));
select pg_temp.ok('admin_accounts shows consent date + version', (select bool_and(e->>'terms_version' = '2026-11-16' and e->>'terms_accepted_at' is not null) from jsonb_array_elements((admin_accounts()->'rows')) e where e->>'email' in ('c@example.kz','d@example.kz')));

set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select pg_temp.ok('old acceptance no longer enough', (select l->>'terms_version' = '2026-11-16' and l->>'terms_required' = '2027-01-01' from (select get_license(1) l) x));
do $$ begin perform create_invoice(3, 1, null); raise notice 'FAIL invoice with outdated consent'; exception when others then raise notice 'PASS invoice with outdated consent rejected (%)', sqlerrm; end $$;
select pg_temp.ok('re-accept → new version', (select accept_terms()->>'version' = '2027-01-01'));
reset role;
select pg_temp.ok('history keeps both acceptances', (select count(*) = 2 from consents where user_id = '44444444-4444-4444-4444-444444444444'));
