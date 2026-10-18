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
#   --http-port <port>         IP mode only: serve on this port instead of 80 (asked when 80 is busy)
#   --pb-port <port>           host port for the PocketBase admin UI, loopback only (default 8090)
#   --no-fail2ban              don't install fail2ban to ban IPs that scan for secret files or brute-force logins
# With all four answered, the install runs without any prompts (unless port 80 or 8090 is busy).
set -euo pipefail

CUBBY_HOME="${CUBBY_HOME:-/opt/cubby}"
ENV_FILE="$CUBBY_HOME/cubby.env"
CUBBY_BIN="${CUBBY_BIN:-/usr/local/bin/cubby-server}"
TTY="${CUBBY_TTY:-/dev/tty}" # tests answer prompts from a file
CUBBY_RAW="${CUBBY_RAW:-https://raw.githubusercontent.com/chaitanyadukkipaty/cubby/main}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { local prompt="$1" var; read -r -p "$prompt" var <"$TTY" || die "No terminal to ask \"$prompt\"; pass the answer as an option (see the top of install.sh)."; printf '%s' "$var"; }
ask_secret() { local prompt="$1" var; read -r -s -p "$prompt" var <"$TTY" || die "No terminal to ask for the admin password; use --admin-password-file or CUBBY_ADMIN_PASSWORD."; echo >&2; printf '%s' "$var"; }

WANT_VERSION="${CUBBY_VERSION:-}"
WANT_REF="${CUBBY_REF:-}"
DOMAIN="${CUBBY_DOMAIN-__ask__}"
ADMIN_EMAIL="${CUBBY_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${CUBBY_ADMIN_PASSWORD:-}"
SERVER_NAME="${CUBBY_SERVER_NAME:-}"
HTTP_PORT="${CUBBY_HTTP_PORT:-}"
PB_PORT="${CUBBY_PB_PORT:-}"
FAIL2BAN=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) WANT_VERSION="${2:-}"; shift 2 ;;
    --ref) WANT_REF="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --no-domain) DOMAIN=""; shift ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-password-file) ADMIN_PASSWORD="$(head -n 1 "${2:-/dev/null}")"; shift 2 ;;
    --name) SERVER_NAME="${2:-}"; shift 2 ;;
    --http-port) HTTP_PORT="${2:-}"; shift 2 ;;
    --pb-port) PB_PORT="${2:-}"; shift 2 ;;
    --no-fail2ban) FAIL2BAN=0; shift ;;
    -h|--help) sed -n '2,16p' "$0" 2>/dev/null || echo "See https://chaitanyadukkipaty.github.io/cubby/#install"; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || die "Cubby installs on Linux servers only."
[[ $EUID -eq 0 || -n "${CUBBY_TEST_NONROOT:-}" ]] || die "Run as root: curl -fsSL ... | sudo bash"
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

# --- Ports -------------------------------------------------------------------------------------
# choose_port <var> <wanted> <default> <flag> <from> <to> [<skip>]: a port given with <flag> must be free; otherwise
# the default, or (when it's busy) a free port from <from>-<to> that the user confirms. The choice is permanent:
# it becomes part of the server's URL, so cubby-server never moves it.
choose_port() {
  local var="$1" want="$2" default="$3" flag="$4" from="$5" to="$6" skip="${7:-}" holder free
  if [[ -n "$want" ]]; then
    [[ "$want" =~ ^[1-9][0-9]{0,4}$ && "$want" -le 65535 ]] || die "$flag needs a port number (1-65535), not \"$want\"."
    holder="$(cubby_port_holder "$want" cubby)"
    [[ -z "$holder" ]] || die "Port $want is in use by $holder. Pick another with $flag <port>."
    printf -v "$var" '%s' "$want"
    return
  fi
  holder="$(cubby_port_holder "$default" cubby)"
  if [[ -z "$holder" ]]; then printf -v "$var" '%s' "$default"; return; fi
  # shellcheck disable=SC2086 # $skip is a single port or empty
  free="$(cubby_free_port "$from" "$to" $skip)" || die "Port $default is in use by $holder, and so are $from-$to. Free one, or pass $flag <port>."
  { true <"$TTY"; } 2>/dev/null || die "Port $default is in use by $holder. Free it, or re-run with $flag $free."
  echo "Port $default is in use by $holder."
  while true; do
    want="$(ask "Use port [$free]: ")"
    want="${want:-$free}"
    if [[ ! "$want" =~ ^[1-9][0-9]{0,4}$ || "$want" -gt 65535 ]]; then echo "That isn't a port number."; continue; fi
    [[ "$want" != "$skip" ]] || { echo "Port $want is taken by Cubby's other port."; continue; }
    holder="$(cubby_port_holder "$want" cubby)"
    [[ -z "$holder" ]] || { echo "Port $want is in use by $holder."; continue; }
    printf -v "$var" '%s' "$want"
    return
  done
}

