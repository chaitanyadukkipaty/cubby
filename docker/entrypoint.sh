#!/bin/bash
# Starts the Cubby server and Caddy; if either exits, the container exits (Docker restarts it).
set -euo pipefail
: "${BASE_DOMAIN:?BASE_DOMAIN is required}"
: "${PUBLIC_URL:?PUBLIC_URL is required}"

EMAIL_LINE=""
[[ -n "${ACME_EMAIL:-}" ]] && EMAIL_LINE="email ${ACME_EMAIL}"

if [[ "${CUBBY_HTTPS:-0}" == "1" ]]; then
  # Real domain: certificates are issued on demand, only for the root domain and existing apps.
  cat > /tmp/Caddyfile <<CADDY
{
	${EMAIL_LINE}
	storage file_system /data/caddy
	on_demand_tls {
		ask http://127.0.0.1:8080/_internal/tls-check
	}
}
https:// {
	tls {
		on_demand
	}
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
CADDY
else
  # IP mode (sslip.io): plain HTTP. Let's Encrypt can't reliably issue certs for shared wildcard-DNS names.
  cat > /tmp/Caddyfile <<CADDY
{
	auto_https off
	storage file_system /data/caddy
}
http:// {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
CADDY
fi

trap 'kill 0' TERM INT
node /app/server/src/index.js &
caddy run --config /tmp/Caddyfile --adapter caddyfile &
wait -n
exit $?
