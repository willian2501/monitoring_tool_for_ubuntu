# Known Me — Custom Tool

## Purpose

This folder contains a publishable Linux monitoring dashboard for Docker hosts.

The app is intentionally simple:

- nginx serves the frontend on port `8080`
- Node.js serves the API on port `3000` behind nginx
- data is stored in a single JSON file at `/data/monitor.db`
- no npm runtime dependencies are required

## Assumptions

- host OS is Linux
- Docker Engine is available through `/var/run/docker.sock`
- host metrics can be read from `/proc`, `/sys`, and `/`
- container log files are available under `/var/lib/docker/containers` or another configured path
- access-log analytics are optional and depend on mounting a directory with JSON logs

## Runtime defaults

- `DATA_RETENTION_DAYS=7`
- `COLLECTION_INTERVAL_MS=180000`
- `HOST_COLLECTION_INTERVAL_MS=30000`
- `CONFIG_ROOT_PATH=/host-root`
- `SELECTED_LOG_CONTAINERS=` empty by default

## Published-package decisions

- no built-in Firebase login
- no built-in OTP flow
- no hardcoded personal domains, emails, or VM paths
- bundled Docker Compose file contains only the monitoring container
- bundled Caddy file is a minimal example site block, not a full server config

## Main features

- host CPU, memory, disk, network, uptime, and load averages
- running-container inventory with CPU, memory, restarts, health, image, and last-seen freshness
- request analytics from JSON access logs when available
- important container-log entries and live tails for selected containers
- storage diagnostics for large folders, large files, and growth trends
- top process view sourced from procfs
- config explorer for a mounted directory that contains `docker-compose.yml`, `compose.yml`, or `Caddyfile`

## Deployment files

- `docker-compose/docker-compose.monitoring.yml`: standalone Docker Compose example
- `docker-compose/.env.example`: environment template to copy to `.env`
- `caddy/Caddyfile.monitoring-phase1.snippet`: optional reverse-proxy example
- `cloudflare/access-setup.md`: optional external-auth guidance

## Security note

This tool mounts privileged host resources. Treat it as an admin-only dashboard and keep it behind a private network, VPN, or external authentication layer if it is internet-facing.
