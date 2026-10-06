#!/usr/bin/env bash
# 排好看 一键部署脚本（阿里云 ECS：Alibaba Cloud Linux / CentOS / Ubuntu / Debian）
#
# 用法（以 root 运行，与 index.html、login.html、admin.html、server.js 放在同一目录）：
#   bash install.sh                        # 用服务器公网 IP 访问（http）
#   DOMAIN=pai.example.com bash install.sh # 已备案、已解析到本机的域名：自动申请免费 HTTPS 证书并自动续期
#
# 再次运行即为升级：只替换程序文件，邀请码、图片、密钥和证书都会保留；
# 之前设置过的域名会被记住，升级时不用再写 DOMAIN=。
set -euo pipefail

APP_DIR=/opt/paihaokan
APP_USER=paihaokan
APP_PORT=8787
NODE_VERSION=v20.18.0
DOMAIN="${DOMAIN:-}"
if [ -z "$DOMAIN" ] && [ -s "$APP_DIR/.domain" ]; then DOMAIN=$(cat "$APP_DIR/.domain"); fi
DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed 's#^https\{0,1\}://##; s#/.*$##')
if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'; then
  printf '\n\033[1;31m✘ 域名格式不对：%s（只写域名本身，例如 pai.example.com）\033[0m\n' "$DOMAIN" >&2; exit 1
fi
SSL_DIR=/etc/nginx/ssl
ACME_ROOT=/var/www/acme
ACME_HOME=/root/.acme.sh
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash $0"
for f in index.html login.html admin.html server.js; do
  [ -f "$SRC_DIR/$f" ] || die "缺少 $f，请把它和本脚本放在同一目录"
done

if command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf >/dev/null 2>&1; then PKG=dnf
elif command -v yum >/dev/null 2>&1; then PKG=yum
else die "不支持的系统：找不到 apt / dnf / yum"; fi

install_pkgs() {
  if [ "$PKG" = apt ]; then
    DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" >/dev/null
  else
    "$PKG" install -y "$@" >/dev/null
  fi
}

say "1/6 安装基础工具和 nginx"
install_pkgs curl tar xz-utils 2>/dev/null || install_pkgs curl tar xz
command -v nginx >/dev/null 2>&1 || install_pkgs nginx

say "2/6 安装 Node.js"
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]'); fi
if [ "$NODE_MAJOR" -lt 18 ]; then
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "不支持的 CPU 架构：$(uname -m)" ;;
  esac
  TARBALL="node-$NODE_VERSION-linux-$ARCH.tar.xz"
  TMP=$(mktemp -d)
  # 国内服务器优先用 npmmirror 镜像，失败再用官方地址。
  for BASE in "https://npmmirror.com/mirrors/node/$NODE_VERSION" "https://nodejs.org/dist/$NODE_VERSION"; do
    if curl -fsSL --connect-timeout 15 -o "$TMP/$TARBALL" "$BASE/$TARBALL" && curl -fsSL --connect-timeout 15 -o "$TMP/SHASUMS256.txt" "$BASE/SHASUMS256.txt"; then
      if (cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c - >/dev/null 2>&1); then OK=1; break; fi
    fi
  done
  [ "${OK:-0}" = 1 ] || die "Node.js 下载失败，请检查服务器能否访问外网"
  rm -rf /usr/local/node && mkdir -p /usr/local/node
  tar -xJf "$TMP/$TARBALL" -C /usr/local/node --strip-components=1
  ln -sf /usr/local/node/bin/node /usr/local/bin/node
  rm -rf "$TMP"
fi
NODE_BIN=$(command -v node)
echo "Node.js $("$NODE_BIN" -v)"

say "3/6 安装程序到 $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null || useradd -r -d "$APP_DIR" -s /sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/uploads"
install -m 0644 "$SRC_DIR/index.html" "$SRC_DIR/login.html" "$SRC_DIR/admin.html" "$SRC_DIR/server.js" "$APP_DIR/"
[ -f "$SRC_DIR/README.md" ] && install -m 0644 "$SRC_DIR/README.md" "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "4/6 注册系统服务（开机自启、崩溃自动重启）"
cat > /etc/systemd/system/paihaokan.service <<EOF
[Unit]
Description=排好看 公众号排版工具
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=HOST=127.0.0.1
Environment=PORT=$APP_PORT
Environment=TRUST_PROXY=1
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable paihaokan >/dev/null 2>&1
systemctl restart paihaokan

