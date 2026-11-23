#!/bin/bash
# Runs every tests/sql/test*.sql on its own fresh database:
#   stub.sql (Supabase auth/storage stand-in) → supabase/migrations/001_billing.sql → 002_team.sql → 003_support.sql → 004_insights.sql → 005_growth.sql → 006_indexes.sql → 007_bot_batch.sql → 008_bot_lock.sql → 009…025 → the test.
# Connection from the usual PG* variables. Locally: PGHOST=/tmp PGPORT=5499 PGUSER=postgres
# Exit code 1 if any check printed FAIL, a file printed no PASS at all, or the schema failed to load.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# The raw template's migrations hold a TRIAL_DAYS double-brace token (replaced by scripts/init-new-saas.mjs); render it here so the template itself is testable.
TOK='{''{TRIAL_DAYS}''}'
MIG="$(mktemp -d)"; trap 'rm -rf "$MIG"' EXIT
for f in "$ROOT"/supabase/migrations/*.sql; do sed "s/$TOK/${TRIAL_DAYS:-14}/g" "$f" > "$MIG/$(basename "$f")"; done
pass=0; fail=0; bad=0
for t in "$HERE"/test*.sql; do
  db="app_sqltest_$$"
  dropdb --if-exists "$db" >/dev/null 2>&1; createdb "$db" || exit 2
  psql -q -d "$db" -f "$HERE/stub.sql" >/dev/null 2>&1
  if ! schema_err=$( { psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/001_billing.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/002_team.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/003_support.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/004_insights.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/005_growth.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/006_indexes.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/007_bot_batch.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/008_bot_lock.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/009_billing_revoke_fix.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/010_advisor_fixes.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/011_security_hardening.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/012_trial_and_rate_hardening.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/013_account_sharing.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/014_retention_and_deletion.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/015_feature_flags.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/016_system_banner.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/017_revoke_anon_bot_ops.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/018_trial_14_days.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/019_referral_program.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/020_security_hardening_fixes.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/021_admin_referral_info.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/022_product_funnel_events.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/023_client_errors_and_retention.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/024_ux_behavior_telemetry.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/025_audit_hardening_f1_f2.sql"; } 2>&1 >/dev/null); then
    echo "SCHEMA FAILED before $(basename "$t"): $schema_err" | head -5; bad=$((bad + 1))
  fi
  out=$(psql -d "$db" -f "$t" 2>&1)
  p=$(grep -o 'PASS' <<<"$out" | wc -l); f=$(grep -c 'FAIL' <<<"$out")
  echo "$(basename "$t"): $p passed, $f failed"
  grep 'FAIL' <<<"$out" | sed 's/^/   /'
  [ "$p" -eq 0 ] && { echo "   no checks ran"; bad=$((bad + 1)); }
  # a broken statement prints ERROR and its check silently never runs: count that as a failure
  # (expected refusals are caught inside DO blocks and print PASS/FAIL notices, not ERROR)
  errs=$(grep -c 'ERROR:' <<<"$out")
  [ "$errs" -gt 0 ] && { echo "   $errs SQL error(s):"; grep 'ERROR:' <<<"$out" | head -3 | sed 's/^/     /'; bad=$((bad + 1)); }
  pass=$((pass + p)); fail=$((fail + f))
  dropdb "$db" >/dev/null 2>&1
done
echo "SQL: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && [ "$bad" -eq 0 ]
