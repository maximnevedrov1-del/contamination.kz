-- SaaS core: Telegram bot sends in batches. Safe to run again. Run after 006_indexes.sql.
-- bot_jobs returned every due message at once: with many users one run outlived the function's
-- time limit and the caller's timeout, nothing was recorded and the next run sent it all again.
-- Now at most `batch` items per call; the bot records results every 50 messages and calls
-- again while a full batch came back (functions/telegram-bot/bot.js, run()).

create or replace function public.bot_jobs(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare batch constant int := 300; c public.billing_config; yday date := (now() at time zone 'Asia/Almaty')::date - 1; r jsonb;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  select * into c from public.billing_config where id = 1;
  -- the win-back offer is granted when it is sent (valid 30 days)
  with due as (
    select l.user_id, l.chat_id, l.digest, coalesce(l.tg_name, '') name, a acc, p.last_active_at, ds.stats, ds.reported_at,
           greatest(a.trial_ends_at, coalesce(a.paid_until, a.trial_ends_at)) ended,
           coalesce(a.frozen_until, '-infinity') < now() not_frozen
    from public.tg_links l join public.accounts a using (user_id)
    left join public.user_progress p using (user_id)
    left join public.digest_stats ds on ds.user_id = l.user_id and ds.day = yday
    where l.blocked_at is null
  ), items as (
    select user_id, chat_id, 'morning' kind, yday::text key,
           jsonb_build_object('name', name, 'day', yday, 'stats', stats, 'as_of', reported_at) data
      from due where digest and public.has_access_of(user_id) and stats is not null
    union all
    select user_id, chat_id, 'care', to_char(now(), 'IYYY-IW'), jsonb_build_object('name', name)
      from due where (acc).paid_until > now() and not_frozen
       and coalesce(last_active_at, (acc).last_seen_at, (acc).created_at) < now() - interval '6 days'
       and not exists (select 1 from public.tg_sent s where s.user_id = due.user_id and s.kind = 'care' and s.sent_at > now() - interval '14 days')
    union all
    select user_id, chat_id, 'grace', (now() at time zone 'Asia/Almaty')::date::text,
           jsonb_build_object('name', name, 'until', public.grace_until(acc), 'days_left', ceil(extract(epoch from public.grace_until(acc) - now()) / 86400))
      from due where (acc).paid_until <= now() and public.grace_until(acc) > now()
    union all
    select user_id, chat_id, 'winback30', ended::date::text, jsonb_build_object('name', name, 'whats_new', c.whats_new)
      from due where ended between now() - interval '45 days' and now() - interval '30 days' and not_frozen and c.whats_new is not null
    union all
    select user_id, chat_id, 'winback60', ended::date::text, jsonb_build_object('name', name, 'pct', 50)
      from due where ended between now() - interval '75 days' and now() - interval '60 days' and not_frozen
  )
  select coalesce(jsonb_agg(jsonb_build_object('user_id', i.user_id, 'chat_id', i.chat_id, 'kind', i.kind, 'key', i.key, 'data', i.data)), '[]')
    into r
  from (
    select * from items i
    where not exists (select 1 from public.tg_sent s where s.user_id = i.user_id and s.kind = i.kind and s.key = i.key)
    -- time-sensitive first: the morning digest, then the grace warning
    order by case i.kind when 'morning' then 0 when 'grace' then 1 else 2 end, i.user_id
    limit batch
  ) i;
  return jsonb_build_object('items', r, 'batch', batch, 'app_url', c.app_url, 'support_url', c.support_url);
end $$;
