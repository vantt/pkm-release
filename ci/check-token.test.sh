#!/usr/bin/env bash
# Thử ci/check-token.sh với token giả và máy chủ GitHub giả chạy trên 127.0.0.1 (cần python3). Không gọi mạng thật.
set -u
cd "$(dirname "$0")"
SECRET='ghp_FAKE_never_a_real_token_0123456789'
tmp="$(mktemp -d)"
trap 'kill "$srv" 2>/dev/null; rm -rf "$tmp"' EXIT
cat > "$tmp/srv.py" <<'PY'
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        mode = self.headers.get('Authorization', '').replace('Bearer ', '')
        code, exp = {'ok': (200, None), 'soon': (200, '2026-11-26 10:00:00 UTC'), 'later': (200, '2027-01-30 10:00:00 UTC'),
                     'expired': (401, None), 'noread': (404, None), 'forbid': (403, None), 'down': (502, None)}.get(mode, (401, None))
        self.send_response(code)
        if exp: self.send_header('github-authentication-token-expiration', exp)
        self.send_header('Content-Length', '33'); self.end_headers()
        self.wfile.write(b'{"secret_repo_content":"do-not-print"}'[:33])
    def log_message(self, *a): pass
s = http.server.HTTPServer(('127.0.0.1', 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
PY
python3 "$tmp/srv.py" > "$tmp/port" & srv=$!
for _ in $(seq 50); do [ -s "$tmp/port" ] && break; sleep 0.1; done
port="$(cat "$tmp/port")"
bad=0
run() { # tên, token, mã thoát mong đợi, chuỗi phải có, [biến...]
  local name="$1" tok="$2" want="$3" has="$4"; shift 4
  out="$(env PKM_READ_TOKEN="$tok" GITHUB_API_URL="http://127.0.0.1:$port" TODAY=2026-11-23 "$@" ./check-token.sh 2>&1)"; got=$?
  ok=1
  [ "$got" = "$want" ] || ok=0
  echo "$out" | grep -q -- "$has" || ok=0
  echo "$out" | grep -q "$SECRET" && ok=0
  echo "$out" | grep -q "do-not-print" && ok=0
  if [ "$ok" = 1 ]; then echo "ok   $name"; else echo "FAIL $name (exit $got, want $want)"; echo "$out"; bad=1; fi
}
run "empty secret"            ""        1 "trống hoặc chưa đặt"
run "expired token (401)"     expired   1 "không đọc được repo vantt/pkm (HTTP 401)" X=1
run "repo not visible (404)"  noread    1 "HTTP 404"
run "forbidden (403)"         forbid    1 "HTTP 403"
run "fix hint is printed"     expired   1 "gh secret set PKM_READ_TOKEN"
run "expires in 3 days: warn" soon      0 "còn 3 ngày"
run "expires far: ok"         later     0 "còn 68 ngày"
run "no expiry header: ok"    ok        0 "không khai hạn"
run "server error: warn only" down      0 "HTTP 502"
run "already past: fail"      soon      1 "đã hết hạn" TODAY=2026-12-01
exit $bad
