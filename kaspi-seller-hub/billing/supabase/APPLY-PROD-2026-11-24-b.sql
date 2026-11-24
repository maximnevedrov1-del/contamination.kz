-- SaudaPulse: production update 24.11.2026 (b): the client's interface language. Run ONCE in Supabase → SQL Editor.
-- Production already has 001–028. This applies 029_client_language.sql, then grants.sql. Safe to run again.

-- ==================== 029_client_language.sql ====================
-- Seller Hub: the client's interface language (ru / kk) on the server. Safe to run again.
-- Apply AFTER 028_payment_autoconfirm.sql, then grants.sql.
--
-- The extension sends the language chosen in its interface (set_my_lang) on sign-in and whenever it changes.
-- The Telegram bot writes every message in that language (bot_langs); support tickets remember the language
-- they were written in, so the admin answers in it; the «what's new» text for the win-back message has a
-- Kazakh variant. Default and fallback: Russian.
begin;

-- ---------- language of the account ----------
alter table public.accounts add column if not exists lang text not null default 'ru';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_lang_check') then
    alter table public.accounts add constraint accounts_lang_check check (lang in ('ru', 'kk'));
  end if;
end $$;

create or replace function public.set_my_lang(p_lang text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); l text := lower(btrim(coalesce(p_lang, '')));
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if l not in ('ru', 'kk') then raise exception 'invalid_lang' using errcode = '22023'; end if;
  perform public.ensure_account();
  update public.accounts set lang = l where user_id = uid and lang is distinct from l;
  return jsonb_build_object('lang', l);
end $$;
revoke execute on function public.set_my_lang(text) from public, anon;
grant execute on function public.set_my_lang(text) to authenticated;

-- ---------- support: a ticket keeps the language it was written in ----------
alter table public.support_tickets add column if not exists lang text not null default 'ru';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'support_tickets_lang_check') then
    alter table public.support_tickets add constraint support_tickets_lang_check check (lang in ('ru', 'kk'));
  end if;
end $$;

create or replace function public.support_ticket_set_lang()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.lang := coalesce((select a.lang from public.accounts a where a.user_id = new.user_id), 'ru');
  return new;
end $$;
revoke execute on function public.support_ticket_set_lang() from public, anon, authenticated;
drop trigger if exists support_tickets_lang on public.support_tickets;
create trigger support_tickets_lang before insert on public.support_tickets
  for each row execute function public.support_ticket_set_lang();

-- the admin view of a ticket now carries its language (the client's view is unchanged)
create or replace function public.ticket_json(t public.support_tickets, p_admin boolean default false)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'topic', t.topic, 'message', t.message, 'status', t.status, 'reply', t.reply,
    'created_at', t.created_at, 'replied_at', t.replied_at,
    'unread', t.replied_at is not null and (t.seen_at is null or t.seen_at < t.replied_at))
  || case when p_admin then jsonb_build_object('email', t.email, 'report', t.report, 'version', t.version, 'user_id', t.user_id, 'lang', t.lang) else '{}'::jsonb end;
$$;

-- ---------- «what's new» in Kazakh for the win-back message ----------
alter table public.billing_config add column if not exists whats_new_kk text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'billing_config_whats_new_kk_check') then
    alter table public.billing_config add constraint billing_config_whats_new_kk_check check (length(whats_new_kk) <= 1500);
  end if;
end $$;

