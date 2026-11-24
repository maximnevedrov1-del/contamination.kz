-- 009_billing_revoke_fix.sql
-- Run after 008_bot_lock.sql.
-- Recorded from supabase_migrations.schema_migrations: version 20261121055930,
-- name "001_billing_revoke_fix" (applied 2026-11-21, after 008_bot_lock = 20261121055850).
-- Tables are service-side only: no direct access for anon/authenticated.
revoke all on public.consents, public.store_claims, public.price_feeds from anon, authenticated;
