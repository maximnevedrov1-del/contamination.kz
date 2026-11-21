\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- Telegram bot: only one run at a time (008_bot_lock.sql); the lease expires after a crash.
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
update public.ops_settings set bot_key_hash = encode(sha256(convert_to('bot-key-0123456789abcdef0123456789abcdef', 'utf8')), 'hex');
\set K '''bot-key-0123456789abcdef0123456789abcdef'''

set role anon;
select pg_temp.ok('first run takes the lock', bot_lock(:K, 'run-aaaaaaaa', 120));
select pg_temp.ok('a second run at the same time is refused', not bot_lock(:K, 'run-bbbbbbbb', 120));
select pg_temp.ok('the holder may renew its lease', bot_lock(:K, 'run-aaaaaaaa', 120));
select bot_unlock(:K, 'run-bbbbbbbb');
select pg_temp.ok('another run cannot free the lock', not bot_lock(:K, 'run-bbbbbbbb', 120));
select bot_unlock(:K, 'run-aaaaaaaa');
select pg_temp.ok('after unlock the next run takes it', bot_lock(:K, 'run-bbbbbbbb', 120));
do $$ begin perform bot_lock('wrong-key-0123456789abcdef0123456789', 'run-cccccccc', 120); raise notice 'FAIL wrong key refused';
exception when others then raise notice 'PASS wrong key refused'; end $$;
do $$ begin perform bot_lock('bot-key-0123456789abcdef0123456789abcdef', 'x', 120); raise notice 'FAIL too short holder refused';
exception when others then raise notice 'PASS too short holder refused'; end $$;
do $$ begin perform 1 from public.bot_run_lock; raise notice 'FAIL lock table hidden from anon';
exception when insufficient_privilege then raise notice 'PASS lock table hidden from anon'; end $$;
reset role;
-- a crashed run: its lease ran out
update public.bot_run_lock set until = now() - interval '1 second';
set role anon;
select pg_temp.ok('an expired lease is taken over', bot_lock(:K, 'run-cccccccc', 120));
reset role;
select pg_temp.ok('ttl is capped at 10 minutes', (select until <= now() + interval '600 seconds' from public.bot_run_lock)
  and (select bot_lock(:K, 'run-cccccccc', 99999)) and (select until <= now() + interval '600 seconds' from public.bot_run_lock));
