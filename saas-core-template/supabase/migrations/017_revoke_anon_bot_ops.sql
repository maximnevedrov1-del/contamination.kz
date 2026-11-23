-- 017: the Telegram-bot and ops-digest RPCs are for the server side only.
-- They were callable with the public anon key (guarded only by a key argument); now EXECUTE is
-- granted to service_role alone. Callers: the telegram-bot Edge Function (uses
-- SUPABASE_SERVICE_ROLE_KEY) and the ops-alert GitHub workflow (github-workflows/ops-alert.yml, secret SUPABASE_SERVICE_ROLE_KEY).
-- Deploy the updated telegram-bot function BEFORE applying this migration.
--
-- NOT revoked on purpose: get_service_status(). The extension (anon / seller token) and the admin
-- page read it to show the service-status banner; revoking it would break that banner.

revoke execute on function public.bot_link(text, text, bigint, text)  from public, anon, authenticated;
revoke execute on function public.bot_unlink(text, bigint, boolean)   from public, anon, authenticated;
revoke execute on function public.bot_jobs(text)                      from public, anon, authenticated;
revoke execute on function public.bot_sent(text, jsonb)               from public, anon, authenticated;
revoke execute on function public.bot_lock(text, text, int)           from public, anon, authenticated;
revoke execute on function public.bot_unlock(text, text)              from public, anon, authenticated;
revoke execute on function public.bot_key_ok(text)                    from public, anon, authenticated;
revoke execute on function public.ops_digest(text)                    from public, anon, authenticated;

grant execute on function public.bot_link(text, text, bigint, text)  to service_role;
grant execute on function public.bot_unlink(text, bigint, boolean)   to service_role;
grant execute on function public.bot_jobs(text)                      to service_role;
grant execute on function public.bot_sent(text, jsonb)               to service_role;
grant execute on function public.bot_lock(text, text, int)           to service_role;
grant execute on function public.bot_unlock(text, text)              to service_role;
grant execute on function public.bot_key_ok(text)                    to service_role;
grant execute on function public.ops_digest(text)                    to service_role;
