-- 018: бесплатный пробный период 14 дней вместо 30.
-- Меняется только значение по умолчанию для НОВЫХ аккаунтов (handle_new_user / ensure_account
-- читают billing_config.trial_days). Уже созданные аккаунты и их trial_ends_at не трогаем.
-- Миграция идемпотентна.
alter table public.billing_config alter column trial_days set default 14;
update public.billing_config set trial_days = 14 where id = 1 and trial_days = 30;
