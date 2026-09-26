#!/usr/bin/env node
'use strict';

// 3PVC health watchdog.
//
// Probes every site in sites.json for two failure classes and emails
// product-validation@greyorange.com when either trips:
//   - network unreachable  (TCP connect or Influx /ping fails)
//   - stale data           (newest row older than --stale-days, default 3)
//
// It also probes the local Ollama instance (AI capability) and includes its
// state in the report, so a dead AI endpoint is visible even when all sites
// are healthy.
//
// Alert de-duplication: a state file remembers the last time an alert was
// sent. Repeat alerts are throttled to once per --throttle-hours (default 24)
// so a long outage does not spam. When a previously-alerting run goes back to
// healthy, a single "resolved" mail is sent and the state is cleared.
//
// Usage:
//   node bin/health-watchdog.js                 # normal run (alerts as needed)
//   node bin/health-watchdog.js --dry-run       # probe + print, never email
//   node bin/health-watchdog.js --always-send   # ignore throttle (testing)
//   node bin/health-watchdog.js --stale-days 3 --throttle-hours 24
//   node bin/health-watchdog.js --site meli_spo4   # probe one site only

const fs   = require('node:fs');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const alerts = require('../lib/alerts');
const hc     = require('../lib/healthcheck');

const SITES_PATH = path.join(__dirname, '..', 'sites.json');
const STATE_PATH = process.env.HEALTH_STATE_PATH || path.join(__dirname, '..', '.health-state.json');

// product-validation@greyorange.com is the alerting mailbox. Override with
// HEALTH_ALERT_TO for testing without spamming the real distribution list.
const ALERT_TO = process.env.HEALTH_ALERT_TO || 'product-validation@greyorange.com';

function parseArgs(argv) {
    const out = { dryRun: false, alwaysSend: false, staleDays: hc.DEFAULT_STALE_DAYS, throttleHours: 24, site: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--always-send') out.alwaysSend = true;
        else if (a === '--stale-days') out.staleDays = Number(argv[++i]);
        else if (a === '--throttle-hours') out.throttleHours = Number(argv[++i]);
        else if (a === '--site') out.site = argv[++i];
    }
    return out;
}

function loadSites() {
    try {
        return JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));
    } catch (e) {
        throw new Error(`Could not read sites.json: ${e.message}`);
    }
}

