#!/bin/bash
# Fresh test database "billing" (real 001_billing.sql on local PostgreSQL) + fresh mock Supabase.
E="$(cd "$(dirname "$0")" && pwd)"; T="$(cd "$E/.." && pwd)"; SRC="$(cd "$T/.." && pwd)"
P="psql -h /tmp -p 5499 -U postgres -q"
$P -c "drop database if exists billing with (force)" -c "create database billing" 2>/dev/null
$P -d billing -f "$T/sql/stub.sql" >/dev/null 2>&1
# every migration in order (017 revokes the anon bot RPCs: the bot then needs the service_role key)
for f in "$SRC"/billing/supabase/[0-9][0-9][0-9]_*.sql; do $P -d billing -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 || { echo "migration failed: $f" >&2; break; }; done
$P -d billing -c "insert into auth.users(email) values ('owner@example.kz'); insert into public.admins select id from auth.users where email='owner@example.kz';" >/dev/null
pkill -f "node mocksupa.js"; cd "$E" && (node mocksupa.js > supa.log 2>&1 &); sleep 1.5
