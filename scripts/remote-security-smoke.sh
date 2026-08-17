#!/usr/bin/env bash
set -euo pipefail
ORIGIN="${GTRZ_MAIL_ORIGIN:-https://mail.gtrz.com.br}"
fail(){ echo "::error::$*"; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

code="$(curl -sS -L --max-time 15 -D "$tmp/root.h" -o /dev/null -w '%{http_code}' "$ORIGIN/")" || fail 'HTTPS root failed'
[[ "$code" == 200 ]] || fail "HTTPS root returned $code"
for h in strict-transport-security content-security-policy x-content-type-options referrer-policy permissions-policy cross-origin-opener-policy; do
grep -Eiq "^$h:" "$tmp/root.h" || fail "Missing $h"
done
! grep -Eiq '^x-powered-by:' "$tmp/root.h" || fail 'X-Powered-By exposed'

code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' http://mail.gtrz.com.br/)" || fail 'HTTP endpoint failed'
[[ "$code" =~ ^30[1278]$ ]] || fail "HTTP did not redirect: $code"

for path in /api/session /api/messages /api/contacts /api/admin/accounts; do
code="$(curl -sS --max-time 15 -D "$tmp/api.h" -o /dev/null -w '%{http_code}' "$ORIGIN$path")" || fail "$path failed"
[[ "$code" == 401 ]] || fail "$path expected 401, got $code"
grep -Eiq '^cache-control: *no-store' "$tmp/api.h" || fail "$path missing no-store"
! grep -Eiq '^access-control-allow-origin: *\*' "$tmp/api.h" || fail "$path exposes wildcard CORS"
done

code="$(curl -sS --max-time 15 -X POST -H 'Origin: https://attacker.invalid' -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}' "$ORIGIN/api/messages/send")" || fail 'cross-origin test failed'
[[ "$code" == 403 ]] || fail "cross-origin POST expected 403, got $code"

code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$ORIGIN/api/internal/key-rotation/status")" || fail 'rotation endpoint failed'
[[ "$code" == 403 || "$code" == 404 ]] || fail "rotation endpoint exposed: $code"

trace="$(curl -sS --max-time 15 -X TRACE -o /dev/null -w '%{http_code}' "$ORIGIN/" || true)"
[[ "$trace" != 200 ]] || fail 'TRACE returned 200'

host=mail.gtrz.com.br
if timeout 10 openssl s_client -connect "$host:443" -servername "$host" -tls1 </dev/null >"$tmp/t10" 2>&1; then ! grep -Eq 'TLSv1([^.]|$)' "$tmp/t10" || fail 'TLS 1.0 enabled'; fi
if timeout 10 openssl s_client -connect "$host:443" -servername "$host" -tls1_1 </dev/null >"$tmp/t11" 2>&1; then ! grep -q 'TLSv1.1' "$tmp/t11" || fail 'TLS 1.1 enabled'; fi
timeout 10 openssl s_client -connect "$host:443" -servername "$host" -tls1_2 </dev/null >"$tmp/t12" 2>&1 || fail 'TLS 1.2 unavailable'
grep -q 'TLSv1.2' "$tmp/t12" || fail 'TLS 1.2 not negotiated'

echo 'Remote production security smoke: PASS'
