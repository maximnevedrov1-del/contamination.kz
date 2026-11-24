-- SaudaPulse: production update 24.11.2026 (d). Replaces APPLY-PROD-2026-11-24-c.sql (not applied yet: production has 001–029).
-- Run ONCE in Supabase → SQL Editor. Applies, in order:
--   030_audit_fixes.sql      — security-audit fixes (SECURITY-AUDIT-2026-11-24.md);
--   031_phone_verified.sql   — payer phone confirmed in Telegram (/phone);
--   032_support_bot.sql      — answer base and support in the bot, daily monitoring for the owner;
--   grants.sql               — function, table and Storage privileges.
-- Safe to run again (the answer base is seeded once: your edits in the admin page are kept).
-- After it: redeploy the telegram-bot Edge Function (supabase functions deploy telegram-bot --no-verify-jwt)
-- and update the admin page files (billing/admin/) wherever you host them.

-- ==================== 030_audit_fixes.sql ====================
-- Seller Hub: fixes from SECURITY-AUDIT-2026-11-24.md. Safe to run again.
-- Apply AFTER 029_client_language.sql, then grants.sql (no new functions: create or replace keeps the grants).
--
-- M-1  payment_received(): a payment that carries no invoice id is NEVER confirmed by a phone match any more.
--      The phone on an invoice is typed by the client and is not verified, so anyone could put another seller's
--      number on their own invoice and receive that seller's payment. A phone + amount match now goes to the
--      admin's review queue with reason 'phone_only' and the candidate invoice; the admin confirms by hand.
-- M-2  The retention discount («30 % на 2 счёта», cancel_flow → discount) covers ONE month of each discounted
--      invoice. Before, a 12-month invoice got 30 % off all 12 months (2 invoices → up to 24 months at −30 %).
--      The offer now also expires 60 days after it was taken.
begin;

-- ---------- M-1: phone-only matches go to review ----------
alter table public.payment_events drop constraint if exists payment_events_reason_check;
alter table public.payment_events add constraint payment_events_reason_check check (reason is null or reason in
  ('no_match', 'ambiguous', 'amount_mismatch', 'invoice_not_pending', 'invoice_not_found', 'phone_only'));

create or replace function public.payment_received(p_provider text, p_payment_id text, p_amount int,
                                                   p_invoice_id bigint default null, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.payment_events; inv public.invoices; ph text; n int; why text;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_-]{2,32}$' or p_payment_id is null or length(p_payment_id) not between 1 and 128
     or p_amount is null or p_amount <= 0 then
    raise exception 'invalid_payment' using errcode = '22023';
  end if;
  ph := public.normalize_phone(p_phone);
  insert into public.payment_events (provider, payment_id, amount, phone)
  values (p_provider, p_payment_id, p_amount, ph)
  on conflict (provider, payment_id) do nothing
  returning * into ev;
  if not found then
    -- the provider sent the same payment again (retry): answer what was decided the first time, change nothing
    select * into ev from public.payment_events where provider = p_provider and payment_id = p_payment_id;
    return jsonb_build_object('outcome', ev.outcome, 'reason', ev.reason, 'invoice_id', ev.invoice_id, 'duplicate', true);
  end if;

  if p_invoice_id is not null then
    -- our own invoice number came back from the provider: the only reference good enough to confirm automatically
    select * into inv from public.invoices where id = p_invoice_id for update;
    if not found then why := 'invoice_not_found'; end if;
    if why is null and inv.status <> 'pending' then why := 'invoice_not_pending'; end if;
    if why is null and inv.amount <> p_amount then why := 'amount_mismatch'; end if;
  elsif ph is not null then
    -- the phone on an invoice is whatever the client typed (not verified): suggest the candidate, never confirm
    select count(*) into n from public.invoices where status = 'pending' and phone = ph and amount = p_amount;
    if n = 0 then why := 'no_match';
    elsif n > 1 then why := 'ambiguous';
    else
      select * into inv from public.invoices where status = 'pending' and phone = ph and amount = p_amount;
      why := 'phone_only';
    end if;
  else
    why := 'no_match';
  end if;

  if why is null then
    perform public.confirm_invoice_core(inv.id, left('auto: ' || p_provider || ' ' || p_payment_id, 200), null);
    update public.payment_events set outcome = 'confirmed', invoice_id = inv.id where id = ev.id returning * into ev;
  else
    update public.payment_events set outcome = 'review', reason = why, invoice_id = inv.id where id = ev.id returning * into ev;
  end if;
  return jsonb_build_object('outcome', ev.outcome, 'reason', ev.reason, 'invoice_id', ev.invoice_id, 'duplicate', false);
end $$;
revoke execute on function public.payment_received(text, text, int, bigint, text) from public, anon, authenticated;
grant execute on function public.payment_received(text, text, int, bigint, text) to service_role;

-- ---------- M-2: the discount covers one month per discounted invoice; the offer expires ----------
-- Both functions are patched in place (exactly one occurrence each), so the rest of their bodies and their grants
-- stay as the earlier migrations left them. Re-running is a no-op once patched.
do $$
declare d text; old_s text; new_s text;
begin
  d := pg_get_functiondef('public.create_invoice(integer,integer,text)'::regprocedure);
  old_s := 'public.discounted(public.billing_price(n_stores, p_months), acc)';
  new_s := 'public.discounted(public.billing_price(n_stores, 1), acc) + public.billing_price(n_stores, p_months - 1)';
  if position(new_s in d) = 0 then
    if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
      raise exception 'create_invoice: expected exactly one "%"', old_s;
    end if;
    execute replace(d, old_s, new_s);
  end if;

  d := pg_get_functiondef('public.cancel_flow(text,text,text)'::regprocedure);
  old_s := 'discount_pct = 30, discount_left = 2, discount_until = null';
  new_s := 'discount_pct = 30, discount_left = 2, discount_until = now() + interval ''60 days''';
  if position(new_s in d) = 0 then
    if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
      raise exception 'cancel_flow: expected exactly one "%"', old_s;
    end if;
    execute replace(d, old_s, new_s);
  end if;
end $$;

commit;

