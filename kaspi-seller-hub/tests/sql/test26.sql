\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- 029: the client's interface language (set_my_lang, support tickets, bot_langs, whats_new_kk)
create or replace function pg_temp.ok(name text, cond boolean) returns text language sql as $$ select case when cond then 'PASS ' else 'FAIL ' end || name $$;
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'u1@example.kz'),
  ('a0000000-0000-0000-0000-000000000002', 'u2@example.kz'),
  ('b0000000-0000-0000-0000-000000000001', 'boss@example.kz');
insert into public.admins values ('b0000000-0000-0000-0000-000000000001');
insert into public.accounts (user_id, trial_ends_at) values ('a0000000-0000-0000-0000-000000000001', now() + interval '10 days'), ('a0000000-0000-0000-0000-000000000002', now() + interval '10 days') on conflict do nothing;
insert into public.tg_links (user_id, chat_id) values ('a0000000-0000-0000-0000-000000000001', 111), ('a0000000-0000-0000-0000-000000000002', 222);
update public.ops_settings set bot_key_hash = encode(sha256(convert_to(repeat('k', 40), 'utf8')), 'hex') where id = 1;

select pg_temp.ok('default language is Russian', (select bool_and(lang = 'ru') from accounts));

-- ===== set_my_lang =====
set role anon;
do $$ begin perform set_my_lang('kk'); raise notice 'FAIL anon set_my_lang'; exception when insufficient_privilege then raise notice 'PASS anon cannot set a language'; end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select pg_temp.ok('set_my_lang kk', (set_my_lang('KK '))->>'lang' = 'kk');
do $$ begin perform set_my_lang('en'); raise notice 'FAIL en accepted'; exception when others then raise notice '% unknown language rejected', case when sqlerrm = 'invalid_lang' then 'PASS' else 'FAIL' end; end $$;
do $$ begin perform set_my_lang(null); raise notice 'FAIL null accepted'; exception when others then raise notice '% null language rejected', case when sqlerrm = 'invalid_lang' then 'PASS' else 'FAIL' end; end $$;
do $$ begin update accounts set lang = 'kk' where user_id = 'a0000000-0000-0000-0000-000000000002'; raise notice 'FAIL client wrote accounts directly'; exception when insufficient_privilege then raise notice 'PASS client cannot write accounts.lang directly'; end $$;
reset role; set role authenticated; reset request.jwt.claim.sub;
do $$ begin perform set_my_lang('kk'); raise notice 'FAIL anonymous jwt'; exception when others then raise notice '% no user → not_authenticated', case when sqlerrm = 'not_authenticated' then 'PASS' else 'FAIL' end; end $$;
reset role;
select pg_temp.ok('only user 1 switched to kk', (select lang from accounts where user_id = 'a0000000-0000-0000-0000-000000000001') = 'kk' and (select lang from accounts where user_id = 'a0000000-0000-0000-0000-000000000002') = 'ru');
do $$ begin update accounts set lang = 'en' where user_id = 'a0000000-0000-0000-0000-000000000002'; raise notice 'FAIL constraint'; exception when check_violation then raise notice 'PASS table check rejects other languages'; end $$;

-- ===== support tickets remember the language =====
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select ticket_create('orders', 'Тапсырыстар жүктелмейді');
select pg_temp.ok('client view of a ticket has no admin fields', not ((my_tickets())->0 ? 'lang') and not ((my_tickets())->0 ? 'email'));
reset role; set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select ticket_create('orders', 'Заказы не грузятся');
reset role;
select pg_temp.ok('ticket language taken from the account', (select lang from support_tickets where user_id = 'a0000000-0000-0000-0000-000000000001') = 'kk' and (select lang from support_tickets where user_id = 'a0000000-0000-0000-0000-000000000002') = 'ru');
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.ok('admin sees the language of each ticket', (select count(*) from jsonb_array_elements((admin_tickets('all'))->'items') x where (x->>'lang' = 'kk' and x->>'email' = 'u1@example.kz') or (x->>'lang' = 'ru' and x->>'email' = 'u2@example.kz')) = 2);
reset role;
-- a ticket keeps the language it was written in even if the client switches later
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select set_my_lang('ru');
reset role;
select pg_temp.ok('old ticket keeps its language', (select lang from support_tickets where user_id = 'a0000000-0000-0000-0000-000000000001') = 'kk');
set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select set_my_lang('kk');
reset role;

-- ===== whats_new_kk =====
set role authenticated; set request.jwt.claim.sub = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.ok('admin saves whats_new_kk', (admin_growth_settings('{"whats_new_kk":"  Жаңа мүмкіндіктер  "}'))->>'whats_new_kk' = 'Жаңа мүмкіндіктер');
select pg_temp.ok('other settings untouched by that save', (admin_growth_settings('{}')) ? 'whats_new');
reset role; set role authenticated; set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ begin perform admin_growth_settings('{"whats_new_kk":"x"}'); raise notice 'FAIL client changed settings'; exception when others then raise notice '% client cannot change settings', case when sqlerrm = 'forbidden' then 'PASS' else 'FAIL' end; end $$;
reset role;

-- ===== bot_langs =====
set role authenticated;
do $$ begin perform bot_langs(repeat('k', 40)); raise notice 'FAIL authenticated bot_langs'; exception when insufficient_privilege then raise notice 'PASS client cannot call bot_langs'; end $$;
reset role;
set role service_role;
do $$ begin perform bot_langs('wrong-key-wrong-key-wrong-key-wrong'); raise notice 'FAIL bad key'; exception when others then raise notice '% bad bot key rejected', case when sqlerrm = 'bad_key' then 'PASS' else 'FAIL' end; end $$;
select pg_temp.ok('languages by user', (select r->'users' = '{"a0000000-0000-0000-0000-000000000001":"kk","a0000000-0000-0000-0000-000000000002":"ru"}'::jsonb from (select bot_langs(repeat('k', 40), array['a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002']::uuid[]) r) x));
select pg_temp.ok('languages by chat', (select r->'chats' = '{"111":"kk","222":"ru"}'::jsonb from (select bot_langs(repeat('k', 40), null, array[111, 222, 999]::bigint[]) r) x));
select pg_temp.ok('Kazakh what''s new passed to the bot', (bot_langs(repeat('k', 40)))->>'whats_new_kk' = 'Жаңа мүмкіндіктер');
select pg_temp.ok('nothing asked → empty maps', (select r->'users' = '{}'::jsonb and r->'chats' = '{}'::jsonb from (select bot_langs(repeat('k', 40)) r) x));
reset role;
