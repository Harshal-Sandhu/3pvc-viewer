#!/usr/bin/env node
// One-off mailer for prepared per-site CSV exports.
//
// Reads CSV files from a directory, derives per-site Compatible / Incompatible /
// Dead counts, renders the same body format the user wants, attaches every CSV
// in the folder, and sends via Gmail HTTP API (same plumbing as lib/alerts.js).
//
// Usage:
//   node bin/send-prepared-mail.js TTP   <recipient>
//   node bin/send-prepared-mail.js RELAY <recipient>

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const nodemailer = require('nodemailer');

const DIRS = {
    TTP:   '/Users/harshal.s/mail/TTp',
    RELAY: '/Users/harshal.s/mail/RElay'
};

function parseCsv(text) {
    // Simple CSV reader; the exports are well-formed (no embedded commas in
    // values that matter for the totals — version/compat strings are plain).
    const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.length > 0);
    if (lines.length === 0) return { columns: [], rows: [] };
    const columns = splitCsvRow(lines[0]);
    const rows = lines.slice(1).map(splitCsvRow);
    return { columns, rows };
}

function splitCsvRow(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
            if (c === '"') { inQuotes = false; continue; }
            cur += c;
        } else {
            if (c === '"') { inQuotes = true; continue; }
            if (c === ',') { out.push(cur); cur = ''; continue; }
            cur += c;
        }
    }
    out.push(cur);
    return out;
}

function siteNameFromFile(file) {
    return file.replace(/_\d+\.csv$/, '').replace(/\.csv$/, '');
}

function isDeadStr(v) {
    if (v == null) return true;
    const s = String(v).trim().toLowerCase();
    return s === '' || s === 'dead_bot';
}