-- ==================== 031_phone_verified.sql ====================
-- Seller Hub: phone confirmed through the Telegram bot. Safe to run again.
-- Apply AFTER 030_audit_fixes.sql, then grants.sql.
--
-- A phone typed by the client proves nothing (030 sends every phone-only match to review). Telegram, however,
-- can hand the bot the user's OWN number: the «Поделиться номером» button (request_contact) sends a contact whose
-- user_id is the sender's, and Telegram has verified that number by SMS. The bot stores it here (bot_verify_phone).
-- payment_received() confirms a payment that carries no invoice id only when exactly one pending invoice has this
-- phone and amount AND that phone is the account's Telegram-confirmed number. Anything else still goes to review.
begin;

alter table public.accounts add column if not exists phone_verified text check (phone_verified ~ '^77\d{9}$');
alter table public.accounts add column if not exists phone_verified_at timestamptz;

-- The bot (service_role) received a contact the user shared from their own Telegram account.
create or replace function public.bot_verify_phone(p_key text, p_chat_id bigint, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; ph text;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  select user_id into uid from public.tg_links where chat_id = p_chat_id and blocked_at is null;
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not_linked'); end if;
  ph := public.normalize_phone(p_phone);
  if ph is null then return jsonb_build_object('ok', false, 'error', 'invalid_phone'); end if;
  update public.accounts set phone = ph, phone_verified = ph, phone_verified_at = now() where user_id = uid;
  update public.invoices set phone = ph where user_id = uid and status = 'pending';
  return jsonb_build_object('ok', true, 'phone', ph);
end $$;
revoke execute on function public.bot_verify_phone(text, bigint, text) from public, anon, authenticated;
grant execute on function public.bot_verify_phone(text, bigint, text) to service_role;

-- payment_received: as in 030, plus the confirmed-phone path
create or replace function public.payment_received(p_provider text, p_payment_id text, p_amount int,
                                                   p_invoice_id bigint default null, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.payment_events; inv public.invoices; ph text; n int; why text;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_-]{2,32}$' or p_payment_id is null or length(p_payment_id) not between 1 and 128
     or p_amount is null or p_amount <= 0 then
    raise exception 'invalid_payment' using errcode = '22023';
  end if;
  ph := public.normalize_phone(p_phone);
  insert into public.payment_events (provider, payment_id, amount, phone)
  values (p_provider, p_payment_id, p_amount, ph)
  on conflict (provider, payment_id) do nothing
  returning * into ev;
  if not found then
    -- the provider sent the same payment again (retry): answer what was decided the first time, change nothing
    select * into ev from public.payment_events where provider = p_provider and payment_id = p_payment_id;
    return jsonb_build_object('outcome', ev.outcome, 'reason', ev.reason, 'invoice_id', ev.invoice_id, 'duplicate', true);
  end if;

  if p_invoice_id is not null then
    -- our own invoice number came back from the provider
    select * into inv from public.invoices where id = p_invoice_id for update;
    if not found then why := 'invoice_not_found'; end if;
    if why is null and inv.status <> 'pending' then why := 'invoice_not_pending'; end if;
    if why is null and inv.amount <> p_amount then why := 'amount_mismatch'; end if;
  elsif ph is not null then
    select count(*) into n from public.invoices where status = 'pending' and phone = ph and amount = p_amount;
    if n = 0 then why := 'no_match';
    elsif n > 1 then why := 'ambiguous';
    else
      select * into inv from public.invoices where status = 'pending' and phone = ph and amount = p_amount for update;
      -- confirmed only when the phone is the account's own, confirmed in Telegram; a typed phone goes to review
      if not exists (select 1 from public.accounts a where a.user_id = inv.user_id and a.phone_verified = ph) then
        why := 'phone_only';
      end if;
    end if;
  else
    why := 'no_match';
  end if;

  if why is null then
    perform public.confirm_invoice_core(inv.id, left('auto: ' || p_provider || ' ' || p_payment_id, 200), null);
    update public.payment_events set outcome = 'confirmed', invoice_id = inv.id where id = ev.id returning * into ev;
  else
    update public.payment_events set outcome = 'review', reason = why, invoice_id = inv.id where id = ev.id returning * into ev;
  end if;
  return jsonb_build_object('outcome', ev.outcome, 'reason', ev.reason, 'invoice_id', ev.invoice_id, 'duplicate', false);
end $$;
revoke execute on function public.payment_received(text, text, int, bigint, text) from public, anon, authenticated;
grant execute on function public.payment_received(text, text, int, bigint, text) to service_role;

-- The licence tells the extension whether the account's phone is the confirmed one (for the hint on the payment page).
do $$
declare d text := pg_get_functiondef('public.get_license(integer,text[])'::regprocedure);
        old_s text := '''phone'', acc.phone,';
        new_s text := '''phone'', acc.phone, ''phone_verified'', acc.phone_verified is not null and acc.phone_verified is not distinct from acc.phone,';
begin
  if position('phone_verified' in d) = 0 then
    if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
      raise exception 'get_license: expected exactly one "%"', old_s;
    end if;
    execute replace(d, old_s, new_s);
  end if;
end $$;

commit;

-- ==================== 032_support_bot.sql ====================
-- Seller Hub: support answers in the Telegram bot, and daily monitoring for the owner. Safe to run again.
-- Apply AFTER 031_phone_verified.sql, then grants.sql.
--
-- 1. support_faq: the answer base (RU + KZ). The bot matches a seller's message against the keywords (bot.js
--    matchFaq), or the seller picks a topic and a question from the menu. The owner edits the base in the admin
--    page («База ответов»); the bot reads it on every question, so no redeploy is needed.
-- 2. bot_questions: every question asked in the bot, which answer it got (or none), and whether it helped.
--    Unanswered questions show the owner what to add. Long digit runs (phones, IIN) are masked; kept 180 days.
-- 3. «Написать в поддержку» in the bot: the next message of a linked chat becomes a support ticket
--    (source 'telegram'); the owner's reply is sent back to that chat (admin_ticket_tg → bot route /ticket-reply).
-- 4. ops_digest (every 10 minutes) also returns:
--    digest_late — the morning digest has still not gone out by 09:30 (once a day);
--    daily       — once a day after 10:00: digest delivery, bot questions, tickets, clients, top errors.
-- All times are Kazakhstan time (Asia/Almaty, UTC+5).
begin;

