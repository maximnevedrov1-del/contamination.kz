-- SaaS core: function privileges, deterministic and idempotent.
-- Apply AFTER restoring a dump made without privileges (pg_restore --no-owner ...):
--   psql "$TARGET_DB_URL" -f supabase/grants.sql
-- Mirrors the grants of migrations 001..025 (verified against a database built from them).
-- Keep in sync: when a migration adds a function or changes who may call it, update this file too.

-- 1. everything closed first (also for future functions)
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

-- 2. anonymous: the service-status banner (extension, admin page) and the health probe
grant execute on function public.get_service_status(), public.health() to anon, authenticated;

-- 3. signed-in sellers and admins (admin_* functions check is_admin() inside)
grant execute on function
  public.accept_terms(),
  public.admin_accounts(text,text,int,int),
  public.admin_cancel_invoice(bigint,text),
  public.admin_client_errors(int),
  public.admin_confirm_invoice(bigint,text,int,int),
  public.admin_delete_account(uuid,text),
  public.admin_delete_feature_flag(text),
  public.admin_funnel_events(),
  public.admin_get_config(),
  public.admin_get_system_banner(),
  public.admin_grant_days(uuid,int,int),
  public.admin_growth_settings(jsonb),
  public.admin_health(int),
  public.admin_insights(int),
  public.admin_invoices(text,text,int,int),
  public.admin_list_feature_flags(),
  public.admin_ops_settings(text,int,numeric),
  public.admin_purge_expired(),
  public.admin_set_feature_flag(text,boolean,int,text[],text),
  public.admin_set_status(text,text,int),
  public.admin_set_system_banner(boolean,text,text),
  public.admin_ticket_reply(bigint,text,boolean),
  public.admin_tickets(text,text,int,int),
  public.admin_update_config(jsonb),
  public.admin_ux_summary(),
  public.alert_create(text,text,int,text),
  public.apply_referral_code(text),
  public.billing_price(int,int),
  public.can_write_feed(text),
  public.cancel_flow(text,text,text),
  public.cancel_my_invoice(bigint),
  public.create_invoice(int,int,text),
  public.digest_report(date,jsonb),
  public.ensure_price_feed(text),
  public.ensure_renewal_invoice(int),
  public.feedback_due(),
  public.feedback_submit(text,int,text,text,bigint),
  public.get_license(int,text[]),
  public.health_report(jsonb),
  public.is_admin(),
  public.my_referral(),
  public.my_tickets(),
  public.report_client_error(text,text,text),
  public.request_store_addon(int),
  public.resume_subscription(),
  public.set_my_phone(text),
  public.start_trial_boost(),
  public.team_check(uuid),
  public.team_invite(text,text,text[],boolean),
  public.team_join(uuid),
  public.team_list(),
  public.team_remove(uuid),
  public.team_set_enabled(uuid,boolean),
  public.team_update(uuid,text,text[],boolean),
  public.tg_link_create(),
  public.tg_settings(boolean,boolean),
  public.tg_status(),
  public.tg_unlink(),
  public.ticket_close(bigint),
  public.ticket_create(text,text,text,text),
  public.ticket_seen(bigint),
  public.track_funnel_event(text),
  public.track_ux_event(text,text,text),
  public.upgrade_quote(int),
  public.usage_report(jsonb,jsonb,text)
to authenticated;

-- 4. server side only (Telegram bot Edge Function, ops-alert job, retention job): service_role
grant execute on function
  public.bot_link(text, text, bigint, text), public.bot_unlink(text, bigint, boolean), public.bot_jobs(text), public.bot_sent(text, jsonb),
  public.bot_lock(text, text, int), public.bot_unlock(text, text), public.bot_key_ok(text), public.ops_digest(text),
  public.enqueue_retention_nudges()
to service_role;

-- 5. only Supabase Auth may run the access-token hook
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema public to supabase_auth_admin;
    grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
  end if;
end $$;
