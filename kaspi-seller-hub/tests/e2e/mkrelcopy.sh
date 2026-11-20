#!/bin/bash
# The REAL release build (tools/build-release.mjs, API-only: no cabinet, no content scripts, no
# scripting permission) of an isolated copy, then a copy of that build pointed at the local mocks.
#   tests/relcopy/                       copy of the source with a made-up but valid release config
#   tests/relcopy/dist/kaspi-seller-hub  the build as it would ship (apionly.js checks it untouched)
#   tests/relmock/                       the same build; ONLY the Kaspi and Supabase addresses (code,
#                                        host permissions, CSP connect-src) changed to localhost mocks
# Needs mock Supabase on :8098 (its signing key goes into the build). The source tree is not changed.
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$(cd "$S/.." && pwd)"
JWK=$(curl -sf localhost:8098/__jwk) || { echo "mock supabase not running" >&2; exit 1; }
rm -rf "$S/relcopy" "$S/relmock"
mkdir -p "$S/relcopy"
tar -C "$SRC" --exclude=./tests --exclude=./dist -cf - . | tar -C "$S/relcopy" -xf -
python3 - "$S/relcopy/shared/billing-config.js" "$JWK" <<'PY'
import base64, json, sys
p, jwk = sys.argv[1], sys.argv[2]
s = open(p).read()
b = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
s = s.replace("supabaseUrl: ''", "supabaseUrl: 'https://example-project.supabase.co'")
s = s.replace("supabaseAnonKey: ''", "supabaseAnonKey: '%s.%s.sig'" % (b({'alg': 'HS256'}), b({'role': 'anon'})))
s = s.replace("licenseKeys: []", "licenseKeys: [%s]" % jwk)
open(p, 'w').write(s)
PY
(cd "$S/relcopy" && node tools/build-release.mjs >/dev/null)
BUILT="$S/relcopy/dist/kaspi-seller-hub"
cp -r "$BUILT" "$S/relmock"
python3 - "$S/relmock" <<'PY'
import json, re, sys, os
d = sys.argv[1]
def edit(rel, fn):
    p = os.path.join(d, rel); s = open(p).read(); t = fn(s)
    assert t != s, rel + ' unchanged'
    open(p, 'w').write(t)
edit('shared/billing-config.js', lambda s: s.replace("'https://example-project.supabase.co'", "'http://localhost:8098'").replace(re.search(r"supabaseAnonKey: '([^']*)'", s).group(1), 'test-anon-key'))
edit('shared/selectors.js', lambda s: s.replace("'https://kaspi.kz/shop/api/v2'", "'http://localhost:8099/shop/api/v2'").replace("'https://kaspi.kz/shop/api/products'", "'http://localhost:8099/shop/api/products'"))
m = json.load(open(os.path.join(d, 'manifest.json')))
# what the build decided must still hold
assert 'content_scripts' not in m, 'content scripts in an API-only build'
assert 'scripting' not in m.get('permissions', []), 'scripting permission in an API-only build'
assert 'cabinet: false' in open(os.path.join(d, 'shared/features.js')).read(), 'cabinet mode on'
assert not os.path.exists(os.path.join(d, 'content')), 'content/ shipped'
m['host_permissions'] = m.get('host_permissions', []) + ['http://localhost:8098/*', 'http://localhost:8099/*']
csp = m['content_security_policy']['extension_pages']
m['content_security_policy']['extension_pages'] = csp.replace('connect-src ', 'connect-src http://localhost:8098 http://localhost:8099 ')
json.dump(m, open(os.path.join(d, 'manifest.json'), 'w'), indent=2)
PY
grep -q "cabinet: false" "$S/relmock/shared/features.js"
echo "relcopy built, relmock ready"
