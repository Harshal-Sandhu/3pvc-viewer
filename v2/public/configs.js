// 3PVC Configs page.
// - ES module, no globals on window
// - All rendered values go through textContent (no innerHTML interpolation)

import { getFeaturedSettings, parseGroupedByBot, parseSingleBotValue } from './configs-logic.js';

const $ = (sel) => document.querySelector(sel);
const els = {
    loginView: $('#login-view'),
    appView: $('#app-view'),

    otpForm: $('#otp-form'),
    otpEmail: $('#otp-email'),
    otpSendBtn: $('#otp-send-btn'),
    otpCodeRow: $('#otp-code-row'),
    otpCode: $('#otp-code'),
    otpStatus: $('#otp-status'),
    otpError: $('#otp-error'),

    who: $('#who'),
    logout: $('#logout-btn'),
    adminLink: $('#admin-link'),

    site: $('#site-select'),
    bot: $('#bot-select'),
    load: $('#load-btn'),

    status: $('#config-status'),
    view: $('#config-view'),
    featuredBody: $('#config-featured-body'),
    featuredEmpty: $('#config-featured-empty')
};

// Featured settings — a curated subset of firmware_configs worth showing up
// front. VTM and HTM bots populate different subsets of /system/nav/config
// and /hardware/basic; rows simply don't render when a path isn't present,
// so the same list works for both without needing to know the bot type.
// (Field list + extraction logic live in configs-logic.js so they're unit
// testable outside the browser.)
function renderFeaturedSettings(cfg) {
    els.featuredBody.replaceChildren();
    const rows = getFeaturedSettings(cfg);
    for (const { label, value } of rows) {
        const tr = document.createElement('tr');
        const labelTd = document.createElement('td');
        labelTd.textContent = label;
        const valueTd = document.createElement('td');
        valueTd.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
        tr.append(labelTd, valueTd);
        els.featuredBody.append(tr);
    }
    els.featuredEmpty.hidden = rows.length > 0;
}

const state = {
    sites: [],
    selectedSite: null,
    rows: [],
    columns: []
};

