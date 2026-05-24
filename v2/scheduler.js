'use strict';

// Per-site compliance-report scheduler.
//
// Reads sites.json once at startup, then registers a node-cron job per site
// whose `alertSchedule.enabled` is true. The same lib/alerts.js used by the
// admin "Send now" button generates the report and emails it.
//
// Run: `npm run scheduler` — runs independently of the web server.
// To pick up site changes, restart this process.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const alerts = require('./lib/alerts');

const SITES_PATH = path.join(__dirname, 'sites.json');
const AGENT_RECIPIENTS_PATH = path.join(__dirname, 'agent-recipients.json');
const TIMEZONE = process.env.SCHEDULER_TIMEZONE || undefined;

function loadSites() {
    try {
        return JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));
    } catch (e) {
        console.error('Failed to read sites.json:', e.message);
        process.exit(1);
    }
}

function loadAgentRecipients() {
    try {
        const raw = JSON.parse(fs.readFileSync(AGENT_RECIPIENTS_PATH, 'utf8'));
        return { TTP: Array.isArray(raw.TTP) ? raw.TTP : [], RELAY: Array.isArray(raw.RELAY) ? raw.RELAY : [] };
    } catch (e) {
        return { TTP: [], RELAY: [] };
    }
}

// Convert {frequency, time HH:MM, dayOfWeek} into a 5-field cron expression.
// Returns null if the schedule isn't valid/runnable.
function scheduleToCron(sched) {
    if (!sched || !sched.enabled) return null;
    const time = typeof sched.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(sched.time) ? sched.time : '08:00';
    const [hh, mm] = time.split(':').map(Number);
    const dow = Number.isInteger(sched.dayOfWeek) && sched.dayOfWeek >= 0 && sched.dayOfWeek <= 6 ? sched.dayOfWeek : 1;

    switch (sched.frequency) {
        case 'hourly':   return `${mm} * * * *`;
        case 'daily':    return `${mm} ${hh} * * *`;
        case 'weekdays': return `${mm} ${hh} * * 1-5`;
        case 'weekly':   return `${mm} ${hh} * * ${dow}`;
        default:         return null;
    }
}

async function runForSite(siteName, site) {
    const start = Date.now();
    // Re-read the per-agent list every run so admin edits take effect without a restart.
    const ar = loadAgentRecipients();
    const extra = ar[site.agentType] || [];
    try {
        const result = await alerts.sendReport(siteName, site, { agentTypeRecipients: extra });
        const ms = Date.now() - start;
        console.log(`[${new Date().toISOString()}] ${siteName}: sent to ${result.recipients.join(', ')} — ${result.totals.incompatible} incompatible / ${result.totals.total} bots (${ms}ms)`);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ${siteName}: FAILED — ${err.message}`);
    }
}

function main() {
    const sites = loadSites();
    const entries = Object.entries(sites);
    if (entries.length === 0) {
        console.error('No sites configured.');
        process.exit(1);
    }
    let scheduled = 0;
    for (const [name, site] of entries) {
        const expr = scheduleToCron(site.alertSchedule);
        if (!expr) {
            console.log(`- ${name}: scheduling disabled`);
            continue;
        }
        if (!cron.validate(expr)) {
            console.error(`- ${name}: invalid cron "${expr}" — skipping`);
            continue;
        }
        const opts = TIMEZONE ? { timezone: TIMEZONE } : undefined;
        cron.schedule(expr, () => runForSite(name, site), opts);
        scheduled++;
        console.log(`- ${name}: ${expr}${TIMEZONE ? ` (${TIMEZONE})` : ''}  → ${alerts.resolveRecipients(site).join(', ') || '(no recipients — will fail)'}`);
    }
    if (scheduled === 0) {
        console.log('No sites have scheduling enabled. Exiting.');
        process.exit(0);
    }
    console.log(`\nScheduler running. ${scheduled} job(s) registered. Ctrl+C to stop.`);
}

main();
