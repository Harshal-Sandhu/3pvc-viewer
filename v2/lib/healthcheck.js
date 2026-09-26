'use strict';

// Health watchdog checks for the 3PVC viewer.
//
// Two independent failure classes are detected per site:
//   1. Network/connectivity failure — the site's InfluxDB is unreachable
//      (TCP connect fails, or the /ping endpoint does not answer 204).
//   2. Stale data — the site's measurement HAS a latest row, but that row is
//      older than the freshness threshold (default 3 days), meaning the
//      collector stopped writing even though the DB is up.
//
// A third, non-site check covers the local Ollama instance (AI capability):
//   3. Ollama unreachable on its default port (11434).
//
// The evaluation helpers (isStale, summarize, decideAlert) are pure and unit
// tested in test/healthcheck.test.mjs. Only the network probes touch the
// network, and every probe is bounded by an AbortController timeout.

const net = require('net');

const DEFAULT_STALE_DAYS  = 3;
const DEFAULT_TCP_TIMEOUT_MS     = 5000;
// 30s matches the viewer's site-columns Influx timeout — a remote site can be
// slow to answer, and a short timeout here would raise a false alert.
const DEFAULT_HTTP_TIMEOUT_MS    = 30000;
const OLLAMA_DEFAULT_URL  = 'http://127.0.0.1:11434';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// True when `latestMs` (epoch ms of newest row, or null when no data) is older
// than `staleDays`. No data at all counts as stale — an empty measurement is
// exactly the "data not getting populated" case we want to surface.
function isStale(latestMs, staleDays, nowMs) {
    const threshold = staleDays * 24 * 60 * 60 * 1000;
    if (latestMs == null) return true;
    const age = nowMs - latestMs;
    return age > threshold;
}

function ageInDays(latestMs, nowMs) {
    if (latestMs == null) return null;
    return (nowMs - latestMs) / (24 * 60 * 60 * 1000);
}

// Turn raw per-site probe results into a health summary.
// Each `result` is { name, reachable, latestMs, rowCount, error, staleDays, nowMs }.
// Returns { healthy, total, unreachable, stale, ok, issues[] }.
function summarize(results, nowMs) {
    const now = nowMs || Date.now();
    const issues = [];
    for (const r of results) {
        if (!r.reachable) {
            issues.push({ name: r.name, kind: 'unreachable', detail: r.error || 'InfluxDB unreachable' });
            continue;
        }
        if (r.noMeasurement) {
            // Reachable, but the site has no measurement configured — nothing
            // to judge staleness on, so don't report it.
            continue;
        }
        if (r.latestMs == null) {
            issues.push({ name: r.name, kind: 'no-data', detail: 'no rows in measurement' });
            continue;
        }
        if (isStale(r.latestMs, r.staleDays != null ? r.staleDays : DEFAULT_STALE_DAYS, now)) {
            const days = ageInDays(r.latestMs, now);
            issues.push({
                name: r.name,
                kind: 'stale',
                detail: `latest data is ${days.toFixed(1)}d old (> ${r.staleDays != null ? r.staleDays : DEFAULT_STALE_DAYS}d)`
            });
        }
    }
    const unreachable = issues.filter(i => i.kind === 'unreachable').length;
    const stale = issues.filter(i => i.kind === 'stale' || i.kind === 'no-data').length;
    return {
        total: results.length,
        ok: results.length - issues.length,
        unreachable,
        stale,
        healthy: issues.length === 0,
        issues
    };
}

// Decide whether an alert email should be sent this run, given the last time
// an alert was sent for this exact issue-set. Re-alerts are throttled to once
// per `throttleMs` so a persistently-down site does not spam every run.
function decideAlert({ summary, lastSentMs, throttleMs, nowMs }) {
    if (summary.healthy) return { send: false, reason: 'healthy' };
    const now = nowMs || Date.now();
    if (lastSentMs != null && now - lastSentMs < throttleMs) {
        return { send: false, reason: 'throttled' };
    }
    return { send: true, reason: 'issues-detected' };
}

// ---------------------------------------------------------------------------
// Network probes
// ---------------------------------------------------------------------------

// Bounded TCP connect. Resolves { ok } — never throws.
function tcpProbe(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (ok, err) => {
            if (done) return;
            done = true;
            try { socket.destroy(); } catch (_) { /* ignore */ }
            resolve({ ok, error: err });
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false, `tcp timeout after ${timeoutMs}ms`));
        socket.once('error', (e) => finish(false, `tcp error: ${e.message}`));
        socket.connect(port, host);
    });
}

async function httpGet(url, timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const r = await fetch(url, { signal: ac.signal });
        const text = await r.text();
        return { ok: r.ok, status: r.status, body: text };
    } catch (err) {
        return { ok: false, status: 0, body: '', error: err.name === 'AbortError' ? `http timeout after ${timeoutMs}ms` : err.message };
    } finally {
        clearTimeout(timer);
    }
}

