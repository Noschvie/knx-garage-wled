// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine - https://github.com/Noschvie/semantic-knx-gateway.git

import WebSocket from 'ws';

// -- Configuration --
const apiUrl            = process.env.API_URL;
const oauthClientId     = process.env.OAUTH_CLIENT_ID;
const oauthClientSecret = process.env.OAUTH_CLIENT_SECRET;
const wledIp            = process.env.WLED_IP;

// KNX Group Addresses - garage door status
const GA_OPEN   = '5/1/3';   // true  = door fully open  (top limit switch)
const GA_CLOSED = '5/1/4';   // false = door fully closed (bottom limit switch)
const GA_MOVING = '5/1/6';   // true  = door is moving

// Reconnect settings
const MAX_RECONNECT_ATTEMPTS  = 10;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS  = 60_000;

// Token refresh: renew token this many seconds before expiry
const TOKEN_REFRESH_MARGIN_SEC = 60;

// WLED auto-off timeouts after reaching a stable state
// Set to 0 to disable the timeout for that state.
const WLED_OPEN_TIMEOUT_MS  = process.env.WLED_OPEN_TIMEOUT_MS    ? Number(process.env.WLED_OPEN_TIMEOUT_MS)   : 2 * 60_000;  // 2 min - green (open)
const WLED_CLOSED_TIMEOUT_MS = process.env.WLED_CLOSED_TIMEOUT_MS ? Number(process.env.WLED_CLOSED_TIMEOUT_MS) : 2 * 60_000;  // 2 min - spots (closed)

// Segment brightness for all WLED states (0-255)
const WLED_GLOBAL_BRI = 255; // global brightness
const WLED_SEG_BRI    =  55; // segment brightness

// Number of LEDs configured in WLED - fetched once at startup via /json/info.
// Payloads use this value; fall back to WLED_LED_COUNT_FALLBACK if unreachable.
const WLED_LED_COUNT_FALLBACK = 140;
let wledLedCount = null;

// -- WLED Payloads --
// Payloads are built lazily so they can reference wledLedCount (fetched at startup).