// Returns { total, compatible, incompatible, dead } for one site CSV.
function summariseSite(agentType, csv) {
    const { columns, rows } = csv;
    const idx = (n) => columns.indexOf(n);

    // RELAY CSVs carry an explicit `compatibility` column — trust it.
    // Values look like "Compatible" / "Incompatible (3)" / "Dead", so match
    // by prefix rather than equality.
    if (agentType === 'RELAY' && idx('compatibility') !== -1) {
        const cIdx  = idx('compatibility');
        const bIdx  = idx('bot_id');
        const ipIdx = idx('ip');
        const seen = new Set();
        let total = 0, compatible = 0, incompatible = 0, dead = 0;
        for (const r of rows) {
            const id = bIdx !== -1 ? r[bIdx]
                     : ipIdx !== -1 ? r[ipIdx]
                     : `${total}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const v = String(r[cIdx] || '').trim().toLowerCase();
            total++;
            if (v.startsWith('compatible'))        compatible++;
            else if (v.startsWith('incompatible')) incompatible++;
            else if (v.startsWith('dead'))         dead++;
            else                                    dead++;   // unknown -> dead, surfaces data issues
        }
        return { total, compatible, incompatible, dead };
    }

    // TTP CSVs have no compatibility column. Scope to HAI rows (version
    // contains "hai"), then derive status by comparing vda_version vs
    // released_version. Dedupe by ip since these exports don't ship bot_id.
    const vIdx = idx('version');
    const vdaIdx = idx('vda_version');
    const relIdx = idx('released_version');
    const ipIdx  = idx('ip');
    const seen = new Set();
    let total = 0, compatible = 0, incompatible = 0, dead = 0;
    for (const r of rows) {
        if (vIdx !== -1 && !/hai/i.test(String(r[vIdx] || ''))) continue;
        const id = ipIdx !== -1 ? r[ipIdx] : `${total}`;
        if (seen.has(id)) continue;
        seen.add(id);
        total++;
        const vda = vdaIdx !== -1 ? r[vdaIdx] : '';
        const rel = relIdx !== -1 ? r[relIdx] : '';
        if (isDeadStr(vda)) { dead++; continue; }
        if (String(vda).trim() === String(rel).trim()) compatible++;
        else incompatible++;
    }
    return { total, compatible, incompatible, dead };
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderEmail(agentType, perSite, stamp) {
    const agg = perSite.reduce((a, s) => {
        a.total        += s.totals.total;
        a.compatible   += s.totals.compatible;
        a.incompatible += s.totals.incompatible;
        a.dead         += s.totals.dead;
        return a;
    }, { total: 0, compatible: 0, incompatible: 0, dead: 0 });

    // Bots evaluated = compatible + incompatible (dead excluded from the
    // headline and the per-site row, per request).
    const evaluated = agg.compatible + agg.incompatible;
    const evaluatedFor = (s) => s.totals.compatible + s.totals.incompatible;

    const rowsHtml = perSite.map(s => `
        <tr>
            <td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${escapeHtml(s.name)}</b></td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${evaluatedFor(s)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#0a7f30">${s.totals.compatible}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#b91c1c"><b>${s.totals.incompatible}</b></td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(s.attachedFile)}</td>
        </tr>`).join('');

    const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#222;max-width:920px;margin:auto">
        <h2 style="margin:0 0 8px">3PVC compliance report — ${escapeHtml(agentType)} (${perSite.length} site${perSite.length === 1 ? '' : 's'})</h2>
        <p style="color:#666;margin:0 0 16px">Generated ${escapeHtml(stamp)}</p>
        <table style="border-collapse:collapse;margin-bottom:18px">
            <tr><td style="padding:4px 14px 4px 0;color:#666">Bots evaluated</td><td style="padding:4px 0"><b>${evaluated}</b></td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#0a7f30">Compatible</td><td style="padding:4px 0"><b>${agg.compatible}</b></td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#b91c1c">Incompatible</td><td style="padding:4px 0"><b>${agg.incompatible}</b></td></tr>
        </table>
        <h3 style="margin:18px 0 8px">Per-site breakdown</h3>
        <table style="border-collapse:collapse;font-size:13px;width:100%">
            <thead><tr style="background:#f5f5f5">
                <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">Site</th>
                <th style="padding:6px 10px;text-align:right;border-bottom:1px solid #ddd">Bots</th>
                <th style="padding:6px 10px;text-align:right;border-bottom:1px solid #ddd">Compatible</th>
                <th style="padding:6px 10px;text-align:right;border-bottom:1px solid #ddd">Incompatible</th>
                <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">Attached file</th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
        </table>
    </body></html>`;

    const text = [
        `3PVC compliance report — ${agentType} (${perSite.length} sites)`,
        `Generated ${stamp}`,
        '',
        `Bots evaluated:   ${evaluated}`,
        `Compatible:       ${agg.compatible}`,
        `Incompatible:     ${agg.incompatible}`,
        '',
        'Per-site breakdown:',
        ...perSite.map(s =>
            `  - ${s.name}: ${evaluatedFor(s)} bots / ${s.totals.compatible} compatible / ${s.totals.incompatible} incompatible`)
    ].join('\n');

    return { html, text };
}

let _accessToken = null;
let _accessTokenExpiresAt = 0;
async function getAccessToken() {
    const now = Date.now();
    if (_accessToken && now < _accessTokenExpiresAt - 60_000) return _accessToken;
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
        throw new Error('OAuth not configured in .env');
    }
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: GOOGLE_REFRESH_TOKEN,
            grant_type: 'refresh_token'
        }).toString()
    });
    const body = await r.json();
    if (!r.ok || !body.access_token) throw new Error(`OAuth refresh failed: ${JSON.stringify(body)}`);
    _accessToken = body.access_token;
    _accessTokenExpiresAt = now + (body.expires_in || 3600) * 1000;
    return _accessToken;
}

async function sendViaGmail(mimeBuffer) {
    const token = await getAccessToken();
    const raw = mimeBuffer.toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw })
    });
    const body = await r.json();
    if (!r.ok) throw new Error(`Gmail API send failed (HTTP ${r.status}): ${JSON.stringify(body).slice(0, 400)}`);
    return body.id;
}

