#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR"
INSTALL_DIR="/opt/server-portal"
SERVICE_NAME="server-portal"
APP_USER="portal"
PORT="8088"
HOST="127.0.0.1"
SESSION_TIMEOUT_MS="28800000"
ADMIN_INVITE_COUNT="6"
USER_INVITE_COUNT="3"
FILE_ROOT=""
MAX_UPLOAD_BYTES="104857600"
MAX_UPLOAD_FILES="10"
RESOURCES_ALLOW_USERS="true"
REMOTE_ALLOW_PUBLIC_DIRECT_HOSTS=""
DOMAIN=""
EMAIL=""
CERT_FILE=""
KEY_FILE=""
LETSENCRYPT="0"
ENABLE_NGINX="1"
CLIENT_MAX_BODY_SIZE="100m"

usage() {
  cat <<'EOF'
Usage:
  sudo ./deploy-systemd.sh --domain example.com [options]

Options:
  --domain DOMAIN              Domain name for Nginx, e.g. portal.example.com
  --email EMAIL                Email used by Let's Encrypt when --letsencrypt is enabled
  --letsencrypt                Use certbot to request and configure HTTPS automatically
  --cert-file PATH             Existing TLS certificate file, used with --key-file
  --key-file PATH              Existing TLS private key file, used with --cert-file
  --install-dir PATH           Install directory, default: /opt/server-portal
  --service-name NAME          systemd service name, default: server-portal
  --user USER                  Linux service user, default: portal
  --port PORT                  App listen port, default: 8088
  --host HOST                  App listen host, default: 127.0.0.1
  --session-timeout-ms MS      Login session timeout, default: 28800000
  --admin-invite-count N       Invite codes for first/admin user, default: 6
  --user-invite-count N        Invite codes for new normal users, default: 3
  --file-root PATH             File-management root, default: INSTALL_DIR/data/files
  --max-upload-bytes BYTES     Single file upload limit, default: 104857600
  --max-upload-files N         Max files per upload, default: 10
  --resources-admin-only       Only administrators can view server resources
  --allow-public-direct-hosts  Comma-separated public hosts allowed for direct SSH
  --client-max-body-size SIZE  Nginx upload limit, default: 100m
  --no-nginx                   Only install the Node.js systemd service
  -h, --help                   Show this help

Examples:
  # HTTP only, useful before DNS/HTTPS is ready:
  sudo ./deploy-systemd.sh --domain portal.example.com

  # HTTPS with existing certificate files:
  sudo ./deploy-systemd.sh --domain portal.example.com \
    --cert-file /etc/ssl/portal/fullchain.pem \
    --key-file /etc/ssl/portal/privkey.pem

  # HTTPS using Let's Encrypt/certbot:
  sudo ./deploy-systemd.sh --domain portal.example.com \
    --letsencrypt --email admin@example.com

Notes:
  - Open cloud firewall/security group ports: 22, 80, 443.
  - Do not expose the app port, default 8088, to the public Internet.
  - Keep data/remote-master.key safe; losing it makes saved remote-session
    passwords/private keys undecryptable.
EOF
}

log() {
  printf '\033[1;34m[deploy]\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2
}

die() {
  printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --letsencrypt) LETSENCRYPT="1"; shift ;;
    --cert-file) CERT_FILE="${2:-}"; shift 2 ;;
    --key-file) KEY_FILE="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --service-name) SERVICE_NAME="${2:-}"; shift 2 ;;
    --user) APP_USER="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --session-timeout-ms) SESSION_TIMEOUT_MS="${2:-}"; shift 2 ;;
    --admin-invite-count) ADMIN_INVITE_COUNT="${2:-}"; shift 2 ;;
    --user-invite-count) USER_INVITE_COUNT="${2:-}"; shift 2 ;;
    --file-root) FILE_ROOT="${2:-}"; shift 2 ;;
    --max-upload-bytes) MAX_UPLOAD_BYTES="${2:-}"; shift 2 ;;
    --max-upload-files) MAX_UPLOAD_FILES="${2:-}"; shift 2 ;;
    --resources-admin-only) RESOURCES_ALLOW_USERS="false"; shift ;;
    --allow-public-direct-hosts) REMOTE_ALLOW_PUBLIC_DIRECT_HOSTS="${2:-}"; shift 2 ;;
    --client-max-body-size) CLIENT_MAX_BODY_SIZE="${2:-}"; shift 2 ;;
    --no-nginx) ENABLE_NGINX="0"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || die "Please run as root, e.g. sudo $0 ..."
[[ -f "$SOURCE_DIR/app.js" ]] || die "app.js not found in $SOURCE_DIR"
[[ -f "$SOURCE_DIR/package.json" ]] || die "package.json not found in $SOURCE_DIR"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"
[[ "$SESSION_TIMEOUT_MS" =~ ^[0-9]+$ ]] || die "--session-timeout-ms must be a number"
[[ "$ADMIN_INVITE_COUNT" =~ ^[0-9]+$ ]] || die "--admin-invite-count must be a number"
[[ "$USER_INVITE_COUNT" =~ ^[0-9]+$ ]] || die "--user-invite-count must be a number"
[[ "$MAX_UPLOAD_BYTES" =~ ^[0-9]+$ ]] || die "--max-upload-bytes must be a number"
[[ "$MAX_UPLOAD_FILES" =~ ^[0-9]+$ ]] || die "--max-upload-files must be a number"

