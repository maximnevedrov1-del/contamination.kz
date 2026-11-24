-- 011_security_hardening.sql  (applied to {{APP_SLUG}} 2026-11-21)
-- Run after 010_advisor_fixes.sql.
-- Security hardening (2026-11-21):
--  1. bot_key_ok(): constant-shape key check against ops_settings.bot_key_hash (length >= 32, sha256 hex).
--  2. ops_digest(): verify the key BEFORE taking the row lock (for update). A caller with a wrong key
--     could previously queue on the ops_settings row lock; now bad keys are rejected (after the 0.5 s
--     delay) without ever locking the row.
--  3. Privileges re-asserted: bot_key_ok is postgres-only; ops_digest is executable by anon, authenticated.
begin;

create or replace function public.bot_key_ok(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_key is not null and length(p_key) >= 32
    and encode(sha256(convert_to(p_key, 'utf8')), 'hex') = (select bot_key_hash from public.ops_settings where id = 1), false);
$$;

create or replace function public.ops_digest(p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.ops_settings; kh text; w jsonb; e jsonb; alerts jsonb := '[]'; recovered jsonb := '[]'; down jsonb; since timestamptz;
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
  update public.ops_settings set last_digest_at = now(), alerted = down where id = 1;
  return jsonb_build_object(
    'alerts', alerts,
    'recovered', recovered,
    'new_tickets', (select count(*) from public.support_tickets where created_at > since),
    'open_tickets', (select count(*) from public.support_tickets where status = 'open'),
    'new_invoices', (select count(*) from public.invoices where created_at > since and status = 'pending'),
    'pending_invoices', (select count(*) from public.invoices where status = 'pending'),
    'pending_sum', (select coalesce(sum(amount), 0) from public.invoices where status = 'pending'));
end
$$;

revoke all on function public.bot_key_ok(text) from public, anon, authenticated;
revoke all on function public.ops_digest(text) from public;
grant execute on function public.ops_digest(text) to anon, authenticated;

commit;