// State file tracks { lastAlertAt, alerting, issueKeys } so we can throttle
// repeat alerts and detect recovery.
function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (_) {
        return { lastAlertAt: null, alerting: false, issueKeys: [] };
    }
}
function writeState(state) {
    try {
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    } catch (e) {
        console.error(`[warn] could not write state file ${STATE_PATH}: ${e.message}`);
    }
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Build the alert email (text + html) from the summary.
function renderAlert(summary, ollama, args, resolvedFrom) {
    const stamp = new Date().toISOString();
    const down = summary.issues.length;
    const subject = `[3PVC] HEALTH ALERT — ${down} site${down === 1 ? '' : 's'} down/stale`
        + (summary.stale ? `, ${summary.stale} stale` : '')
        + (ollama && !ollama.reachable ? ', Ollama down' : '');

    const issueRows = summary.issues.map(i => `
        <tr>
            <td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${esc(i.name)}</b></td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;color:${i.kind === 'unreachable' ? '#b91c1c' : (i.kind === 'check-failed' ? '#b45309' : '#b45309')}">${esc(i.kind)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(i.detail)}</td>
        </tr>`).join('');

    const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#222;max-width:820px;margin:auto">
        <h2 style="margin:0 0 8px;color:#b91c1c">3PVC health alert</h2>
        <p style="color:#666;margin:0 0 4px">${esc(stamp)}</p>
        ${resolvedFrom ? `<p style="color:#666;margin:0 0 16px">Repeat alert (throttled to every ${args.throttleHours}h). Previously: ${esc(resolvedFrom)}</p>` : ''}
        <table style="border-collapse:collapse;margin-bottom:16px">
            <tr><td style="padding:4px 14px 4px 0;color:#666">Sites checked</td><td><b>${summary.total}</b></td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#0a7f30">Healthy</td><td><b>${summary.ok}</b></td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#b91c1c">Unreachable</td><td><b>${summary.unreachable}</b></td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#b45309">Stale (&gt;${args.staleDays}d)</td><td><b>${summary.stale}</b></td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#b45309">Check failed</td><td><b>${summary.checkFailed}</b></td></tr>
            ${ollama ? `<tr><td style="padding:4px 14px 4px 0;color:${ollama.reachable ? '#0a7f30' : '#b91c1c'}">Ollama (AI)</td><td><b>${ollama.reachable ? 'up' : 'DOWN'}</b></td></tr>` : ''}
        </table>
        <h3 style="margin:16px 0 8px">Affected sites</h3>
        <table style="border-collapse:collapse;font-size:13px;width:100%">
            <thead><tr style="background:#f5f5f5">
                <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">site</th>
                <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">kind</th>
                <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">detail</th>
            </tr></thead>
            <tbody>${issueRows}</tbody>
        </table>
        <p style="color:#666;margin-top:18px;font-size:12px">
            Sent by the 3PVC health watchdog.
            <b>unreachable</b> = TCP or Influx /ping did not answer (service not responding).
            <b>stale</b> = reachable, but newest row is older than ${args.staleDays} days.
            <b>check-failed</b> = reachable, but the freshness query itself failed.
        </p>
    </body></html>`;

    const text = [
        '3PVC HEALTH ALERT',
        `Generated ${stamp}`,
        resolvedFrom ? `Repeat alert (throttled to every ${args.throttleHours}h). Previously: ${resolvedFrom}` : null,
        '',
        `Sites checked:    ${summary.total}`,
        `Healthy:          ${summary.ok}`,
        `Unreachable:      ${summary.unreachable}`,
        `Stale (>${args.staleDays}d): ${summary.stale}`,
        `Check failed:     ${summary.checkFailed}`,
        ollama ? `Ollama (AI):      ${ollama.reachable ? 'up' : 'DOWN'}` : null,
        '',
        'Affected sites:',
        ...summary.issues.map(i => `  - ${i.name} [${i.kind}]: ${i.detail}`),
        ollama && !ollama.reachable ? `  - ollama [ai-down]: ${ollama.error || 'unreachable'}` : null
    ].filter(l => l !== null).join('\n');

    return { subject, html, text };
}

async function main() {
    const args = parseArgs(process.argv);
    const staleDays = Number.isFinite(args.staleDays) ? args.staleDays : hc.DEFAULT_STALE_DAYS;
    const opts = { staleDays, nowMs: Date.now() };

    let sites = loadSites();
    if (args.site) {
        if (!sites[args.site]) throw new Error(`Unknown site: ${args.site}`);
        sites = { [args.site]: sites[args.site] };
    }

    console.log(`[${new Date().toISOString()}] probing ${Object.keys(sites).length} site(s) (stale threshold ${staleDays}d)…`);
    const results = await hc.checkAllSites(sites, opts);
    const ollama = await hc.checkOllama();
    const summary = hc.summarize(results, opts.nowMs);

    // Per-site one-liner
    for (const r of results) {
        const state = !r.reachable ? 'UNREACHABLE'
            : r.noMeasurement ? 'ok (no measurement)'
            : r.probeFailed ? 'CHECK-FAILED'
            : r.latestMs == null ? 'NO DATA'
            : (hc.isStale(r.latestMs, staleDays, opts.nowMs) ? `STALE (${hc.ageInDays(r.latestMs, opts.nowMs).toFixed(1)}d)` : 'ok');
        console.log(`  ${state.padEnd(18)} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
    }
    console.log(`  ${(ollama.reachable ? 'ok' : 'DOWN').padEnd(18)} ollama (${ollama.reachable ? (ollama.models.join(', ') || 'no models') : ollama.error})`);
    console.log(`summary: ${summary.ok}/${summary.total} healthy, ${summary.unreachable} unreachable, ${summary.stale} stale, ${summary.checkFailed} check-failed`);

    if (args.dryRun) {
        console.log('[dry-run] would evaluate alert decision, but not send.');
        return;
    }

    const state = readState();
    const throttleMs = args.throttleHours * 60 * 60 * 1000;
    const decision = args.alwaysSend
        ? { send: !summary.healthy, reason: summary.healthy ? 'healthy' : 'issues-detected (forced)' }
        : hc.decideAlert({ summary, lastSentMs: state.lastAlertAt, throttleMs, nowMs: opts.nowMs });

    // Recovery: previously alerting, now healthy -> one "resolved" note.
    if (summary.healthy && state.alerting) {
        try {
            await alerts.sendMail({
                to: ALERT_TO,
                subject: '[3PVC] HEALTH RECOVERED — all sites healthy',
                text: `3PVC health watchdog: all ${summary.total} site(s) are reachable with fresh data (< ${staleDays}d).\nResolved ${new Date().toISOString()}.`,
                html: `<p>3PVC health watchdog: all <b>${summary.total}</b> site(s) are reachable with fresh data (&lt; ${staleDays}d).</p><p>Resolved ${new Date().toISOString()}.</p>`
            });
            console.log('sent: HEALTH RECOVERED mail');
        } catch (e) {
            console.error(`[error] failed to send recovery mail: ${e.message}`);
        }
        writeState({ lastAlertAt: null, alerting: false, issueKeys: [] });
        return;
    }

    if (!decision.send) {
        console.log(`no alert sent (${decision.reason}).`);
        return;
    }

    const resolvedFrom = state.alerting ? (state.issueKeys || []).join(', ') : null;
    const { subject, html, text } = renderAlert(summary, ollama, { ...args, staleDays }, resolvedFrom);
    try {
        await alerts.sendMail({ to: ALERT_TO, subject, text, html });
        console.log(`sent: HEALTH ALERT to ${ALERT_TO} (${summary.issues.length} issue(s))`);
    } catch (e) {
        console.error(`[error] failed to send alert mail: ${e.message}`);
        process.exitCode = 1;
        return; // don't record lastAlertAt on failure so we retry next run
    }
    writeState({
        lastAlertAt: opts.nowMs,
        alerting: true,
        issueKeys: summary.issues.map(i => `${i.name}:${i.kind}`)
    });
}

main().catch((e) => {
    console.error('[fatal]', e.message);
    process.exit(1);
});
