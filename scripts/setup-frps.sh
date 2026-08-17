#!/usr/bin/env bash
# DSH-Z 服务器端一键脚本：腾讯云轻量 Ubuntu/Debian 安装 frps + Nginx HTTPS 反代
# 用法（在服务器上执行）：
#   sudo bash setup-frps.sh <你的frp token> [域名，默认 dsh.example.com] [映射端口，默认 8080]
# 示例：
#   sudo bash setup-frps.sh mysecret-token dsh.example.com 8080
set -euo pipefail

TOKEN="${1:?用法: setup-frps.sh <token> [域名] [映射端口]}"
DOMAIN="${2:-dsh.example.com}"
REMOTE_PORT="${3:-8080}"
BIND_PORT=7000
FRP_VER=$(curl -fsSL https://api.github.com/repos/fatedier/frp/releases/latest | grep -oP '"tag_name":\s*"\K[^"]+' || echo "v0.61.1")
ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && ARCH="amd64" || [ "$ARCH" = "aarch64" ] && ARCH="arm64"

echo "==> 1/5 安装 frps ${FRP_VER} (${ARCH})"
cd /tmp
curl -fsSL -o frp.tgz "https://github.com/fatedier/frp/releases/download/${FRP_VER}/frp_${FRP_VER#v}_linux_${ARCH}.tar.gz"
tar xzf frp.tgz
sudo cp "frp_${FRP_VER#v}_linux_${ARCH}/frps" /usr/local/bin/frps
rm -rf "frp_${FRP_VER#v}_linux_${ARCH}" frp.tgz

echo "==> 2/5 配置 frps"
sudo tee /etc/frps.toml >/dev/null <<EOF
bindPort = ${BIND_PORT}
auth.token = "${TOKEN}"

# 允许 frpc 用 remotePort 范围（防御性，frpc 直接指定亦可）
allowPorts = [{ start = ${REMOTE_PORT}, end = ${REMOTE_PORT} }]
EOF

echo "==> 3/5 注册 frps 系统服务"
sudo tee /etc/systemd/system/frps.service >/dev/null <<'EOF'
[Unit]
Description=frp Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frps.toml
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now frps
sleep 1
sudo systemctl is-active frps && echo "    frps 运行中"

echo "==> 4/5 腾讯云安全组放行"
echo "    请到 腾讯云控制台 → 防火墙 放行 TCP: ${BIND_PORT}（frps 通信）和 TCP: 443（HTTPS）"
echo "    轻量服务器: 控制台 → 轻量应用服务器 → 防火墙 → 添加规则"

echo "==> 5/5 安装 Nginx + 证书反代 ${DOMAIN} -> 127.0.0.1:${REMOTE_PORT}"
sudo apt-get update -y
sudo apt-get install -y nginx certbot python3-certbot-nginx

# 域名先解析到本机 IP，再签证书
PUB_IP=$(curl -fsSL --max-time 5 ifconfig.me || curl -fsSL --max-time 5 https://api.ipify.org || echo "")
echo "    服务器公网 IP: ${PUB_IP}  → 请确认 DNS 的 A 记录已指向它"

sudo tee /etc/nginx/sites-available/dshz >/dev/null <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
sudo ln -sf /etc/nginx/sites-available/dshz /etc/nginx/sites-enabled/dshz
sudo nginx -t && sudo systemctl reload nginx

echo "==> 签发 Let's Encrypt 证书（需 DNS 已解析且 80 可访问）"
sudo certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos --redirect --register-unsafely-without-email || {
  echo "    证书签发失败：请确认 ${DOMAIN} 的 A 记录已解析到本机，且防火墙放行 80/443，然后重跑:"
  echo "    sudo certbot --nginx -d ${DOMAIN}"
}

# 写 Nginx 反代配置（WebSocket 支持）
sudo tee /etc/nginx/sites-available/dshz >/dev/null <<EOF
server {
    listen 443 ssl http2;
    server_name ${DOMAIN};
    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:${REMOTE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
sudo nginx -t && sudo systemctl reload nginx

echo ""
echo "================================================================"
echo " ✅ 服务器端部署完成"
echo "    frps : ${BIND_PORT} 端口，token=${TOKEN}"
echo "    反代 : https://${DOMAIN} -> 127.0.0.1:${REMOTE_PORT}"
echo "    下一步在 DSH-Z 网络页填写："
echo "      服务器地址 = 本机公网 IP"
echo "      frps 端口 = ${BIND_PORT}"
echo "      映射端口 = ${REMOTE_PORT}"
echo "      token    = ${TOKEN}"
echo "      域名     = ${DOMAIN}"
echo "    然后点「启动 frp 连接」即可。"
echo "================================================================"