if [[ "$ENABLE_NGINX" == "1" ]]; then
  [[ -n "$DOMAIN" ]] || die "--domain is required when Nginx is enabled"
  if [[ -n "$CERT_FILE" || -n "$KEY_FILE" ]]; then
    [[ -n "$CERT_FILE" && -n "$KEY_FILE" ]] || die "--cert-file and --key-file must be provided together"
    [[ -r "$CERT_FILE" ]] || die "Certificate file is not readable: $CERT_FILE"
    [[ -r "$KEY_FILE" ]] || die "Private key file is not readable: $KEY_FILE"
  fi
fi

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_LIKE="${ID_LIKE:-}"
else
  OS_ID="unknown"
  OS_LIKE=""
fi

install_packages() {
  local packages=("$@")
  [[ "${#packages[@]}" -gt 0 ]] || return 0
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "${packages[@]}"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "${packages[@]}"
  else
    die "No supported package manager found. Please install manually: ${packages[*]}"
  fi
}

ensure_command() {
  local command_name="$1"
  shift
  if ! command -v "$command_name" >/dev/null 2>&1; then
    log "Installing missing dependency: $command_name"
    install_packages "$@"
  fi
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is still unavailable after installation attempt"
}

ensure_command tar tar
ensure_command systemctl systemd
ensure_command node nodejs
ensure_command npm npm
if command -v apt-get >/dev/null 2>&1; then
  ensure_command sqlite3 sqlite3
else
  ensure_command sqlite3 sqlite
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "$NODE_MAJOR" -lt 16 ]]; then
  die "Node.js >= 16 is required, current version is $(node -v). Please install Node.js 20 LTS, then rerun this script."
fi

if [[ "$ENABLE_NGINX" == "1" ]]; then
  ensure_command nginx nginx
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Creating service user: $APP_USER"
  useradd -r -m -s /bin/bash "$APP_USER"
fi

log "Installing application to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if [[ "$(cd "$SOURCE_DIR" && pwd)" != "$(cd "$INSTALL_DIR" && pwd 2>/dev/null || echo "$INSTALL_DIR")" ]]; then
  tar \
    --exclude='./node_modules' \
    --exclude='./logs' \
    --exclude='./run' \
    --exclude='./.git' \
    -C "$SOURCE_DIR" -cf - . | tar -C "$INSTALL_DIR" -xf -
fi

mkdir -p "$INSTALL_DIR/data/files" "$INSTALL_DIR/logs" "$INSTALL_DIR/run"
if [[ -z "$FILE_ROOT" ]]; then
  FILE_ROOT="$INSTALL_DIR/data/files"
fi
mkdir -p "$FILE_ROOT"
chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"
chown -R "$APP_USER:$APP_USER" "$FILE_ROOT"
chmod 750 "$INSTALL_DIR" "$INSTALL_DIR/data" "$INSTALL_DIR/data/files" || true
[[ -f "$INSTALL_DIR/start.sh" ]] && chmod +x "$INSTALL_DIR/start.sh"
[[ -f "$INSTALL_DIR/stop.sh" ]] && chmod +x "$INSTALL_DIR/stop.sh"
[[ -f "$INSTALL_DIR/factory-reset.sh" ]] && chmod +x "$INSTALL_DIR/factory-reset.sh"

log "Writing unified application config"
mkdir -p "$INSTALL_DIR/config"
cat >"$INSTALL_DIR/config/local.json" <<EOF
{
  "server": {
    "host": "$HOST",
    "port": $PORT
  },
  "session": {
    "timeoutMs": $SESSION_TIMEOUT_MS
  },
  "registration": {
    "adminInviteCount": $ADMIN_INVITE_COUNT,
    "userInviteCount": $USER_INVITE_COUNT
  },
  "files": {
    "root": "$FILE_ROOT",
    "maxUploadBytes": $MAX_UPLOAD_BYTES,
    "maxUploadFiles": $MAX_UPLOAD_FILES
  },
  "resources": {
    "allowUsers": $RESOURCES_ALLOW_USERS
  },
  "remote": {
    "allowPublicDirectHosts": $(node -e "console.log(JSON.stringify(String(process.argv[1] || '').split(',').map(s => s.trim()).filter(Boolean)))" "$REMOTE_ALLOW_PUBLIC_DIRECT_HOSTS")
  },
  "data": {
    "root": "$INSTALL_DIR/data"
  }
}
EOF
chown "$APP_USER:$APP_USER" "$INSTALL_DIR/config/local.json"
chmod 640 "$INSTALL_DIR/config/local.json"