// Probe one site:
//   - TCP connect to the Influx port
//   - /ping should answer 204 (auth-free liveness)
//   - SELECT last(...) to get the newest row timestamp + a rough row count
function checkSite(siteName, site, opts = {}) {
    const tcpTimeout = opts.tcpTimeoutMs || DEFAULT_TCP_TIMEOUT_MS;
    const httpTimeout = opts.httpTimeoutMs || DEFAULT_HTTP_TIMEOUT_MS;
    const staleDays = opts.staleDays != null ? opts.staleDays : DEFAULT_STALE_DAYS;
    const nowMs = opts.nowMs || Date.now();
    const port = site.port || 8086;

    return (async () => {
        const base = { name: siteName, staleDays, nowMs, reachable: false, latestMs: null, rowCount: 0 };

        const tcp = await tcpProbe(site.ip, port, tcpTimeout);
        if (!tcp.ok) return { ...base, error: tcp.error };

        const ping = await httpGet(`http://${site.ip}:${port}/ping`, httpTimeout);
        if (!ping.ok) return { ...base, error: `ping failed: ${ping.error || `HTTP ${ping.status}`}` };

        const measurement = site.measurement;
        if (!measurement) {
            // Reachable but no measurement configured — healthy as far as we can tell.
            return { ...base, reachable: true, noMeasurement: true };
        }

        // Newest row only — we need just its timestamp, so LIMIT 1. A wide
        // `SELECT * ... LIMIT 5000` takes 15-30s+ on these sites and would
        // time out, producing false "unreachable" alerts even though the
        // viewer reads the same data fine. LIMIT 1 returns in well under a
        // second. Also aggregate-free (ORDER BY DESC): these InfluxDB 1.8.10
        // instances return an empty series for last()/count() queries.
        const q = `SELECT * FROM "${measurement}" WHERE time > now() - ${staleDays * 2}d ORDER BY time DESC LIMIT 1`;
        const url = `http://${site.ip}:${port}/query?db=${encodeURIComponent(site.db)}&q=${encodeURIComponent(q)}`;
        const res = await httpGet(url, httpTimeout);
        if (!res.ok) return { ...base, error: `query failed: ${res.error || `HTTP ${res.status}`}` };

        let parsed;
        try {
            parsed = JSON.parse(res.body);
        } catch (e) {
            return { ...base, error: `bad JSON: ${e.message}` };
        }
        const r0 = (parsed.results && parsed.results[0]) || {};
        if (r0.error) return { ...base, error: `influx: ${r0.error}` };

        const series = (r0.series && r0.series[0]) || null;
        if (!series || !series.values || !series.values.length) {
            // Reachable and queryable, but no rows in the window.
            return { ...base, reachable: true, latestMs: null, rowCount: 0 };
        }
        const timeIdx = series.columns.indexOf('time');
        const lastRaw = timeIdx !== -1 ? series.values[0][timeIdx] : null;
        const latestMs = lastRaw ? new Date(lastRaw).getTime() : null;

        return { ...base, reachable: true, latestMs: isNaN(latestMs) ? null : latestMs, rowCount: series.values.length };
    })();
}

// Probe the local Ollama instance. Returns { name:'ollama', reachable, models[] }.
async function checkOllama(opts = {}) {
    const url = opts.url || process.env.OLLAMA_URL || OLLAMA_DEFAULT_URL;
    // Ollama is local — it either answers in well under a second or is down.
    const timeout = opts.httpTimeoutMs || 5000;
    const res = await httpGet(`${url.replace(/\/$/, '')}/api/tags`, timeout);
    if (!res.ok) {
        return { name: 'ollama', reachable: false, url, error: res.error || `HTTP ${res.status}` };
    }
    let models = [];
    try {
        const body = JSON.parse(res.body);
        models = (body.models || []).map(m => m.name || m.model).filter(Boolean);
    } catch (_) { /* models list is best-effort */ }
    return { name: 'ollama', reachable: true, url, models };
}

// Run every site's probe in parallel, never rejecting — a failed probe is
// already reported in-band as { reachable:false, error }.
async function checkAllSites(sites, opts = {}) {
    const names = Object.keys(sites || {});
    return Promise.all(names.map(name => checkSite(name, sites[name], opts)));
}

module.exports = {
    DEFAULT_STALE_DAYS,
    DEFAULT_TCP_TIMEOUT_MS,
    DEFAULT_HTTP_TIMEOUT_MS,
    OLLAMA_DEFAULT_URL,
    isStale,
    ageInDays,
    summarize,
    decideAlert,
    tcpProbe,
    httpGet,
    checkSite,
    checkOllama,
    checkAllSites
};
