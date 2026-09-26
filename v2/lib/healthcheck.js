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
        if (r.probeFailed) {
            // Reachable and answering, but the freshness query itself failed
            // (e.g. the site is so slow it timed out). Distinct from
            // "unreachable" — we could not determine freshness.
            issues.push({ name: r.name, kind: 'check-failed', detail: r.error || 'freshness query failed' });
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
    const checkFailed = issues.filter(i => i.kind === 'check-failed').length;
    return {
        total: results.length,
        ok: results.length - issues.length,
        unreachable,
        stale,
        checkFailed,
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
        // The site answered /ping, so it IS reachable — a failure here means we
        // could not determine freshness, not that the site is down.
        if (!res.ok) return { ...base, reachable: true, probeFailed: true, error: `freshness query failed: ${res.error || `HTTP ${res.status}`}` };

        let parsed;
        try {
            parsed = JSON.parse(res.body);
        } catch (e) {
            return { ...base, reachable: true, probeFailed: true, error: `bad JSON: ${e.message}` };
        }
        const r0 = (parsed.results && parsed.results[0]) || {};
        if (r0.error) return { ...base, reachable: true, probeFailed: true, error: `influx: ${r0.error}` };

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

// ---------------------------------------------------------------------------
// Health-mail configuration (edited from the admin page)
//
// Shape:
//   {
//     enabled: true,
//     recipients: { to: [], cc: [], bcc: [] },
//     schedule: { time: '08:00', dayOfWeek: [0..6] },   // 0 = Sunday
//     staleDays: 3,
//     sendWhenAllHealthy: true,     // still send the daily digest when nothing is wrong
//     alertOnNewOutage: false       // ignore the daily cadence and page immediately
//   }
// ---------------------------------------------------------------------------

const DEFAULT_SEND_TIME = '08:00';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function defaultHealthConfig() {
    return {
        enabled: true,
        recipients: { to: [], cc: [], bcc: [] },
        schedule: { time: DEFAULT_SEND_TIME, dayOfWeek: ALL_DAYS.slice() },
        staleDays: DEFAULT_STALE_DAYS,
        sendWhenAllHealthy: true,
        alertOnNewOutage: false
    };
}

function normalizeRecipients(raw) {
    const bucket = (raw && typeof raw === 'object') ? raw : {};
    const list = (v) => (Array.isArray(v) ? v.filter(s => typeof s === 'string') : []);
    return { to: list(bucket.to), cc: list(bucket.cc), bcc: list(bucket.bcc) };
}

// Tolerant loader: a missing/partial file falls back to defaults field by field,
// so a hand-edited config can never take the watchdog down.
function normalizeHealthConfig(raw) {
    const d = defaultHealthConfig();
    if (!raw || typeof raw !== 'object') return d;
    const sched = (raw.schedule && typeof raw.schedule === 'object') ? raw.schedule : {};
    const time = typeof sched.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(sched.time) ? sched.time : d.schedule.time;
    const days = Array.isArray(sched.dayOfWeek)
        ? Array.from(new Set(sched.dayOfWeek.filter(n => Number.isInteger(n) && n >= 0 && n <= 6))).sort((a, b) => a - b)
        : d.schedule.dayOfWeek;
    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
        recipients: normalizeRecipients(raw.recipients),
        schedule: { time, dayOfWeek: days.length ? days : d.schedule.dayOfWeek.slice() },
        staleDays: Number.isFinite(raw.staleDays) && raw.staleDays > 0 ? raw.staleDays : d.staleDays,
        sendWhenAllHealthy: typeof raw.sendWhenAllHealthy === 'boolean' ? raw.sendWhenAllHealthy : d.sendWhenAllHealthy,
        alertOnNewOutage: typeof raw.alertOnNewOutage === 'boolean' ? raw.alertOnNewOutage : d.alertOnNewOutage
    };
}

function validateEmails(list, label) {
    const out = [];
    for (const raw of list || []) {
        const v = String(raw).trim();
        if (!v) continue;
        if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
            return { ok: false, error: `${label}: invalid email "${v}"` };
        }
        out.push(v);
    }
    return { ok: true, value: out };
}

