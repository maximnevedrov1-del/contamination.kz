-- Seller Hub: indexes for per-user lookups that scanned whole tables. Safe to run again.
-- Run after 005_growth.sql.

-- offer_used check: count by user_id, outcome over 180 days (005_growth.sql, cancel flow); also FK cascade
create index if not exists cancellations_user on public.cancellations (user_id, outcome, created_at desc);
-- link rate limit: count by user_id over the last hour; also FK cascade
create index if not exists tg_link_tokens_user on public.tg_link_tokens (user_id, expires_at);
-- expired-token cleanup runs on every new link
create index if not exists tg_link_tokens_exp on public.tg_link_tokens (expires_at);
-- FK cascade on account delete
create index if not exists store_claims_user on public.store_claims (user_id);
