# Optional Cloudflare Access

This published package no longer ships its own Firebase or OTP login flow.

If you expose the dashboard on the public internet, put it behind an external access-control layer such as Cloudflare Access, Tailscale Funnel + ACLs, a VPN, or reverse-proxy authentication.

Recommended Cloudflare Access setup:

- Application type: Self-hosted
- Domain: your monitoring hostname, for example `monitoring.example.com`
- Policy: allow only your admin group, email list, or identity provider group
- Session duration: short enough for admin access, long enough to avoid constant re-prompts

Notes:

- The monitoring container mounts Docker and host metrics paths, so it should stay admin-only.
- If you do not publish the dashboard externally, you can skip Cloudflare Access and keep the port bound to a private network.