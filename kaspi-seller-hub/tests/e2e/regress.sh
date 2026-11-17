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
for t in cattest billtest hack billtest2; do
  fresh
  echo "$t: $(timeout 600 node $t.js 2>&1 | grep -E '^(FAIL|CRASH|ALL|[0-9]+ FAILED)' | cut -c1-220 | tr '\n' ' ')"
done
# API / demo suites use their own copies
rm -rf $S/apicopy && copyext $S/apicopy && sed -i "s#base: 'https://kaspi.kz/shop/api/v2'#base: 'http://localhost:8099/shop/api/v2'#" $S/apicopy/shared/selectors.js
for t in apitest run2 demofile feat uxtest learn photoprint interactive readonly; do
  pkill -f "node mockapi.js"; (node mockapi.js > mock.log 2>&1 &); sleep 1; rm -rf apiprof profile2
  echo "$t: $(timeout 600 node $t.js 2>&1 | grep -E '^(FAIL|CRASH|ALL|[0-9]+ FAILED)' | cut -c1-220 | tr '\n' ' ')"
done
# Release build without cabinet mode (fake but well-formed subscription config; the build refuses an empty one)
rm -rf $S/relcopy && copyext $S/relcopy && python3 - "$S/relcopy/shared/billing-config.js" <<'PY'
import base64, json, sys
p = sys.argv[1]; s = open(p).read()
b = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
s = s.replace("supabaseUrl: ''", "supabaseUrl: 'https://example-project.supabase.co'")
s = s.replace("supabaseAnonKey: ''", "supabaseAnonKey: '%s.%s.sig'" % (b({'alg': 'HS256'}), b({'role': 'anon'})))
s = s.replace("licenseKeys: []", "licenseKeys: [{ kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB', kid: 'k1', alg: 'ES256' }]")
open(p, 'w').write(s)
PY
(cd $S/relcopy && node tools/build-release.mjs >/dev/null) && echo "apionly: $(timeout 300 node apionly.js $S/relcopy/dist/kaspi-seller-hub 2>&1 | grep -E '^(FAIL|CRASH|ALL|[0-9]+ FAILED)' | tr '\n' ' ')"
