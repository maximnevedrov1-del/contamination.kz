# Что нужно сделать вам — по шагам

Делайте по порядку: каждый следующий шаг опирается на предыдущий. Примерное время указано у каждого шага.

---

## Шаг 1. Влить PR в `main` (2 мин)

1. Откройте https://github.com/maximnevedrov1-del/contamination.kz/pull/2
2. Убедитесь, что все проверки CI зелёные.
3. Нажмите **Merge pull request** → **Confirm merge**.

Пока этого не сделано, сайт показывает старую версию, а бот, алерты и бэкапы не запускаются.

---

## Шаг 2. Добавить секреты в GitHub (10 мин)

GitHub → репозиторий → **Settings → Secrets and variables → Actions → New repository secret**. Добавьте:

| Секрет | Где взять |
|---|---|
| `SUPABASE_URL` | `https://zraktrilvwrfpcbmkqwi.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → `service_role` (secret). Никому не показывайте этот ключ. |
| `SUPABASE_DB_URL` | Supabase → кнопка **Connect** → строка подключения (URI, лучше Session pooler) с вашим паролем БД |
| `BACKUP_PASSPHRASE` | Любая длинная случайная фраза. **Сохраните её у себя**: без неё бэкап не расшифровать. |
| `BOT_KEY` | Админка SaudaPulse → «Состояние» → «Ключ бота» |
| `OPS_KEY` | Админка → «Состояние» → ключ для алертов (ops) |
| `TELEGRAM_BOT_TOKEN` | @BotFather → ваш бот → API Token |
| `TELEGRAM_CHAT_ID` | ID вашего чата, куда приходят алерты. Можно узнать, написав боту @userinfobot. |

Проверка: GitHub → **Actions** → `seller-hub-ops-alert` → **Run workflow**. Должно пройти зелёным, затем то же самое для `seller-hub-db-backup`.

---

## Шаг 3. Секреты Telegram-бота в Supabase (5 мин)

Supabase → **Edge Functions → Secrets**. Проверьте, что заданы:

- `BOT_TOKEN` — токен от @BotFather;
- `BOT_KEY` — тот же ключ, что в шаге 2;
- `WEBHOOK_SECRET` — любая длинная случайная строка.

Если вебхук ещё не подключён, откройте в браузере эту ссылку, подставив свои значения:

```
https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=https://zraktrilvwrfpcbmkqwi.supabase.co/functions/v1/telegram-bot/webhook&secret_token=<WEBHOOK_SECRET>&allowed_updates=%5B%22message%22,%22my_chat_member%22%5D
```

Проверка с вашего компьютера: команда должна вывести `401`.

```bash
curl -s -o /dev/null -w '%{http_code}' -X POST https://zraktrilvwrfpcbmkqwi.supabase.co/functions/v1/telegram-bot -d '{}'
```

---

## Шаг 4. Безопасность Supabase (3 мин)

1. **Authentication → Providers / Settings** → включите **Leaked password protection**.
2. **Database → Backups** → проверьте, включён ли **PITR**. Если тариф позволяет, включите.

---

## Шаг 5. Домен `saudapulse.kz` (30 мин + время на обновление DNS)

1. Купите домен `saudapulse.kz`, если ещё не купили.
2. У регистратора добавьте DNS-записи для GitHub Pages:
   - `A` для `@`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`;
   - `CNAME` для `www` → `maximnevedrov1-del.github.io`.
3. Напишите мне «переведи сайт на saudapulse.kz». Я поменяю `CNAME`, выложу новый сайт из `kaspi-seller-hub/site` и проверю, что открываются `/offer` и `/privacy`.
4. GitHub → **Settings → Pages** → Custom domain `saudapulse.kz` → включите **Enforce HTTPS**.
5. Заведите почту `support@saudapulse.kz`: она указана в расширении и на сайте.

---

## Шаг 6. Публикация в Chrome Web Store (1 час + проверка Google 1–7 дней)

1. Зарегистрируйтесь в https://chrome.google.com/webstore/devconsole. Регистрация стоит $5, платится один раз.
2. **New item** → загрузите `kaspi-seller-hub/dist/saudapulse-chrome-release.zip`. Если его у вас нет, попросите меня: «собери ZIP и пришли».
3. Заполните карточку. Готовые тексты лежат в `kaspi-seller-hub/docs/CHROME-WEB-STORE-SUBMISSION.md`:
   - единственное назначение (single purpose);
   - обоснование каждого разрешения, включая `externally_connectable`;
   - раздел о данных (Privacy practices);
   - ссылка на политику: `https://saudapulse.kz/privacy`. Она должна открываться, поэтому шаг 5 нужно закончить раньше.
4. Добавьте скриншоты 1280×800. Готовые картинки лежат в `kaspi-seller-hub/site/assets/`.
5. Отправьте на проверку.

---

## Шаг 7. После одобрения расширения (5 мин)

1. Скопируйте из Chrome Web Store **ID расширения** (32 буквы) и **ссылку на страницу расширения**.
2. Пришлите их мне. Я заполню `extensionId` и `storeUrl` в `site/site.config.json` и пересоберу сайт. После этого кнопка «Подключить магазин Kaspi за 1 минуту» на сайте будет вести в магазин, а если расширение уже установлено — сразу открывать кабинет.

---

## Шаг 8. Мелочи (по желанию)

- **WhatsApp поддержки:** пришлите номер, я внесу его в расширение и на сайт. Для селлеров это главный канал связи.
- **Проверка бэкапа:** в кабинете откройте «Настройки» → «Экспорт данных (JSON)», затем в другом профиле Chrome сделайте «Импорт из файла». Заказы и себестоимость должны появиться.
- **Оплата:** пока каждый счёт Kaspi Pay вы подтверждаете вручную в админке («Счета» → «Подтвердить»). Делайте это ежедневно, пока клиентов немного.

---

## Короткий чек-лист

- [ ] 1. Влить PR #2
- [ ] 2. Секреты GitHub (8 штук) + ручной запуск ops-alert и db-backup
- [ ] 3. Секреты бота в Supabase + проверка `curl`, должен быть `401`
- [ ] 4. Leaked password protection + PITR
- [ ] 5. Домен `saudapulse.kz` + DNS + почта support@
- [ ] 6. Chrome Web Store: загрузка ZIP и карточка
- [ ] 7. Прислать мне ID и ссылку расширения
- [ ] 8. WhatsApp, проверка бэкапа