say "5/6 配置 nginx"
NGINX_CONF=/etc/nginx/conf.d/paihaokan.conf
mkdir -p "$ACME_ROOT/.well-known/acme-challenge" "$SSL_DIR"
PROXY_BLOCK="    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }"
ACME_BLOCK="    # 申请 / 续期 HTTPS 证书时的域名验证
    location /.well-known/acme-challenge/ {
        root $ACME_ROOT;
    }"

write_http_conf() {
  cat > "$NGINX_CONF" <<EOF
# 排好看：nginx 接收 80 端口请求并转给本机的 Node 服务
server {
    listen 80 default_server;
    server_name ${DOMAIN:-_};
$ACME_BLOCK

$PROXY_BLOCK
}
EOF
}

write_https_conf() {
  cat > "$NGINX_CONF" <<EOF
# 排好看：http 一律跳转到 https://$DOMAIN，https 转给本机的 Node 服务
server {
    listen 80 default_server;
    server_name _;
$ACME_BLOCK

    location / {
        return 301 https://$DOMAIN\$request_uri;
    }
}

server {
    listen 443 ssl default_server;
    server_name $DOMAIN;
    ssl_certificate     $SSL_DIR/$DOMAIN.pem;
    ssl_certificate_key $SSL_DIR/$DOMAIN.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:paihaokan_ssl:10m;
    ssl_session_timeout 1d;
    add_header Strict-Transport-Security "max-age=31536000" always;
$PROXY_BLOCK
}
EOF
}

# 用 acme.sh 向 Let's Encrypt 申请免费证书（90 天有效；acme.sh 每天检查，到期前自动续期并重载 nginx）。
issue_cert() {
  local resolved rc=0 tmp
  resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')
  if [ -z "$resolved" ]; then
    echo "⚠ 域名 $DOMAIN 还没有解析到任何 IP，先跳过 HTTPS。解析生效后重新运行本脚本即可。"; return 1
  fi
  if [ -n "$PUBLIC_IP" ] && [ "$resolved" != "$PUBLIC_IP" ]; then
    echo "⚠ 域名 $DOMAIN 解析到 $resolved，但本服务器公网 IP 是 $PUBLIC_IP。"
    echo "  请把解析记录改成 $PUBLIC_IP，生效后重新运行本脚本。先跳过 HTTPS。"; return 1
  fi
  if [ ! -x "$ACME_HOME/acme.sh" ]; then
    command -v git >/dev/null 2>&1 || install_pkgs git
    command -v crontab >/dev/null 2>&1 || install_pkgs cronie 2>/dev/null || install_pkgs cron
    systemctl enable --now crond >/dev/null 2>&1 || systemctl enable --now cron >/dev/null 2>&1 || true
    tmp=$(mktemp -d)
    # 国内服务器优先用 gitee 镜像
    if ! git clone --depth 1 -q https://gitee.com/neilpang/acme.sh.git "$tmp/acme.sh" 2>/dev/null \
      && ! git clone --depth 1 -q https://github.com/acmesh-official/acme.sh.git "$tmp/acme.sh"; then
      rm -rf "$tmp"; echo "⚠ 下载证书工具 acme.sh 失败，先跳过 HTTPS"; return 1
    fi
    if ! (cd "$tmp/acme.sh" && ./acme.sh --install --home "$ACME_HOME" -m "${EMAIL:-admin@$DOMAIN}" >/dev/null); then
      rm -rf "$tmp"; echo "⚠ 安装 acme.sh 失败，先跳过 HTTPS"; return 1
    fi
    rm -rf "$tmp"
  fi
  # 国内服务器连证书机构偶尔会断线：每家试 3 次，Let's Encrypt 不行再换 ZeroSSL。
  local ca try ok=0
  for ca in letsencrypt zerossl; do
    for try in 1 2 3; do
      rc=0
      "$ACME_HOME/acme.sh" --issue -d "$DOMAIN" --webroot "$ACME_ROOT" --server "$ca" --keylength ec-256 || rc=$?
      # 返回 2 表示证书仍然有效，不需要重新申请
      if [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]; then ok=1; break 2; fi
      echo "… 第 $try 次申请没成功（$ca），稍后重试"
      sleep $((try * 10))
    done
  done
  if [ "$ok" != 1 ]; then
    echo "⚠ 证书申请失败（常见原因：安全组没放行 80 端口、域名解析还没生效、服务器连不上证书机构），先用 http 运行。"
    echo "  稍后重新运行本脚本即可再试。"; return 1
  fi
  "$ACME_HOME/acme.sh" --install-cert -d "$DOMAIN" --ecc \
    --key-file "$SSL_DIR/$DOMAIN.key" --fullchain-file "$SSL_DIR/$DOMAIN.pem" \
    --reloadcmd "systemctl reload nginx" >/dev/null
}

