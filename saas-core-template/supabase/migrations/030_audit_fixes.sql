-- SaaS core: fixes from SECURITY-AUDIT-2026-11-24.md. Safe to run again.
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
