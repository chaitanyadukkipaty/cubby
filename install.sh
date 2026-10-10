#!/usr/bin/env bash
# Cubby installer for a Linux VPS. Usage:
#   curl -fsSL <url-of-this-file> | sudo bash
# Asks for: domain (optional), admin email, admin password. Installs Docker if needed,
# builds the Cubby image and starts it on ports 80/443.
set -euo pipefail

CUBBY_REPO="${CUBBY_REPO:-https://github.com/chaitanyadukkipaty/cubby.git}"
CUBBY_REF="${CUBBY_REF:-main}"
CUBBY_HOME=/opt/cubby
ENV_FILE="$CUBBY_HOME/cubby.env"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { local prompt="$1" var; read -r -p "$prompt" var </dev/tty; printf '%s' "$var"; }
ask_secret() { local prompt="$1" var; read -r -s -p "$prompt" var </dev/tty; echo >/dev/tty; printf '%s' "$var"; }

[[ "$(uname -s)" == "Linux" ]] || die "Cubby installs on Linux servers only."
[[ $EUID -eq 0 ]] || die "Run as root: curl -fsSL ... | sudo bash"
if [[ -f "$ENV_FILE" ]]; then
  die "Cubby is already installed ($ENV_FILE). Use: cubby-server upgrade | status | set-domain"
fi

bold "Cubby installer"
echo

# --- Questions ---------------------------------------------------------------------------------
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org || curl -fsS --max-time 5 https://ifconfig.me || true)"
[[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || PUBLIC_IP="$(hostname -I | awk '{print $1}')"

echo "Domain for this server, e.g. cubby.example.com"
echo "Point both <domain> and *.<domain> at $PUBLIC_IP first. Leave blank to use the IP (HTTP only)."
DOMAIN="$(ask 'Domain: ' | tr '[:upper:]' '[:lower:]' | sed 's#^https\?://##; s#/.*##')"

ADMIN_EMAIL=""
until [[ "$ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; do
  ADMIN_EMAIL="$(ask 'Admin email: ')"
done
while true; do
  ADMIN_PASSWORD="$(ask_secret 'Admin password (8+ characters): ')"
  [[ ${#ADMIN_PASSWORD} -ge 8 ]] || { echo "Too short."; continue; }
  CONFIRM="$(ask_secret 'Repeat password: ')"
  [[ "$ADMIN_PASSWORD" == "$CONFIRM" ]] && break
  echo "Passwords don't match."
done
# Shown to everyone who uses this server; changeable later in the dashboard's Admin tab.
DEFAULT_NAME="${ADMIN_EMAIL%%@*}'s Cubby"
SERVER_NAME="$(ask "Name your cubby [$DEFAULT_NAME]: " | tr -d '\000-\037' | sed 's/^ *//; s/ *$//')"
SERVER_NAME="${SERVER_NAME:-$DEFAULT_NAME}"
SERVER_NAME="${SERVER_NAME:0:60}"

if [[ -n "$DOMAIN" ]]; then
  BASE_DOMAIN="$DOMAIN"
  PUBLIC_URL="https://$DOMAIN"
  CUBBY_HTTPS=1
  RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
  WILDCARD="$(getent hosts "check.$DOMAIN" | awk '{print $1}' | head -1 || true)"
  [[ "$RESOLVED" == "$PUBLIC_IP" ]] || echo "  ! $DOMAIN resolves to '${RESOLVED:-nothing}', not $PUBLIC_IP. HTTPS will fail until DNS is fixed."
  [[ "$WILDCARD" == "$PUBLIC_IP" ]] || echo "  ! *.$DOMAIN doesn't resolve to $PUBLIC_IP yet. Apps will fail until you add a wildcard A record."
else
  BASE_DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  PUBLIC_URL="http://$BASE_DOMAIN"
  CUBBY_HTTPS=0
fi

# --- Dependencies ------------------------------------------------------------------------------
echo
bold "Installing"
if ! command -v docker >/dev/null; then
  info "Docker…"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
if ! command -v git >/dev/null; then
  info "git…"
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq git >/dev/null
  elif command -v dnf >/dev/null; then dnf install -y -q git
  else die "Install git and re-run."; fi
fi

mkdir -p "$CUBBY_HOME"
chmod 700 "$CUBBY_HOME"
if [[ -d "$CUBBY_HOME/src/.git" ]]; then
  git -C "$CUBBY_HOME/src" fetch -q origin "$CUBBY_REF" && git -C "$CUBBY_HOME/src" checkout -q FETCH_HEAD
else
  git clone -q --depth 1 --branch "$CUBBY_REF" "$CUBBY_REPO" "$CUBBY_HOME/src"
fi

words=(otter maple cedar comet river falcon ember harbor lumen pebble quartz sable tundra willow zephyr birch)
SIGNUP_CODE="${words[RANDOM % 16]}-${words[RANDOM % 16]}-$((RANDOM % 90 + 10))"

umask 077
cat > "$ENV_FILE" <<ENV
BASE_DOMAIN=$BASE_DOMAIN
PUBLIC_URL=$PUBLIC_URL
CUBBY_HTTPS=$CUBBY_HTTPS
ACME_EMAIL=$ADMIN_EMAIL
CUBBY_ADMIN_EMAIL=$ADMIN_EMAIL
CUBBY_ADMIN_PASSWORD=$ADMIN_PASSWORD
CUBBY_SIGNUP_CODE=$SIGNUP_CODE
CUBBY_SERVER_NAME=$SERVER_NAME
PB_SUPERUSER_EMAIL=superuser@cubby.internal
PB_SUPERUSER_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
ENV

install -m 755 "$CUBBY_HOME/src/docker/cubby-server" /usr/local/bin/cubby-server
info "Building image (takes a minute)…"
cubby-server rebuild >/dev/null

info "Waiting for Cubby to start…"
for _ in $(seq 1 60); do
  if curl -fsS -H "Host: $BASE_DOMAIN" http://127.0.0.1/api/info >/dev/null 2>&1; then STARTED=1; break; fi
  sleep 2
done
[[ "${STARTED:-}" == "1" ]] || die "Cubby didn't start. Check: cubby-server logs"

# The admin account exists now; don't keep its password on disk.
sed -i '/^CUBBY_ADMIN_PASSWORD=/d' "$ENV_FILE"

echo
bold "Cubby is running 🎉"
echo
info "URL:          $PUBLIC_URL"
info "Name:         $SERVER_NAME"
info "Admin:        $ADMIN_EMAIL"
info "Signup code:  $SIGNUP_CODE"
echo
info "Send your friends the URL and the signup code."
[[ "$CUBBY_HTTPS" == "1" ]] || info "Running on plain HTTP. Add a domain later with: cubby-server set-domain <domain>"
info "Manage it with: cubby-server status | logs | upgrade | backup | restore | code"
