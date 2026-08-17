#!/usr/bin/env bash
set -u -o pipefail
ORIGIN="${GTRZ_MAIL_ORIGIN:-https://mail.gtrz.com.br}"
failures=0
bad(){ echo "::error::$*"; failures=$((failures+1)); }
ok(){ echo "::notice::$*"; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

code="$(curl -sS -L --max-time 15 -D "$tmp/root.h" -o /dev/null -w '%{http_code}' "$ORIGIN/" || true)"
[[ "$code" == 200 ]] && ok 'HTTPS root 200' || bad "HTTPS root returned ${code:-request-failed}"
for h in strict-transport-security content-security-policy x-content-type-options referrer-policy permissions-policy cross-origin-opener-policy; do
  grep -Eiq "^$h:" "$tmp/root.h" 2>/dev/null && ok "Header present: $h" || bad "Missing $h on static root"
done
if grep -Eiq '^x-powered-by:' "$tmp/root.h" 2>/dev/null; then bad 'X-Powered-By exposed'; else ok 'X-Powered-By not exposed'; fi

code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' http://mail.gtrz.com.br/ || true)"
[[ "$code" =~ ^30[1278]$ ]] && ok "HTTP redirects ($code)" || bad "HTTP did not redirect: ${code:-request-failed}"

health="$(curl -sS --max-time 15 -D "$tmp/health.h" -o /dev/null -w '%{http_code}' "$ORIGIN/api/health" || true)"
[[ "$health" == 200 ]] && ok 'Health endpoint 200' || bad "Health returned ${health:-request-failed}"
grep -Eiq '^cache-control: *no-store' "$tmp/health.h" 2>/dev/null && ok 'Health no-store' || bad 'Health missing Cache-Control: no-store'

for path in /api/session /api/messages /api/contacts /api/admin/accounts; do
  code="$(curl -sS --max-time 15 -D "$tmp/api.h" -o /dev/null -w '%{http_code}' "$ORIGIN$path" || true)"
  [[ "$code" == 401 ]] && ok "$path rejects unauthenticated access" || bad "$path expected 401, got ${code:-request-failed}"
  grep -Eiq '^cache-control: *no-store' "$tmp/api.h" 2>/dev/null && ok "$path no-store" || bad "$path missing no-store"
  if grep -Eiq '^access-control-allow-origin: *\*' "$tmp/api.h" 2>/dev/null; then bad "$path exposes wildcard CORS"; else ok "$path no wildcard CORS"; fi
done

code="$(curl -sS --max-time 15 -X POST -H 'Origin: https://attacker.invalid' -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}' "$ORIGIN/api/messages/send" || true)"
[[ "$code" == 403 ]] && ok 'Cross-origin mutation rejected' || bad "Cross-origin POST expected 403, got ${code:-request-failed}"

code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$ORIGIN/api/internal/key-rotation/status" || true)"
[[ "$code" == 403 || "$code" == 404 ]] && ok "Internal rotation route protected ($code)" || bad "Internal rotation endpoint unexpectedly reachable: ${code:-request-failed}"

trace="$(curl -sS --max-time 15 -X TRACE -o /dev/null -w '%{http_code}' "$ORIGIN/" || true)"
[[ "$trace" != 200 ]] && ok "TRACE not accepted ($trace)" || bad 'TRACE returned 200'

host=mail.gtrz.com.br
if timeout 10 openssl s_client -connect "$host:443" -servername "$host" -tls1 </dev/null >"$tmp/t10" 2>&1 && grep -Eq 'Protocol  : TLSv1$|Protocol version: TLSv1$|New, TLSv1,' "$tmp/t10"; then bad 'TLS 1.0 enabled'; else ok 'TLS 1.0 unavailable'; fi
if timeout 10 openssl s_client -connect "$host:443" -servername "$host" -tls1_1 </dev/null >"$tmp/t11" 2>&1 && grep -Eq 'TLSv1\.1' "$tmp/t11"; then bad 'TLS 1.1 enabled'; else ok 'TLS 1.1 unavailable'; fi
if timeout 10 openssl s_client -connect "$host:443" -servername "$host" -tls1_2 </dev/null >"$tmp/t12" 2>&1 && grep -Eq 'TLSv1\.2' "$tmp/t12"; then ok 'TLS 1.2 available'; else bad 'TLS 1.2 unavailable'; fi

if (( failures > 0 )); then
  echo "Remote production security smoke: FAIL ($failures finding(s))"
  exit 1
fi
echo 'Remote production security smoke: PASS'
