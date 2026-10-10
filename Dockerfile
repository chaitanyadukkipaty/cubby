# One container: Cubby control plane (Node) + PocketBase + Caddy (TLS / HTTP front).
FROM caddy:2.11.6 AS caddy

FROM node:24-bookworm-slim
ARG PB_VERSION=0.40.5
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip tini \
 && rm -rf /var/lib/apt/lists/*
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && curl -fsSL -o /tmp/pb.zip "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${arch}.zip" \
 && unzip -j /tmp/pb.zip pocketbase -d /usr/local/bin \
 && rm /tmp/pb.zip
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY cli/package.json cli/
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .

ENV DATA_DIR=/data \
    PB_BIN=/usr/local/bin/pocketbase \
    PB_URL=http://127.0.0.1:8090 \
    PB_LISTEN=0.0.0.0:8090 \
    PORT=8080 \
    NODE_ENV=production
VOLUME /data
EXPOSE 80 443 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:8080/api/info >/dev/null || exit 1
ENTRYPOINT ["tini", "--", "/app/docker/entrypoint.sh"]