if [ -n "$DOMAIN" ] && [ -s "$SSL_DIR/$DOMAIN.pem" ] && [ -s "$SSL_DIR/$DOMAIN.key" ]; then
  write_https_conf
else
  write_http_conf
fi
# 系统自带的默认站点也占用 80 端口，关掉它，避免访问到 nginx 欢迎页。
rm -f /etc/nginx/sites-enabled/default
if grep -q 'listen[[:space:]]*80 default_server' /etc/nginx/nginx.conf 2>/dev/null; then
  sed -i 's/listen\([[:space:]]*\)80 default_server;/listen\180;/; s/listen\([[:space:]]*\)\[::\]:80 default_server;/listen\1[::]:80;/' /etc/nginx/nginx.conf
fi
nginx -t
systemctl enable nginx >/dev/null 2>&1
systemctl restart nginx

if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null && firewall-cmd --reload >/dev/null
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q active; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

PUBLIC_IP=$(curl -fsS --connect-timeout 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null \
  || curl -fsS --connect-timeout 3 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null \
  || curl -fsS --connect-timeout 5 https://ifconfig.me 2>/dev/null || true)

HTTPS_OK=0
if [ -n "$DOMAIN" ]; then
  printf '%s\n' "$DOMAIN" > "$APP_DIR/.domain"
  if [ -s "$SSL_DIR/$DOMAIN.pem" ]; then
    HTTPS_OK=1
  else
    say "申请 $DOMAIN 的 HTTPS 证书"
    if issue_cert; then
      write_https_conf
      nginx -t && systemctl reload nginx
      HTTPS_OK=1
      echo "✔ HTTPS 证书已安装，到期前会自动续期"
    fi
  fi
fi

say "6/6 检查服务并准备邀请码"
for i in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1/api/health" >/dev/null || die "服务没有正常启动，请运行 journalctl -u paihaokan -n 50 查看原因"

CODES_FILE="$APP_DIR/invite-codes.json"
if [ ! -s "$CODES_FILE" ]; then
  (cd "$APP_DIR" && runuser -u "$APP_USER" -- "$NODE_BIN" server.js invite create --note 管理员)
else
  echo "已有邀请码（保留原有设置）："
fi
(cd "$APP_DIR" && runuser -u "$APP_USER" -- "$NODE_BIN" server.js invite list)

if [ ! -s "$APP_DIR/admin.json" ]; then
  echo
  (cd "$APP_DIR" && runuser -u "$APP_USER" -- "$NODE_BIN" server.js admin password)
  ADMIN_NOTE="后台密码见上方，请记下来"
else
  ADMIN_NOTE="沿用原来的后台密码"
fi

if [ "$HTTPS_OK" = 1 ]; then ADDRESS="https://$DOMAIN"
else ADDRESS="http://${DOMAIN:-${PUBLIC_IP:-你的服务器公网IP}}"; fi

cat <<EOF

========================================================
 ✅ 部署完成

 访问地址：$ADDRESS
 用上面列出的邀请码登录即可使用。

 管理后台：$ADDRESS/admin（$ADMIN_NOTE）
 在后台可以生成邀请码、查看激活和使用情况、解绑或停用。

 如果浏览器打不开：到阿里云控制台 → 云服务器 ECS → 安全组 →
 入方向，放行 HTTP(80) 和 HTTPS(443) 端口，授权对象 0.0.0.0/0。

 常用命令：
   生成邀请码  cd $APP_DIR && runuser -u $APP_USER -- node server.js invite create --count 5
   查看邀请码  cd $APP_DIR && runuser -u $APP_USER -- node server.js invite list
   修改后台密码 cd $APP_DIR && runuser -u $APP_USER -- node server.js admin password 新密码
   查看日志    journalctl -u paihaokan -n 50
   重启服务    systemctl restart paihaokan
 需要备份的数据：$APP_DIR/invite-codes.json、$APP_DIR/.invite-secret、$APP_DIR/admin.json、$APP_DIR/uploads/
========================================================
EOF
