# Contributing

## Scope

This repository is a standalone Linux monitoring dashboard for Docker hosts.

Keep changes focused on:

- Linux host monitoring
- Docker container visibility
- optional access-log analytics
- simple deployment with Docker Compose

## Before opening a pull request

1. Keep the package generic and avoid hardcoded personal domains, usernames, emails, or host paths.
2. Do not reintroduce built-in Firebase, OTP, or other environment-specific authentication.
3. Keep the Docker Compose example standalone. Do not turn it back into a copy of a full production stack.
4. Update the documentation when behavior or required environment variables change.
5. Prefer minimal changes that preserve the zero-dependency runtime approach.

## Testing checklist

Before submitting changes, verify at least these points:

1. The app starts with Docker Compose.
2. The dashboard loads without a login screen.
3. Host metrics render on a Linux Docker host.
4. Container inventory loads when Docker socket access is available.
5. Optional access-log features fail gracefully when no log directory is mounted.
6. Optional config explorer fails gracefully when `CONFIG_ROOT_PATH` does not contain supported files.

## Pull request guidance

- Describe the problem being solved.
- Note any new environment variables or mounts.
- Include screenshots for UI changes when relevant.
- Avoid unrelated formatting churn.
