# knx-garage-wled.js

Bridges KNX garage door status signals to a WLED LED strip controller.
The script subscribes to three KNX Group Addresses via the `knx-runtime-engine`
WebSocket API and controls a WLED controller via its REST API based on the
current door state.

## Requirements

- Running [`semantic-knx-gateway`](https://github.com/Noschvie/semantic-knx-gateway) (`knx-runtime-engine`) server with OAuth2 (Keycloak)
- WLED controller reachable in the same network
- Docker (recommended) **or** Node.js ≥ 18 with `ws` package for standalone use

## Configuration

All parameters are set via environment variables:

| Variable                | Description                                                           |
|-------------------------|-----------------------------------------------------------------------|
| `API_URL`               | URL of the `knx-runtime-engine` server                               |
| `OAUTH_CLIENT_ID`       | OAuth2 Client ID                                                      |
| `OAUTH_CLIENT_SECRET`   | OAuth2 Client Secret                                                  |
| `WLED_IP`               | IP address of the WLED controller                                     |
| `WLED_OPEN_TIMEOUT_MS`  | Auto-off after "open" state in ms — green turns off. `0` = disabled  |
| `WLED_CLOSED_TIMEOUT_MS`| Auto-off after "closed" state in ms — spots turn off. `0` = disabled |

## Running with Docker (recommended)

### File layout

```
wled/
├── Dockerfile
├── docker-compose.yml
├── .env
└── knx-garage-wled.js
```

### .env

```dotenv
API_URL=https://knx-runtime-engine.example.org
OAUTH_CLIENT_ID=knx-default-client
OAUTH_CLIENT_SECRET=<secret>
WLED_IP=192.168.7.228
WLED_OPEN_TIMEOUT_MS=60000
WLED_CLOSED_TIMEOUT_MS=120000
```

### docker-compose.yml

```yaml
services:
  knx-garage-wled:
    build: .
    image: knx-garage-wled:latest
    container_name: knx-garage-wled
    restart: unless-stopped
    env_file:
      - .env
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

### Build and start

```bash
docker compose up -d --build
```

### View logs

```bash
docker compose logs -f
```

### Stop

```bash
docker compose down
```

## Running standalone (without Docker)

```bash
npm install ws

export API_URL=https://knx-runtime-engine.example.org
export OAUTH_CLIENT_ID=knx-default-client
export OAUTH_CLIENT_SECRET=<secret>
export WLED_IP=192.168.7.228

node knx-garage-wled.js
```

## KNX Group Addresses

| GA      | Name                               | DPT      | Logic                                            |
|---------|------------------------------------|----------|--------------------------------------------------|
| `5/1/3` | Garage door status open (top)      | DPST-1-2 | `true` = door at top (open)                     |
| `5/1/4` | Garage door status closed (bottom) | DPST-1-2 | `false` = door at bottom (closed) — **inverted** |
| `5/1/6` | Garage door status moving          | DPST-1-2 | `true` = door is moving                         |

GA `5/1/4` is a normally closed contact and is evaluated inverted: `false`
means closed, `true` means not closed.

## State Logic and WLED Mapping

The three GAs are evaluated in priority order. The first matching condition wins:

| Priority    | Condition        | WLED Effect                           |
|-------------|------------------|---------------------------------------|
| 1 (highest) | `5/1/6 = true`   | 🔴 Red, animated (fx 60) — moving    |
| 2           | `5/1/3 = true`   | 🟢 Green, static — open              |
| 3           | `5/1/4 = false`  | ⚪ White, spot pattern — closed       |
| —           | Intermediate     | No WLED call, last state retained     |

WLED is only updated when the state actually changes — redundant identical
calls are suppressed. On startup the script waits until all three GAs have
delivered their initial value before triggering the first WLED call.

## WLED Auto-off

After reaching a stable state (`open` or `closed`) a timer starts automatically.
Once it expires, WLED is turned off via `{ on: false }`:

| State       | Timeout variable         | Default | Effect              |
|-------------|--------------------------|---------|---------------------|
| 🟢 open     | `WLED_OPEN_TIMEOUT_MS`   | 1 min   | Green turns off     |
| ⚪ closed   | `WLED_CLOSED_TIMEOUT_MS` | 2 min   | Spots turn off      |

As soon as the door starts moving again (`moving = true`), any running timer is
immediately cancelled — the strip stays on during movement. The timer restarts
after the next stable state is reached.

Set a timeout to `0` to disable auto-off for that state:

```dotenv
WLED_OPEN_TIMEOUT_MS=0    # green stays on permanently
WLED_CLOSED_TIMEOUT_MS=0  # spots stay on permanently
```

## Movement Monitoring & Drive Health

Every completed door movement is timed and evaluated against a rolling
statistics window. This allows detecting early signs of drive degradation —
e.g. worn rollers, weakened springs, or a motor struggling under load.

### How it works

When GA `5/1/6` transitions to `true`, the current timestamp is recorded and
the movement direction is derived from the current limit-switch state:

| Condition at start          | Derived direction |
|-----------------------------|-------------------|
| GA `5/1/3 = true` (top)     | `closing`         |
| GA `5/1/4 = false` (bottom) | `opening`         |
| Neither limit active        | `unknown`         |

When GA `5/1/6` returns to `false`, the elapsed time is logged together with
the actually reached end position (verified from the limit switches).

### Statistics

Travel times are collected in separate ring buffers for `opening` and
`closing`, each holding the last **20** completed runs (`STATS_WINDOW`).
Once at least 3 runs are recorded per direction, min/max/mean are printed
after every completed movement.

If the current travel time exceeds the rolling mean by more than **20 %**
(`TRAVEL_WARN_RATIO`), a `⚠` warning is logged.

### Plausibility check

After every state update the script verifies that top and bottom limit
switches are not both active at the same time. If they are, a `⚠` warning
is logged immediately — this indicates a wiring or sensor fault.

### Example log output — normal operation

```
[2026-06-06 20:15:10.412] 🚪 Movement started (opening)
[2026-06-06 20:15:24.318] ⏱ Movement ended → OPEN, travel time=13.9s
[2026-06-06 20:15:24.319] 📊 Stats opening: Min=13.7s  Max=14.2s  Mean=13.9s  (n=5)

[2026-06-06 20:47:03.100] 🚪 Movement started (closing)
[2026-06-06 20:47:26.201] ⏱ Movement ended → CLOSED, travel time=23.1s
[2026-06-06 20:47:26.202] 📊 Stats closing: Min=22.8s  Max=23.5s  Mean=23.1s  (n=5)
```

### Example log output — degraded drive (closing too slow)

```
[2026-06-06 21:30:00.000] 🚪 Movement started (closing)
[2026-06-06 21:30:31.400] ⏱ Movement ended → CLOSED, travel time=31.4s
[2026-06-06 21:30:31.401] 📊 Stats closing: Min=22.8s  Max=31.4s  Mean=24.6s  (n=6)
[2026-06-06 21:30:31.401] ⚠ Travel time closing currently 31.4s — mean of last 6 runs: 24.6s — deviation: +28%
```

## WLED Payloads

All three payloads control a 50-LED strip via the WLED JSON API endpoint
`POST http://<WLED_IP>/json/state`.

**Red — moving** (`fx: 60`, animated, full length)
**Green — open** (`fx: 0`, static, full length)
**White — closed** (`fx: 0`, static, spot pattern: `grp: 2, spc: 7`, starting at LED 2)

## Technical Details

### OAuth2

The script uses the `client_credentials` grant for two scopes:

- `manage` — for the WebSocket connection
- `read` — for the initial datapoint lookup via REST API

Tokens expire after 1440 seconds (24 minutes). `TokenHolder` proactively
renews them 60 seconds before expiry. When a token is refreshed while the
WebSocket is connected, the connection is closed and immediately re-established
with the new token. On a `401` error from the server the token is immediately
force-refreshed.

### WebSocket

All three datapoints are subscribed in a single subscription message. On an
unexpected connection drop, the script automatically reconnects with exponential
backoff (1s → 2s → 4s → ... → max. 60s, up to 10 attempts).

### Value Conversion

The server delivers values differently depending on the interface:

- WebSocket (after fix in `messaging-websocket-server.js`): string (`"true"` / `"false"`)
- REST API: string per KNX IoT Spec

The `toBoolean()` function handles both cases robustly, and older server
versions that still deliver native JS booleans:

```js
function toBoolean(val) {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string')  return val === 'true' || val === 'alarm' || val === 'on';
    return false;
}
```

### Logging

All timestamps are output in the `Europe/Vienna` timezone. When running in
Docker, logs are captured by the `json-file` driver and accessible via
`docker compose logs -f`.

Example output on startup with the door closed:

```
Connecting to wss://knx-runtime-engine.example.org/messaging/ws
Datapoint : GA=5/1/3  datapointId=GA-2  "Garage door status open (top)"
Datapoint : GA=5/1/4  datapointId=GA-3  "Garage door status closed (bottom)"
Datapoint : GA=5/1/6  datapointId=GA-5  "Garage door status moving"

[2026-06-06 20:01:37.159] WebSocket connected
[2026-06-06 20:01:37.200] ✓ Welcome — clientId: knx-default-client, scope: manage
[2026-06-06 20:01:37.210] ✓ Subscribed — 3 item(s)
[2026-06-06 20:01:37.300] ★ Update  GA=5/1/3  "Garage door status open (top)"      value=false  raw="false"(string)  ts=2026-06-06 20:01:37.152
[2026-06-06 20:01:37.387] ★ Update  GA=5/1/4  "Garage door status closed (bottom)"  value=false  raw="false"(string)  ts=2026-06-06 20:01:37.378
[2026-06-06 20:01:38.553] ★ Update  GA=5/1/6  "Garage door status moving"           value=false  raw="false"(string)  ts=2026-06-06 20:01:38.547
[2026-06-06 20:01:38.678] 💡 WLED → ⚪ closed
[2026-06-06 20:01:38.679] ⏱ WLED auto-off in 120s (closed)
[2026-06-06 20:03:38.680] 💡 WLED auto-off (timeout reached)
[2026-06-06 20:03:53.933] ♥ Ping  serverTime=2026-06-06 20:03:53

[2026-06-06 20:15:10.412] ★ Update  GA=5/1/6  "Garage door status moving"  value=true  raw="true"(string)
[2026-06-06 20:15:10.413] 🚪 Movement started (opening)
[2026-06-06 20:15:10.414] 💡 WLED → 🔴 moving
[2026-06-06 20:15:24.318] ★ Update  GA=5/1/3  "Garage door status open (top)"  value=true  raw="true"(string)
[2026-06-06 20:15:24.319] ★ Update  GA=5/1/6  "Garage door status moving"      value=false  raw="false"(string)
[2026-06-06 20:15:24.320] ⏱ Movement ended → OPEN, travel time=13.9s
[2026-06-06 20:15:24.321] 💡 WLED → 🟢 open
[2026-06-06 20:15:24.322] ⏱ WLED auto-off in 60s (open)
```

# License

This project is licensed under the GNU General Public License v3.0 or later (GPL-3.0-or-later).

See the LICENSE file for details.

# Disclaimer

KNX is a trademark of the KNX Association.

This project is an independent implementation and is not affiliated with, endorsed by, or sponsored by the KNX Association.
