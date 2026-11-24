# Готовность релиза — 2026-11-22

**Вердикт: GO** (условие: применить миграции 019→022 в `kaspi-seller-hub` до запуска).

## 1. SQL (`tests/sql/run.sh`, цепочка миграций 001–022)
| Файл | PASS | FAIL |
|---|---|---|
| test1 (`test.sql`) | 34 | 0 |
| test2 | 26 | 0 |
| test3 | 17 | 0 |
| test4 | 23 | 0 |
| test5 | 10 | 0 |
| test6 | 17 | 0 |
| test7 | 29 | 0 |
| test8 | 41 | 0 |
| test9 | 28 | 0 |
| test10 | 48 | 0 |
| test11 | 13 | 0 |
| test12 | 11 | 0 |
| test13 | 21 | 0 |
| test14 | 25 | 0 |
| test15 | 14 | 0 |
| test16 | 21 | 0 |
| test17 | 11 | 0 |
| test18 | 6 | 0 |
| test19 (022, воронка) | 13 | 0 |
| **Итого** | **408** | **0** |

## 2. Unit-тесты (10 наборов)
| Набор | Результат |
|---|---|
| robust | 38/38 ✅ |
| locales | 1133 ключа ✅ |
| storage-split | 16 ✅ |
| token-crypto | 7 ✅ |
| license-signature | 11 ✅ |
| license-flow | 26 ✅ |
| bot-run | 9 ✅ |
| feature-flags | ok ✅ |
| notices | ok ✅ |
| backup | 8 ✅ (вкл. атомарный откат) |

## 3. Браузерные E2E (`tests/e2e/regress.sh`, Chromium, офлайн)
| Прогон | ALL PASS | FAIL/CRASH |
|---|---|---|
| До стабилизации | 0 из 5 отработавших | 5 (таймауты, `ERR_TUNNEL_CONNECTION_FAILED`) |
| Промежуточный | 16/21 | 5 |
| **Финальный** | **21/21** | **0** (exit=0) |

Наборы: cattest, billtest, hack, billtest2, team, support, insights, orchestra, growth, telegram, apitest, run2, demofile, feat, uxtest, learn, photoprint, interactive, readonly, onboard, apionly.

| Причина сбоя | Исправление (только `tests/e2e/*`) |
|---|---|
| Копии расширения ходили в боевой Supabase/saudapulse.kz → прокси блокировал | `offline.js`: saudapulse.kz → локальный `site/`, прочие внешние хосты — мгновенный abort; `--no-sandbox`, `--disable-dev-shm-usage`; `mkbillcopy.sh` → мок 8098 |
| `resetdb.sh` грузил только 001–008 | грузит все миграции |
| Нет `service_role` в моке (бот, ops-дайджест) | ключ сервиса в `mocksupa.js` |
| Кэш статуса сервиса 5 мин | сброс кэша в `support.js` |
| Триал 14 дней / грейс 4 дня | ожидания тестов обновлены |
| relcopy внутри `tests/` отфильтрован сборкой | сборка в `/tmp/kaspi-relcopy` |

Код продукта при стабилизации не менялся.

## 4. Релиз
| Параметр | Значение |
|---|---|
| `dist/kaspi-seller-hub-0.1.0.zip` | **1 807 555 байт**, `unzip -t`: без ошибок |
| Ветка | `claude/magical-maxwell-6yq76b` |
| Последний коммит кода/тестов | `043e7c3` (хэш коммита с этим отчётом — в ответе терминала) |

## 5. Миграции на завтра (проект `kaspi-seller-hub`, `zraktrilvwrfpcbmkqwi`)
| # | Файл |
|---|---|
| 1 | `019_referral_program.sql` |
| 2 | `020_security_hardening_fixes.sql` |
| 3 | `021_admin_referral_info.sql` |
| 4 | `022_product_funnel_events.sql` |

Проект `lfadrqgwkjdxkmolhnwi` не трогать. Сегодня в Supabase ничего не применялось.