function resolveRecipients(agentType, cliArg) {
    // CLI override: a single explicit recipient (used for personal previews).
    if (cliArg) return { to: [cliArg], cc: [], bcc: [] };
    // Otherwise read mail-recipients.json next to v2/. Supports either a flat
    // {to,cc,bcc} shape or per-agent overrides {TTP:{...}, RELAY:{...}}.
    const cfgPath = path.join(__dirname, '..', 'mail-recipients.json');
    if (!fs.existsSync(cfgPath)) {
        throw new Error(`No recipient on CLI and ${cfgPath} not found.`);
    }
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const perAgent = cfg[agentType];
    const src = perAgent && (perAgent.to || perAgent.cc || perAgent.bcc) ? perAgent : cfg;
    const norm = (a) => Array.isArray(a) ? a.map(s => String(s).trim()).filter(Boolean) : [];
    return { to: norm(src.to), cc: norm(src.cc), bcc: norm(src.bcc) };
}

async function main() {
    const agentType = (process.argv[2] || '').toUpperCase();
    const cliArg = process.argv[3];
    if (!agentType || !DIRS[agentType]) {
        console.error('Usage: node bin/send-prepared-mail.js <TTP|RELAY> [override-recipient-email]');
        process.exit(2);
    }
    if (!process.env.GMAIL_USER) {
        console.error('GMAIL_USER missing in .env');
        process.exit(2);
    }
    const recipients = resolveRecipients(agentType, cliArg);
    if (recipients.to.length === 0 && recipients.cc.length === 0 && recipients.bcc.length === 0) {
        console.error('No recipients configured (mail-recipients.json) and no CLI override given.');
        process.exit(2);
    }

    const dir = DIRS[agentType];
    // If a site appears more than once (e.g. owen_n_minor_177...csv exists in
    // two timestamps), keep only the most recently modified file per site
    // name so the email never double-counts a re-export.
    const all = fs.readdirSync(dir)
        .filter(f => f.toLowerCase().endsWith('.csv'))
        .map(f => ({ name: f, site: siteNameFromFile(f), mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }));
    const bySite = new Map();
    for (const e of all) {
        const prev = bySite.get(e.site);
        if (!prev || e.mtimeMs > prev.mtimeMs) bySite.set(e.site, e);
    }
    const files = [...bySite.values()].sort((a, b) => a.site.localeCompare(b.site)).map(e => e.name);
    if (files.length === 0) {
        console.error(`No CSV files in ${dir}`);
        process.exit(2);
    }
    // Tell the user which files are being used so resends are obvious.
    console.log(`Files used (latest per site):`);
    for (const f of files) console.log(`  ${f}`);

    const perSite = [];
    for (const f of files) {
        const full = path.join(dir, f);
        const csv = parseCsv(fs.readFileSync(full, 'utf8'));
        const totals = summariseSite(agentType, csv);
        perSite.push({ name: siteNameFromFile(f), file: full, attachedFile: f, totals });
        console.log(`  ${siteNameFromFile(f).padEnd(30)} total=${totals.total} compat=${totals.compatible} incompat=${totals.incompatible} dead=${totals.dead}`);
    }

    const stamp = new Date().toISOString();
    const { html, text } = renderEmail(agentType, perSite, stamp);

    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const info = await builder.sendMail({
        from: process.env.GMAIL_USER,
        // If To is empty, Gmail still needs *something* in To — fall back to
        // the sender so a CC/BCC-only send still goes through.
        to:  recipients.to.length  ? recipients.to.join(',')  : process.env.GMAIL_USER,
        cc:  recipients.cc.length  ? recipients.cc.join(',')  : undefined,
        bcc: recipients.bcc.length ? recipients.bcc.join(',') : undefined,
        subject: `3PVC Report for ${agentType}`,
        text,
        html,
        attachments: perSite.map(s => ({ filename: s.attachedFile, path: s.file }))
    });
    const messageId = await sendViaGmail(info.message);
    console.log(`\nSent ${agentType} mail — Gmail message id: ${messageId}`);
    console.log(`  To:  ${recipients.to.join(', ')  || '(sender only)'}`);
    if (recipients.cc.length)  console.log(`  Cc:  ${recipients.cc.join(', ')}`);
    if (recipients.bcc.length) console.log(`  Bcc: ${recipients.bcc.join(', ')}`);
}

main().catch(err => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
