# Security Policy

## Supported scope

This project is intended for Linux hosts that run Docker.

Because the container mounts privileged host resources such as the Docker socket and host metric paths, treat this dashboard as an admin-only tool.

## Deployment guidance

- keep the dashboard on a private network when possible
- if it is internet-facing, place it behind external authentication such as Cloudflare Access, VPN access, or reverse-proxy authentication
- mount host paths read-only wherever supported
- review which container logs are exposed through `SELECTED_LOG_CONTAINERS`

## Reporting a vulnerability

Do not open a public issue for a security vulnerability.

Report the issue privately to the repository owner with:

- a short summary
- impact description
- affected files or features
- reproduction steps if available
- suggested remediation if known

## Out of scope

- vulnerabilities in third-party images that require upstream fixes
- security posture of a user’s own reverse proxy, firewall, or identity provider
