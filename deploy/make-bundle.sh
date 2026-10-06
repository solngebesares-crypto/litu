#!/usr/bin/env bash
# 把程序文件和 install.sh 打包成一个可直接上传到服务器运行的文件：
#   bash deploy/make-bundle.sh            → 生成 dist/paihaokan-deploy.sh
# 服务器上运行：bash paihaokan-deploy.sh   （或 DOMAIN=example.com bash paihaokan-deploy.sh）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/paihaokan-deploy.sh"
mkdir -p "$ROOT/dist"
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
cp "$ROOT/index.html" "$ROOT/login.html" "$ROOT/admin.html" "$ROOT/server.js" "$ROOT/README.md" "$ROOT/deploy/install.sh" "$STAGE/"
{
  cat <<'HEAD'
#!/usr/bin/env bash
# 排好看 一键部署包：包含全部程序文件。以 root 运行：bash paihaokan-deploy.sh
set -euo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
sed '1,/^__PAYLOAD__$/d' "$0" | base64 -d | tar -xz -C "$TMP"
bash "$TMP/install.sh"
exit 0
__PAYLOAD__
HEAD
  tar -czf - -C "$STAGE" . | base64
} > "$OUT"
chmod +x "$OUT"
echo "已生成 $OUT（$(du -h "$OUT" | cut -f1)）"
