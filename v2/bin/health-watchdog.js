#!/usr/bin/env node
'use strict';

// 3PVC health watchdog.
//
// Probes every site in sites.json and the local Ollama instance, then mails a
// single detailed daily digest. Who receives it and when it goes out are
// configured on the admin page (stored in health-alert-config.json).
//
// Two failure classes are reported per site:
//   - unreachable   TCP connect or Influx /ping did not answer
//   - stale         reachable, but the newest row is older than staleDays
//   - check-failed  reachable, but the freshness query itself failed
//   - no-data       reachable, but the measurement has no rows in the window
//
// Scheduling: the systemd timer ticks often (every 15 min) and simply records
// the latest snapshot. A digest goes out once per day at schedule.time, on
// schedule.dayOfWeek, as long as one has not already been sent that day.
// Setting alertOnNewOutage overrides the cadence and mails immediately when a
// site that was healthy becomes unreachable.
//
// Usage:
//   node bin/health-watchdog.js                 # tick: probe, store, maybe send
//   node bin/health-watchdog.js --dry-run       # probe + print, never email
//   node bin/health-watchdog.js --force         # send the digest now, ignoring the schedule
//   node bin/health-watchdog.js --site meli_spo4   # probe one site only
//   node bin/health-watchdog.js --print-config  # show effective config

const fs   = require('node:fs');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const alerts = require('../lib/alerts');
const hc     = require('../lib/healthcheck');
const digest = require('../lib/healthDigest');
const { siteStatus, renderDigest, fmtTs } = digest;

const SITES_PATH = path.join(__dirname, '..', 'sites.json');
const STATE_PATH = process.env.HEALTH_STATE_PATH || path.join(__dirname, '..', '.health-state.json');
const CONFIG_PATH = process.env.HEALTH_ALERT_CONFIG || path.join(__dirname, '..', 'health-alert-config.json');

