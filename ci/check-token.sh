#!/usr/bin/env bash
# Kiểm secret PKM_READ_TOKEN trước khi workflow checkout repo private vantt/pkm.
#   - không đọc được repo (401, 403, 404, hay secret rỗng): dừng, nói cách thay token;
#   - còn dưới 7 ngày (header github-authentication-token-expiration): cảnh báo, chạy tiếp;
#   - lỗi mạng hay 5xx: cảnh báo, chạy tiếp (bước checkout sẽ báo lỗi thật).
# Không in token, không in nội dung repo (thân phản hồi bỏ vào /dev/null; token đi qua cấu hình curl trên stdin, không
# nằm trong tham số dòng lệnh). Biến: PKM_READ_TOKEN (bắt buộc), PKM_REPO (mặc định vantt/pkm), GITHUB_API_URL (mặc định
# https://api.github.com; Actions tự đặt), WARN_DAYS (mặc định 7), TODAY (YYYY-MM-DD, để thử; mặc định ngày UTC).
set -u

REPO="${PKM_REPO:-vantt/pkm}"
API="${GITHUB_API_URL:-https://api.github.com}"
WARN_DAYS="${WARN_DAYS:-7}"

HOWTO="Cách thay token: tạo fine-grained personal access token mới của tài khoản vantt, chỉ cho repo ${REPO}, quyền Contents: read, đặt hạn; rồi chạy: gh secret set PKM_READ_TOKEN -R vantt/pkm-release (dán token). Không cần sửa workflow."

fail() {
  echo "::error title=PKM_READ_TOKEN::$1"
  echo "$1"
  echo "$HOWTO"
  exit 1
}
warn() {
  echo "::warning title=PKM_READ_TOKEN::$1"
  echo "$1"
}

# Số ngày kể từ 1970-01-01 của YYYY-MM-DD (không dùng `date -d`: runner macOS không có bản GNU).
days_from_civil() {
  local y=$((10#$1)) m=$((10#$2)) d=$((10#$3)) era yoe doy doe
  [ "$m" -le 2 ] && y=$((y - 1))
  era=$((y / 400))
  yoe=$((y - era * 400))
  if [ "$m" -gt 2 ]; then doy=$(((153 * (m - 3) + 2) / 5 + d - 1)); else doy=$(((153 * (m + 9) + 2) / 5 + d - 1)); fi
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  echo $((era * 146097 + doe - 719468))
}

if [ -z "${PKM_READ_TOKEN:-}" ]; then
  fail "Secret PKM_READ_TOKEN trống hoặc chưa đặt ở repo này."
fi

hdr="$(mktemp)"
trap 'rm -f "$hdr"' EXIT

code="$(printf 'header = "Authorization: Bearer %s"\n' "$PKM_READ_TOKEN" |
  curl -sS -K - -o /dev/null -D "$hdr" -w '%{http_code}' --max-time 30 \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$API/repos/$REPO/contents/Cargo.toml" 2>/dev/null)" || code="000"

case "$code" in
  200) ;;
  401 | 403 | 404)
    fail "PKM_READ_TOKEN không đọc được repo ${REPO} (HTTP ${code}): token hết hạn, bị thu hồi, hay không có quyền Contents: read trên repo đó." ;;
  *)
    warn "Không kiểm được PKM_READ_TOKEN (HTTP ${code}); chạy tiếp, bước checkout sẽ báo nếu token hỏng."
    exit 0 ;;
esac

exp="$(tr -d '\r' < "$hdr" | sed -n 's/^[Gg]ithub-authentication-token-expiration: *//p' | head -n 1)"
if [ -z "$exp" ]; then
  echo "PKM_READ_TOKEN đọc được repo ${REPO}; token không khai hạn."
  exit 0
fi

day="${exp%% *}"
case "$day" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) warn "PKM_READ_TOKEN đọc được repo nhưng không đọc được hạn ('${exp}')."; exit 0 ;;
esac
today="${TODAY:-$(date -u +%Y-%m-%d)}"
left=$(($(days_from_civil "${day%%-*}" "$(echo "$day" | cut -d- -f2)" "${day##*-}") - $(days_from_civil "${today%%-*}" "$(echo "$today" | cut -d- -f2)" "${today##*-}")))

if [ "$left" -lt 0 ]; then
  fail "PKM_READ_TOKEN đã hết hạn ngày ${day}."
elif [ "$left" -lt "$WARN_DAYS" ]; then
  warn "PKM_READ_TOKEN hết hạn ngày ${day} (còn ${left} ngày). ${HOWTO}"
else
  echo "PKM_READ_TOKEN đọc được repo ${REPO}; hạn ${day} (còn ${left} ngày)."
fi
