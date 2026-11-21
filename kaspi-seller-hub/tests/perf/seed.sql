-- Scale data for the server timing check (tests/perf/sqlperf.sh): ~2 years of a large business.
-- 10 000 sellers, ~1 000 000 usage days, 300 000 API-health rows, 20 000 tickets, 50 000 invoices.
\timing off
set client_min_messages = warning;
insert into auth.users (id, email) select gen_random_uuid(), 'p' || g || '@example.kz' from generate_series(1, 10000) g;
update accounts set created_at = now() - ((random() * 700)::int || ' days')::interval,
                    trial_ends_at = now() - ((random() * 600)::int - 30 || ' days')::interval,
                    paid_until = case when random() < .4 then now() + ((random() * 60)::int || ' days')::interval end,
                    last_seen_at = now() - ((random() * 30)::int || ' days')::interval
  where email like 'p%@example.kz';
insert into user_progress (user_id, steps, last_active_at, first_seen_at)
select user_id, jsonb_build_object('store', now() - interval '100 days') || case when random() < .6 then jsonb_build_object('orders', now() - interval '99 days', 'print', now() - interval '90 days') else '{}' end,
       now() - ((random() * 30)::int || ' days')::interval, created_at
from accounts where email like 'p%@example.kz';
-- ~100 active days per seller in the last 400 days
insert into usage_daily (user_id, day, sections, actions)
select a.user_id, current_date - (random() * 400)::int,
       '{"orders": 9, "home": 3, "settings": 1, "analytics": 1}', '{"accept": 5, "pack": 4, "print": 3, "sync": 6}'
from accounts a, generate_series(1, 100) g where a.email like 'p%@example.kz'
on conflict do nothing;
insert into api_health (bucket, user_id, market, ok, fail, kinds)
select date_trunc('hour', now()) - (g || ' hours')::interval, a.user_id, 'kaspi', 40, 1, '{"server": 1}'
from (select user_id from accounts where email like 'p%@example.kz' limit 900) a, generate_series(0, 335) g
on conflict do nothing;
insert into support_tickets (user_id, email, topic, message, report, status, reply, created_at)
select a.user_id, a.email, 'orders', 'Вопрос номер ' || g, repeat('отчёт ', 200), (array['open','answered','closed'])[1 + (g % 3)], case when g % 3 > 0 then 'ответ' end, now() - ((g % 700) || ' days')::interval
from (select user_id, email, row_number() over () rn from accounts where email like 'p%@example.kz') a, generate_series(1, 2) g where a.rn <= 10000;
insert into invoices (user_id, kind, stores, months, amount, status, phone, created_at)
select a.user_id, 'manual', 3, 1, 20000, (array['paid','paid','paid','pending','cancelled'])[1 + (g % 5)], '77011234567', now() - ((g * 13 % 700) || ' days')::interval
from (select user_id from accounts where email like 'p%@example.kz') a, generate_series(1, 5) g;
insert into feedback (user_id, kind, score, comment)
select user_id, 'nps', (random() * 10)::int, case when random() < .3 then 'комментарий' end from accounts where email like 'p%@example.kz' and random() < .3;
analyze;