-- ---------- 1. the answer base ----------
create table if not exists public.support_faq (
  id          serial primary key,
  slug        text unique check (slug ~ '^[a-z0-9_]{2,40}$'),
  topic       text not null check (topic in ('connect', 'orders', 'print', 'payment', 'goods', 'bot')),
  question_ru text not null check (length(btrim(question_ru)) between 3 and 100),
  question_kk text not null check (length(btrim(question_kk)) between 3 and 100),
  answer_ru   text not null check (length(btrim(answer_ru)) between 3 and 1500),
  answer_kk   text not null check (length(btrim(answer_kk)) between 3 and 1500),
  keywords    text not null default '' check (length(keywords) <= 1000),   -- comma-separated word starts, RU and KZ
  sort        int not null default 100,
  enabled     boolean not null default true,
  shown       int not null default 0,
  helped      int not null default 0,
  not_helped  int not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.support_faq enable row level security;
revoke all on public.support_faq from public, anon, authenticated;
revoke all on sequence public.support_faq_id_seq from public, anon, authenticated;

-- ---------- 2. questions asked in the bot ----------
create table if not exists public.bot_questions (
  id         bigserial primary key,
  chat_id    bigint not null,
  user_id    uuid references auth.users (id) on delete cascade,
  lang       text not null default 'ru' check (lang in ('ru', 'kk')),
  source     text not null check (source in ('text', 'menu')),
  text       text not null check (length(text) <= 500),
  faq_id     int references public.support_faq (id) on delete set null,
  helped     boolean,
  ticket_id  bigint references public.support_tickets (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists bot_questions_created on public.bot_questions (created_at desc);
create index if not exists bot_questions_chat on public.bot_questions (chat_id, created_at desc);
alter table public.bot_questions enable row level security;
revoke all on public.bot_questions from public, anon, authenticated;
revoke all on sequence public.bot_questions_id_seq from public, anon, authenticated;

-- ---------- 3. tickets from Telegram ----------
alter table public.support_tickets add column if not exists source text not null default 'app';
alter table public.support_tickets drop constraint if exists support_tickets_source_check;
alter table public.support_tickets add constraint support_tickets_source_check check (source in ('app', 'telegram'));
alter table public.tg_links add column if not exists ticket_wait_until timestamptz;

-- ---------- 4. monitoring state ----------
alter table public.ops_settings add column if not exists digest_alert_day date;
alter table public.ops_settings add column if not exists report_day date;

-- ---------- the bot (service_role, BOT_KEY) ----------
-- The base for matching and the menu, plus the support link for chats that are not linked.
create or replace function public.bot_faq(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'topic', topic, 'q_ru', question_ru, 'q_kk', question_kk,
                                                           'a_ru', answer_ru, 'a_kk', answer_kk, 'kw', keywords) order by sort, id)
                       from public.support_faq where enabled), '[]'),
    'support_url', (select support_url from public.billing_config where id = 1),
    'app_url', (select app_url from public.billing_config where id = 1));
end $$;