log "Installing Node.js dependencies"
if [[ -f "$INSTALL_DIR/package-lock.json" ]]; then
  runuser -u "$APP_USER" -- bash -lc "cd '$INSTALL_DIR' && npm ci --omit=dev"
else
  runuser -u "$APP_USER" -- bash -lc "cd '$INSTALL_DIR' && npm install --omit=dev"
fi

log "Writing systemd service: $SERVICE_NAME"
cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Server Portal
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$INSTALL_DIR
Environment=PORTAL_CONFIG=$INSTALL_DIR/config/local.json
ExecStart=$(command -v node) $INSTALL_DIR/app.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
sleep 1
systemctl is-active --quiet "$SERVICE_NAME" || {
  systemctl status "$SERVICE_NAME" --no-pager || true
  die "systemd service failed to start"
}

log "Checking local app health"
if command -v curl >/dev/null 2>&1; then
  curl -fsS "http://${HOST}:${PORT}/api/registration-status" >/dev/null \
    || die "App is running but health check failed: http://${HOST}:${PORT}/api/registration-status"
else
  warn "curl is unavailable; skipped HTTP health check"
fi

write_nginx_http_config() {
  local target="$1"
  cat >"$target" <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    client_max_body_size $CLIENT_MAX_BODY_SIZE;

    location / {
        proxy_pass http://$HOST:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
}

write_nginx_https_config() {
  local target="$1"
  cat >"$target" <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate $CERT_FILE;
    ssl_certificate_key $KEY_FILE;

    client_max_body_size $CLIENT_MAX_BODY_SIZE;

    location / {
        proxy_pass http://$HOST:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
EOF
}

if [[ "$ENABLE_NGINX" == "1" ]]; then
  log "Configuring Nginx for domain: $DOMAIN"
  if getent hosts "$DOMAIN" >/dev/null 2>&1; then
    log "Domain resolves: $(getent hosts "$DOMAIN" | head -n 1)"
  else
    warn "Domain does not resolve from this server yet: $DOMAIN"
  fi

  if [[ -d /etc/nginx/sites-available && -d /etc/nginx/sites-enabled ]]; then
    NGINX_CONF="/etc/nginx/sites-available/${SERVICE_NAME}.conf"
    NGINX_LINK="/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"
  else
    NGINX_CONF="/etc/nginx/conf.d/${SERVICE_NAME}.conf"
    NGINX_LINK=""
  fi

  if [[ -n "$CERT_FILE" && -n "$KEY_FILE" ]]; then
    write_nginx_https_config "$NGINX_CONF"
  else
    write_nginx_http_config "$NGINX_CONF"
  fi

  if [[ -n "$NGINX_LINK" && ! -e "$NGINX_LINK" ]]; then
    ln -s "$NGINX_CONF" "$NGINX_LINK"
  fi

  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx

  if [[ "$LETSENCRYPT" == "1" ]]; then
    [[ -z "$CERT_FILE" && -z "$KEY_FILE" ]] || die "--letsencrypt cannot be combined with --cert-file/--key-file"
    if ! command -v certbot >/dev/null 2>&1; then
      log "Installing certbot"
      if command -v snap >/dev/null 2>&1; then
        snap install core || true
        snap refresh core || true
        snap install --classic certbot
        ln -sf /snap/bin/certbot /usr/bin/certbot
      elif command -v apt-get >/dev/null 2>&1; then
        install_packages certbot python3-certbot-nginx
      elif command -v dnf >/dev/null 2>&1; then
        install_packages certbot python3-certbot-nginx
      elif command -v yum >/dev/null 2>&1; then
        install_packages certbot python3-certbot-nginx
      else
        die "Please install certbot manually, then rerun this script"
      fi
    fi

    CERTBOT_ARGS=(--nginx -d "$DOMAIN" --agree-tos --redirect --non-interactive)
    if [[ -n "$EMAIL" ]]; then
      CERTBOT_ARGS+=(--email "$EMAIL")
    else
      CERTBOT_ARGS+=(--register-unsafely-without-email)
    fi
    log "Requesting Let's Encrypt certificate"
    certbot "${CERTBOT_ARGS[@]}"
    certbot renew --dry-run
  fi
fi

cat <<EOF

Deployment completed.

Service:
  systemctl status $SERVICE_NAME
  journalctl -u $SERVICE_NAME -f

Application:
  http://$HOST:$PORT

EOF

if [[ "$ENABLE_NGINX" == "1" ]]; then
  if [[ "$LETSENCRYPT" == "1" || -n "$CERT_FILE" ]]; then
    echo "Public URL:"
    echo "  https://$DOMAIN"
  else
    echo "Public URL:"
    echo "  http://$DOMAIN"
    echo
    echo "To enable HTTPS later, rerun with either:"
    echo "  sudo $0 --domain $DOMAIN --letsencrypt --email admin@example.com"
    echo "or:"
    echo "  sudo $0 --domain $DOMAIN --cert-file /path/fullchain.pem --key-file /path/privkey.pem"
  fi
fi