// Red, animated - door moving (full strip)
function buildWledMoving() {
    const n = wledLedCount ?? WLED_LED_COUNT_FALLBACK;
    return {
        on: true, bri: WLED_GLOBAL_BRI, transition: 7, ps: -1, pl: -1,
        nl: { on: false, dur: 60, fade: true, mode: 1, tbri: 0, rem: -1 },
        seg: [{ id: 0, start: 0, stop: n, len: n, grp: 1, spc: 0, on: true, bri: WLED_SEG_BRI,
                col: [[255, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
                fx: 28, sx: 190, ix: 80, pal: 0, sel: true, rev: false, mi: true }]
    };
}

// Green - door is open (full strip)
function buildWledOpen() {
    const n = wledLedCount ?? WLED_LED_COUNT_FALLBACK;
    return {
        on: true, bri: WLED_GLOBAL_BRI, transition: 7, ps: -1, pl: -1,
        nl: { on: false, dur: 60, fade: true, mode: 1, tbri: 0, rem: -1 },
        seg: [{ id: 0, start: 0, stop: n, len: n, grp: 1, spc: 0, on: true, bri: WLED_SEG_BRI,
                col: [[0, 255, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
                fx: 0, sx: 155, ix: 246, pal: 0, sel: true, rev: false, mi: false }]
    };
}

// White, spots - door closed
// grp/spc are linearly interpolated between two reference points:
//   140 LEDs -> grp=3, spc=5
//   320 LEDs -> grp=6, spc=7
// Values are clamped to [1, ref_high], and spc is always kept >= grp+1.
const WLED_SPOTS_REF_LO = { leds: 140, grp: 3, spc: 5 };
const WLED_SPOTS_REF_HI = { leds: 320, grp: 6, spc: 7 };

function buildWledClosed() {
    const n = wledLedCount ?? WLED_LED_COUNT_FALLBACK;
    const t = (n - WLED_SPOTS_REF_LO.leds) / (WLED_SPOTS_REF_HI.leds - WLED_SPOTS_REF_LO.leds);
    const grp = Math.max(1, Math.round(WLED_SPOTS_REF_LO.grp + t * (WLED_SPOTS_REF_HI.grp - WLED_SPOTS_REF_LO.grp)));
    const spc = Math.max(grp + 1, Math.round(WLED_SPOTS_REF_LO.spc + t * (WLED_SPOTS_REF_HI.spc - WLED_SPOTS_REF_LO.spc)));
    return {
        on: true, bri: WLED_GLOBAL_BRI, transition: 7, ps: -1, pl: -1,
        nl: { on: false, dur: 60, fade: true, mode: 1, tbri: 0, rem: -1 },
        seg: [{ id: 0, start: 1, stop: n - 2, grp, spc, on: true, bri: WLED_SEG_BRI,
                col: [[0, 0, 0, 255], [0, 0, 0, 0], [0, 0, 0, 0]],
                fx: 0, sx: 155, ix: 246, pal: 0, sel: true, rev: false, mi: false }]
    };
}

// -- State tracking --

// Tracks the last known boolean value for each GA.
// null = not yet received from the server.
const state = {
    [GA_OPEN]:   null,
    [GA_CLOSED]: null,
    [GA_MOVING]: null,
};

// Initial state is preloaded via REST before the WebSocket connects,
// so all WebSocket updates are real events from the start.

// -- Movement timing & health monitoring --

let movementStartTs  = null;
let movementDirection = null; // 'opening' | 'closing' | 'unknown'

// Ring buffer for travel-time statistics (last N completed runs per direction)
const STATS_WINDOW = 20;
const travelStats = {
    opening: /** @type {number[]} */ ([]),
    closing: /** @type {number[]} */ ([]),
};

// Deviation threshold (ratio) above which a warning is logged
const TRAVEL_WARN_RATIO = 0.20; // 20 %

function recordTravelTime(direction, durationSec) {
    if (direction === 'unknown') return;
    const arr = travelStats[direction];
    arr.push(durationSec);
    if (arr.length > STATS_WINDOW) arr.shift();

    if (arr.length < 3) return; // not enough data yet

    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const deviation = (durationSec - mean) / mean;

    console.log(
        `[${timestamp()}] 📊 Stats ${direction}: ` +
        `Min=${Math.min(...arr).toFixed(1)}s  Max=${Math.max(...arr).toFixed(1)}s  ` +
        `Mean=${mean.toFixed(1)}s  (n=${arr.length})`
    );

    if (deviation > TRAVEL_WARN_RATIO) {
        console.warn(
            `[${timestamp()}] ⚠ Travel time ${direction} currently ${durationSec}s -- ` +
            `mean of last ${arr.length} runs: ${mean.toFixed(1)}s -- ` +
            `deviation: +${(deviation * 100).toFixed(0)}%`
        );
    }
}

// -- End-position debounce --
// When GA_MOVING flips to false, the end-position GA (open / closed) arrives
// a few ms later.  We wait this long before resolving the new stable state.
const WAIT_FOR_END_POSITION_MS = 500;
let endPositionTimer = null;   // pending WAIT_FOR_END_POSITION timer

function cancelEndPositionTimer() {
    if (endPositionTimer !== null) {
        clearTimeout(endPositionTimer);
        endPositionTimer = null;
    }
}

/** Schedule a deferred applyWledState() call (replaces any pending one). */
function scheduleEndPositionEval(onElapsed) {
    cancelEndPositionTimer();
    endPositionTimer = setTimeout(() => {
        endPositionTimer = null;
        if (onElapsed) onElapsed();
        applyWledState();
    }, WAIT_FOR_END_POSITION_MS);
}

/**
 * Derives the target WLED state from the current KNX state.
 * Priority: moving > open > closed
 * Returns { payload, label } or null if no state is known yet.
 */
function resolveWledState() {
    // Wait until we have received at least one value for every GA
    if (Object.values(state).some(v => v === null)) return null;

    if (state[GA_MOVING] === true)  return { payload: buildWledMoving(), label: '🔴 moving' };
    if (state[GA_OPEN]   === true)  return { payload: buildWledOpen(),   label: '🟢 open' };
    if (state[GA_CLOSED] === false) return { payload: buildWledClosed(), label: '⚪ closed' };  // inverted: false = closed

    // All false - undefined intermediate state, keep current WLED as-is
    return null;
}

// -- WLED discovery --

/**
 * Reads the number of LEDs configured in WLED via GET /json/info.
 * Stores the result in `wledLedCount`; falls back to WLED_LED_COUNT_FALLBACK
 * if the request fails, so the rest of the startup is not blocked.
 */
async function fetchWledLedCount() {
    const url = `http://${wledIp}/json/info`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`[${timestamp()}] ⚠ WLED /json/info returned ${response.status} -- using fallback (${WLED_LED_COUNT_FALLBACK} LEDs)`);
            wledLedCount = WLED_LED_COUNT_FALLBACK;
            return;
        }
        const info = await response.json();
        const count = info?.leds?.count;
        if (typeof count === 'number' && count > 0) {
            wledLedCount = count;
            console.log(`[${timestamp()}] 💡 WLED LED count: ${wledLedCount}`);
        } else {
            console.warn(`[${timestamp()}] ⚠ WLED /json/info: unexpected leds.count (${JSON.stringify(count)}) -- using fallback (${WLED_LED_COUNT_FALLBACK} LEDs)`);
            wledLedCount = WLED_LED_COUNT_FALLBACK;
        }
    } catch (err) {
        console.warn(`[${timestamp()}] ⚠ WLED unreachable at startup: ${err.message} -- using fallback (${WLED_LED_COUNT_FALLBACK} LEDs)`);
        wledLedCount = WLED_LED_COUNT_FALLBACK;
    }
}

// -- WLED API --

let lastWledLabel = null;   // label of the last state sent to WLED
let wledIsOff     = false;  // true after auto-off, until a movement-triggered state clears it
let wledOffTimer  = null;   // auto-off timer for stable states (open / closed)

const WLED_OFF = { on: false };

function cancelWledOffTimer() {
    if (wledOffTimer !== null) {
        clearTimeout(wledOffTimer);
        wledOffTimer = null;
    }
}

function scheduleWledOff(timeoutMs) {
    cancelWledOffTimer();
    if (!timeoutMs) return;
    wledOffTimer = setTimeout(async () => {
        wledOffTimer = null;
        console.log(`[${timestamp()}] 💡 WLED auto-off (timeout reached)`);
        try {
            const response = await fetch(`http://${wledIp}/json/state`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(WLED_OFF),
            });
            if (!response.ok) {
                console.error(`[${timestamp()}] ✗ WLED auto-off error (${response.status})`);
                return;
            }
            // Keep lastWledLabel intact - only re-enable WLED after actual movement.
            wledIsOff = true;
        } catch (err) {
            console.error(`[${timestamp()}] ✗ WLED unreachable during auto-off: ${err.message}`);
        }
    }, timeoutMs);
}

