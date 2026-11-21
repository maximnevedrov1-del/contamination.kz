-- LOCAL TEST DATABASE ONLY. Creates 50 000 fake clients. Never run on the production project.
\timing on
-- 50 000 clients: users (trigger creates accounts), consents, 3 stores each, ~6 invoices each
insert into auth.users (id, email) select md5('u' || g)::uuid, 'user' || g || '@example.kz' from generate_series(1, 50000) g;
update accounts set terms_version = '2026-11-16', terms_accepted_at = now(), last_store_count = 3,
  paid_until = case when random() < 0.6 then now() + (random() * 30 || ' days')::interval end,
  created_at = now() - (random() * 365 || ' days')::interval;
insert into consents (user_id, version) select user_id, '2026-11-16' from accounts;
insert into store_claims (store_key, user_id) select encode(sha256(convert_to('ksh:' || (g * 3 + s), 'UTF8')), 'hex'), md5('u' || g)::uuid from generate_series(1, 50000) g, generate_series(0, 2) s;
insert into invoices (user_id, kind, stores, months, amount, status, created_at, paid_at)
  select md5('u' || g)::uuid, 'renewal', 3, 1, 20000, 'paid', now() - (k * 30 || ' days')::interval, now() - (k * 30 || ' days')::interval
  from generate_series(1, 50000) g, generate_series(1, 6) k;
analyze;
select (select count(*) from accounts) accounts, (select count(*) from invoices) invoices, (select count(*) from store_claims) claims, pg_size_pretty(pg_database_size('loadt')) size;
