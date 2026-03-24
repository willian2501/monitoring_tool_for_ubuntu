FROM node:20-bookworm-slim AS node_runtime

WORKDIR /app

FROM nginx:stable-bookworm

WORKDIR /app

COPY --from=node_runtime /usr/local /usr/local
COPY package.json ./

COPY src ./src
COPY public /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY docker/entrypoint.sh /entrypoint.sh

RUN mkdir -p /data /app/state \
    && chmod +x /entrypoint.sh

ENV PORT=3000 \
    DB_PATH=/data/monitor.db \
    DATA_RETENTION_DAYS=7 \
    COLLECTION_INTERVAL_MS=180000 \
    HOST_COLLECTION_INTERVAL_MS=30000 \
    CADDY_LOG_DIR=/host-caddy-logs \
    CONTAINER_LOG_ROOT=/var/lib/docker/containers \
    CONFIG_ROOT_PATH=/host-root \
    SELECTED_LOG_CONTAINERS=

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]