function parseArgs(argv) {
    const out = { dryRun: false, force: false, site: null, printConfig: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--force' || a === '--always-send') out.force = true;
        else if (a === '--site') out.site = argv[++i];
        else if (a === '--print-config') out.printConfig = true;
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

function loadConfig() {
    try {
        return hc.normalizeHealthConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[warn] could not read ${CONFIG_PATH}: ${e.message} — using defaults`);
        return hc.defaultHealthConfig();
    }
}

// Environment override wins over the file so a one-off manual run can be
// pointed somewhere else without editing the admin config.
function effectiveRecipients(config) {
    if (process.env.HEALTH_ALERT_TO) {
        return { to: process.env.HEALTH_ALERT_TO.split(',').map(s => s.trim()).filter(Boolean), cc: [], bcc: [] };
    }
    const r = config.recipients;
    return r.to.length || r.cc.length || r.bcc.length ? r : { to: ['product-validation@greyorange.com'], cc: [], bcc: [] };
}

// State: { lastSentDate, lastSentAt, lastIssues, snapshot, alerting }.
// The snapshot is kept so the digest can report the full picture, not just the
// sites that happen to be broken at send time.
function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (_) {
        return { lastSentDate: null, lastSentAt: null, lastIssues: [], snapshot: null, alerting: false };
    }
}
function writeState(state) {
    try {
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    } catch (e) {
        console.error(`[warn] could not write state file ${STATE_PATH}: ${e.message}`);
    }
}


async function main() {
    const args = parseArgs(process.argv);
    const config = loadConfig();

    if (args.printConfig) {
        console.log(JSON.stringify({ configPath: CONFIG_PATH, config, recipients: effectiveRecipients(config) }, null, 2));
        return;
    }

    let sites = loadSites();
    if (args.site) {
        if (!sites[args.site]) throw new Error(`Unknown site: ${args.site}`);
        sites = { [args.site]: sites[args.site] };
    }

    const opts = { staleDays: config.staleDays, nowMs: Date.now() };

    console.log(`[${new Date().toISOString()}] probing ${Object.keys(sites).length} site(s) (stale threshold ${config.staleDays}d)…`);
    const results = await hc.checkAllSites(sites, opts);
    const ollama = await hc.checkOllama();
    const summary = hc.summarize(results, opts.nowMs);

    for (const r of results) {
        const status = siteStatus(r, config.staleDays, opts.nowMs);
        const extra = r.latestMs && status === 'ok' ? ` (newest ${fmtTs(r.latestMs)})` : '';
        console.log(`  ${status.padEnd(14)} ${r.name}${extra}${r.error ? ` — ${r.error}` : ''}`);
    }
    console.log(`  ${(ollama.reachable ? 'ok' : 'DOWN').padEnd(14)} ollama (${ollama.reachable ? (ollama.models.join(', ') || 'no models') : ollama.error})`);
    console.log(`summary: ${summary.ok}/${summary.total} healthy, ${summary.unreachable} unreachable, ${summary.stale} stale/no-data, ${summary.checkFailed} check-failed`);

    const state = readState();
    const snapshot = {
        at: opts.nowMs,
        results: results.map(r => ({
            name: r.name, reachable: r.reachable, probeFailed: !!r.probeFailed,
            noMeasurement: !!r.noMeasurement, latestMs: r.latestMs || null, error: r.error || null
        })),
        ollama: { reachable: !!ollama.reachable, models: ollama.models || [], error: ollama.error || null }
    };
    const issueKeys = summary.issues.map(i => `${i.name}:${i.kind}`);

    if (args.dryRun) {
        const next = hc.nextSendAt({ nowMs: opts.nowMs, schedule: config.schedule });
        const due = hc.dueForDailySend({ nowMs: opts.nowMs, schedule: config.schedule, lastSentDate: state.lastSentDate });
        console.log(`[dry-run] enabled=${config.enabled} sendToday=${due.due} lastSent=${state.lastSentDate || 'never'} nextSendAt=${next ? fmtTs(next) : 'n/a'}`);
        return;
    }

    // Always persist the latest snapshot, whatever we decide about mailing.
    state.snapshot = snapshot;
    state.alerting = issueKeys.length > 0;
    state.lastIssues = issueKeys;

    const due = hc.dueForDailySend({ nowMs: opts.nowMs, schedule: config.schedule, lastSentDate: state.lastSentDate });
    if (due.markDate) state.lastSentDate = due.markDate; // skipped a non-send day

    const newlyUnreachable = config.alertOnNewOutage
        && summary.unreachable > 0
        && !(state.lastSnapshot && state.lastSnapshot.unreachableCount > 0);

    const shouldSend = args.force
        || (config.enabled && (newlyUnreachable || (due.due && (summary.issues.length > 0 || config.sendWhenAllHealthy))));

    if (!shouldSend) {
        const reason = !config.enabled ? 'digest disabled in admin'
            : !due.due ? `not the scheduled send moment (next ${fmtTs(hc.nextSendAt({ nowMs: opts.nowMs, schedule: config.schedule }) || 0)})`
            : 'nothing to report';
        writeState(state);
        console.log(`no digest sent (${reason}).`);
        return;
    }

    const recipients = effectiveRecipients(config);
    const { subject, html, text } = renderDigest({ results, summary, ollama, config, nowMs: opts.nowMs, isTest: args.force });
    try {
        await alerts.sendMail({
            to: recipients.to.length ? recipients.to : undefined,
            cc: recipients.cc.length ? recipients.cc : undefined,
            bcc: recipients.bcc.length ? recipients.bcc : undefined,
            subject, text, html
        });
    } catch (e) {
        console.error(`[error] failed to send digest: ${e.message}`);
        process.exitCode = 1;
        writeState(state);
        return; // leave lastSentDate untouched so the next tick retries
    }

    const allRecipients = [...recipients.to, ...recipients.cc, ...recipients.bcc].join(', ') || '(none)';
    console.log(`sent: digest to ${allRecipients} (${summary.issues.length} site(s) need attention)`);

    if (!args.force) {
        state.lastSentDate = hc.localDateKey(opts.nowMs);
        state.lastSentAt = opts.nowMs;
    }
    state.lastSnapshot = { unreachableCount: summary.unreachable };
    writeState(state);
}

main().catch((e) => {
    console.error('[fatal]', e.message);
    process.exit(1);
});
