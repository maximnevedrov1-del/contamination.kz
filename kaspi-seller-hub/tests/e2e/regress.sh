#!/bin/bash
# Full browser regression: each suite on a fresh DB + fresh mocks + fresh test copy.
S="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$(cd "$S/.." && pwd)"
copyext() { mkdir -p "$1" && tar -C "$SRC" --exclude=./tests --exclude=./dist -cf - . | tar -C "$1" -xf -; }  # the extension without tests/ and dist/
cd $S/e2e
# the container may have restarted: make sure PostgreSQL is up
psql -h /tmp -p 5499 -U postgres -Atc 'select 1' >/dev/null 2>&1 || su pgt -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -o '-p 5499 -k /tmp' -l /tmp/pg.log start" >/dev/null; sleep 2
fresh() {
  $S/e2e/resetdb.sh >/dev/null 2>&1
  pkill -f "node mockapi.js"; (node mockapi.js > mock.log 2>&1 &); sleep 1
  $S/e2e/mkbillcopy.sh >/dev/null
  rm -rf billprof bill2prof profile2 apiprof featprof
}
# A suite passes only with exit code 0 AND «ALL PASS» in its output (older suites print FAIL
# without setting the exit code, so both are required). Summary and exit code at the end.
FAILED=()
run() { # name, command…
  local name="$1"; shift
  local out code
  out=$(timeout 600 "$@" 2>&1); code=$?
  local summary
  summary=$(printf '%s\n' "$out" | grep -E '^(FAIL|CRASH|ALL|[0-9]+ FAILED)' | cut -c1-220 | tr '\n' ' ')
  if [ $code -eq 0 ] && printf '%s\n' "$out" | grep -q '^ALL PASS'; then echo "$name: PASS (exit 0) $summary"
  else echo "$name: FAIL (exit $code) $summary"; FAILED+=("$name"); fi
}
for t in cattest billtest hack billtest2 team support insights orchestra growth telegram; do
  fresh
  run "$t" node $t.js
done
# API / demo suites use their own copies
rm -rf $S/apicopy && copyext $S/apicopy && sed -i "s#base: 'https://kaspi.kz/shop/api/v2'#base: 'http://localhost:8099/shop/api/v2'#" $S/apicopy/shared/selectors.js
for t in apitest run2 demofile feat uxtest learn photoprint interactive readonly onboard; do
  pkill -f "node mockapi.js"; (node mockapi.js > mock.log 2>&1 &); sleep 1; rm -rf apiprof profile2
  run "$t" node $t.js
done
# Release build (API-only, as shipped) of an isolated copy with a made-up valid config: mkrelcopy.sh.
# apionly.js checks the build untouched; apionly-sync.js syncs with the same build pointed at the mocks.
fresh
if $S/e2e/mkrelcopy.sh >/dev/null; then
  run apionly node apionly.js $S/relcopy/dist/kaspi-seller-hub
  pkill -f "node mockapi.js"; (node mockapi.js > mock.log 2>&1 &); sleep 1
  run apionly-sync node apionly-sync.js $S/relmock
else
  echo "release build: FAIL (mkrelcopy.sh)"; FAILED+=(release-build)
fi
echo "---"
if [ ${#FAILED[@]} -eq 0 ]; then echo "REGRESSION: ALL SUITES PASS"; exit 0; fi
echo "REGRESSION: ${#FAILED[@]} FAILED: ${FAILED[*]}"; exit 1
