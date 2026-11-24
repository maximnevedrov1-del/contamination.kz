\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- 031: the payer phone confirmed in Telegram (bot_verify_phone) lets a phone + amount match confirm automatically
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
create or replace function pg_temp.as_user(id text) returns boolean language sql as $$ select set_config('request.jwt.claim.sub', id, false) is not null $$;
insert into auth.users (id, email) values
  ('e1000000-0000-0000-0000-00000000000a', 'honest@example.kz'),
  ('e1000000-0000-0000-0000-00000000000b', 'attacker@example.kz'),
  ('e1000000-0000-0000-0000-00000000000c', 'nobot@example.kz');
update public.accounts set terms_version = (select terms_version from billing_config);
update public.ops_settings set bot_key_hash = encode(sha256(convert_to('bot-key-0123456789abcdef0123456789abcdef', 'utf8')), 'hex');
insert into public.tg_links (user_id, chat_id, tg_name) values
  ('e1000000-0000-0000-0000-00000000000a', 1001, 'Honest'),
  ('e1000000-0000-0000-0000-00000000000b', 1002, 'Attacker');

-- ===== who may call =====
set role authenticated; select pg_temp.as_user('e1000000-0000-0000-0000-00000000000b');
do $$ begin perform bot_verify_phone('bot-key-0123456789abcdef0123456789abcdef', 1002, '+77015554433'); raise notice 'FAIL seller called bot_verify_phone'; exception when insufficient_privilege then raise notice 'PASS a seller cannot call bot_verify_phone'; end $$;
reset role;
select pg_temp.ok('service_role only', has_function_privilege('service_role', 'public.bot_verify_phone(text,bigint,text)', 'execute') and not has_function_privilege('anon', 'public.bot_verify_phone(text,bigint,text)', 'execute'));

set role service_role;
do $$ begin perform bot_verify_phone('wrong-key-0123456789abcdef0123456789', 1001, '+77015554433'); raise notice 'FAIL wrong bot key'; exception when others then raise notice '% wrong bot key refused', case when sqlerrm = 'bad_key' then 'PASS' else 'FAIL' end; end $$;
select pg_temp.ok('unknown chat → not_linked', (bot_verify_phone('bot-key-0123456789abcdef0123456789abcdef', 999, '+77015554433'))->>'error' = 'not_linked');
select pg_temp.ok('foreign number → invalid_phone', (bot_verify_phone('bot-key-0123456789abcdef0123456789abcdef', 1001, '+12025550100'))->>'error' = 'invalid_phone');
reset role;

-- ===== the honest client: invoice first, then confirms the phone in the bot =====
set role authenticated; select pg_temp.as_user('e1000000-0000-0000-0000-00000000000a');
select id as honest_inv from (select (create_invoice(3, 1)->>'id')::bigint id) x \gset
select pg_temp.ok('licence: phone not confirmed yet', (get_license()->>'phone_verified')::boolean = false);
reset role;
set role service_role;
select pg_temp.ok('Telegram contact → phone confirmed', (bot_verify_phone('bot-key-0123456789abcdef0123456789abcdef', 1001, '+7 701 555 44 33'))->>'phone' = '77015554433');
reset role;
select pg_temp.ok('the open invoice got the confirmed phone', (select phone = '77015554433' from invoices where id = :honest_inv));
set role authenticated; select pg_temp.as_user('e1000000-0000-0000-0000-00000000000a');
select pg_temp.ok('licence: phone confirmed', (get_license()->>'phone_verified')::boolean);
reset role;
set role service_role;
select pg_temp.ok('payment from the confirmed phone, no invoice id → confirmed automatically', (payment_received('aipay', 'v1', 20000, null, '87015554433'))->>'outcome' = 'confirmed');
reset role;
select pg_temp.ok('the honest invoice is paid', (select status = 'paid' from invoices where id = :honest_inv));

-- ===== the attacker types the honest client's phone on their own invoice =====
set role authenticated; select pg_temp.as_user('e1000000-0000-0000-0000-00000000000b');
select create_invoice(3, 1, '+77015554433') is not null;
reset role;
set role service_role;
select pg_temp.ok('payment from that phone → review phone_only (the attacker never confirmed it)', (select r->>'outcome' = 'review' and r->>'reason' = 'phone_only' from (select payment_received('aipay', 'v2', 20000, null, '77015554433') r) x));
-- the attacker confirms their OWN number in the bot: it does not make the typed one count
select pg_temp.ok('attacker confirms own number', (bot_verify_phone('bot-key-0123456789abcdef0123456789abcdef', 1002, '+77029998877'))->>'ok' = 'true');
reset role;
select pg_temp.ok('confirming moved the attacker''s pending invoice to their own number', (select i.phone = '77029998877' from invoices i join accounts a using (user_id) where a.email = 'attacker@example.kz' and i.status = 'pending'));
set role authenticated; select pg_temp.as_user('e1000000-0000-0000-0000-00000000000b');
select create_invoice(3, 1, '+77015554433') is not null;   -- types the victim's phone again
reset role;
set role service_role;
select pg_temp.ok('still review: invoice phone ≠ the account''s confirmed phone', (select r->>'reason' = 'phone_only' from (select payment_received('aipay', 'v3', 20000, null, '77015554433') r) x));
reset role;
select pg_temp.ok('attacker''s invoice never paid', (select count(*) = 0 from invoices i join accounts a using (user_id) where a.email = 'attacker@example.kz' and i.status = 'paid'));

-- ===== a client without the bot: typed phone still goes to review =====
set role authenticated; select pg_temp.as_user('e1000000-0000-0000-0000-00000000000c');
select create_invoice(1, 1, '+77031112233') is not null;
reset role;
set role service_role;
select pg_temp.ok('no confirmed phone → review phone_only', (select r->>'reason' = 'phone_only' from (select payment_received('aipay', 'v4', 12000, null, '77031112233') r) x));
reset role;