async function applyWledState() {
    // resolveWledState() returns null until all three GAs have been seen.
    // That first complete snapshot is the server's initial state dump -
    // we silently absorb it and skip the WLED call.
    const resolved = resolveWledState();
    if (!resolved) return;

    const { payload, label } = resolved;

    // Suppress identical stable-state updates (no change).
    if (label === lastWledLabel && !wledIsOff) return;

    // After auto-off: only wake WLED on an actual movement event.
    // Spurious KNX updates for open/closed without prior movement are ignored.
    if (wledIsOff && label !== '🔴 moving') {
        console.log(`[${timestamp()}] 💡 WLED suppressed (no movement since auto-off): ${label}`);
        return;
    }

    const url = `http://${wledIp}/json/state`;
    try {
        const response = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });

        if (!response.ok) {
            console.error(`[${timestamp()}] ✗ WLED error (${response.status}) for state "${label}"`);
            return;
        }

        lastWledLabel = label;
        wledIsOff     = false;  // WLED is now on
        console.log(`[${timestamp()}] 💡 WLED -> ${label}`);

        // Manage auto-off timer based on the new stable state
        if (label === '🟢 open') {
            const t = WLED_OPEN_TIMEOUT_MS;
            if (t) console.log(`[${timestamp()}] ⏱ WLED auto-off in ${t / 1000}s (open)`);
            scheduleWledOff(t);
        } else if (label === '⚪ closed') {
            const t = WLED_CLOSED_TIMEOUT_MS;
            if (t) console.log(`[${timestamp()}] ⏱ WLED auto-off in ${t / 1000}s (closed)`);
            scheduleWledOff(t);
        } else {
            // moving - cancel any pending auto-off while in motion
            cancelWledOffTimer();
        }
    } catch (err) {
        console.error(`[${timestamp()}] ✗ WLED unreachable: ${err.message}`);
    }
}

