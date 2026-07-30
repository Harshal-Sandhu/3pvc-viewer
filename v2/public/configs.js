// 3PVC Configs page.
// - ES module, no globals on window
// - All rendered values go through textContent (no innerHTML interpolation)

const $ = (sel) => document.querySelector(sel);
const els = {
    loginView: $('#login-view'),
    appView: $('#app-view'),
    loginForm: $('#login-form'),
    loginUser: $('#login-user'),
    loginPass: $('#login-pass'),
    loginError: $('#login-error'),

    who: $('#who'),
    logout: $('#logout-btn'),
    adminLink: $('#admin-link'),

    site: $('#site-select'),
    bot: $('#bot-select'),
    load: $('#load-btn'),

    status: $('#config-status'),
    view: $('#config-view')
};

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

function parseInflux(result) {
    if (!result || !result.results || !result.results[0]) return { columns: [], rows: [] };
    const r0 = result.results[0];
    if (r0.error) return { error: r0.error, columns: [], rows: [] };
    if (!r0.series || !r0.series[0]) return { columns: [], rows: [] };
    const s = r0.series[0];
    return { columns: s.columns || [], rows: s.values || [] };
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
    els.loginForm.addEventListener('submit', onLogin);
    els.logout.addEventListener('click', onLogout);
    els.site.addEventListener('change', onSiteChange);
    els.bot.addEventListener('change', renderSelectedBot);
    els.load.addEventListener('click', () => loadConfigs());
}

async function onLogin(e) {
    e.preventDefault();
    els.loginError.hidden = true;
    const username = els.loginUser.value.trim();
    const password = els.loginPass.value;
    try {
        const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
        els.loginPass.value = '';
        els.who.textContent = username;
        els.adminLink.hidden = r.role !== 'admin';
        setView(true);
        await loadSites();
    } catch (err) {
        els.loginError.textContent = err.message;
        els.loginError.hidden = false;
    }
}

async function onLogout() {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    setView(false);
    els.loginUser.value = '';
    els.loginPass.value = '';
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

async function loadConfigs() {
    const site = state.selectedSite;
    if (!site) { setStatus('Select a site first', true); return; }
    const q = `SELECT * FROM "${site.measurement}" WHERE time > now() - 24h ORDER BY time DESC LIMIT 5000`;
    els.load.disabled = true;
    setStatus('Loading...');
    try {
        const params = new URLSearchParams({ site: site.name, db: site.configDb, q });
        const result = await api('/api/query?' + params.toString());
        const parsed = parseInflux(result);
        if (parsed.error) throw new Error(parsed.error);
        state.columns = parsed.columns;
        state.rows = getLatestPerBot(parsed.columns, parsed.rows);
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

// First-row-wins dedup keyed on the `ip` field, relying on the query's
// `ORDER BY time DESC` — mirrors app.js's getLatestNonDeadPerBot(), but this
// dataset has no `bot_id` tag (main4.py writes fields only), so `ip` is the
// bot identity here instead.
function getLatestPerBot(columns, rows) {
    const ipIdx = columns.indexOf('ip');
    if (ipIdx === -1) return [];
    const latest = new Map();
    for (const r of rows) {
        const ip = r[ipIdx];
        if (ip == null || latest.has(ip)) continue;
        latest.set(ip, r);
    }
    return [...latest.values()];
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

function renderSelectedBot() {
    const ipIdx = state.columns.indexOf('ip');
    const configIdx = state.columns.indexOf('firmware_configs');
    const ip = els.bot.value;
    if (!ip) { els.view.textContent = 'Select a bot.'; return; }
    const row = state.rows.find(r => r[ipIdx] === ip);
    if (!row) { els.view.textContent = 'No data for that bot.'; return; }
    if (configIdx === -1) { els.view.textContent = 'This measurement has no firmware_configs field.'; return; }
    const raw = row[configIdx];
    if (raw == null || raw === '') { els.view.textContent = 'No firmware config recorded for this bot.'; return; }
    try {
        const parsed = JSON.parse(raw);
        els.view.textContent = JSON.stringify(parsed, null, 2);
    } catch {
        // Not JSON — e.g. an "ERROR: ..." marker from a failed SSH fetch.
        els.view.textContent = raw;
    }
}

init();
