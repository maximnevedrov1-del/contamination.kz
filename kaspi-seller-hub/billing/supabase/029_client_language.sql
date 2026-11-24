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
