-- Seller Hub: one Telegram bot run at a time. Safe to run again. Run after 007_bot_batch.sql.
-- Two runs at once (a cron retry while the first is still sending, a manual call) both got the
-- same bot_jobs batch before either recorded it, and sellers received every message twice.
-- bot_lock() takes a lease for `p_ttl` seconds; a crashed run never frees it, so it simply
-- expires. The same holder may take it again (renew). functions/telegram-bot/bot.js, run().

create table if not exists public.bot_run_lock (
  id int primary key default 1 check (id = 1),
  holder text not null,
  until timestamptz not null
);
alter table public.bot_run_lock enable row level security;
revoke all on public.bot_run_lock from public, anon, authenticated;

create or replace function public.bot_lock(p_key text, p_holder text, p_ttl int default 120)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  if coalesce(length(p_holder), 0) not between 8 and 64 then raise exception 'bad_holder'; end if;
  -- the row lock taken by on conflict makes two simultaneous calls wait for each other: one wins
  insert into public.bot_run_lock as l (id, holder, until)
  values (1, p_holder, now() + make_interval(secs => least(greatest(coalesce(p_ttl, 120), 30), 600)))
  on conflict (id) do update set holder = excluded.holder, until = excluded.until
    where l.until < now() or l.holder = excluded.holder
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function public.bot_unlock(p_key text, p_holder text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  delete from public.bot_run_lock where id = 1 and holder = p_holder;
end $$;

revoke execute on function public.bot_lock(text, text, int), public.bot_unlock(text, text) from public, anon, authenticated;
grant execute on function public.bot_lock(text, text, int), public.bot_unlock(text, text) to anon, authenticated;
