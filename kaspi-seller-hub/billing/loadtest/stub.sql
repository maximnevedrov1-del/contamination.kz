-- LOCAL PostgreSQL ONLY (not Supabase): stand-in for the auth schema and API roles.
-- Minimal stand-in for Supabase's auth schema and API roles.
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
-- Like Supabase: API roles get everything in public by default (RLS + explicit revokes must protect).
create role supabase_auth_admin nologin;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