// -- URL helpers --

function toWebSocketUrl(httpUrl) {
    const normalized = httpUrl.endsWith('/') ? httpUrl.slice(0, -1) : httpUrl;
    if (normalized.startsWith('https://')) return `${normalized.replace('https://', 'wss://')}/messaging/ws`;
    return `${normalized.replace('http://', 'ws://')}/messaging/ws`;
}

// -- OAuth --

async function fetchToken(scope) {
    const form  = new URLSearchParams({ grant_type: 'client_credentials', scope });
    const basic = Buffer.from(`${oauthClientId}:${oauthClientSecret}`, 'utf8').toString('base64');

    const response = await fetch(`${apiUrl}/oauth/access`, {
        method:  'POST',
        headers: {
            Authorization:  `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OAuth request failed (${response.status}): ${text}`);
    }

    const payload = await response.json();
    if (!payload.access_token) throw new Error('OAuth response did not include access_token');

    const expiresIn = payload.expires_in ?? 1440;
    const expiresAt = Date.now() + expiresIn * 1000;
    return { accessToken: payload.access_token, expiresAt };
}

class TokenHolder {
    constructor(scope) {
        this.scope         = scope;
        this.accessToken   = null;
        this.expiresAt     = 0;
        this._refreshTimer = null;
        this._onRefresh    = null;
    }

    async init() {
        const { accessToken, expiresAt } = await fetchToken(this.scope);
        this.accessToken = accessToken;
        this.expiresAt   = expiresAt;
        this._scheduleRefresh();
        return accessToken;
    }

    async get({ forceRefresh = false } = {}) {
        if (forceRefresh || Date.now() >= this.expiresAt) {
            const reason = forceRefresh ? 'forced (401 from server)' : 'expired';
            console.log(`[${timestamp()}] ⟳ Token (${this.scope}) refresh -- ${reason}`);
            await this.init();
        }
        return this.accessToken;
    }

    onRefresh(cb) { this._onRefresh = cb; }

    _scheduleRefresh() {
        clearTimeout(this._refreshTimer);
        const msUntilRefresh = (this.expiresAt - Date.now()) - TOKEN_REFRESH_MARGIN_SEC * 1000;
        if (msUntilRefresh <= 0) return;
        this._refreshTimer = setTimeout(async () => {
            try {
                console.log(`[${timestamp()}] ⟳ Proactive token refresh (${this.scope})...`);
                await this.init();
                console.log(`[${timestamp()}] ✓ Token refreshed (${this.scope})`);
                if (this._onRefresh) this._onRefresh(this.accessToken);
            } catch (err) {
                console.error(`[${timestamp()}] ✗ Token refresh failed (${this.scope}): ${err.message}`);
                this._refreshTimer = setTimeout(() => this._scheduleRefresh(), 30_000);
            }
        }, msUntilRefresh);
    }

    destroy() { clearTimeout(this._refreshTimer); }
}

// -- Datapoint lookup --

async function fetchDatapointMetaByGA(ga, readToken) {
    const url = new URL(`${apiUrl}/api/v1/datapoints`);
    url.searchParams.set('filter[ga]', ga);

    const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${readToken}` }
    });

    if (!response.ok) throw new Error(`Datapoint lookup failed for GA ${ga} (${response.status})`);

    const payload = await response.json();
    const d = payload?.data?.[0];
    if (!d) return null;

    return {
        datapointId: d.meta?.datapointId,
        name:        d.attributes?.title,
        ga:          d.meta?.ga,
        dpt:         d.meta?.dpt,
    };
}


async function fetchInitialValues(dpMap, readToken) {
    const entries = [...dpMap.entries()]; // [[datapointId, {ga, name}], ...]
    await Promise.all(entries.map(async ([datapointId, { ga }]) => {
        const url = `${apiUrl}/api/v1/datapoints/${datapointId}`;
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${readToken}` }
        });
        if (!response.ok) {
            console.warn(`[${timestamp()}] ⚠ Could not prefetch value for GA ${ga} (${response.status})`);
            return;
        }
        const payload = await response.json();
        const rawVal  = payload?.data?.attributes?.value;
        if (rawVal !== undefined) {
            state[ga] = toBoolean(rawVal);
            console.log(`[${timestamp()}] ℹ Prefetch  GA=${ga}  value=${state[ga]}  raw=${JSON.stringify(rawVal)}`);
        }
    }));

    // Set lastWledLabel from prefetched state so the first real WS event
    // only triggers WLED if the state actually changed.
    const snap = resolveWledState();
    if (snap) {
        lastWledLabel = snap.label;
        console.log(`[${timestamp()}] ℹ Prefetch complete -- initial state: ${snap.label} (WLED not changed)`);
    }
}

