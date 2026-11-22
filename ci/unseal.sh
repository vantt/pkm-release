#!/usr/bin/env bash
# Giải mã file do ci/seal.sh mã hoá (chạy trên máy của người giữ khoá riêng).
# Dùng: ci/unseal.sh <file>.enc <file>.key.enc <khoá riêng .pem> <file ra>
set -eu
enc="$1"; keyenc="$2"; priv="$3"; out="$4"
if ! key="$(openssl pkeyutl -decrypt -inkey "$priv" -pkeyopt rsa_padding_mode:oaep -in "$keyenc" 2>/dev/null)"; then
  key="$(openssl rsautl -decrypt -oaep -inkey "$priv" -in "$keyenc")"
fi
openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:$key" -in "$enc" -out "$out"
echo "unsealed $out"