create or replace function public.admin_growth_settings(p jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p ? 'bot_key_hash' and coalesce(p->>'bot_key_hash', '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_key'; end if;
  update public.billing_config set
    bot_username = case when p ? 'bot_username' then nullif(btrim(p->>'bot_username', ' @'), '') else bot_username end,
    support_url  = case when p ? 'support_url' then nullif(btrim(p->>'support_url'), '') else support_url end,
    app_url      = case when p ? 'app_url' then nullif(btrim(p->>'app_url'), '') else app_url end,
    whats_new    = case when p ? 'whats_new' then nullif(btrim(p->>'whats_new'), '') else whats_new end,
    whats_new_kk = case when p ? 'whats_new_kk' then nullif(btrim(p->>'whats_new_kk'), '') else whats_new_kk end
  where id = 1;
  if p ? 'bot_key_hash' then update public.ops_settings set bot_key_hash = p->>'bot_key_hash' where id = 1; end if;
  return (select jsonb_build_object('bot_username', bot_username, 'support_url', support_url, 'app_url', app_url, 'whats_new', whats_new,
            'whats_new_kk', whats_new_kk,
            'has_bot_key', (select bot_key_hash is not null from public.ops_settings where id = 1),
            'linked', (select count(*) from public.tg_links where blocked_at is null),
            'blocked', (select count(*) from public.tg_links where blocked_at is not null),
            'cancellations', (select coalesce(jsonb_object_agg(outcome, n), '{}') from (select outcome, count(*) n from public.cancellations where created_at > now() - interval '90 days' group by outcome) x))
          from public.billing_config where id = 1);
end $$;

-- ---------- for the bot: languages of the users / chats it is about to write to ----------
create or replace function public.bot_langs(p_key text, p_user_ids uuid[] default null, p_chat_ids bigint[] default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  return jsonb_build_object(
    'users', coalesce((select jsonb_object_agg(a.user_id::text, a.lang) from public.accounts a
                        where a.user_id = any (coalesce(p_user_ids, '{}'::uuid[]))), '{}'::jsonb),
    'chats', coalesce((select jsonb_object_agg(l.chat_id::text, a.lang) from public.tg_links l join public.accounts a using (user_id)
                        where l.chat_id = any (coalesce(p_chat_ids, '{}'::bigint[]))), '{}'::jsonb),
    'whats_new_kk', (select whats_new_kk from public.billing_config where id = 1));
end $$;
revoke execute on function public.bot_langs(text, uuid[], bigint[]) from public, anon, authenticated;
grant execute on function public.bot_langs(text, uuid[], bigint[]) to service_role;

commit;

-- ==================== grants.sql ====================
-- Seller Hub: function, table and Storage privileges, deterministic and idempotent.
-- Apply AFTER restoring a dump (pg_restore --no-owner ...):
--   psql "$TARGET_DB_URL" -f kaspi-seller-hub/billing/supabase/grants.sql
-- Mirrors the grants of migrations 001..026 (verified against a database built from them).
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
  public.admin_payment_events(boolean,int),
  public.admin_resolve_payment_event(bigint,text),
  public.set_my_lang(text),
  public.admin_delete_account(uuid,text),
  public.admin_delete_feature_flag(text),
  public.admin_fail_storage_cleanup(bigint,text),
  public.admin_funnel_events(),
  public.admin_get_config(),
  public.admin_get_system_banner(),
  public.admin_grant_days(uuid,int,int),
  public.admin_growth_settings(jsonb),
  public.admin_health(int),
  public.admin_insights(int),
  public.admin_invoices(text,text,int,int),
  public.admin_list_feature_flags(),
  public.admin_list_storage_cleanups(),
  public.admin_ops_settings(text,int,numeric),
  public.admin_purge_expired(),
  public.admin_resolve_storage_cleanup(bigint),
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
  public.track_ux_events(jsonb),
  public.upgrade_quote(int),
  public.usage_report(jsonb,jsonb,text)
to authenticated;

-- 4. server side only (Telegram bot Edge Function, ops-alert job, retention job): service_role
grant execute on function
  public.bot_link(text, text, bigint, text), public.bot_unlink(text, bigint, boolean), public.bot_jobs(text), public.bot_sent(text, jsonb),
  public.bot_lock(text, text, int), public.bot_unlock(text, text), public.bot_key_ok(text), public.ops_digest(text),
  public.enqueue_retention_nudges(), public.payment_received(text,text,int,bigint,text), public.bot_langs(text,uuid[],bigint[])
to service_role;

-- 5. only Supabase Auth may run the access-token hook
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema public to supabase_auth_admin;
    grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
  end if;
end $$;

-- ---------- 6. tables and sequences (restore drill 2026-11-23) ----------
-- A restore into a Supabase project runs CREATE TABLE under Supabase's default privileges
-- (ALL to anon/authenticated); the dump's GRANTs only add on top. Close everything, then
-- re-grant exactly what the migrations grant: clients read their own account row (RLS) and
-- the public invoice columns of their own invoices (RLS); everything else goes through RPCs.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
grant select on public.accounts to authenticated;
grant select (id, user_id, kind, stores, months, amount, phone, status, created_at, paid_at, period_from, period_to, discount_pct)
  on public.invoices to authenticated;

-- ---------- 7. Storage: price-list bucket and its rules (schema storage is NOT in the dump) ----------
-- The files themselves live in Supabase Storage, outside the database dump: after a restore the
-- extension re-uploads a feed only when its prices/stock change or on a forced re-publish (same feed_id → same URL
-- on the same project; a new project has a new URL that the seller must paste into Kaspi again).
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('pricelists', 'pricelists', true, 5242880, array['application/xml', 'text/xml'])
      on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = array['application/xml', 'text/xml'];
    drop policy if exists "pricelists insert own" on storage.objects;
    drop policy if exists "pricelists update own" on storage.objects;
    drop policy if exists "pricelists select own" on storage.objects;
    drop policy if exists "pricelists delete own" on storage.objects;
    drop policy if exists "pricelists admin select" on storage.objects;
    drop policy if exists "pricelists admin delete" on storage.objects;
    create policy "pricelists insert own" on storage.objects for insert to authenticated
      with check (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists update own" on storage.objects for update to authenticated
      using (bucket_id = 'pricelists' and public.can_write_feed(name))
      with check (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists select own" on storage.objects for select to authenticated
      using (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists delete own" on storage.objects for delete to authenticated
      using (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists admin select" on storage.objects for select to authenticated
      using (bucket_id = 'pricelists' and public.is_admin());
    create policy "pricelists admin delete" on storage.objects for delete to authenticated
      using (bucket_id = 'pricelists' and public.is_admin());
  end if;
end $$;
