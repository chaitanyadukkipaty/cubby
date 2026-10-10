#!/usr/bin/env bash
# Cubby installer for a Linux VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/chaitanyadukkipaty/cubby/main/install.sh | sudo bash
#
# Installs the latest release by default. Options (pass after `bash -s --`):
#   --version X.Y.Z            a specific release
#   --ref <branch|tag|commit>  any ref, e.g. a branch you're testing (not a release)
#   --domain <domain>          skip the domain question (--no-domain for IP-only, HTTP)
#   --admin-email <email>      skip the admin email question
#   --admin-password-file <f>  read the admin password from a file (or set CUBBY_ADMIN_PASSWORD)
#   --name "<server name>"     skip the server name question
# With all four answered, the install runs without any prompts.
set -euo pipefail

CUBBY_HOME="${CUBBY_HOME:-/opt/cubby}"
ENV_FILE="$CUBBY_HOME/cubby.env"
CUBBY_RAW="${CUBBY_RAW:-https://raw.githubusercontent.com/chaitanyadukkipaty/cubby/main}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { local prompt="$1" var; read -r -p "$prompt" var </dev/tty || die "No terminal to ask \"$prompt\"; pass the answer as an option (see the top of install.sh)."; printf '%s' "$var"; }
ask_secret() { local prompt="$1" var; read -r -s -p "$prompt" var </dev/tty || die "No terminal to ask for the admin password; use --admin-password-file or CUBBY_ADMIN_PASSWORD."; echo >/dev/tty; printf '%s' "$var"; }

WANT_VERSION="${CUBBY_VERSION:-}"
WANT_REF="${CUBBY_REF:-}"
DOMAIN="${CUBBY_DOMAIN-__ask__}"
ADMIN_EMAIL="${CUBBY_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${CUBBY_ADMIN_PASSWORD:-}"
SERVER_NAME="${CUBBY_SERVER_NAME:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) WANT_VERSION="${2:-}"; shift 2 ;;
    --ref) WANT_REF="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --no-domain) DOMAIN=""; shift ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-password-file) ADMIN_PASSWORD="$(head -n 1 "${2:-/dev/null}")"; shift 2 ;;
    --name) SERVER_NAME="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0" 2>/dev/null || echo "See https://chaitanyadukkipaty.github.io/cubby/#install"; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || die "Cubby installs on Linux servers only."
[[ $EUID -eq 0 ]] || die "Run as root: curl -fsSL ... | sudo bash"
if [[ -f "$ENV_FILE" ]]; then
  die "Cubby is already installed ($ENV_FILE). Use: cubby-server upgrade | version | status | set-domain"
fi

bold "Cubby installer"
echo

if ! command -v git >/dev/null; then
  info "Installing git…"
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq git >/dev/null
  elif command -v dnf >/dev/null; then dnf install -y -q git
  else die "Install git and re-run."; fi
fi

# Version resolution is shared with cubby-server (docker/ref.sh). Run from a checkout, use the local copy.
HERE=""
[[ -f "${BASH_SOURCE[0]:-}" ]] && HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "$HERE" && -f "$HERE/docker/ref.sh" ]]; then
  # shellcheck source=docker/ref.sh
  source "$HERE/docker/ref.sh"
else
  REF_SH="$(curl -fsSL "$CUBBY_RAW/docker/ref.sh")" || die "Couldn't download $CUBBY_RAW/docker/ref.sh"
  eval "$REF_SH"
fi
cubby_resolve "$WANT_VERSION" "$WANT_REF" || exit 1
if [[ "$CUBBY_TARGET_CHANNEL" == release && "$CUBBY_TARGET_REF" != main ]]; then
  info "Installing Cubby ${CUBBY_TARGET_REF#v}"
else
  info "Installing Cubby from $CUBBY_TARGET_REF"
fi
[[ -z "$CUBBY_TARGET_NOTE" ]] || info "note: $CUBBY_TARGET_NOTE"
echo

# --- Questions ---------------------------------------------------------------------------------
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org || curl -fsS --max-time 5 https://ifconfig.me || true)"
[[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || PUBLIC_IP="$(hostname -I | awk '{print $1}')"

if [[ "$DOMAIN" == "__ask__" ]]; then
  echo "Domain for this server, e.g. cubby.example.com"
  echo "Point both <domain> and *.<domain> at $PUBLIC_IP first. Leave blank to use the IP (HTTP only)."
  DOMAIN="$(ask 'Domain: ')"
fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed 's#^https\?://##; s#/.*##')"

until [[ "$ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; do
  [[ -z "$ADMIN_EMAIL" ]] || echo "That doesn't look like an email address."
  ADMIN_EMAIL="$(ask 'Admin email: ')"
done
if [[ -n "$ADMIN_PASSWORD" ]]; then
  [[ ${#ADMIN_PASSWORD} -ge 8 ]] || die "The admin password must be at least 8 characters."
else
  while true; do
    ADMIN_PASSWORD="$(ask_secret 'Admin password (8+ characters): ')"
    [[ ${#ADMIN_PASSWORD} -ge 8 ]] || { echo "Too short."; continue; }
    CONFIRM="$(ask_secret 'Repeat password: ')"
    [[ "$ADMIN_PASSWORD" == "$CONFIRM" ]] && break
    echo "Passwords don't match."
  done
fi
# Shown to everyone who uses this server; changeable later in the dashboard's Admin tab.
DEFAULT_NAME="${ADMIN_EMAIL%%@*}'s Cubby"
if [[ -z "$SERVER_NAME" ]]; then
  SERVER_NAME="$(ask "Name your cubby [$DEFAULT_NAME]: ")"
fi
SERVER_NAME="$(printf '%s' "$SERVER_NAME" | tr -d '\000-\037' | sed 's/^ *//; s/ *$//')"
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

# --- Install -----------------------------------------------------------------------------------
echo
bold "Installing"
if ! command -v docker >/dev/null; then
  info "Docker…"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi

mkdir -p "$CUBBY_HOME"
chmod 700 "$CUBBY_HOME"
info "Fetching Cubby ($CUBBY_TARGET_REF)…"
cubby_checkout "$CUBBY_HOME/src" "$CUBBY_TARGET_REF" || die "Couldn't fetch $CUBBY_TARGET_REF."

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
CUBBY_INSTALL_CHANNEL=$CUBBY_TARGET_CHANNEL
CUBBY_INSTALL_REF=$CUBBY_TARGET_REF
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
RUNNING="$(curl -fsS -H "Host: $BASE_DOMAIN" http://127.0.0.1/api/info | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"

echo
bold "Cubby is running 🎉"
echo
info "URL:          $PUBLIC_URL"
info "Name:         $SERVER_NAME"
info "Version:      ${RUNNING:-unknown}"
info "Admin:        $ADMIN_EMAIL"
info "Signup code:  $SIGNUP_CODE"
echo
info "Send your friends the URL and the signup code."
[[ "$CUBBY_HTTPS" == "1" ]] || info "Running on plain HTTP. Add a domain later with: cubby-server set-domain <domain>"
info "Manage it with: cubby-server status | version | upgrade | backup | restore | code"