// -- Main --

async function run() {
    const manageHolder = new TokenHolder('manage');
    const readHolder   = new TokenHolder('read');
    await Promise.all([manageHolder.init(), readHolder.init()]);

    // Resolve all three GAs in parallel
    const readToken = await readHolder.get();
    const GAS = [GA_OPEN, GA_CLOSED, GA_MOVING];

    const metas = await Promise.all(GAS.map(ga => fetchDatapointMetaByGA(ga, readToken)));

    // Build a lookup: datapointId -> { ga, name }
    const dpMap = new Map();
    for (let i = 0; i < GAS.length; i++) {
        const ga   = GAS[i];
        const meta = metas[i];
        if (!meta?.datapointId) throw new Error(`No datapoint found for GA "${ga}"`);
        dpMap.set(meta.datapointId, { ga, name: meta.name ?? ga });
        console.log(`Datapoint : GA=${ga}  datapointId=${meta.datapointId}  "${meta.name ?? ga}"`);
    }

    // Preload current values via REST so the WebSocket handler
    // treats every incoming update as a real event from the start.
    await fetchInitialValues(dpMap, await readHolder.get());

    // Read WLED LED count so effect payloads can use the actual strip length.
    await fetchWledLedCount();

    const datapointIds = [...dpMap.keys()];

    let reconnectAttempts = 0;
    let shuttingDown      = false;
    let got401            = false;

    process.on('SIGTERM', () => {
        console.log('\nSIGTERM received -- shutting down...');
        shuttingDown = true;
        manageHolder.destroy();
        readHolder.destroy();
        process.exit(0);
    });

    process.on('SIGINT', () => {
        console.log('\nInterrupted -- shutting down...');
        shuttingDown = true;
        manageHolder.destroy();
        readHolder.destroy();
        process.exit(0);
    });

    function connect() {
        if (shuttingDown) return;

        const wsUrl = toWebSocketUrl(apiUrl);

        if (reconnectAttempts === 0) {
            console.log(`\nConnecting to ${wsUrl}`);
        } else {
            console.log(`[${timestamp()}] ↺ Reconnecting (attempt ${reconnectAttempts})...`);
        }

        manageHolder.get({ forceRefresh: reconnectAttempts > 0 && got401 }).then(token => {
            got401 = false;

            const ws = new WebSocket(wsUrl, 'gw.knx.org', {
                headers: { Authorization: `Bearer ${token}` }
            });

            let inactivityTimer = null;
            let messageCount    = 0;

            function resetInactivityTimer() {
                clearTimeout(inactivityTimer);
                inactivityTimer = setTimeout(() => {
                    console.log(`\n[${timestamp()}] No messages received for 60s -- closing connection.`);
                    ws.close(1000, 'inactivity-timeout');
                }, 60_000);
            }

            ws.on('open', () => {
                reconnectAttempts = 0;
                console.log(`[${timestamp()}] WebSocket connected`);

                // Token refreshed while connected -> reconnect immediately with new token
                manageHolder.onRefresh(() => {
                    console.log(`[${timestamp()}] ℹ New manage token -- reconnecting WebSocket`);
                    ws.close(1000, 'token-refresh');  // triggers 'close' handler -> scheduleReconnect()
                });

                // Subscribe to all three datapoints in one message
                const subscribeMsg = {
                    action: 'subscribe',
                    items:  datapointIds.map(id => ({ type: 'datapoint', id }))
                };

                console.log('Sending subscribe message:');
                console.log(JSON.stringify(subscribeMsg, null, 2));
                console.log('\nWaiting for events... (Ctrl+C to exit)\n');

                ws.send(JSON.stringify(subscribeMsg));
                resetInactivityTimer();
            });

            ws.on('message', (data) => {
                resetInactivityTimer();
                messageCount += 1;

                let parsed;
                try {
                    parsed = JSON.parse(data.toString());
                } catch {
                    console.log(`[${timestamp()}] message[${messageCount}] (raw): ${data.toString()}`);
                    return;
                }

                const type = parsed.type ?? '?';

                switch (type) {
                    case 'welcome':
                        console.log(`[${timestamp()}] ✓ Welcome -- clientId: ${parsed.data?.clientId}, scope: ${parsed.data?.scope}`);
                        break;

                    case 'subscribed': {
                        const items = parsed.data ?? [];
                        if (items.length === 0) {
                            console.warn(`[${timestamp()}] ⚠ Subscribed -- no items matched`);
                        } else {
                            console.log(`[${timestamp()}] ✓ Subscribed -- ${items.length} item(s)`);
                        }
                        break;
                    }

                    case 'update': {
                        const entries = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
                        for (const entry of entries) {
                            const datapointId = entry?.meta?.datapointId ?? entry?.id;
                            const dp          = dpMap.get(datapointId);
                            const ga          = dp?.ga ?? entry?.meta?.ga ?? '?';
                            const name        = dp?.name ?? '?';
                            const rawVal      = entry?.attributes?.value;
                            const ts          = entry?.attributes?.timestamp ?? '';
                            const tsFormatted = ts ? `  ts=${formatServerTimestamp(ts)}` : '';

                            // Log raw value with type so we can verify what the server sends
                            const rawInfo = `  raw=${JSON.stringify(rawVal)}(${typeof rawVal})`;

                            const boolVal = toBoolean(rawVal);

                            // Update state
                            if (dp) state[ga] = boolVal;

                            console.log(`[${timestamp()}] ★ Update  GA=${ga}  "${name}"  value=${boolVal}${rawInfo}${tsFormatted}`);

                            // -- Plausibility check --
                            if (state[GA_OPEN] === true && state[GA_CLOSED] === false) {
                                console.warn(
                                    `[${timestamp()}] ⚠ Implausible state: top and bottom limit switches active simultaneously`
                                );
                            }

                            // -- Detect movement direction (start) --
                            if (ga === GA_MOVING && boolVal === true && movementStartTs === null) {
                                movementStartTs = Date.now();

                                if (state[GA_OPEN] === true) {
                                    movementDirection = 'closing';
                                } else if (state[GA_CLOSED] === false) {
                                    movementDirection = 'opening';
                                } else {
                                    movementDirection = 'unknown';
                                }

                                console.log(
                                    `[${timestamp()}] 🚪 Movement started (${movementDirection})`
                                );
                            }

                            // -- Log travel time on stop --
                            // durationSec captured immediately for accurate timing;
                            // target resolution and logging deferred to the end-position timer,
                            // so the limit-switch GA is already in state when we evaluate.
                            let travelLogCallback = null;
                            if (ga === GA_MOVING && boolVal === false && movementStartTs !== null) {
                                const durationSec = ((Date.now() - movementStartTs) / 1000).toFixed(1);
                                const direction   = movementDirection;

                                movementStartTs   = null;
                                movementDirection = null;

                                travelLogCallback = () => {
                                    let target = 'unknown';
                                    if (state[GA_OPEN] === true)         target = 'OPEN';
                                    else if (state[GA_CLOSED] === false) target = 'CLOSED';

                                    console.log(
                                        `[${timestamp()}] ⏱ Movement ended -> ${target}, travel time=${durationSec}s`
                                    );

                                    recordTravelTime(direction, parseFloat(durationSec));
                                };
                            }

                            // -- State machine dispatch --
                            if (ga === GA_MOVING && boolVal === true) {
                                // MOVING: cancel any pending end-position eval and
                                // apply the moving state immediately.
                                cancelEndPositionTimer();
                                applyWledState();
                            } else if (ga === GA_MOVING && boolVal === false) {
                                // WAIT_FOR_END_POSITION: the end-position GA arrives
                                // a few ms after moving=false - defer evaluation.
                                scheduleEndPositionEval(travelLogCallback);
                            } else {
                                // Any other GA update (open / closed arriving during
                                // the debounced window, or initial value) - applies now
                                // only if we are not already waiting for end position.
                                if (endPositionTimer === null && state[GA_MOVING] !== true) {
                                    applyWledState();
                                }
                            }
                        }
                        break;
                    }

                    case 'error':
                        console.error(`[${timestamp()}] ✗ Error:`, JSON.stringify(parsed.errors ?? parsed.error ?? parsed));
                        break;

                    case 'ping':
                        console.log(`[${timestamp()}] ♥ Ping  serverTime=${parsed.data?.serverTime ?? '?'}`);
                        break;

                    case 'pong':
                    case 'heartbeat':
                        break;

                    default:
                        console.log(`[${timestamp()}] message[${messageCount}] (${type}):`, JSON.stringify(parsed, null, 2));
                }
            });

            ws.on('close', (code, reason) => {
                clearTimeout(inactivityTimer);
                const reasonStr = reason.toString();
                console.log(`[${timestamp()}] WebSocket closed (${code}): ${reasonStr}`);

                const isTokenRefresh = reasonStr === 'token-refresh';
                const intentional = shuttingDown || code === 1000 || reasonStr === 'user-interrupt';

                if (isTokenRefresh) {
                    // No backoff during scheduled token refresh; reconnect immediately with the new token.
                    reconnectAttempts = 0;
                    scheduleReconnect();
                } else if (!intentional) {
                    scheduleReconnect();
                }
            });

            ws.on('error', (err) => {
                clearTimeout(inactivityTimer);
                if (err.message?.includes('401')) got401 = true;
                console.error(`[${timestamp()}] WebSocket error: ${err.message}`);
            });

        }).catch(err => {
            console.error(`[${timestamp()}] Failed to get manage token: ${err.message}`);
            scheduleReconnect();
        });
    }

    function scheduleReconnect() {
        if (shuttingDown) return;

        reconnectAttempts += 1;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            console.error(`[${timestamp()}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached -- giving up.`);
            process.exit(1);
        }

        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1),
            RECONNECT_MAX_DELAY_MS
        );
        console.log(`[${timestamp()}] Reconnecting in ${delay / 1000}s...`);
        setTimeout(connect, delay);
    }

    connect();
}

// -- Value helpers --

/**
 * Robustly convert a KNX value to boolean.
 * WebSocket delivers native JS booleans; REST API delivers strings.
 * Covers: boolean, "true"/"false", "alarm"/"no alarm", "on"/"off"
 */
function toBoolean(val) {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string')  return val === 'true' || val === 'alarm' || val === 'on';
    return false;
}

// -- Timestamp helpers --

function timestamp() {
    const now = new Date();
    return formatServerTimestamp(now.toISOString());
}

function formatServerTimestamp(isoString) {
    try {
        const d = new Date(isoString);
        return d.toLocaleString('sv-SE', { timeZone: 'Europe/Vienna', hour12: false }).replace('T', ' ')
            + '.' + String(d.getMilliseconds()).padStart(3, '0');
    } catch {
        return isoString;
    }
}

run().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