// Strict validator for the admin PUT endpoint. Returns a fully normalized
// config, or { ok: false, error } with a message safe to show the user.
function validateHealthConfig(input) {
    if (input == null) return { ok: true, value: defaultHealthConfig() };
    if (typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, error: 'Config must be an object' };
    }
    const base = defaultHealthConfig();
    const out = { ...base };

    if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
        out.enabled = input.enabled;
    }
    if (input.staleDays !== undefined) {
        const n = Number(input.staleDays);
        if (!Number.isFinite(n) || n < 1 || n > 365) return { ok: false, error: 'staleDays must be between 1 and 365' };
        out.staleDays = n;
    }
    for (const flag of ['sendWhenAllHealthy', 'alertOnNewOutage']) {
        if (input[flag] === undefined) continue;
        if (typeof input[flag] !== 'boolean') return { ok: false, error: `${flag} must be true or false` };
        out[flag] = input[flag];
    }
    if (input.recipients !== undefined) {
        const r = input.recipients;
        if (r === null) {
            out.recipients = base.recipients;
        } else {
            if (typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: 'recipients must be { to, cc, bcc }' };
            const norm = {};
            for (const field of ['to', 'cc', 'bcc']) {
                if (r[field] === undefined) { norm[field] = base.recipients[field]; continue; }
                const v = Array.isArray(r[field]) ? r[field] : (typeof r[field] === 'string' ? r[field].split(',') : null);
                if (v === null) return { ok: false, error: `recipients.${field} must be an array or comma-separated string` };
                const check = validateEmails(v, `recipients.${field}`);
                if (!check.ok) return check;
                norm[field] = Array.from(new Set(check.value.map(s => s.toLowerCase())));
            }
            out.recipients = norm;
        }
    }
    if (input.schedule !== undefined) {
        const s = input.schedule;
        if (s === null) {
            out.schedule = base.schedule;
        } else {
            if (typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: 'schedule must be { time, dayOfWeek }' };
            if (s.time !== undefined) {
                if (!(typeof s.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time))) {
                    return { ok: false, error: 'schedule.time must be HH:MM in 24h format' };
                }
                out.schedule.time = s.time;
            }
            if (s.dayOfWeek !== undefined) {
                const d = Array.isArray(s.dayOfWeek) ? s.dayOfWeek : (typeof s.dayOfWeek === 'number' ? [s.dayOfWeek] : null);
                if (d === null) return { ok: false, error: 'schedule.dayOfWeek must be an array of 0-6 (0 = Sunday)' };
                const days = Array.from(new Set(d.filter(n => Number.isInteger(n) && n >= 0 && n <= 6))).sort((a, b) => a - b);
                if (!days.length) return { ok: false, error: 'schedule.dayOfWeek must include at least one day' };
                out.schedule.dayOfWeek = days;
            }
        }
    }
    return { ok: true, value: out };
}

// Local-date key (YYYY-MM-DD) used to mark which day's digest has gone out.
function localDateKey(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localWeekday(ms) {
    return new Date(ms).getDay();
}

function minutesOfDay(ms) {
    const d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes();
}

function parseHhMm(s) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s || '');
    return m ? (Number(m[1]) * 60 + Number(m[2])) : Number(DEFAULT_SEND_TIME.slice(0, 2)) * 60;
}

// True when the daily digest for the day containing `nowMs` has not been sent
// yet and the configured send time has arrived (or passed).
// Returns { due, markDate }: markDate should be persisted on a non-send-day so
// the scheduler does not keep re-evaluating a day it already decided to skip.
function dueForDailySend({ nowMs, schedule, lastSentDate }) {
    if (!schedule) return { due: false, markDate: null };
    const today = localDateKey(nowMs);
    if (lastSentDate === today) return { due: false, markDate: null }; // already sent today
    if (!schedule.dayOfWeek.includes(localWeekday(nowMs))) {
        return { due: false, markDate: today }; // not a send day — skip today
    }
    if (minutesOfDay(nowMs) < parseHhMm(schedule.time)) {
        return { due: false, markDate: null }; // before today's send time
    }
    return { due: true, markDate: null };
}

// Next moment the digest is allowed to go out, for display in the admin page.
function nextSendAt({ nowMs, schedule }) {
    if (!schedule) return null;
    const target = parseHhMm(schedule.time);
    const days = schedule.dayOfWeek.length ? schedule.dayOfWeek : ALL_DAYS;
    for (let i = 0; i < 8; i++) {
        const probe = new Date(nowMs);
        probe.setDate(probe.getDate() + i);
        if (!days.includes(probe.getDay())) continue;
        const at = new Date(probe);
        at.setHours(Math.floor(target / 60), target % 60, 0, 0);
        if (at.getTime() > nowMs) return at.getTime();
    }
    return null;
}

module.exports = {
    DEFAULT_STALE_DAYS,
    DEFAULT_TCP_TIMEOUT_MS,
    DEFAULT_HTTP_TIMEOUT_MS,
    OLLAMA_DEFAULT_URL,
    ALL_DAYS,
    isStale,
    ageInDays,
    summarize,
    decideAlert,
    tcpProbe,
    httpGet,
    checkSite,
    checkOllama,
    checkAllSites,
    defaultHealthConfig,
    normalizeHealthConfig,
    validateHealthConfig,
    localDateKey,
    localWeekday,
    dueForDailySend,
    nextSendAt
};
