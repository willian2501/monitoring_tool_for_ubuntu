# Linux Host Monitor for Ubuntu

## Overview

Linux Host Monitor for Ubuntu is a lightweight monitoring dashboard for Linux machines that run Docker.

It ships as a single container with:

- nginx serving the frontend on port 8080
- a Node.js API for collection and aggregation
- a local JSON-backed store for lightweight history

The project is designed to stay simple:

- no external database
- no npm runtime dependencies
- no built-in Firebase or OTP authentication layer
- no production-specific domains or host paths in the published package

## What It Monitors

### Host metrics

- CPU usage
- memory usage
- disk usage
- network RX and TX
- uptime and load average

### Docker metrics

- running containers
- container CPU and memory
- restart count
- health state
- image names
- last-seen freshness information

### Optional log-based insights

- request trends from JSON access logs
- top URLs and top client IPs
- HTTP error breakdowns
- important container log entries
- live tails for selected containers

### Storage and process visibility

- largest root folders
- largest files
- storage growth trends
- top host processes

## Features

- range-aware dashboard views
- lightweight host polling every 30 seconds
- slower full snapshot collection every 3 minutes
- historical snapshot compaction to reduce memory usage
- config explorer for mounted `docker-compose.yml`, `compose.yml`, and `Caddyfile`
- standalone Docker Compose example for the monitoring container only
- minimal Caddy reverse-proxy example

## Requirements

- Ubuntu or another Linux distribution
- Docker Engine
- access to `/var/run/docker.sock`
- readable host mounts for `/proc`, `/sys`, and `/`

Optional:

- a directory with JSON access logs
- access to `/var/lib/docker/containers` for important log entries and live tails
- a reverse proxy such as Caddy

## Quick Start

1. Copy this repository to your Linux host.
2. Open `docker-compose/.env.example` and create `docker-compose/.env`.
3. Adjust the paths and host-specific values.
4. Start the container:

```bash
cd docker-compose
docker compose -f docker-compose.monitoring.yml up -d --build
```

5. Open `http://<host>:8080` or the port defined by `MONITORING_PORT`.

## Configuration

The main environment template is in `docker-compose/.env.example`.

Important variables:

- `MONITORING_PORT`
- `HOST_CADDY_LOG_DIR`
- `HOST_CONTAINER_LOG_ROOT`
- `CONFIG_ROOT_PATH`
- `DATA_RETENTION_DAYS`
- `COLLECTION_INTERVAL_MS`
- `HOST_COLLECTION_INTERVAL_MS`
- `SELECTED_LOG_CONTAINERS`
- `SERVICE_PROBES`

Default runtime tuning:

- `DATA_RETENTION_DAYS=7`
- `COLLECTION_INTERVAL_MS=180000`
- `HOST_COLLECTION_INTERVAL_MS=30000`

## Security

This dashboard mounts privileged host resources.

If you expose it outside a private network, place it behind external authentication such as:

- Cloudflare Access
- reverse-proxy authentication
- a VPN

The project intentionally does not ship its own login screen.

## Repository Layout

- `src/` application backend
- `public/` frontend assets
- `nginx/` nginx config
- `docker/` container entrypoint
- `docker-compose/` standalone Compose example and env template
- `caddy/` optional reverse-proxy example
- `cloudflare/` optional access-control guidance
- `Setup_custom_tool.md` deployment notes
- `KNOWN_ME.md` operator-focused quick notes

## Documentation

- `Setup_custom_tool.md` for installation and deployment
- `CONTRIBUTING.md` for contribution rules
- `SECURITY.md` for security guidance

## Notes

- host cards can update between full snapshots, but container and log freshness still follows the full snapshot cycle
- the package is generic for Linux Docker hosts, not for non-Docker environments
- access-log analytics work only when the mounted log directory actually contains JSON logs
