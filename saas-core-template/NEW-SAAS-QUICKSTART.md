# New SaaS quickstart (checklist)

Details: [README.md](README.md).

- [ ] Copy the template: `git archive saas-core-v1.0.0 saas-core-template | tar -x` (or `cp -r saas-core-template ...`), then `cd saas-core-template`.
- [ ] `cp saas.config.example.json saas.config.json` and fill in all keys (`SUPABASE_ANON_KEY` and `LICENSE_PUBLIC_JWK` may stay empty at first).
- [ ] Dry run: `node scripts/init-new-saas.mjs --dry-run --config saas.config.json` (expect `unreplaced tokens: none`).
- [ ] Generate: `node scripts/init-new-saas.mjs --config saas.config.json --out ../<APP_SLUG>`; `git init` the output as the new repo.
- [ ] Create a Supabase project; put its ref into `SUPABASE_PROJECT_ID` and the anon key into `SUPABASE_ANON_KEY`, re-run init if you changed the config.
- [ ] Apply `supabase/migrations/001` -> `028` in order (SQL Editor, `supabase db push`, or `psql "$DB_URL" -f ...`), then `supabase/grants.sql` last.
- [ ] Make yourself admin: `insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';`.
- [ ] Add GitHub secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` (user `postgres.<project-ref>`, session pooler), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `BACKUP_PASSPHRASE` (backup encryption key, store a copy outside GitHub), `OPS_KEY` (only for ops-alert).
- [ ] `mkdir -p .github/workflows && cp github-workflows/*.yml .github/workflows/` in the new repo (`ops-alert.yml` also needs your own `tools/ops-alert.mjs`; skip it otherwise).
- [ ] Deploy the bot: `supabase functions deploy telegram-bot --no-verify-jwt`, set its secrets, then set the Telegram webhook to the function URL.
- [ ] Paste the project's public ES256 JWK into `LICENSE_PUBLIC_JWK` (production licensing).
- [ ] Host `admin/` as a static site.
- [ ] Run tests: `PGHOST=... PGUSER=postgres npm run test:sql` (scratch PostgreSQL) and `npm test`; both must show 0 failures.
- [ ] Trigger both workflows manually (`workflow_dispatch`) once and confirm the Telegram message / backup artifact.