if [[ -n "$DOMAIN" ]]; then
  # Let's Encrypt only checks ports 80 and 443, so HTTPS can't move to other ports.
  [[ -z "$HTTP_PORT" || "$HTTP_PORT" == 80 ]] || die "--http-port only works without a domain: HTTPS needs ports 80 and 443 (Let's Encrypt checks them)."
  for port in 80 443; do
    holder="$(cubby_port_holder "$port" cubby)"
    [[ -z "$holder" ]] || die "Port $port is in use by $holder. A domain with HTTPS needs ports 80 and 443 (Let's Encrypt checks them). Free them, or install without a domain (--no-domain) on another port."
  done
  HTTP_PORT=80
else
  choose_port HTTP_PORT "$HTTP_PORT" 80 --http-port 8080 8099 "${PB_PORT:-8090}"
fi
choose_port PB_PORT "$PB_PORT" 8090 --pb-port 8091 8110 "$HTTP_PORT"
[[ "$PB_PORT" != "$HTTP_PORT" ]] || die "--http-port and --pb-port must differ."

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
  # The port is part of the domain, so app URLs (<app>.<ip>.sslip.io:<port>) carry it too.
  [[ "$HTTP_PORT" == 80 ]] || BASE_DOMAIN="$BASE_DOMAIN:$HTTP_PORT"
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
CUBBY_HTTP_PORT=$HTTP_PORT
CUBBY_PB_PORT=$PB_PORT
PB_SUPERUSER_EMAIL=superuser@cubby.internal
PB_SUPERUSER_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
ENV

install -m 755 "$CUBBY_HOME/src/docker/cubby-server" "$CUBBY_BIN"
F2B_NOTE=""
if [[ "$FAIL2BAN" == 1 ]]; then
  info "fail2ban…"
  # Before the first start, so the container comes up already writing the access log fail2ban reads.
  if ! F2B_OUT="$(CUBBY_HOME="$CUBBY_HOME" CUBBY_BIN="$CUBBY_BIN" "$CUBBY_BIN" fail2ban enable --no-restart 2>&1)"; then
    FAIL2BAN=0
    F2B_NOTE="$(printf '%s' "$F2B_OUT" | tail -n 1)"
  fi
fi
info "Building image (takes a minute)…"
CUBBY_HOME="$CUBBY_HOME" CUBBY_BIN="$CUBBY_BIN" "$CUBBY_BIN" rebuild >/dev/null

info "Waiting for Cubby to start…"
for _ in $(seq 1 60); do
  if curl -fsS -H "Host: $BASE_DOMAIN" "http://127.0.0.1:$HTTP_PORT/api/info" >/dev/null 2>&1; then STARTED=1; break; fi
  sleep 2
done
[[ "${STARTED:-}" == "1" ]] || die "Cubby didn't start. Check: cubby-server logs"

# The admin account exists now; don't keep its password on disk.
sed -i.bak '/^CUBBY_ADMIN_PASSWORD=/d' "$ENV_FILE" && rm -f "$ENV_FILE.bak"
RUNNING="$(curl -fsS -H "Host: $BASE_DOMAIN" "http://127.0.0.1:$HTTP_PORT/api/info" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"

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
[[ "$HTTP_PORT" == 80 ]] || info "Open port $HTTP_PORT (TCP) in your cloud provider's firewall, or the URL won't load."
info "PocketBase admin UI: ssh -L $PB_PORT:127.0.0.1:$PB_PORT you@$PUBLIC_IP, then http://localhost:$PB_PORT/_/"
[[ "$CUBBY_HTTPS" == "1" ]] || info "Running on plain HTTP. Add a domain later with: cubby-server set-domain <domain>"
if [[ "$FAIL2BAN" == 1 ]]; then
  info "Bans:         fail2ban bans IPs that scan for secret files or brute-force logins (cubby-server fail2ban status)"
elif [[ -n "$F2B_NOTE" ]]; then
  info "! fail2ban couldn't be set up: ${F2B_NOTE#error: }"
fi
info "Manage it with: cubby-server status | version | upgrade | backup | restore | code"
