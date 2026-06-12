# Contributing

Thanks for your interest in contributing to **knx-garage-wled**.

## Before you start

This project is tightly coupled to a specific hardware setup (KNX garage door
with three limit/movement GAs + a WLED LED strip). If you are adapting it for
a different setup, a fork is probably the better approach.

## Reporting issues

- Check existing issues before opening a new one.
- Include relevant log output (sanitize any IPs or secrets first).
- Mention your `knx-runtime-engine` version and WLED firmware version if applicable.

## Submitting changes

1. Fork the repository and create a branch from `development`.
2. Keep changes focused — one concern per PR.
3. Update `CHANGELOG.md` under `[Unreleased]` with a brief description.
4. Test locally with Docker (`docker compose up -d --build`) before opening a PR.

## Code style

- Plain Node.js — no build step, no transpilation.
- Prefer clarity to cleverness; this script runs unattended 24/7.
- Log meaningful state transitions; avoid noisy debug output in normal operation.

## License

By contributing you agree that your changes will be licensed under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