-- A question asked (p_faq = the answer given, null = none found). Returns the question id.
create or replace function public.bot_ask(p_key text, p_chat_id bigint, p_lang text, p_text text, p_faq int default null, p_source text default 'text')
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; q public.bot_questions; clean text;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  if p_chat_id is null then raise exception 'invalid_chat' using errcode = '22023'; end if;
  -- a script or a stuck client must not fill the table
  if (select count(*) from public.bot_questions where chat_id = p_chat_id and created_at > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('id', null, 'limited', true);
  end if;
  select user_id into uid from public.tg_links where chat_id = p_chat_id and blocked_at is null;
  clean := left(btrim(regexp_replace(coalesce(p_text, ''), '\+?\d(?:[\s()-]*\d){9,}', '[номер]', 'g')), 500);
  if clean = '' then clean := '—'; end if;
  insert into public.bot_questions (chat_id, user_id, lang, source, text, faq_id)
  values (p_chat_id, uid, case when p_lang = 'kk' then 'kk' else 'ru' end, case when p_source = 'menu' then 'menu' else 'text' end,
          clean, (select id from public.support_faq where id = p_faq))
  returning * into q;
  if q.faq_id is not null then update public.support_faq set shown = shown + 1 where id = q.faq_id; end if;
  delete from public.bot_questions where created_at < now() - interval '180 days';
  return jsonb_build_object('id', q.id, 'limited', false);
end $$;

-- «👍 Помогло» / «👎 Не помогло»: about the last answer this chat got (within a day), once.
create or replace function public.bot_feedback(p_key text, p_chat_id bigint, p_helped boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.bot_questions;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  select * into q from public.bot_questions
   where chat_id = p_chat_id and faq_id is not null and created_at > now() - interval '1 day'
   order by created_at desc limit 1;
  if q.id is null or q.helped is not null then return jsonb_build_object('ok', false); end if;
  update public.bot_questions set helped = coalesce(p_helped, false) where id = q.id;
  update public.support_faq set helped = helped + case when p_helped then 1 else 0 end,
                                not_helped = not_helped + case when p_helped then 0 else 1 end
   where id = q.faq_id;
  return jsonb_build_object('ok', true, 'faq_id', q.faq_id);
end $$;

-- «Написать в поддержку» (p_on = true): the next message of this chat (within 15 minutes) becomes a ticket.
-- «Отмена» (p_on = false). Only a linked chat: a ticket belongs to an account.
create or replace function public.bot_ticket_wait(p_key text, p_chat_id bigint, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  update public.tg_links set ticket_wait_until = case when p_on then now() + interval '15 minutes' end
   where chat_id = p_chat_id and blocked_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0, 'error', case when n = 0 then 'not_linked' end);
end $$;

-- A message from a chat waiting for «Написать в поддержку» → a ticket. {ok:false, error:'not_waiting'} otherwise.
create or replace function public.bot_ticket(p_key text, p_chat_id bigint, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.tg_links; t public.support_tickets; last_q public.bot_questions; topic text; msg text;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  select * into l from public.tg_links where chat_id = p_chat_id and blocked_at is null;
  if l.user_id is null or l.ticket_wait_until is null or l.ticket_wait_until < now() then
    return jsonb_build_object('ok', false, 'error', 'not_waiting');
  end if;
  update public.tg_links set ticket_wait_until = null where user_id = l.user_id;
  msg := left(btrim(coalesce(p_text, '')), 2000);
  if msg = '' then return jsonb_build_object('ok', false, 'error', 'empty'); end if;
  -- the same limits as ticket_create in the extension
  if (select count(*) from public.support_tickets where user_id = l.user_id and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.support_tickets where user_id = l.user_id and created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'error', 'ticket_limit');
  end if;
  -- the topic of the last answer the seller saw, if any
  select * into last_q from public.bot_questions where chat_id = p_chat_id and created_at > now() - interval '1 day' order by created_at desc limit 1;
  select case f.topic when 'connect' then 'connect' when 'orders' then 'orders' when 'print' then 'print'
                      when 'payment' then 'payment' when 'goods' then 'warehouse' else 'other' end
    into topic from public.support_faq f where f.id = last_q.faq_id;
  insert into public.support_tickets (user_id, email, topic, message, report, source)
  values (l.user_id, (select email from auth.users where id = l.user_id), coalesce(topic, 'other'), msg,
          case when last_q.id is not null then left('Из Telegram. Перед этим спрашивал: ' || last_q.text, 8000) else 'Из Telegram.' end,
          'telegram')
  returning * into t;
  if last_q.id is not null then update public.bot_questions set ticket_id = t.id where id = last_q.id; end if;
  return jsonb_build_object('ok', true, 'id', t.id);
end $$;

-- ---------- the admin page ----------
create or replace function public.admin_faq()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(to_jsonb(f) order by f.topic, f.sort, f.id) from public.support_faq f), '[]');
end $$;

-- Insert (no id) or update one answer. Keywords: lower case, comma-separated, duplicates dropped.
create or replace function public.admin_faq_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare f public.support_faq; kw text;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select string_agg(distinct k, ', ') into kw
    from (select btrim(lower(x)) k from unnest(string_to_array(coalesce(p->>'keywords', ''), ',')) x) y where k <> '';
  if nullif(p->>'id', '') is null then
    insert into public.support_faq (topic, question_ru, question_kk, answer_ru, answer_kk, keywords, sort, enabled)
    values (p->>'topic', btrim(p->>'question_ru'), btrim(p->>'question_kk'), btrim(p->>'answer_ru'), btrim(p->>'answer_kk'),
            left(coalesce(kw, ''), 1000), coalesce((p->>'sort')::int, 100), coalesce((p->>'enabled')::boolean, true))
    returning * into f;
  else
    update public.support_faq set
      topic = coalesce(p->>'topic', topic),
      question_ru = coalesce(btrim(p->>'question_ru'), question_ru), question_kk = coalesce(btrim(p->>'question_kk'), question_kk),
      answer_ru = coalesce(btrim(p->>'answer_ru'), answer_ru), answer_kk = coalesce(btrim(p->>'answer_kk'), answer_kk),
      keywords = case when p ? 'keywords' then left(coalesce(kw, ''), 1000) else keywords end,
      sort = coalesce((p->>'sort')::int, sort), enabled = coalesce((p->>'enabled')::boolean, enabled), updated_at = now()
    where id = (p->>'id')::int returning * into f;
    if f.id is null then raise exception 'not_found'; end if;
  end if;
  return to_jsonb(f);
end $$;

create or replace function public.admin_faq_delete(p_id int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  delete from public.support_faq where id = p_id;
  return found;
end $$;

-- Questions asked in the bot. p_filter: 'unanswered' (no answer found), 'not_helped', anything else = all.
create or replace function public.admin_bot_questions(p_filter text default 'unanswered', p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select q.id, q.created_at, q.lang, q.source, q.text, q.helped, q.ticket_id, q.faq_id, f.question_ru faq, l.tg_name name
          from public.bot_questions q left join public.support_faq f on f.id = q.faq_id left join public.tg_links l on l.chat_id = q.chat_id
         where case p_filter when 'unanswered' then q.faq_id is null and q.source = 'text' when 'not_helped' then q.helped = false else true end
         order by q.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'),
    'stats', (select jsonb_build_object(
        'days', 7,
        'asked', count(*),
        'answered', count(*) filter (where faq_id is not null),
        'unanswered', count(*) filter (where faq_id is null and source = 'text'),
        'helped', count(*) filter (where helped),
        'not_helped', count(*) filter (where helped = false),
        'tickets', count(*) filter (where ticket_id is not null))
      from public.bot_questions where created_at > now() - interval '7 days'));
end $$;

-- After the owner answered a ticket: where to send the answer in Telegram (null = the client has no linked bot).
create or replace function public.admin_ticket_tg(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t public.support_tickets; chat bigint; lng text;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select * into t from public.support_tickets where id = p_id;
  if t.id is null or coalesce(btrim(t.reply), '') = '' then return null; end if;
  select l.chat_id into chat from public.tg_links l where l.user_id = t.user_id and l.blocked_at is null;
  if chat is null then return null; end if;
  select lang into lng from public.accounts where user_id = t.user_id;
  return jsonb_build_object('id', t.id, 'chat_id', chat, 'lang', coalesce(lng, 'ru'), 'question', left(t.message, 300), 'reply', t.reply);
end $$;

-- ---------- monitoring ----------
-- Chats whose digest for p_day is due but not sent yet (the same rule as bot_jobs → 'morning').
create or replace function public.digest_pending(p_day date)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.tg_links l join public.digest_stats ds on ds.user_id = l.user_id and ds.day = p_day
   where l.blocked_at is null and l.digest and public.has_access_of(l.user_id)
     and not exists (select 1 from public.tg_sent s where s.user_id = l.user_id and s.kind = 'morning' and s.key = p_day::text);
$$;

-- The owner's daily report: the last 24 hours, Kazakhstan time.
create or replace function public.ops_daily_report()
returns jsonb language sql stable security definer set search_path = public as $$
  with local as (select (now() at time zone 'Asia/Almaty')::date today),
  d as (select today - 1 yday from local),
  sent as (select s.* from public.tg_sent s, d where s.kind = 'morning' and s.key = d.yday::text)
  select jsonb_build_object(
    'day', (select today from local),
    'digest', jsonb_build_object(
      'for_day', (select yday from d),
      'sent', (select count(*) from sent where error is null),
      'failed', (select count(*) from sent where error is not null),
      'first_at', (select to_char(min(sent_at) at time zone 'Asia/Almaty', 'HH24:MI') from sent where error is null),
      'last_at', (select to_char(max(sent_at) at time zone 'Asia/Almaty', 'HH24:MI') from sent where error is null),
      'pending', (select public.digest_pending(yday) from d)),
    'bot', (select jsonb_build_object(
        'asked', count(*),
        'answered', count(*) filter (where faq_id is not null),
        'unanswered', count(*) filter (where faq_id is null and source = 'text'),
        'helped', count(*) filter (where helped),
        'not_helped', count(*) filter (where helped = false),
        'top_unanswered', coalesce((select jsonb_agg(left(x.text, 80)) from (
            select text from public.bot_questions where faq_id is null and source = 'text' and created_at > now() - interval '1 day'
             order by created_at desc limit 5) x), '[]'),
        'top_faq', coalesce((select jsonb_agg(jsonb_build_object('q', x.q, 'n', x.n)) from (
            select f.question_ru q, count(*) n from public.bot_questions b join public.support_faq f on f.id = b.faq_id
             where b.created_at > now() - interval '1 day' group by f.question_ru order by count(*) desc limit 3) x), '[]'))
      from public.bot_questions where created_at > now() - interval '1 day'),
    'tickets', jsonb_build_object(
      'new', (select count(*) from public.support_tickets where created_at > now() - interval '1 day'),
      'new_telegram', (select count(*) from public.support_tickets where created_at > now() - interval '1 day' and source = 'telegram'),
      'open', (select count(*) from public.support_tickets where status = 'open'),
      'oldest_open_hours', (select floor(extract(epoch from now() - min(created_at)) / 3600)::int from public.support_tickets where status = 'open')),
    'clients', jsonb_build_object(
      'accounts', (select count(*) from public.accounts),
      'active_24h', (select count(*) from public.accounts where last_seen_at > now() - interval '1 day'),
      'tg_linked', (select count(*) from public.tg_links where blocked_at is null),
      'tg_blocked_24h', (select count(*) from public.tg_links where blocked_at > now() - interval '1 day')),
    'errors', coalesce((select jsonb_agg(jsonb_build_object('code', x.error_code, 'users', x.users, 'n', x.n)) from (
        select error_code, count(distinct user_id) users, sum(occurrences) n from public.client_errors
         where last_seen_at > now() - interval '1 day' group by error_code order by count(distinct user_id) desc, sum(occurrences) desc limit 3) x), '[]'));
$$;

-- ops_digest as in 014, plus digest_late and the daily report.
create or replace function public.ops_digest(p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.ops_settings; kh text; w jsonb; e jsonb; alerts jsonb := '[]'; recovered jsonb := '[]'; down jsonb; since timestamptz;
        purged jsonb; loc timestamp := now() at time zone 'Asia/Almaty'; late jsonb; daily jsonb; n int;
begin
  -- verify the key without a lock
  select key_hash into kh from public.ops_settings where id = 1;
  if kh is null or p_key is null or length(p_key) < 32
     or encode(sha256(convert_to(p_key, 'utf8')), 'hex') <> kh then
    perform pg_sleep(0.5);
    raise exception 'bad_key';
  end if;
  select * into o from public.ops_settings where id = 1 for update;
  since := coalesce(o.last_digest_at, now() - interval '1 hour');
  down := o.alerted;
  w := public.health_window(60);
  for e in select * from jsonb_array_elements(w) loop
    if (e->>'failing')::int >= o.min_users and (e->>'share')::numeric >= o.min_share then
      -- new outage, or a reminder every 2 hours while it lasts
      if not (down ? (e->>'market')) or (down->>(e->>'market'))::timestamptz < now() - interval '2 hours' then
        alerts := alerts || jsonb_build_array(e);
        down := down || jsonb_build_object(e->>'market', now());
      end if;
    elsif down ? (e->>'market') and (e->>'share')::numeric < o.min_share / 2 then
      recovered := recovered || to_jsonb(e->>'market');
      down := down - (e->>'market');
    end if;
  end loop;
  -- the morning digest should be out by 09:30: say so once a day if it is not
  if loc::time >= time '09:30' and o.digest_alert_day is distinct from loc::date then
    n := public.digest_pending(loc::date - 1);
    if n > 0 then
      late := jsonb_build_object('pending', n, 'sent', (select count(*) from public.tg_sent where kind = 'morning' and key = (loc::date - 1)::text and error is null));
      o.digest_alert_day := loc::date;
    end if;
  end if;
  -- the daily report, once a day after 10:00
  if loc::time >= time '10:00' and o.report_day is distinct from loc::date then
    daily := public.ops_daily_report();
    o.report_day := loc::date;
  end if;
  update public.ops_settings set last_digest_at = now(), alerted = down, digest_alert_day = o.digest_alert_day, report_day = o.report_day where id = 1;
  if o.last_purge_at is null or o.last_purge_at < now() - interval '1 day' then
    purged := public.purge_expired();
  end if;
  return jsonb_build_object(
    'alerts', alerts,
    'recovered', recovered,
    'new_tickets', (select count(*) from public.support_tickets where created_at > since),
    'open_tickets', (select count(*) from public.support_tickets where status = 'open'),
    'new_invoices', (select count(*) from public.invoices where created_at > since and status = 'pending'),
    'pending_invoices', (select count(*) from public.invoices where status = 'pending'),
    'pending_sum', (select coalesce(sum(amount), 0) from public.invoices where status = 'pending'),
    'purged', purged,
    'digest_late', late,
    'daily', daily);
end
$$;

-- ---------- privileges ----------
revoke execute on function public.bot_faq(text), public.bot_ask(text, bigint, text, text, int, text), public.bot_feedback(text, bigint, boolean),
  public.bot_ticket_wait(text, bigint, boolean), public.bot_ticket(text, bigint, text), public.digest_pending(date), public.ops_daily_report(),
  public.ops_digest(text) from public, anon, authenticated;
grant execute on function public.bot_faq(text), public.bot_ask(text, bigint, text, text, int, text), public.bot_feedback(text, bigint, boolean),
  public.bot_ticket_wait(text, bigint, boolean), public.bot_ticket(text, bigint, text), public.ops_digest(text) to service_role;
revoke execute on function public.admin_faq(), public.admin_faq_save(jsonb), public.admin_faq_delete(int),
  public.admin_bot_questions(text, int), public.admin_ticket_tg(bigint) from public, anon;
grant execute on function public.admin_faq(), public.admin_faq_save(jsonb), public.admin_faq_delete(int),
  public.admin_bot_questions(text, int), public.admin_ticket_tg(bigint) to authenticated;

-- ---------- the starting base (the extension's «Помощь» answers + what sellers ask the bot) ----------
-- Inserted once by slug: the owner's later edits are never overwritten when this file runs again.
insert into public.support_faq (slug, topic, sort, question_ru, question_kk, answer_ru, answer_kk, keywords) values
('connect', 'connect', 10,
 'Как подключить магазин?', 'Дүкенді қалай қосуға болады?',
 'Нажмите «+ Подключить магазин» внизу меню, введите название и токен API магазина. Заказы появятся через несколько секунд.',
 'Мәзірдің төменгі жағындағы «+ Дүкенді қосу» батырмасын басып, дүкен атауы мен API токенін енгізіңіз. Тапсырыстар бірнеше секундтан кейін пайда болады.',
 'подключ магазин, добав магазин, как подключ, второй магазин, дүкенді қос, дүкен қос, қосу'),
('token', 'connect', 20,
 'Где взять токен API?', 'API токенін қайдан алуға болады?',
 'Кабинет продавца Kaspi → Настройки → Токен API → «Сформировать». Это может сделать только руководитель магазина. Токен хранится только в вашем браузере.',
 'Kaspi сатушы кабинеті → Баптаулар → API токені → «Жасау». Мұны тек дүкен басшысы жасай алады. Токен тек сіздің браузеріңізде сақталады.',
 'токен, token, api, апи, ключ, сформир'),
('token_bad', 'connect', 30,
 'Пишет «неверный токен» или заказы перестали обновляться', '«Токен қате» деп жазады немесе тапсырыстар жаңармайды',
 'Скорее всего, токен в кабинете Kaspi сформировали заново — старый перестаёт работать. Сформируйте токен (Кабинет Kaspi → Настройки → Токен API) и вставьте его в SaudaPulse: «Настройки» → ваш магазин → «Переподключить токен». Если токен верный, проверьте вверху расширения: при сбое Kaspi там будет сообщение, а данные обновятся сами.',
 'Токенді Kaspi кабинетінде қайта жасаған болуы мүмкін — ескісі жұмыс істемей қалады. Токенді жасап (Kaspi кабинеті → Баптаулар → API токені), SaudaPulse-ке енгізіңіз: «Баптаулар» → дүкеніңіз → «Токенді қайта қосу». Токен дұрыс болса, кеңейтімнің жоғарғы жағын қараңыз: Kaspi істен шықса, сонда хабарлама болады, деректер өздігінен жаңарады.',
 'неверн токен, ошибка токен, токен не, не обновл, не загруж, не груз, не приход заказ, перестал, не работает, ошибка 401, 401, токен қате, жаңармай, жүктелмей, жұмыс істемей'),
('kaspi_down', 'connect', 40,
 'Kaspi не отвечает, данные старые', 'Kaspi жауап бермейді, деректер ескі',
 'Иногда API Kaspi временно недоступен. Тогда расширение показывает последние данные и сообщение «Kaspi API временно недоступен» и само повторяет запросы. Мы видим такие сбои сразу и пишем об этом вверху расширения. Обычно всё восстанавливается за 10–30 минут.',
 'Кейде Kaspi API уақытша қолжетімсіз болады. Сонда кеңейтім соңғы деректерді және «Kaspi API уақытша қолжетімсіз» хабарын көрсетеді, сұрауларды өзі қайталайды. Мұндай ақауларды бірден көреміз және кеңейтімнің жоғарғы жағында жазамыз. Әдетте 10–30 минутта бәрі қалпына келеді.',
 'kaspi не отвеч, каспи не отвеч, сбой, недоступ, старые данн, завис, тормоз, медленн, kaspi жауап, каспи жауап, ақау, баяу'),
('accept', 'orders', 10,
 'Как принять и собрать заказ?', 'Тапсырысты қалай қабылдап, жинауға болады?',
 'Откройте «Заказы» → вкладка «Новые». Нажмите на номер заказа — откроется карточка с товарами и кнопками «Принять» и «Упаковать». Несколько заказов можно отметить галочками и обработать сразу.',
 '«Тапсырыстар» → «Жаңа» қойындысын ашыңыз. Тапсырыс нөмірін басыңыз — тауарлары мен «Қабылдау», «Буып-түю» батырмалары бар карточка ашылады. Бірнеше тапсырысты белгілеп, бірден өңдеуге болады.',
 'принят заказ, принять, собрат, упаков, сборк, новые заказ, қабылда, жина, буып'),
('digest_time', 'orders', 20,
 'Когда приходит сводка?', 'Қорытынды қашан келеді?',
 'Каждый день в 09:00 по времени Казахстана — заказы, выручка и отправки за вчера. Если заказ под угрозой просрочки — сообщение приходит сразу. Отключить сводку: «Настройки» → «Telegram-уведомления».',
 'Күн сайын Қазақстан уақытымен 09:00-де — кешегі тапсырыстар, түсім және жөнелтілімдер. Тапсырыс мерзімі өтіп кету қаупінде болса — хабарлама бірден келеді. Қорытындыны өшіру: «Баптаулар» → «Telegram хабарламалары».',
 'сводк, когда приход, во сколько, время сводк, утром, вечером, отчет, отчёт, қорытынды, қашан, нешеде'),
('digest_zero', 'orders', 30,
 'Почему в сводке нули или не все заказы?', 'Неге қорытындыда нөл немесе барлық тапсырыс жоқ?',
 'Цифры для сводки собирает расширение, пока открыт Chrome. Если вчера Chrome был закрыт, в сводке будут данные на момент последней синхронизации — об этом есть строка «По данным на …». Откройте SaudaPulse хотя бы раз вечером, и сводка будет полной. Если заказов вчера правда не было — будут нули.',
 'Қорытынды сандарын Chrome ашық тұрғанда кеңейтім жинайды. Кеше Chrome жабық болса, қорытындыда соңғы синхрондау кезіндегі деректер болады — бұл туралы «Деректер … уақытындағы» деген жол бар. Кешке SaudaPulse-ті кемінде бір рет ашыңыз, сонда қорытынды толық болады. Кеше тапсырыс шынымен болмаса — нөл болады.',
 'не приход сводк, не присыла сводк, нет сводк, нол, ноль, нули, 0 заказ, не все заказ, неправильн, не совпада, мало заказ, нөл, сәйкес'),
('deadline', 'orders', 40,
 'Что значит «заказ под угрозой просрочки»?', '«Тапсырыс мерзімі өтіп кету қаупінде» деген не?',
 'Kaspi отменяет заказ, если его не собрали вовремя. Бот пишет заранее, сколько минут осталось, — успейте принять и упаковать заказ. Такие сообщения приходят, пока открыт Chrome с расширением.',
 'Тапсырыс уақытында жиналмаса, Kaspi оны болдырмайды. Бот қанша минут қалғанын алдын ала жазады — тапсырысты қабылдап, буып-түюге үлгеріңіз. Мұндай хабарлар кеңейтімі бар Chrome ашық тұрғанда келеді.',
 'просроч, угроз, отмен, осталось минут, дедлайн, срок, мерзім, болдыр, кешік'),
('profit', 'goods', 10,
 'Почему не видно прибыль?', 'Пайда неге көрінбейді?',
 'Прибыль считается, когда указаны себестоимость товара и комиссия Kaspi. Заполните их в разделе «Себестоимость».',
 'Пайда тауардың өзіндік құны мен Kaspi комиссиясы көрсетілгенде есептеледі. Оларды «Өзіндік құн» бөлімінде толтырыңыз.',
 'прибыл, себестоим, комисси, маржа, доход, пайда, өзіндік құн'),
('upload', 'goods', 20,
 'Как выложить товар в несколько магазинов?', 'Тауарды бірнеше дүкенге қалай шығаруға болады?',
 'Раздел «Выгрузка товаров»: сначала загрузите текущий прайс-лист магазина из кабинета Kaspi, затем добавьте товар и отметьте магазины. Цены и остатки Kaspi забирает из прайс-листа раз в час.',
 '«Тауарларды жүктеу» бөлімі: алдымен Kaspi кабинетінен дүкеннің қазіргі прайс-парағын жүктеңіз, содан кейін тауар қосып, дүкендерді белгілеңіз. Kaspi бағалар мен қалдықтарды прайс-парақтан сағатына бір рет алады.',
 'выгруз, выложить, прайс, остатк, цены, цена, товар в, тауар, баға, қалдық, жүкте'),
('staff', 'goods', 30,
 'Как добавить сотрудника-сборщика?', 'Жинаушы қызметкерді қалай қосамын?',
 'Раздел «Сотрудники» → «Пригласить»: укажите имя, почту и магазины. Сборщик входит на компьютере склада (SaudaPulse → «Сотрудник» → «Первый вход») и видит только сборку — без денег, прибыли и настроек.',
 '«Қызметкерлер» бөлімі → «Шақыру»: атын, поштасын және дүкендерді көрсетіңіз. Жинаушы қойма компьютерінде кіреді (SaudaPulse → «Қызметкер» → «Алғаш кіру») және тек жинауды көреді — ақшасыз, пайдасыз және баптауларсыз.',
 'сотрудник, сборщик, склад, работник, доступ сотрудник, пин, pin, қызметкер, жинаушы, қойма'),
('backup', 'goods', 40,
 'Что будет с данными, если переустановить браузер?', 'Браузерді қайта орнатсам, деректер не болады?',
 'Себестоимость, каталог и настройки хранятся в браузере. Сохраните копию: Настройки → «Резервная копия». После переустановки подключите магазины и восстановите копию из файла.',
 'Өзіндік құн, каталог және баптаулар браузерде сақталады. Көшірмесін сақтаңыз: Баптаулар → «Сақтық көшірме». Қайта орнатқаннан кейін дүкендерді қосып, көшірмені файлдан қалпына келтіріңіз.',
 'переустанов, резерв, копи, бэкап, backup, данные пропал, новый компьютер, другой компьютер, сақтық, көшірме, қайта орнат'),
('printer', 'print', 10,
 'Как настроить печать накладных под мой принтер?', 'Жүкқұжаттарды басып шығаруды принтеріме қалай баптаймын?',
 '«Настройки» → «Печать накладных»: выберите свой принтер — термопринтер (и размер этикетки), A4 по одной или A4 по четыре на лист. Нажмите «Пробная печать»: если напечатались все 4 уголка, отрезок ровно 5 см и полоски чёткие — всё настроено. Если нет — в окне печати поставьте масштаб 100 % и поля «Нет». Настройка запоминается на каждом компьютере отдельно.',
 '«Баптаулар» → «Жүкқұжаттарды басып шығару»: принтеріңізді таңдаңыз — термопринтер (және затбелгі өлшемі), A4 параққа біреуден немесе төрттен. «Сынама басып шығару» батырмасын басыңыз: 4 бұрыш басылса, кесінді дәл 5 см және жолақтар анық болса — бәрі дұрыс. Болмаса — басып шығару терезесінде масштабты 100 % және жиектерді «Жоқ» қойыңыз. Баптау әр компьютерде бөлек сақталады.',
 'печат, принтер, накладн, этикет, термо, a4, а4, штрихкод, обрез, мелко, криво, басып шығар, жүкқұжат, затбелгі'),
('pay', 'payment', 10,
 'Как оплатить подписку?', 'Жазылымды қалай төлеуге болады?',
 'Раздел «Подписка»: выберите число магазинов, нажмите «Оплатить по QR» и оплатите в приложении Kaspi. Подписка включится после подтверждения оплаты.',
 '«Жазылым» бөлімі: дүкендер санын таңдап, «QR арқылы төлеу» батырмасын басыңыз да, Kaspi қолданбасында төлеңіз. Жазылым төлем расталғаннан кейін қосылады.',
 'оплат, заплат, qr, кьюар, подписк, продлить, продлен, счет, счёт, төле, жазылым, ұзарт'),
('pay_wait', 'payment', 20,
 'Оплатил, а подписка не включилась', 'Төледім, бірақ жазылым қосылмады',
 'Оплату подтверждаем вручную, обычно в течение пары часов в рабочее время. Чтобы оплата засчитывалась сразу, подтвердите номер, с которого платите: команда /phone в этом боте. Если прошло больше 3 часов — нажмите «Написать в поддержку» и пришлите чек.',
 'Төлемді қолмен растаймыз, әдетте жұмыс уақытында бірнеше сағат ішінде. Төлем бірден есептелуі үшін төлейтін нөміріңізді растаңыз: осы боттағы /phone командасы. 3 сағаттан көп өтсе — «Қолдауға жазу» батырмасын басып, түбіртекті жіберіңіз.',
 'оплатил, оплатила, заплатил, не включ, не активир, не подтверд, деньги ушли, списал, чек, төледім, қосылмады, расталмады, түбіртек'),
('phone', 'payment', 30,
 'Как подтвердить номер для оплаты?', 'Төлем нөмірін қалай растаймын?',
 'Отправьте в этот бот команду /phone и нажмите кнопку «📱 Поделиться номером». Номер подтверждает сам Telegram, и оплата с него будет засчитываться автоматически.',
 'Осы ботқа /phone командасын жіберіп, «📱 Нөмірмен бөлісу» батырмасын басыңыз. Нөмірді Telegram өзі растайды, сонда осы нөмірден төлем автоматты түрде есептеледі.',
 'подтверд номер, номер для оплат, номер телефон, телефон для оплат, phone, нөмірді раста, төлем нөмір, нөмірмен бөлі'),
('price', 'payment', 40,
 'Сколько стоит подписка?', 'Жазылым қанша тұрады?',
 '«Старт» — 1 магазин, 12 000 ₸ в месяц. «Мульти» — до 3 магазинов, 20 000 ₸ в месяц, каждый следующий магазин +5 000 ₸. Первые 14 дней — бесплатно. Точные цены — в разделе «Подписка».',
 '«Старт» — 1 дүкен, айына 12 000 ₸. «Мульти» — 3 дүкенге дейін, айына 20 000 ₸, әр келесі дүкен +5 000 ₸. Алғашқы 14 күн — тегін. Нақты бағалар — «Жазылым» бөлімінде.',
 'сколько стоит, сколько плат, цена подписк, стоимост, тариф, прайс подписк, дорого, скидк, бесплатн, пробн, триал, trial, қанша, тариф, тегін, жеңілдік'),
('cancel', 'payment', 50,
 'Как отменить подписку?', 'Жазылымды қалай тоқтатамын?',
 'Раздел «Подписка» → «Отменить подписку». Доступ сохранится до конца оплаченного периода, данные магазинов останутся — вернуться можно в любой момент. Там же можно вместо отмены заморозить аккаунт: оплаченные дни сохранятся.',
 '«Жазылым» бөлімі → «Жазылымнан бас тарту». Қолжетімділік төленген мерзім соңына дейін сақталады, дүкен деректері қалады — кез келген уақытта қайта оралуға болады. Сол жерде бас тартудың орнына аккаунтты тоқтатып қоюға болады: төленген күндер сақталады.',
 'отмен подписк, отключ подписк, отказ, заморо, вернуть деньг, возврат денег, тоқтат, бас тарт, қайтар'),
('telegram', 'bot', 10,
 'Как подключить Telegram-бота?', 'Telegram-ботты қалай қосамын?',
 'Откройте «Настройки» → карточка «Telegram-уведомления» → «Подключить Telegram» и нажмите «Start» в боте. Если на компьютере нет Telegram — нажмите «OPEN IN WEB» или откройте ссылку на телефоне. Ссылка действует 15 минут: если не успели, нажмите кнопку ещё раз.',
 '«Баптаулар» → «Telegram хабарламалары» картасы → «Telegram қосу» батырмасын басып, боттағы «Start» басыңыз. Компьютерде Telegram болмаса — «OPEN IN WEB» басыңыз немесе сілтемені телефоннан ашыңыз. Сілтеме 15 минут жарамды: үлгермесеңіз, батырманы қайта басыңыз.',
 'подключ бот, подключ телеграм, telegram, телеграм, ссылка устар, бот не, ботты қос, сілтеме'),
('stop', 'bot', 20,
 'Как отключить уведомления?', 'Хабарламаларды қалай өшіремін?',
 'Отправьте /stop — бот перестанет писать. Чтобы выключить только сводку или только срочные сообщения: «Настройки» → «Telegram-уведомления».',
 '/stop жіберіңіз — бот жазуды тоқтатады. Тек қорытындыны немесе тек шұғыл хабарларды өшіру үшін: «Баптаулар» → «Telegram хабарламалары».',
 'отключ уведом, выключ уведом, не присылай, не пиши, отписат, stop, стоп, өшір, тоқтат хабар'),
('phone_app', 'bot', 30,
 'Можно ли работать с телефона?', 'Телефоннан жұмыс істеуге бола ма?',
 'Расширение работает в браузере на компьютере: Chrome, Яндекс.Браузер, Edge, Opera. На телефон приходят сводка и срочные сообщения в этом боте. Версия для телефона готовится.',
 'Кеңейтім компьютердегі браузерде жұмыс істейді: Chrome, Яндекс.Браузер, Edge, Opera. Телефонға осы бот арқылы қорытынды мен шұғыл хабарлар келеді. Телефонға арналған нұсқа дайындалуда.',
 'с телефона, на телефоне, мобил, андроид, android, айфон, iphone, приложени, телефоннан, қолданба')
on conflict (slug) do nothing;

commit;

-- ==================== grants.sql ====================
-- Seller Hub: function, table and Storage privileges, deterministic and idempotent.
-- Apply AFTER restoring a dump (pg_restore --no-owner ...):
--   psql "$TARGET_DB_URL" -f kaspi-seller-hub/billing/supabase/grants.sql
-- Mirrors the grants of migrations 001..032 (verified against a database built from them).
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
  public.admin_bot_questions(text,int),
  public.admin_client_errors(int),
  public.admin_confirm_invoice(bigint,text,int,int),
  public.admin_payment_events(boolean,int),
  public.admin_resolve_payment_event(bigint,text),
  public.set_my_lang(text),
  public.admin_delete_account(uuid,text),
  public.admin_delete_feature_flag(text),
  public.admin_faq(),
  public.admin_faq_delete(int),
  public.admin_faq_save(jsonb),
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
  public.admin_ticket_tg(bigint),
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
  public.enqueue_retention_nudges(), public.payment_received(text,text,int,bigint,text), public.bot_langs(text,uuid[],bigint[]), public.bot_verify_phone(text,bigint,text),
  public.bot_faq(text), public.bot_ask(text,bigint,text,text,int,text), public.bot_feedback(text,bigint,boolean),
  public.bot_ticket_wait(text,bigint,boolean), public.bot_ticket(text,bigint,text)
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

