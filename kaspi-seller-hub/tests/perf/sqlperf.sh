#!/bin/bash
# Server timing at scale: seeds tests/perf/seed.sql into a fresh database with the real schema
# (001–004) and times every API function the extension and the admin page call.
# Locally: PGHOST=/tmp PGPORT=5499 PGUSER=postgres bash tests/perf/sqlperf.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
DB=ksh_perf
dropdb --if-exists $DB >/dev/null 2>&1; createdb $DB
psql -q -d $DB -f "$ROOT/tests/sql/stub.sql" >/dev/null 2>&1
for f in 001_billing 002_team 003_support 004_insights 005_growth 006_indexes; do psql -q -v ON_ERROR_STOP=1 -d $DB -f "$ROOT/billing/supabase/$f.sql" >/dev/null || exit 2; done
psql -q -d $DB -c "insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000aa', 'admin@example.kz'); insert into admins values ('00000000-0000-0000-0000-0000000000aa'); update ops_settings set key_hash = encode(sha256(convert_to('perf-key-0123456789abcdef0123456789abcdef', 'utf8')), 'hex');" >/dev/null
t0=$(date +%s); psql -q -d $DB -f "$HERE/seed.sql" >/dev/null; echo "seeded in $(( $(date +%s) - t0 )) s: $(psql -Atd $DB -c "select (select count(*) from accounts) || ' accounts, ' || (select count(*) from usage_daily) || ' usage days, ' || (select count(*) from api_health) || ' health rows, ' || (select count(*) from support_tickets) || ' tickets, ' || (select count(*) from invoices) || ' invoices'")"
SELLER=$(psql -Atd $DB -c "select user_id from accounts where email = 'p1@example.kz'")
run() { # name, role/user, sql  → median of 5 runs, ms
  local name="$1" uid="$2" sql="$3" ms=()
  for i in 1 2 3 4 5; do
    ms+=("$(psql -Atd $DB -c "select set_config('request.jwt.claim.sub', '$uid', false);" -c "set role authenticated;" -c "\\timing on" -c "$sql" 2>&1 | grep -oP 'Time: \K[0-9.]+' | tail -1)")
  done
  printf '%-34s %8s ms\n' "$name" "$(printf '%s\n' "${ms[@]}" | sort -n | sed -n 3p)"
}
ADMIN=00000000-0000-0000-0000-0000000000aa
echo "--- seller (every few minutes, from each extension) ---"
run "get_license" $SELLER "select get_license(3, null)"
run "usage_report" $SELLER "select usage_report('{\"store\":true}', jsonb_build_array(jsonb_build_object('day', current_date, 'sections', '{\"orders\":3}'::jsonb)))"
run "health_report" $SELLER "select health_report('[{\"market\":\"kaspi\",\"ok\":10,\"fail\":1,\"kinds\":{\"server\":1}}]')"
run "my_tickets" $SELLER "select my_tickets()"
run "feedback_due" $SELLER "select feedback_due()"
run "get_service_status" $SELLER "select get_service_status()"
echo "--- scheduled job (every 10 minutes) ---"
run "ops_digest" $SELLER "select ops_digest('perf-key-0123456789abcdef0123456789abcdef')"
echo "--- admin page ---"
run "admin_invoices (pending)" $ADMIN "select admin_invoices('pending', null, 100, 0)"
run "admin_accounts" $ADMIN "select admin_accounts(null, 'all', 100, 0)"
run "admin_tickets (open)" $ADMIN "select admin_tickets('open', null, 100, 0)"
run "admin_tickets (search)" $ADMIN "select admin_tickets('all', 'p77', 100, 0)"
run "admin_health (24 h)" $ADMIN "select admin_health(24)"
run "admin_insights (30 days)" $ADMIN "select admin_insights(30)"
run "admin_insights (365 days)" $ADMIN "select admin_insights(365)"
[ -n "${KEEP:-}" ] || dropdb $DB
