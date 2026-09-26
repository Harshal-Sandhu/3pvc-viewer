'use strict';

// Renders the 3PVC health digest email (subject + html + text).
//
// Shared by bin/health-watchdog.js (scheduled run) and the admin "send test
// now" endpoint, so a test mail is byte-identical to the real thing.
//
// House style for this mail: discreet framing, maximum detail. It is a status
// report, not a fire alarm — a calm subject line and muted chrome, with every
// site listed (healthy ones included) so the reader can see the whole picture
// at a glance instead of only the failures.

const hc = require('./healthcheck');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtTs(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Per-site status used consistently by the console output, the table and the
// alert-key logic.
function siteStatus(r, staleDays, nowMs) {
    if (!r.reachable) return 'unreachable';
    if (r.noMeasurement) return 'no measurement';
    if (r.probeFailed) return 'check-failed';
    if (r.latestMs == null) return 'no-data';
    return hc.isStale(r.latestMs, staleDays, nowMs) ? 'stale' : 'ok';
}

function renderDigest({ results, summary, ollama, config, nowMs, isTest }) {
    const staleDays = config.staleDays;
    const down = summary.issues.length;
    const ollamaDown = !!(ollama && !ollama.reachable);
    const allOk = down === 0 && !ollamaDown;

    const headline = allOk
        ? `${summary.ok}/${summary.total} sites healthy`
        : `${down} site${down === 1 ? '' : 's'} need attention`;
    const subject = `[3PVC] Health digest — ${headline}`
        + (ollamaDown ? ' (Ollama down)' : '');

    const attention = summary.unreachable
        + ' unreachable, ' + summary.stale + ' stale/no-data, ' + summary.checkFailed + ' check-failed';

    const meta = [
        `Generated:        ${fmtTs(nowMs)}`,
        `Stale threshold:  ${staleDays} day(s)`,
        `Schedule:         daily at ${config.schedule.time} on ${config.schedule.dayOfWeek.map(d => DAY_NAMES[d]).join(', ')}`,
        isTest ? 'NOTE:            manually triggered test digest' : null
    ].filter(Boolean);

    const rowsHtml = results.map(r => {
        const status = siteStatus(r, staleDays, nowMs);
        const age = r.latestMs ? `${hc.ageInDays(r.latestMs, nowMs).toFixed(1)}d` : '—';
        const colour = status === 'ok' ? '#0a7f30' : (status === 'unreachable' ? '#b91c1c' : '#b45309');
        return `<tr>
            <td style="padding:5px 10px;border-bottom:1px solid #eee"><b>${esc(r.name)}</b></td>
            <td style="padding:5px 10px;border-bottom:1px solid #eee;color:${colour};white-space:nowrap">${esc(status)}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #eee;white-space:nowrap">${esc(fmtTs(r.latestMs))}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #eee">${esc(age)}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #eee">${esc(r.error || '')}</td>
        </tr>`;
    }).join('');

    const rowsText = results.map(r => {
        const status = siteStatus(r, staleDays, nowMs);
        const age = r.latestMs ? `${hc.ageInDays(r.latestMs, nowMs).toFixed(1)}d` : '—';
        return `  ${status.padEnd(14)} ${r.name.padEnd(26)} newest=${fmtTs(r.latestMs)} (${age})${r.error ? `  [${r.error}]` : ''}`;
    });

    const ollamaText = ollama
        ? (ollama.reachable
            ? `  ok              ollama (AI)               models: ${ollama.models.join(', ') || 'none'}`
            : `  DOWN            ollama (AI)               ${ollama.error || 'unreachable'}`)
        : null;

    const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#222;max-width:900px;margin:auto;font-size:14px">
        <p style="margin:0 0 2px;color:#888;font-size:12px">3PVC health watchdog</p>
        <h2 style="margin:0 0 12px;font-weight:600;font-size:17px">${esc(headline)}</h2>
        <table style="border-collapse:collapse;margin-bottom:14px">
            <tr><td style="padding:2px 14px 2px 0;color:#666">Sites checked</td><td><b>${summary.total}</b></td></tr>
            <tr><td style="padding:2px 14px 2px 0;color:#666">Healthy</td><td><b>${summary.ok}</b></td></tr>
            <tr><td style="padding:2px 14px 2px 0;color:#666">Need attention</td><td><b>${down}</b> (${esc(attention)})</td></tr>
            <tr><td style="padding:2px 14px 2px 0;color:#666">Ollama (AI)</td><td><b>${ollama ? (ollama.reachable ? 'up' : 'down') : 'n/a'}</b>${ollama && ollama.reachable && ollama.models.length ? ` — ${esc(ollama.models.join(', '))}` : ''}</td></tr>
        </table>
        <h3 style="margin:14px 0 6px;font-size:14px">All sites</h3>
        <table style="border-collapse:collapse;font-size:12px;width:100%">
            <thead><tr style="background:#f6f6f6">
                <th style="padding:5px 10px;text-align:left;border-bottom:1px solid #ddd">site</th>
                <th style="padding:5px 10px;text-align:left;border-bottom:1px solid #ddd">status</th>
                <th style="padding:5px 10px;text-align:left;border-bottom:1px solid #ddd">newest data</th>
                <th style="padding:5px 10px;text-align:left;border-bottom:1px solid #ddd">age</th>
                <th style="padding:5px 10px;text-align:left;border-bottom:1px solid #ddd">detail</th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
        </table>
        <h3 style="margin:16px 0 6px;font-size:14px">Legend</h3>
        <p style="color:#666;font-size:12px;margin:0 0 12px;line-height:1.7">
            <b>ok</b> reachable, newest data younger than ${staleDays}d<br>
            <b>unreachable</b> TCP connect or Influx <code>/ping</code> did not answer<br>
            <b>stale</b> reachable, but the newest row is older than ${staleDays}d<br>
            <b>no-data</b> reachable, but no rows in the recent window<br>
            <b>check-failed</b> reachable, but the freshness query itself failed or timed out
        </p>
        <p style="color:#999;font-size:11px;margin:0;line-height:1.6">${meta.map(esc).join('<br>')}</p>
    </body></html>`;

    const text = [
        '3PVC HEALTH DIGEST',
        '',
        ...meta,
        '',
        `Sites checked:    ${summary.total}`,
        `Healthy:          ${summary.ok}`,
        `Need attention:   ${down} (${attention})`,
        ollama ? `Ollama (AI):      ${ollama.reachable ? 'up' : 'DOWN'}` : null,
        '',
        'ALL SITES:',
        ...rowsText,
        ollamaText,
        '',
        `Legend: ok = fresh (<${staleDays}d) · unreachable = no TCP//ping answer · stale = newest row too old`,
        '        no-data = no rows in window · check-failed = freshness query failed'
    ].filter(l => l !== null).join('\n');

    return { subject, html, text };
}

module.exports = { renderDigest, siteStatus, fmtTs };
