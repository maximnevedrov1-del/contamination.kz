#!/bin/bash
# Runs every tests/sql/test*.sql on its own fresh database:
#   stub.sql (Supabase auth/storage stand-in) → billing/supabase/001_billing.sql → 002_team.sql → 003_support.sql → the test.
# Connection from the usual PG* variables. Locally: PGHOST=/tmp PGPORT=5499 PGUSER=postgres
# Exit code 1 if any check printed FAIL, a file printed no PASS at all, or the schema failed to load.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
pass=0; fail=0; bad=0
for t in "$HERE"/test*.sql; do
  db="ksh_sqltest_$$"
  dropdb --if-exists "$db" >/dev/null 2>&1; createdb "$db" || exit 2
  psql -q -d "$db" -f "$HERE/stub.sql" >/dev/null 2>&1
  if ! schema_err=$( { psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$ROOT/billing/supabase/001_billing.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$ROOT/billing/supabase/002_team.sql" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$ROOT/billing/supabase/003_support.sql"; } 2>&1 >/dev/null); then
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
