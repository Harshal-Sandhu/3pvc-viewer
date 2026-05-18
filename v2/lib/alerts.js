'use strict';

// Compliance-alert builder.
//
// Given a site config, fetches the latest bot snapshot from InfluxDB and the
// reference compliance rows, diffs them, then produces:
//   - a plaintext + HTML email summary
//   - an .xlsx Buffer with the full per-bot breakdown
//
// Used by:
//   - POST /api/alerts/:site/send (manual trigger from admin UI)
//   - scheduler.js                 (per-site cron-driven sends)
//
// Mirrors the frontend diff logic in public/app.js — see getDiffForRow().

const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');

// Same set as on the frontend.
const DIFF_IGNORE = new Set(['time', 'api_version']);

const INFLUX_TIMEOUT_MS = 20000;
// Reports include the last 24h of bot snapshots. Within that window we still
// skip `dead_bot` rows when picking each bot's representative row — see the
// dedup logic in buildReport().
const MAIN_LOOKBACK = '24h';
const ROW_LIMIT = 20000;

async function queryInflux(site, q) {
    const url = `http://${site.ip}:${site.port}/query?db=${encodeURIComponent(site.db)}&q=${encodeURIComponent(q)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), INFLUX_TIMEOUT_MS);
    try {
        const r = await fetch(url, { signal: ac.signal });
        const text = await r.text();
        if (!r.ok) {
            throw new Error(`InfluxDB HTTP ${r.status}: ${text.slice(0, 300)}`);
        }
        const body = JSON.parse(text);
        const r0 = (body.results && body.results[0]) || {};
        if (r0.error) throw new Error(`InfluxDB: ${r0.error}`);
        const s0 = (r0.series && r0.series[0]) || null;
        return { columns: (s0 && s0.columns) || [], rows: (s0 && s0.values) || [] };
    } finally {
        clearTimeout(timer);
    }
}

// Returns Map<api_version, complianceRow>. Most recent row wins per api_version.
function indexCompliance(complianceTable) {
    const out = new Map();
    const apiIdx = complianceTable.columns.indexOf('api_version');
    if (apiIdx === -1) return out;
    for (const row of complianceTable.rows) {
        const v = row[apiIdx];
        if (v == null) continue;
        const key = String(v);
        if (!out.has(key)) out.set(key, row);
    }
    return out;
}

// For one bot row, returns { ref, diffs[{ field, actual, expected }] }.
// ref === null means no compliance row matched (unknown api_version).
function diffRow(botColumns, botRow, complianceTable, complianceIndex) {
    const apiIdx = botColumns.indexOf('api_version');
    if (apiIdx === -1) return { ref: null, diffs: [] };
    const api = botRow[apiIdx];
    if (api == null) return { ref: null, diffs: [] };
    const compRow = complianceIndex.get(String(api));
    if (!compRow) return { ref: null, diffs: [] };

    const diffs = [];
    for (let i = 0; i < botColumns.length; i++) {
        const col = botColumns[i];
        if (DIFF_IGNORE.has(col)) continue;
        const ci = complianceTable.columns.indexOf(col);
        if (ci === -1) continue;
        const actual = botRow[i];
        const expected = compRow[ci];
        if (actual == null || expected == null) continue;
        if (String(actual).trim() !== String(expected).trim()) {
            diffs.push({ field: col, actual, expected });
        }
    }
    return { ref: compRow, diffs };
}

// Builds the full report (summary + xlsx buffer) for one site.
// Returns { ok, siteName, totals, mismatches, xlsxBuffer, columns }.
async function buildReport(siteName, site) {
    const measurement = site.measurement;
    const complianceMeasurement = site.complianceMeasurement || 'compliance_details';

    const mainQ = `SELECT * FROM "${measurement}" WHERE time > now() - ${MAIN_LOOKBACK} ORDER BY time DESC LIMIT ${ROW_LIMIT}`;
    const compQ = `SELECT * FROM "${complianceMeasurement}" ORDER BY time DESC LIMIT 500`;

    const [bots, compliance] = await Promise.all([
        queryInflux(site, mainQ),
        queryInflux(site, compQ).catch(() => ({ columns: [], rows: [] }))
    ]);

    // Keep the latest *known* row per bot. Rows with api_version='dead_bot' (or
    // null) mean the bot was offline at that timestamp — those are useless for
    // a compliance comparison, so we walk past them and take the most recent
    // row that actually reports a real api_version. If a bot has only dead_bot
    // rows in the window, we still keep one so the report shows it as Unknown.
    const botIdx = bots.columns.indexOf('bot_id');
    const apiIdxMain = bots.columns.indexOf('api_version');
    const isUsableApi = (v) => v != null && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'dead_bot';
    let uniqueRows = bots.rows;
    if (botIdx !== -1) {
        const bestKnown = new Map();   // bot_id -> row with usable api_version (first seen, which is latest)
        const fallback = new Map();    // bot_id -> any latest row, used if no known row exists
        for (const r of bots.rows) {
            const id = r[botIdx];
            if (id == null) continue;
            if (!fallback.has(id)) fallback.set(id, r);
            if (!bestKnown.has(id) && apiIdxMain !== -1 && isUsableApi(r[apiIdxMain])) {
                bestKnown.set(id, r);
            }
        }
        uniqueRows = [];
        for (const [id, r] of fallback) {
            uniqueRows.push(bestKnown.get(id) || r);
        }
    }

    const complianceIndex = indexCompliance(compliance);

    let compatible = 0;
    let incompatible = 0;
    let unknown = 0;
    const mismatches = []; // [{ bot_id, ip, api_version, diffs: [{field, actual, expected}], expected: [[field, value]] }]

    for (const row of uniqueRows) {
        const { ref, diffs } = diffRow(bots.columns, row, compliance, complianceIndex);
        if (!ref) { unknown++; continue; }
        if (diffs.length === 0) { compatible++; continue; }
        incompatible++;
        mismatches.push({
            bot_id: botIdx !== -1 ? row[botIdx] : '',
            ip: bots.columns.indexOf('ip') !== -1 ? row[bots.columns.indexOf('ip')] : '',
            api_version: bots.columns.indexOf('api_version') !== -1 ? row[bots.columns.indexOf('api_version')] : '',
            vda_version: bots.columns.indexOf('vda_version') !== -1 ? row[bots.columns.indexOf('vda_version')] : '',
            diffs
        });
    }

    const xlsxBuffer = await renderXlsx({
        siteName,
        complianceColumns: compliance.columns,
        botColumns: bots.columns,
        rows: uniqueRows,
        complianceIndex,
        complianceTable: compliance,
        totals: { total: uniqueRows.length, compatible, incompatible, unknown }
    });

    return {
        siteName,
        totals: { total: uniqueRows.length, compatible, incompatible, unknown },
        mismatches,
        xlsxBuffer
    };
}

async function renderXlsx({ siteName, botColumns, rows, complianceTable, complianceIndex, totals }) {
    const wb = new ExcelJS.Workbook();
    wb.creator = '3PVC Viewer';
    wb.created = new Date();

    const summary = wb.addWorksheet('Summary');
    summary.columns = [
        { header: 'Metric', key: 'metric', width: 28 },
        { header: 'Value', key: 'value', width: 18 }
    ];
    summary.getRow(1).font = { bold: true };
    summary.addRows([
        { metric: 'Site', value: siteName },
        { metric: 'Report generated', value: new Date().toISOString() },
        { metric: 'Bots evaluated', value: totals.total },
        { metric: 'Compatible', value: totals.compatible },
        { metric: 'Incompatible', value: totals.incompatible },
        { metric: 'Unknown (no compliance match)', value: totals.unknown }
    ]);

    const detail = wb.addWorksheet('Per-bot comparison');
    // Columns: bot identity + Status + every overlapping compliance field as
    // its own column (actual on top, expected as a 2nd row group inside one
    // cell would be confusing — instead we emit two columns per field).
    const ignoreInCols = new Set(['time']);
    const trackedFields = [];
    for (const col of complianceTable.columns) {
        if (ignoreInCols.has(col)) continue;
        if (botColumns.indexOf(col) === -1) continue;
        trackedFields.push(col);
    }

    const headerCells = ['bot_id', 'ip', 'api_version', 'status', 'diff_count', ...trackedFields.flatMap(f => [f, `${f} (expected)`])];
    detail.addRow(headerCells);
    const headerRow = detail.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: 'middle' };
    headerRow.eachCell(c => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
        c.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } };
    });
    detail.views = [{ state: 'frozen', ySplit: 1 }];

    const botIdx = botColumns.indexOf('bot_id');
    const ipIdx = botColumns.indexOf('ip');
    const apiIdx = botColumns.indexOf('api_version');

    const badFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    const okFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } };
    const unkFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F1F1' } };
    const diffCellFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCA5A5' } };

    for (const row of rows) {
        const { ref, diffs } = diffRow(botColumns, row, complianceTable, complianceIndex);
        const status = !ref ? 'Unknown' : (diffs.length === 0 ? 'Compatible' : 'Incompatible');
        const diffByField = new Map(diffs.map(d => [d.field, d]));

        const xlRow = [
            botIdx !== -1 ? row[botIdx] : '',
            ipIdx !== -1 ? row[ipIdx] : '',
            apiIdx !== -1 ? row[apiIdx] : '',
            status,
            diffs.length
        ];
        for (const f of trackedFields) {
            const i = botColumns.indexOf(f);
            const actual = i === -1 ? '' : row[i];
            const ci = complianceTable.columns.indexOf(f);
            const expected = (ref && ci !== -1) ? ref[ci] : '';
            xlRow.push(actual == null ? '' : actual);
            xlRow.push(expected == null ? '' : expected);
        }
        const added = detail.addRow(xlRow);

        // Whole-row fill based on status.
        const fill = !ref ? unkFill : (diffs.length === 0 ? okFill : badFill);
        added.eachCell({ includeEmpty: true }, (cell) => {
            cell.fill = fill;
            cell.border = { bottom: { style: 'hair', color: { argb: 'FFDDDDDD' } } };
        });
        // Stronger highlight on the specific differing cells.
        for (let i = 0; i < trackedFields.length; i++) {
            const f = trackedFields[i];
            if (diffByField.has(f)) {
                // 1-based; first 5 fixed cols + (i*2)+1 for actual, +2 for expected
                const actualColIdx = 5 + i * 2 + 1;
                const expectedColIdx = actualColIdx + 1;
                const a = added.getCell(actualColIdx);
                const e = added.getCell(expectedColIdx);
                a.fill = diffCellFill;
                a.font = { bold: true, color: { argb: 'FF7F1D1D' } };
                e.font = { italic: true, color: { argb: 'FF065F46' } };
            }
        }
    }

    // Auto-size identity columns; leave the long firmware columns alone.
    detail.getColumn(1).width = 18;
    detail.getColumn(2).width = 16;
    detail.getColumn(3).width = 14;
    detail.getColumn(4).width = 14;
    detail.getColumn(5).width = 11;
    for (let i = 6; i <= headerCells.length; i++) detail.getColumn(i).width = 22;

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
}

// Renders the email summary HTML (and a plaintext fallback) from the report.
function renderEmail(report) {
    const { siteName, totals, mismatches } = report;
    const subject = totals.incompatible > 0
        ? `[3PVC] ${siteName}: ${totals.incompatible} bot${totals.incompatible === 1 ? '' : 's'} incompatible`
        : `[3PVC] ${siteName}: all bots compatible`;

    const top = mismatches.slice(0, 20);
    const remaining = Math.max(0, mismatches.length - top.length);

    const rowsHtml = top.map(m => {
        const firstFew = m.diffs.slice(0, 3)
            .map(d => `<code>${escapeHtml(d.field)}</code>: ${escapeHtml(String(d.actual))} → ${escapeHtml(String(d.expected))}`)
            .join('<br>');
        const more = m.diffs.length > 3 ? `<br><span style="color:#666">+${m.diffs.length - 3} more</span>` : '';
        return `<tr>
            <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(String(m.bot_id || ''))}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(String(m.ip || ''))}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(String(m.api_version || ''))}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;color:#b91c1c;font-weight:600">${m.diffs.length}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee">${firstFew}${more}</td>
        </tr>`;
    }).join('');

    const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#222;max-width:880px;margin:auto">
        <h2 style="margin:0 0 8px">3PVC compliance report — ${escapeHtml(siteName)}</h2>
        <p style="color:#666;margin:0 0 16px">Generated ${new Date().toISOString()}</p>
        <table style="border-collapse:collapse;margin-bottom:18px">
            <tr><td style="padding:4px 14px 4px 0;color:#666">Bots evaluated</td><td style="padding:4px 0"><b>${totals.total}</b></td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#0a7f30">Compatible</td><td style="padding:4px 0"><b>${totals.compatible}</b></td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#b91c1c">Incompatible</td><td style="padding:4px 0"><b>${totals.incompatible}</b></td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#666">Unknown api_version</td><td style="padding:4px 0"><b>${totals.unknown}</b></td></tr>
        </table>
        ${mismatches.length === 0 ? '<p style="color:#0a7f30">No mismatches.</p>' : `
        <h3 style="margin:18px 0 8px">Mismatched bots${remaining ? ` (showing first ${top.length})` : ''}</h3>
        <table style="border-collapse:collapse;font-size:13px;width:100%">
            <thead><tr style="background:#f5f5f5">
                <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">bot_id</th>
                <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">ip</th>
                <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">api_version</th>
                <th style="padding:6px 10px;text-align:center;border-bottom:1px solid #ddd">diffs</th>
                <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">sample fields</th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
        </table>
        ${remaining ? `<p style="color:#666;margin-top:8px">+ ${remaining} more — see attached spreadsheet for the full list.</p>` : ''}
        `}
        <p style="color:#666;margin-top:18px;font-size:12px">Attached: <code>${reportFilename(siteName)}</code> — per-bot comparison with full firmware detail and expected values.</p>
    </body></html>`;

    const text = [
        `3PVC compliance report — ${siteName}`,
        `Generated ${new Date().toISOString()}`,
        '',
        `Bots evaluated:  ${totals.total}`,
        `Compatible:      ${totals.compatible}`,
        `Incompatible:    ${totals.incompatible}`,
        `Unknown:         ${totals.unknown}`,
        '',
        mismatches.length === 0 ? 'No mismatches.' : `Mismatched bots: ${mismatches.length}`,
        ...top.map(m => `  - ${m.bot_id} (${m.ip}) api=${m.api_version}: ${m.diffs.length} diff(s)`)
    ].join('\n');

    return { subject, html, text };
}

