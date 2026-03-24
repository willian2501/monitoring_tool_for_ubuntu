# Custom Tool

This folder contains a single-container monitoring dashboard for Linux hosts that run Docker.

The container includes:

- nginx for serving the frontend page
- a Node.js API for collection and aggregation
- a local JSON-backed store for lightweight history

Data sources:

- Docker socket for container stats and inspect data
- `/proc` and `/sys` for host metrics
- Caddy access logs for HTTP request insights
- selected Docker container log files for live tails and important events

What is bundled here:

- a standalone Docker Compose example for the monitoring container only
- a minimal Caddy site example for reverse proxying the dashboard
- no built-in Firebase or OTP authentication layer

Current dashboard behavior:

- the Containers tab shows running containers only, aligned with `docker ps`
- the Containers view includes a snapshot freshness badge and `Last Seen` column so stale data is visible
- the home dashboard shows `5xx Errors` for the last hour instead of a derived successful-request count
- the home Network Traffic tile follows the selected time range using lightweight host-series data instead of a single latest snapshot
- the Logs tab includes root-folder usage, largest files, storage growth trends, and a Top Processes panel with friendly service labels
- dashboard polling is split: lightweight host metrics refresh every 30 seconds while full container/log snapshots stay on the slower full collection interval

Runtime defaults are kept intentionally conservative:

- `DATA_RETENTION_DAYS=7`
- `COLLECTION_INTERVAL_MS=180000` (3 minutes)
- `HOST_COLLECTION_INTERVAL_MS=30000` (30 seconds for lightweight host metrics)
- historical snapshots are compacted in storage so only the latest snapshot stays fully expanded in memory

Operational note:

- host cards can update between full snapshots, but container/log freshness still follows the full snapshot cycle so the UI does not overstate how current that heavier data is

Publishing note:

- this package is now generic, but it assumes a Linux Docker host and read access to Docker, `/proc`, `/sys`, and optionally your reverse-proxy log directory
- if you expose it publicly, put it behind external authentication such as Cloudflare Access, VPN, or reverse-proxy auth

The main setup instructions live in `Setup_custom_tool.md`.
