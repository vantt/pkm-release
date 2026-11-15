#!/usr/bin/env bash
# Mã hoá một file log (có thể chứa mã của repo private) để tải lên artifact của repo công khai: khoá AES-256 ngẫu nhiên
# cho mỗi lần, khoá đó mã hoá RSA-OAEP bằng ci/log-key.pub.pem. Chỉ người giữ khoá riêng đọc được.
# Dùng: ci/seal.sh <file> <thư mục ra>   →   <ra>/<tên>.enc, <ra>/<tên>.key.enc
set -eu
in="$1"; out="$2"; here="$(cd "$(dirname "$0")" && pwd)"
name="$(basename "$in")"
mkdir -p "$out"
key="$(openssl rand -hex 32)"
openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:$key" -in "$in" -out "$out/$name.enc"
if ! printf '%s' "$key" | openssl pkeyutl -encrypt -pubin -inkey "$here/log-key.pub.pem" \
     -pkeyopt rsa_padding_mode:oaep -out "$out/$name.key.enc" 2>/dev/null; then
  printf '%s' "$key" | openssl rsautl -encrypt -oaep -pubin -inkey "$here/log-key.pub.pem" -out "$out/$name.key.enc"
fi
echo "sealed $name"
