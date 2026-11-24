-- Seller Hub: UX telemetry in one request per batch. Safe to run again. Apply AFTER 026_strict_invoice_and_cleanup.sql
-- and BEFORE releasing the extension version that calls track_ux_events (older versions keep using track_ux_event).
--
-- Before: the extension called track_ux_event once per event and per repeat (up to 5 × 50 = 250 HTTP requests per
-- batch, a batch per minute while the dashboard is in use). Now: one call with the whole batch.
--   p_events: [{"t": event_type, "k": target_key, "s": screen_key, "n": 1..5}, …], at most 50 items.
-- Same rules as track_ux_event: whitelisted types, short keys, at most 100 distinct rows per user.
-- Invalid items are skipped (the rest of the batch still counts); a wrong shape of the whole batch raises.
-- Returns how many items were counted.
begin;

create or replace function public.track_ux_events(p_events jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  rows_now int;
  applied int := 0;
  r record;
  hit int;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 50 then
    raise exception 'invalid_ux_batch' using errcode = '22023';
  end if;
  select count(*) into rows_now from public.ux_events where user_id = uid;

  for r in
    with items as (
      select e->>'t' as t, e->>'k' as k, e->>'s' as s,
             case when jsonb_typeof(e->'n') = 'number' then least(greatest(floor((e->>'n')::numeric)::int, 1), 5) else 1 end as n
        from jsonb_array_elements(p_events) e
       where jsonb_typeof(e) = 'object'
    )
    select t, k, s, least(sum(n), 1000000)::int as n
      from items
     where t in ('screen_view', 'action_click', 'rage_click', 'form_abandoned', 'help_opened')
       and k ~ '^[a-z0-9_:-]{1,64}$' and k !~ '^[0-9]+$'
       and s ~ '^[a-z0-9_:-]{1,64}$' and s !~ '^[0-9]+$'
     group by t, k, s
     order by t, k, s
  loop
    update public.ux_events
       set occurrences = least(occurrences + r.n, 1000000), last_seen_at = now()
     where user_id = uid and event_type = r.t and target_key = r.k and screen_key = r.s;
    get diagnostics hit = row_count;
    if hit > 0 then
      applied := applied + 1;
    elsif rows_now < 100 then
      insert into public.ux_events (user_id, event_type, target_key, screen_key, occurrences)
      values (uid, r.t, r.k, r.s, r.n)
      on conflict (user_id, event_type, target_key, screen_key)
      do update set occurrences = least(public.ux_events.occurrences + r.n, 1000000), last_seen_at = now();
      rows_now := rows_now + 1;
      applied := applied + 1;
    end if;
  end loop;
  return applied;
end $$;

revoke execute on function public.track_ux_events(jsonb) from public, anon, authenticated;
grant execute on function public.track_ux_events(jsonb) to authenticated;

commit;
