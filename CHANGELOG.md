# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow CalVer: `vYYYY.MM.DD`, with an optional patch suffix `vYYYY.MM.DD.N`
for multiple releases on the same day.

## [Unreleased]

## [v2026.06.12.1] - 2026-06-12

### Fixed
- Token-refresh reconnect no longer goes through `scheduleReconnect()`;
  `reconnectAttempts` is reset to 0 and `connect()` is called directly via
  `setTimeout(connect, 0)` — eliminates the spurious "Reconnecting in 1s…" log
  line and the unnecessary 1 s delay on every proactive token renewal.

### Changed
- README: `knx-runtime-engine` requirement now links to the
  [`semantic-knx-gateway`](https://github.com/Noschvie/semantic-knx-gateway) repository.
- Source header: added an explicit link to `semantic-knx-gateway` alongside the
  existing link to this repository.

## [v2026.06.12] - 2026-06-12

### Added
- Initial release
- KNX WebSocket subscription for three garage door GAs (`5/1/3`, `5/1/4`, `5/1/6`)
- WLED control via JSON REST API (red/green/white states)
- Priority-based state logic: moving → open → closed → intermediate
- Auto-off timers for `open` and `closed` states (`WLED_OPEN_TIMEOUT_MS`, `WLED_CLOSED_TIMEOUT_MS`)
- Timer cancellation on movement start
- Movement monitoring with travel-time statistics (ring buffer, n=20 per direction)
- Drive degradation warning when travel time exceeds rolling mean by >20 %
- Plausibility check: warning if both limits switch active simultaneously
- OAuth2 `client_credentials` grant with proactive token renewal (60 s before expiry)
- Automatic WebSocket reconnect with exponential backoff (max. 60 s, 10 attempts)
- Robust `toBoolean()` handling for string, boolean, and legacy server values
- Docker support with `json-file` logging
- All timestamps in `Europe/Vienna` timezone

[Unreleased]: https://github.com/noschvie/knx-garage-wled/compare/v2026.06.12.1...HEAD
[v2026.06.12.1]: https://github.com/noschvie/knx-garage-wled/compare/v2026.06.12...v2026.06.12.1
[v2026.06.12]: https://github.com/noschvie/knx-garage-wled/releases/tag/v2026.06.12
