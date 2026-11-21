-- Seller Hub: indexes for per-user lookups that scanned whole tables, and a health check. Safe to run again.
-- Run after 005_growth.sql.

-- offer_used check: count by user_id, outcome over 180 days (005_growth.sql, cancel flow); also FK cascade
create index if not exists cancellations_user on public.cancellations (user_id, outcome, created_at desc);
-- link rate limit: count by user_id over the last hour; also FK cascade
create index if not exists tg_link_tokens_user on public.tg_link_tokens (user_id, expires_at);
-- expired-token cleanup runs on every new link
create index if not exists tg_link_tokens_exp on public.tg_link_tokens (expires_at);
-- FK cascade on account delete
create index if not exists store_claims_user on public.store_claims (user_id);

-- Health check for an external uptime monitor: POST /rest/v1/rpc/health (anon key) → {"ok":true,...}.
-- Proves PostgREST and the database answer; reveals nothing but the server time.
create or replace function public.health() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object('ok', true, 'at', now());
$$;
revoke all on function public.health() from public;
grant execute on function public.health() to anon, authenticated;
