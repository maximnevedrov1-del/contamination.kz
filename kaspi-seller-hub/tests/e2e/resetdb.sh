#!/bin/bash
# Fresh test database "billing" (real 001_billing.sql on local PostgreSQL) + fresh mock Supabase.
E="$(cd "$(dirname "$0")" && pwd)"; T="$(cd "$E/.." && pwd)"; SRC="$(cd "$T/.." && pwd)"
P="psql -h /tmp -p 5499 -U postgres -q"
$P -c "drop database if exists billing with (force)" -c "create database billing" 2>/dev/null
$P -d billing -f "$T/sql/stub.sql" >/dev/null 2>&1
$P -d billing -v ON_ERROR_STOP=1 -f "$SRC/billing/supabase/001_billing.sql" >/dev/null 2>&1 && $P -d billing -v ON_ERROR_STOP=1 -f "$SRC/billing/supabase/002_team.sql" >/dev/null 2>&1 && $P -d billing -v ON_ERROR_STOP=1 -f "$SRC/billing/supabase/003_support.sql" >/dev/null 2>&1 && $P -d billing -v ON_ERROR_STOP=1 -f "$SRC/billing/supabase/004_insights.sql" >/dev/null 2>&1 && $P -d billing -v ON_ERROR_STOP=1 -f "$SRC/billing/supabase/005_growth.sql" >/dev/null 2>&1 && $P -d billing -c "insert into auth.users(email) values ('owner@example.kz'); insert into public.admins select id from auth.users where email='owner@example.kz';" >/dev/null
pkill -f "node mocksupa.js"; cd "$E" && (node mocksupa.js > supa.log 2>&1 &); sleep 1.5