function reportFilename(siteName) {
    const safe = String(siteName).replace(/[^a-zA-Z0-9_-]+/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
    return `3pvc_${safe}_${stamp}.xlsx`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// MIME builder. nodemailer's streamTransport produces a raw RFC 5322 message
// without trying to deliver it — we then ship that via Gmail's HTTP API. The
// SMTP transport route doesn't work for Workspace accounts where the admin
// has blocked SMTP submission, but the HTTP API uses the same OAuth token.
let _mimeBuilder = null;
function getMimeBuilder() {
    if (_mimeBuilder) return _mimeBuilder;
    _mimeBuilder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    return _mimeBuilder;
}

// Access-token cache: mint from refresh_token, reuse until 60s before expiry.
let _accessToken = null;
let _accessTokenExpiresAt = 0;
async function getAccessToken() {
    const now = Date.now();
    if (_accessToken && now < _accessTokenExpiresAt - 60_000) return _accessToken;
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
        throw new Error('OAuth not configured. Run `npm run oauth-setup` to mint a refresh token.');
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
    if (!r.ok || !body.access_token) {
        throw new Error(`Failed to refresh OAuth token: ${JSON.stringify(body)}`);
    }
    _accessToken = body.access_token;
    _accessTokenExpiresAt = now + (body.expires_in || 3600) * 1000;
    return _accessToken;
}

// Send a fully-built MIME buffer via Gmail HTTP API. Returns the message id.
async function sendViaGmailApi(mimeBuffer) {
    const accessToken = await getAccessToken();
    const raw = mimeBuffer.toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw })
    });
    const body = await r.json();
    if (!r.ok) {
        throw new Error(`Gmail API send failed (HTTP ${r.status}): ${JSON.stringify(body).slice(0, 400)}`);
    }
    return body.id;
}

