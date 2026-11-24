#!/bin/bash
# Test copy of the extension: subscription server = mock Supabase (8098, ES256 signing key),
# Kaspi API = mock (8099), 4th demo store. Source stays untouched.
set -e
S="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$(cd "$S/.." && pwd)"
copyext() { mkdir -p "$1" && tar -C "$SRC" --exclude=./tests --exclude=./dist -cf - . | tar -C "$1" -xf -; }  # the extension without tests/ and dist/
DST=$S/billcopy
JWK=$(curl -s localhost:8098/__jwk)
[ -n "$JWK" ] || { echo "mock supabase not running"; exit 1; }
rm -rf "$DST"
copyext "$DST"
cd "$DST"
# the source config may hold the real project: point the copy at the mock, never at the real Supabase
perl -0pi -e "s#supabaseUrl: '[^']*'#supabaseUrl: 'http://localhost:8098'#; s#supabaseAnonKey: '[^']*'#supabaseAnonKey: 'test-anon-key'#; s#^  licenseKeys: \\[.*?\\n  \\],#  licenseKeys: [$JWK],#ms; s#offerUrl: '[^']*'#offerUrl: ''#; s#privacyUrl: '[^']*'#privacyUrl: ''#; s#pageUrl: '[^']*'#pageUrl: ''#" shared/billing-config.js
grep -q "localhost:8098" shared/billing-config.js && ! grep -q "zraktrilvwrfpcbmkqwi" shared/billing-config.js || { echo "billcopy still points at real supabase"; exit 1; }
sed -i "s#base: 'https://kaspi.kz/shop/api/v2'#base: 'http://localhost:8099/shop/api/v2'#; s#productsBase: 'https://kaspi.kz/shop/api/products'#productsBase: 'http://localhost:8099/shop/api/products'#" shared/selectors.js
sed -i "s|C: { id: '1003', name: 'Детский мир Алматы', base: 700000, k: 1.3 },|C: { id: '1003', name: 'Детский мир Алматы', base: 700000, k: 1.3 },\n    D: { id: '1004', name: 'Автосалон Астана', base: 900000, k: 0.9 },|" demo/mc/store.js
sed "s/'C'/'D'/" demo/mc/store-c.html > demo/mc/store-d.html
grep -q "localhost:8099/shop/api/products" shared/selectors.js && grep -q "kty" shared/billing-config.js && echo "billcopy ready"
