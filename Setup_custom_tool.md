# Setup Custom Tool

Goal: run a single monitoring container on a Linux Docker host and make it reusable on any machine without editing source code.

This published setup uses:

- one custom container for the monitoring tool
- a local JSON-backed data file with 7-day retention
- Docker socket access for container stats
- `/proc` and `/sys` mounts for Linux host metrics
- optional reverse-proxy access logs for HTTP request metrics
- optional external access control such as Cloudflare Access, VPN, or reverse-proxy auth

## What this tool gives you

- Linux host CPU, RAM, disk, network, uptime, and load average
- per-container CPU, memory, state, health, restart count, and image
- request counts and HTTP response-code trends from JSON access logs
- top request paths from access logs
- storage visibility for root folders, largest files, volume/log growth trends, and top host processes
- recent warning and error entries from selected container logs
- live tail panels for selected containers

## Do this in order

1. Install host prerequisites such as Git, Docker Engine, and the Docker Compose plugin
2. Clone the repository onto the Linux host
3. Copy `docker-compose/.env.example` to `docker-compose/.env`
4. Adjust the host paths and optional settings in `docker-compose/.env`
5. Start the monitoring container with Docker Compose
6. Optionally add the provided Caddy site block to your existing reverse proxy
7. Optionally place the hostname behind Cloudflare Access or another access-control layer

## 1. Install prerequisites on the host

On Ubuntu, install Git first if needed:

```bash
sudo apt update
sudo apt install -y git ca-certificates curl
```

Then make sure Docker and Docker Compose are available:

```bash
docker --version
docker compose version
git --version
```

This project does not require a separate host-side `npm install` or `pip install`. The runtime is built inside Docker.

## 2. Clone the repository to the host

```bash
cd /opt
sudo git clone https://github.com/willian2501/monitoring_tool_for_ubuntu.git linux-host-monitor
cd /opt/linux-host-monitor
```

If you want a different folder, that is fine. Just update the example paths accordingly.

## 3. Prepare `.env`

```bash
cd /opt/linux-host-monitor/docker-compose
cp .env.example .env
nano .env
```

Use these values as the starting point:

```text
MONITORING_PORT=8080
HOST_CADDY_LOG_DIR=/var/log/caddy
HOST_CONTAINER_LOG_ROOT=/var/lib/docker/containers
CONFIG_ROOT_PATH=/host-root
DATA_RETENTION_DAYS=7
COLLECTION_INTERVAL_MS=180000
HOST_COLLECTION_INTERVAL_MS=30000
SELECTED_LOG_CONTAINERS=
SERVICE_PROBES=
MONITORING_DOMAIN=monitoring.example.com
CADDY_ACME_EMAIL=admin@example.com
```

Key settings:

- `HOST_CADDY_LOG_DIR`: host directory that contains JSON access logs; leave it pointed at an empty or existing directory if you do not use Caddy
- `HOST_CONTAINER_LOG_ROOT`: Docker container log directory; the default works on standard Docker Engine installs
- `CONFIG_ROOT_PATH`: path inside the container for config explorer; because the host root is mounted at `/host-root`, a host path like `/opt/my-stack` becomes `/host-root/opt/my-stack`
- `SELECTED_LOG_CONTAINERS`: optional comma-separated container names for important-log and live-tail panels
- `SERVICE_PROBES`: optional probe definitions if you want synthetic checks in addition to host metrics
- `requirements.txt`: included only as documentation that there are no Python package dependencies for this repository

Default monitoring tune-up now used by this tool:

- `DATA_RETENTION_DAYS=7`
- `COLLECTION_INTERVAL_MS=180000`
- `HOST_COLLECTION_INTERVAL_MS=30000`

This keeps 7 days of history, collects a full snapshot every 3 minutes, and samples lightweight host metrics every 30 seconds so home CPU, memory, disk, and network stay more responsive without making Docker and log collection run that often.

Recent behavior worth knowing before you deploy:

- the home Network Traffic tile is range-aware from host series, not just the latest snapshot
- the Containers tab uses snapshot freshness separately from fast host polling, so container data is not marked fresher than it really is
- the Logs tab now includes storage diagnostics and a Top Processes panel with friendly service labels

## 4. Start the container

```bash
cd /opt/linux-host-monitor/docker-compose
docker compose -f docker-compose.monitoring.yml up -d --build
```

This starts only the monitoring container. It does not replace your existing application stack.

The container publishes `MONITORING_PORT` on the host. If you only want private access, bind that port to a private interface at your reverse proxy or firewall layer.

After starting, verify that it is healthy:

```bash
docker compose -f /opt/linux-host-monitor/docker-compose/docker-compose.monitoring.yml ps
docker logs monitoring_tool --tail 50
```

## 5. Optional Caddy reverse proxy

The bundled Caddy file is now a minimal example site block, not a full server-wide Caddyfile.

Use `caddy/Caddyfile.monitoring-phase1.snippet` as a starting point and set these environment variables for Caddy:

- `MONITORING_DOMAIN`
- `CADDY_ACME_EMAIL`

The example proxies traffic to `monitoring_tool:8080` and writes JSON access logs to `/var/log/caddy/monitoring-access.log`.

If your Caddy instance runs outside the same Docker network, change the upstream target to the host and published port instead.

## 6. Optional access control

This published package no longer includes Firebase login or OTP.

If the dashboard is reachable from the public internet, put it behind external auth. Reference notes: `cloudflare/access-setup.md`

## 7. Validate

1. Open `http://<HOST_OR_DOMAIN>:<MONITORING_PORT>` or your reverse-proxied hostname
2. Confirm the dashboard loads without a built-in login screen
3. Confirm the host cards show CPU, RAM, disk, and network
4. Confirm container rows appear
5. Confirm request charts populate if your access-log directory contains JSON logs
6. Confirm important logs and live tails appear for any containers listed in `SELECTED_LOG_CONTAINERS`

If request charts stay empty, verify that `HOST_CADDY_LOG_DIR` points to a real directory with JSON log files.

## Retention

The tool keeps data intentionally short:

- 7 days of snapshots
- 7 days of access rollups
- 7 days of stored important log events

Live tail panels are read on demand from the current Docker log files.

## Security notes

- The custom tool mounts `/var/run/docker.sock`; treat it as privileged
- The custom tool mounts host metrics paths read-only
- The custom tool mounts Caddy log files read-only
- Prefer private-network access or external authentication if the dashboard is exposed beyond localhost or a VPN

## Next step

If this custom tool already covers what you need, you may not need Grafana, Loki, Portainer, or Dozzle at all.