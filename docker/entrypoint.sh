#!/bin/bash
# Starts the Cubby server and Caddy; if either exits, the container exits (Docker restarts it).
set -euo pipefail
: "${BASE_DOMAIN:?BASE_DOMAIN is required}"
: "${PUBLIC_URL:?PUBLIC_URL is required}"

CADDYFILE="${CUBBY_CADDYFILE:-/tmp/Caddyfile}" # tests write it elsewhere
EMAIL_LINE=""
[[ -n "${ACME_EMAIL:-}" ]] && EMAIL_LINE="email ${ACME_EMAIL}"

# Access log for fail2ban on the host (`cubby-server fail2ban enable` sets CUBBY_ACCESS_LOG and mounts its folder).
# Only what a ban needs: no headers (cookies, user agents), no ?token= (PocketBase file tokens); kept 7 days.
LOG_BLOCK=""
if [[ -n "${CUBBY_ACCESS_LOG:-}" ]]; then
  LOG_BLOCK="log {
		output file ${CUBBY_ACCESS_LOG} {
			roll_size 10MiB
			roll_keep 5
			roll_keep_for 168h
		}
		format filter {
			wrap json {
				time_format rfc3339
			}
			request>headers delete
			resp_headers delete
			request>uri query {
				delete token
			}
		}
	}"
fi

if [[ "${CUBBY_HTTPS:-0}" == "1" ]]; then
  # Real domain: certificates are issued on demand, only for the root domain and existing apps.
  cat > "$CADDYFILE" <<CADDY
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
	${LOG_BLOCK}
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
CADDY
else
  # IP mode (sslip.io): plain HTTP. Let's Encrypt can't reliably issue certs for shared wildcard-DNS names.
  cat > "$CADDYFILE" <<CADDY
{
	auto_https off
	storage file_system /data/caddy
}
http:// {
	${LOG_BLOCK}
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
CADDY
fi

trap 'kill 0' TERM INT
node /app/server/src/index.js &
caddy run --config "$CADDYFILE" --adapter caddyfile &
wait -n
exit $?