function resolveRecipients(site) {
    const fromSite = Array.isArray(site.recipients)
        ? site.recipients
        : (typeof site.recipients === 'string' ? site.recipients.split(',') : []);
    const normalized = fromSite.map(s => String(s).trim()).filter(Boolean);
    if (normalized.length) return normalized;
    const fallback = (process.env.REPORT_RECIPIENT || '').split(',').map(s => s.trim()).filter(Boolean);
    return fallback;
}

// High-level: build + send for one site. Returns { sent, recipients, totals }.
async function sendReport(siteName, site) {
    const recipients = resolveRecipients(site);
    if (recipients.length === 0) {
        throw new Error('No recipients configured (site.recipients or REPORT_RECIPIENT).');
    }
    if (!process.env.GMAIL_USER) {
        throw new Error('GMAIL_USER is not set in .env.');
    }
    const report = await buildReport(siteName, site);
    const { subject, html, text } = renderEmail(report);

    // Build MIME locally, ship via Gmail HTTP API. See sendViaGmailApi() above.
    const builder = getMimeBuilder();
    const info = await builder.sendMail({
        from: process.env.GMAIL_USER,
        to: recipients.join(','),
        subject,
        text,
        html,
        attachments: [
            { filename: reportFilename(siteName), content: report.xlsxBuffer }
        ]
    });
    const messageId = await sendViaGmailApi(info.message);
    return { sent: true, recipients, totals: report.totals, messageId };
}

module.exports = { buildReport, sendReport, renderEmail, resolveRecipients, reportFilename };
