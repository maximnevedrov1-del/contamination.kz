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