// ---------------------------------------------------------------------------
// Fetch helper (same shape as app.js/operation.js)
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        ...opts
    });
    let body = null;
    try { body = await res.json(); } catch { /* ignore */ }
    if (!res.ok) {
        const err = new Error((body && body.error) || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return body;
}

// ---------------------------------------------------------------------------
// View toggle + auth
// ---------------------------------------------------------------------------

function setView(authenticated) {
    els.loginView.hidden = authenticated;
    els.appView.hidden = !authenticated;
}

async function init() {
    wireEvents();
    const me = await api('/api/me').catch(() => ({ authenticated: false }));
    if (me.authenticated) {
        els.who.textContent = me.user || '';
        els.adminLink.hidden = me.role !== 'admin';
        setView(true);
        await loadSites();
    } else {
        setView(false);
    }
}

function wireEvents() {
    els.logout.addEventListener('click', onLogout);
    els.otpSendBtn.addEventListener('click', onOtpSend);
    els.otpForm.addEventListener('submit', onOtpVerify);
    els.site.addEventListener('change', onSiteChange);
    els.bot.addEventListener('change', renderSelectedBot);
    els.load.addEventListener('click', () => loadConfigs());
}

async function onLogout() {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    setView(false);
}

async function onOtpSend() {
    els.otpError.hidden = true;
    els.otpStatus.hidden = true;
    const email = els.otpEmail.value.trim();
    if (!email) return;
    els.otpSendBtn.disabled = true;
    try {
        await api('/api/otp/request', { method: 'POST', body: JSON.stringify({ email }) });
        els.otpCodeRow.hidden = false;
        els.otpStatus.textContent = 'Code sent — check your email.';
        els.otpStatus.hidden = false;
        els.otpCode.focus();
    } catch (err) {
        els.otpError.textContent = err.message;
        els.otpError.hidden = false;
    } finally {
        els.otpSendBtn.disabled = false;
    }
}

async function onOtpVerify(e) {
    e.preventDefault();
    els.otpError.hidden = true;
    const email = els.otpEmail.value.trim();
    const code = els.otpCode.value.trim();
    if (!code) return;
    try {
        const r = await api('/api/otp/verify', { method: 'POST', body: JSON.stringify({ email, code }) });
        els.otpCode.value = '';
        els.who.textContent = email;
        els.adminLink.hidden = r.role !== 'admin';
        setView(true);
        await loadSites();
    } catch (err) {
        els.otpError.textContent = err.message;
        els.otpError.hidden = false;
    }
}

// ---------------------------------------------------------------------------
// Sites — only ones with a configDb configured show up here
// ---------------------------------------------------------------------------

async function loadSites() {
    try {
        const sites = (await api('/api/sites')).filter(s => s.configDb);
        state.sites = sites;
        els.site.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = sites.length ? 'Select site...' : 'No sites configured for configs';
        els.site.append(placeholder);
        for (const s of sites) {
            const opt = document.createElement('option');
            opt.value = s.name;
            opt.textContent = s.name;
            els.site.append(opt);
        }
        state.selectedSite = null;
        resetBotSelect();
        setStatus(sites.length ? '' : 'No site has a configDb set — nothing to show here yet.');
    } catch (err) {
        if (err.status === 401) setView(false);
        else setStatus(err.message, true);
    }
}

function onSiteChange() {
    state.selectedSite = state.sites.find(s => s.name === els.site.value) || null;
    resetBotSelect();
    state.rows = [];
    state.columns = [];
    els.view.textContent = 'Select a site and a bot.';
    setStatus('');
}

function resetBotSelect() {
    els.bot.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select bot...';
    els.bot.append(placeholder);
    els.bot.disabled = true;
}

function setStatus(message, isError = false) {
    els.status.textContent = message;
    els.status.classList.toggle('error', isError);
}

// ---------------------------------------------------------------------------
// Load configs for the selected site, keep the latest row per bot (by `ip`)
// ---------------------------------------------------------------------------

// InfluxQL string literals use single quotes; escape any that appear in a
// tag value we didn't choose ourselves before interpolating it into a query.
function influxQuote(value) {
    return String(value).replace(/'/g, "\\'");
}

async function loadConfigs() {
    const site = state.selectedSite;
    if (!site) { setStatus('Select a site first', true); return; }
    // Deliberately does NOT select firmware_configs here -- each bot's config
    // can be hundreds of KB, so asking for every bot's config just to
    // populate the dropdown can mean tens of MB in one request (confirmed:
    // one site alone took 20s+ to transfer partial data before timing out).
    // This only fetches a tiny field to enumerate live bots; the actual
    // config is fetched on demand for one bot at a time in
    // fetchBotConfig() below, once the user actually picks one.
    const q = `SELECT last(bot_status) AS bot_status FROM "${site.measurement}" WHERE time > now() - 7d GROUP BY bot_id,ip`;
    els.load.disabled = true;
    setStatus('Loading...');
    try {
        const params = new URLSearchParams({ site: site.name, db: site.configDb, q });
        const result = await api('/api/query?' + params.toString());
        const parsed = parseGroupedByBot(result, 'bot_status');
        if (parsed.error) throw new Error(parsed.error);
        state.columns = parsed.columns;
        state.rows = parsed.rows;
        renderBotSelect();
        setStatus(`Loaded ${state.rows.length} bot(s) from ${site.name}`);
    } catch (err) {
        if (err.status === 401) { setView(false); return; }
        setStatus(err.message, true);
        state.columns = [];
        state.rows = [];
        renderBotSelect();
    } finally {
        els.load.disabled = false;
    }
}

// Fetches a single bot's firmware_configs on demand -- a single-series
// query, so it's at most one bot's worth of data (~hundreds of KB), not
// every bot's at once.
async function fetchBotConfig(site, botId, ip) {
    const filter = botId != null
        ? `"bot_id" = '${influxQuote(botId)}'`
        : `"ip" = '${influxQuote(ip)}'`;
    const q = `SELECT last(firmware_configs) AS firmware_configs FROM "${site.measurement}" WHERE ${filter} AND time > now() - 7d`;
    const params = new URLSearchParams({ site: site.name, db: site.configDb, q });
    const result = await api('/api/query?' + params.toString());
    return parseSingleBotValue(result);
}

function renderBotSelect() {
    resetBotSelect();
    if (state.rows.length === 0) return;
    const ipIdx = state.columns.indexOf('ip');
    const botIdIdx = state.columns.indexOf('bot_id');
    for (const row of state.rows) {
        const opt = document.createElement('option');
        opt.value = row[ipIdx]; // lookup key stays `ip` — it's what dedup is keyed on
        opt.textContent = (botIdIdx !== -1 && row[botIdIdx] != null) ? row[botIdIdx] : row[ipIdx];
        els.bot.append(opt);
    }
    els.bot.disabled = false;
    els.view.textContent = 'Select a bot.';
}

// Bumped on every selection so a slow in-flight fetch from a previous pick
// can't clobber the view after the user has already moved on to another bot.
let botConfigRequestSeq = 0;

async function renderSelectedBot() {
    const ipIdx = state.columns.indexOf('ip');
    const botIdIdx = state.columns.indexOf('bot_id');
    const ip = els.bot.value;
    els.featuredBody.replaceChildren();
    els.featuredEmpty.hidden = true;
    if (!ip) { els.view.textContent = 'Select a bot.'; return; }
    const row = state.rows.find(r => r[ipIdx] === ip);
    if (!row) { els.view.textContent = 'No data for that bot.'; return; }
    const botId = botIdIdx !== -1 ? row[botIdIdx] : null;

    const seq = ++botConfigRequestSeq;
    els.view.textContent = 'Loading config...';
    let raw;
    try {
        raw = await fetchBotConfig(state.selectedSite, botId, ip);
    } catch (err) {
        if (seq === botConfigRequestSeq) els.view.textContent = `Error loading config: ${err.message}`;
        return;
    }
    if (seq !== botConfigRequestSeq) return; // a newer selection has since been made

    if (raw == null || raw === '') {
        els.view.textContent = 'No firmware config recorded for this bot.';
        els.featuredEmpty.hidden = false;
        return;
    }
    try {
        const parsed = JSON.parse(raw);
        els.view.textContent = JSON.stringify(parsed, null, 2);
        renderFeaturedSettings(parsed);
    } catch {
        // Not JSON — e.g. an "ERROR: ..." marker from a failed SSH fetch.
        els.view.textContent = raw;
        els.featuredEmpty.hidden = false;
    }
}

init();
