// Operation page: pick a site + bot, fetch its most recent rows.
// - Same auth flow as the main viewer.
// - All data fetched through /api/query, which already gates on read-only InfluxQL.
// - All cell values rendered via textContent.

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
    botHint: $('#bot-hint'),
    lookback: $('#lookback'),
    lookbackCustom: $('#lookback-custom'),
    lookbackCustomWrap: $('#lookback-custom-wrap'),
    rowLimit: $('#row-limit'),
    rowLimitCustom: $('#row-limit-custom'),
    rowLimitCustomWrap: $('#row-limit-custom-wrap'),

    fieldsMenuBtn: $('#fields-menu-btn'),
    fieldsMenu: $('#fields-menu'),
    colMenuBtn: $('#col-menu-btn'),
    colMenu: $('#col-menu'),

    load: $('#load-btn'),
    exportBtn: $('#export-btn'),
    querySummary: $('#query-summary'),

    runAliasBtn: $('#run-alias-btn'),
    opsHint: $('#site-ops-hint'),
    opsOutput: $('#site-ops-output'),

    head: $('#data-head'),
    body: $('#data-body'),
    empty: $('#empty-state'),
    rowCount: $('#row-count'),

    toasts: $('#toasts')
};

const PREFS_KEY = 'operation.prefs.v1';
const defaultPrefs = {
    lastSite: null,
    lastBot: null,
    lookback: '7d',
    rowLimit: 10,
    selectedFields: null,   // null = all; otherwise array of field names
    hiddenColumns: []
};

function loadPrefs() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return { ...defaultPrefs };
        return { ...defaultPrefs, ...JSON.parse(raw) };
    } catch {
        return { ...defaultPrefs };
    }
}

function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

const prefs = loadPrefs();

const state = {
    sites: [],
    selectedSite: null,
    bots: [],                  // list of distinct bot_id values for current site
    selectedBot: null,
    availableFields: [],       // every field/tag name discoverable from the measurement
    columns: [],               // columns returned by the last query
    rows: []                   // rows returned by the last query
};

// ---------------------------------------------------------------------------
// API + toasts
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

function toast(message, kind = 'info', ms = 3500) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    els.toasts.append(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 200ms'; }, ms - 200);
    setTimeout(() => el.remove(), ms);
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
// View
// ---------------------------------------------------------------------------

function setView(authenticated) {
    els.loginView.hidden = authenticated;
    els.appView.hidden = !authenticated;
}

// ---------------------------------------------------------------------------
// Init + login
// ---------------------------------------------------------------------------

async function init() {
    wireEvents();
    applyPrefsToControls();
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

function applyPrefsToControls() {
    const presets = new Set(Array.from(els.lookback.options).map(o => o.value).filter(v => v !== '__custom'));
    if (presets.has(prefs.lookback)) {
        els.lookback.value = prefs.lookback;
        els.lookbackCustomWrap.hidden = true;
        els.lookbackCustom.value = '';
    } else {
        els.lookback.value = '__custom';
        els.lookbackCustomWrap.hidden = false;
        els.lookbackCustom.value = prefs.lookback || '';
    }
    const rowPresets = new Set(Array.from(els.rowLimit.options).map(o => o.value).filter(v => v !== '__custom'));
    if (rowPresets.has(String(prefs.rowLimit))) {
        els.rowLimit.value = String(prefs.rowLimit);
        els.rowLimitCustomWrap.hidden = true;
        els.rowLimitCustom.value = '';
    } else {
        els.rowLimit.value = '__custom';
        els.rowLimitCustomWrap.hidden = false;
        els.rowLimitCustom.value = String(prefs.rowLimit || '');
    }
}

const INFLUX_DURATION_RE = /^[1-9]\d*(ms|m|h|d|w)$/;
function isValidLookback(s) { return typeof s === 'string' && INFLUX_DURATION_RE.test(s); }

function wireEvents() {
    els.loginForm.addEventListener('submit', onLogin);
    els.logout.addEventListener('click', onLogout);

    els.site.addEventListener('change', onSiteChange);
    els.bot.addEventListener('change', () => {
        state.selectedBot = els.bot.value || null;
        prefs.lastBot = state.selectedBot;
        savePrefs();
        updateLoadButton();
        updateSummary();
    });

    els.lookback.addEventListener('change', () => {
        if (els.lookback.value === '__custom') {
            els.lookbackCustomWrap.hidden = false;
            els.lookbackCustom.focus();
            return;
        }
        els.lookbackCustomWrap.hidden = true;
        els.lookbackCustom.value = '';
        prefs.lookback = els.lookback.value;
        savePrefs();
        updateSummary();
    });

    els.lookbackCustom.addEventListener('input', () => {
        const v = els.lookbackCustom.value.trim().toLowerCase();
        if (!v) { els.lookbackCustom.classList.remove('invalid'); return; }
        if (!isValidLookback(v)) { els.lookbackCustom.classList.add('invalid'); return; }
        els.lookbackCustom.classList.remove('invalid');
        prefs.lookback = v;
        savePrefs();
        updateSummary();
    });

    els.rowLimit.addEventListener('change', () => {
        if (els.rowLimit.value === '__custom') {
            els.rowLimitCustomWrap.hidden = false;
            els.rowLimitCustom.focus();
            return;
        }
        els.rowLimitCustomWrap.hidden = true;
        els.rowLimitCustom.value = '';
        prefs.rowLimit = Number(els.rowLimit.value);
        savePrefs();
        updateSummary();
    });

    els.rowLimitCustom.addEventListener('input', () => {
        const n = Number(els.rowLimitCustom.value);
        if (!Number.isInteger(n) || n < 1 || n > 100000) {
            els.rowLimitCustom.classList.add('invalid');
            return;
        }
        els.rowLimitCustom.classList.remove('invalid');
        prefs.rowLimit = n;
        savePrefs();
        updateSummary();
    });

    els.load.addEventListener('click', () => loadRows());
    els.exportBtn.addEventListener('click', onExport);
    els.runAliasBtn.addEventListener('click', onRunAlias);

    els.fieldsMenuBtn.addEventListener('click', toggleFieldsMenu);
    els.colMenuBtn.addEventListener('click', toggleColMenu);

    document.addEventListener('click', onGlobalClick);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { hideFieldsMenu(); hideColMenu(); }
    });
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
// Sites
// ---------------------------------------------------------------------------

async function loadSites() {
    try {
        const sites = await api('/api/sites');
        state.sites = sites;
        els.site.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select site…';
        els.site.append(placeholder);
        for (const s of sites) {
            const opt = document.createElement('option');
            opt.value = s.name;
            opt.textContent = s.name;
            els.site.append(opt);
        }
        const preferred = prefs.lastSite && sites.find(s => s.name === prefs.lastSite);
        const target = preferred || null;  // do not auto-pick first site here — bot list must load deliberately
        if (target) {
            els.site.value = target.name;
            await applySiteSelection(target);
        }
    } catch (err) {
        if (err.status === 401) setView(false);
        else toast(err.message, 'error');
    }
}

async function onSiteChange() {
    const next = state.sites.find(s => s.name === els.site.value) || null;
    if (!next) {
        state.selectedSite = null;
        state.bots = [];
        state.availableFields = [];
        state.selectedBot = null;
        prefs.lastSite = null;
        prefs.lastBot = null;
        savePrefs();
        resetBotSelect('Select site first…');
        els.fieldsMenuBtn.disabled = true;
        updateLoadButton();
        updateOpsCard();
        return;
    }
    await applySiteSelection(next);
}

function updateOpsCard() {
    const site = state.selectedSite;
    const configured = !!(site && site.butlerIp && site.targetIp && site.hasGorPassword);
    els.runAliasBtn.disabled = !configured;
    if (!site) {
        els.opsHint.textContent = 'Select a site that has SSH details configured in admin.';
    } else if (!configured) {
        els.opsHint.textContent = `${site.name} has no SSH chain configured. Ask an admin to set Butler IP, Target IP, and gor password.`;
    } else {
        els.opsHint.textContent = `Will SSH via jumper → ${site.butlerIp} → gor@${site.targetIp} and run \`alias\`.`;
    }
    els.opsOutput.hidden = true;
    els.opsOutput.textContent = '';
}

async function onRunAlias() {
    if (!state.selectedSite) return;
    const site = state.selectedSite;
    els.runAliasBtn.disabled = true;
    const originalLabel = els.runAliasBtn.textContent;
    els.runAliasBtn.textContent = 'Running…';
    els.opsOutput.hidden = false;
    els.opsOutput.textContent = 'Running on ' + site.name + '…';
    try {
        const r = await api('/api/operations/run-alias', {
            method: 'POST',
            body: JSON.stringify({ site: site.name })
        });
        const lines = [];
        lines.push(`exit code: ${r.code}`);
        if (r.stdout) lines.push('--- stdout ---', r.stdout);
        if (r.stderr) lines.push('--- stderr ---', r.stderr);
        if (!r.stdout && !r.stderr) lines.push('(no output)');
        els.opsOutput.textContent = lines.join('\n');
    } catch (err) {
        els.opsOutput.textContent = 'Error: ' + err.message;
    } finally {
        els.runAliasBtn.disabled = false;
        els.runAliasBtn.textContent = originalLabel;
    }
}

async function applySiteSelection(site) {
    state.selectedSite = site;
    prefs.lastSite = site.name;
    savePrefs();
    state.rows = [];
    state.columns = [];
    renderTable();
    resetBotSelect('Loading bots…');
    els.fieldsMenuBtn.disabled = true;
    els.colMenuBtn.disabled = true;

    // Run bot discovery and field discovery in parallel.
    const [bots, fields] = await Promise.all([
        discoverBots(site).catch(err => { console.error(err); return []; }),
        discoverFields(site).catch(err => { console.error(err); return []; })
    ]);

    state.bots = bots;
    state.availableFields = fields;
    populateBotSelect();
    els.fieldsMenuBtn.disabled = fields.length === 0;
    updateLoadButton();
    updateSummary();
    updateOpsCard();
}

function resetBotSelect(placeholder) {
    els.bot.replaceChildren();
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    els.bot.append(opt);
    els.bot.disabled = true;
    state.selectedBot = null;
    els.botHint.textContent = '—';
}

function populateBotSelect() {
    els.bot.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = state.bots.length ? 'Select bot…' : 'No bots found';
    els.bot.append(placeholder);
    for (const id of state.bots) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        els.bot.append(opt);
    }
    els.bot.disabled = state.bots.length === 0;
    els.botHint.textContent = state.bots.length
        ? `${state.bots.length} bot${state.bots.length === 1 ? '' : 's'} discovered`
        : 'No bots seen on this measurement.';
    // Restore last bot if available.
    if (prefs.lastBot && state.bots.includes(prefs.lastBot)) {
        els.bot.value = prefs.lastBot;
        state.selectedBot = prefs.lastBot;
    }
}

// ---------------------------------------------------------------------------
// Bot + field discovery
// ---------------------------------------------------------------------------

// Strategy:
//  1. Try SHOW TAG VALUES with bot_id (works if bot_id is a tag).
//  2. Fall back to SELECT DISTINCT("bot_id") over the last 30d (works if it's a field).
async function discoverBots(site) {
    const meas = site.measurement;
    try {
        const q = `SHOW TAG VALUES FROM "${meas}" WITH KEY = "bot_id"`;
        const res = await runQuery(site.name, q);
        const ids = [];
        if (res && res.results && res.results[0] && res.results[0].series) {
            for (const s of res.results[0].series) {
                for (const row of s.values || []) {
                    // SHOW TAG VALUES returns [key, value]
                    const v = row && row[1];
                    if (v != null && String(v).length) ids.push(String(v));
                }
            }
        }
        if (ids.length) return uniqueSorted(ids);
    } catch (err) {
        // ignore — fall through to DISTINCT
    }
    try {
        const q = `SELECT DISTINCT("bot_id") FROM "${meas}" WHERE time > now() - 30d LIMIT 10000`;
        const res = await runQuery(site.name, q);
        const parsed = parseInflux(res);
        if (parsed.error) throw new Error(parsed.error);
        const idx = parsed.columns.indexOf('distinct');
        if (idx === -1) return [];
        const ids = parsed.rows.map(r => r[idx]).filter(v => v != null).map(String);
        return uniqueSorted(ids);
    } catch (err) {
        toast(`Could not list bots: ${err.message}`, 'warn');
        return [];
    }
}

async function discoverFields(site) {
    const meas = site.measurement;
    const fields = new Set();
    try {
        const res = await runQuery(site.name, `SHOW FIELD KEYS FROM "${meas}"`);
        if (res && res.results && res.results[0] && res.results[0].series) {
            for (const s of res.results[0].series) {
                for (const row of s.values || []) {
                    const name = row && row[0];
                    if (name) fields.add(String(name));
                }
            }
        }
    } catch { /* ignore */ }
    try {
        const res = await runQuery(site.name, `SHOW TAG KEYS FROM "${meas}"`);
        if (res && res.results && res.results[0] && res.results[0].series) {
            for (const s of res.results[0].series) {
                for (const row of s.values || []) {
                    const name = row && row[0];
                    if (name) fields.add(String(name));
                }
            }
        }
    } catch { /* ignore */ }
    return Array.from(fields).sort();
}

function uniqueSorted(arr) {
    return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b));
}

async function runQuery(siteName, q) {
    const params = new URLSearchParams({ site: siteName, q });
    return await api('/api/query?' + params.toString());
}

// ---------------------------------------------------------------------------
// Fields-to-query popover
// ---------------------------------------------------------------------------

function toggleFieldsMenu() {
    if (!els.fieldsMenu.hidden) { hideFieldsMenu(); return; }
    if (!state.availableFields.length) return;
    renderFieldsMenu();
    positionPopoverUnder(els.fieldsMenu, els.fieldsMenuBtn);
    els.fieldsMenu.hidden = false;
}

function hideFieldsMenu() { els.fieldsMenu.hidden = true; }

function renderFieldsMenu() {
    const selected = effectiveSelectedFields();
    els.fieldsMenu.replaceChildren();
    const head = document.createElement('div');
    head.className = 'popover-head';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search fields…';
    head.append(search);
    els.fieldsMenu.append(head);

    const body = document.createElement('div');
    body.className = 'popover-body';
    const selSet = new Set(selected);

    function renderList(needle) {
        body.replaceChildren();
        for (const name of state.availableFields) {
            if (needle && !name.toLowerCase().includes(needle)) continue;
            const row = document.createElement('label');
            row.className = 'opt';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = selSet.has(name);
            cb.addEventListener('change', () => {
                if (cb.checked) selSet.add(name); else selSet.delete(name);
            });
            const lab = document.createElement('span');
            lab.className = 'opt-label';
            lab.textContent = name;
            row.append(cb, lab);
            body.append(row);
        }
    }
    renderList('');
    search.addEventListener('input', () => renderList(search.value.trim().toLowerCase()));
    els.fieldsMenu.append(body);

    const foot = document.createElement('div');
    foot.className = 'popover-foot';
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'btn-subtle btn-small';
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => { state.availableFields.forEach(f => selSet.add(f)); renderList(search.value.trim().toLowerCase()); });
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.className = 'btn-subtle btn-small';
    noneBtn.textContent = 'None';
    noneBtn.addEventListener('click', () => { selSet.clear(); renderList(search.value.trim().toLowerCase()); });
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn-small';
    apply.textContent = 'Apply';
    apply.addEventListener('click', () => {
        const allSelected = state.availableFields.every(f => selSet.has(f));
        prefs.selectedFields = allSelected ? null : Array.from(selSet);
        savePrefs();
        hideFieldsMenu();
        updateSummary();
    });
    foot.append(allBtn, noneBtn, spacer, apply);
    els.fieldsMenu.append(foot);
}

// Returns the currently selected field names. Null prefs.selectedFields = all.
function effectiveSelectedFields() {
    if (!prefs.selectedFields || prefs.selectedFields.length === 0) {
        return state.availableFields.slice();
    }
    // Drop any stale names not in availableFields.
    return prefs.selectedFields.filter(f => state.availableFields.includes(f));
}

// ---------------------------------------------------------------------------
// Columns popover (visible columns)
// ---------------------------------------------------------------------------

function toggleColMenu() {
    if (!els.colMenu.hidden) { hideColMenu(); return; }
    if (!state.columns.length) return;
    renderColMenu();
    positionPopoverUnder(els.colMenu, els.colMenuBtn);
    els.colMenu.hidden = false;
}

function hideColMenu() { els.colMenu.hidden = true; }

function renderColMenu() {
    els.colMenu.replaceChildren();
    const body = document.createElement('div');
    body.className = 'popover-body';
    const hidden = new Set(prefs.hiddenColumns);
    for (const col of state.columns) {
        const row = document.createElement('label');
        row.className = 'opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !hidden.has(col);
        cb.addEventListener('change', () => {
            if (cb.checked) hidden.delete(col); else hidden.add(col);
            prefs.hiddenColumns = Array.from(hidden);
            savePrefs();
            renderTable();
        });
        const lab = document.createElement('span');
        lab.className = 'opt-label';
        lab.textContent = col;
        row.append(cb, lab);
        body.append(row);
    }
    els.colMenu.append(body);
}

function positionPopoverUnder(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    pop.style.position = 'absolute';
    pop.style.top = `${window.scrollY + r.bottom + 4}px`;
    pop.style.left = `${window.scrollX + r.left}px`;
    pop.style.minWidth = `${r.width}px`;
}

function onGlobalClick(e) {
    if (!els.fieldsMenu.hidden && !els.fieldsMenu.contains(e.target) && e.target !== els.fieldsMenuBtn) hideFieldsMenu();
    if (!els.colMenu.hidden && !els.colMenu.contains(e.target) && e.target !== els.colMenuBtn) hideColMenu();
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

function updateLoadButton() {
    const ready = !!(state.selectedSite && state.selectedBot);
    els.load.disabled = !ready;
}

function updateSummary() {
    if (!state.selectedSite) {
        els.querySummary.textContent = 'Select a site and a bot to load rows.';
        return;
    }
    if (!state.selectedBot) {
        els.querySummary.textContent = `Site: ${state.selectedSite.name} — select a bot.`;
        return;
    }
    const fields = effectiveSelectedFields();
    const fieldDesc = (!prefs.selectedFields || prefs.selectedFields.length === 0)
        ? 'all fields'
        : `${fields.length} field${fields.length === 1 ? '' : 's'}`;
    els.querySummary.textContent =
        `${state.selectedSite.measurement} · bot ${state.selectedBot} · last ${prefs.rowLimit} rows · ${prefs.lookback} · ${fieldDesc}`;
}

function quoteFieldList(fields) {
    return fields.map(f => `"${f.replace(/"/g, '\\"')}"`).join(', ');
}

function escapeStringLiteral(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function loadRows() {
    if (!state.selectedSite || !state.selectedBot) return;
    if (!isValidLookback(prefs.lookback)) {
        toast(`Invalid lookback "${prefs.lookback}". Use e.g. 30m, 48h, 3d, 2w.`, 'warn');
        return;
    }
    const limit = Number(prefs.rowLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100000) {
        toast('Invalid row count.', 'warn');
        return;
    }
    const site = state.selectedSite;
    const fields = effectiveSelectedFields();
    const selectClause = (!prefs.selectedFields || prefs.selectedFields.length === 0 || fields.length === state.availableFields.length)
        ? '*'
        : quoteFieldList(fields);
    if (selectClause !== '*' && !fields.length) {
        toast('No fields selected. Pick at least one or use All.', 'warn');
        return;
    }
    const bot = escapeStringLiteral(state.selectedBot);
    const q = `SELECT ${selectClause} FROM "${site.measurement}" WHERE "bot_id" = '${bot}' AND time > now() - ${prefs.lookback} ORDER BY time DESC LIMIT ${limit}`;
    els.load.disabled = true;
    try {
        const res = await runQuery(site.name, q);
        const parsed = parseInflux(res);
        if (parsed.error) throw new Error(parsed.error);
        state.columns = parsed.columns;
        state.rows = parsed.rows;
        renderTable();
        els.exportBtn.disabled = parsed.rows.length === 0;
        els.colMenuBtn.disabled = state.columns.length === 0;
        toast(`Loaded ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
        if (err.status === 401) { setView(false); return; }
        state.columns = [];
        state.rows = [];
        renderTable();
        els.exportBtn.disabled = true;
        els.colMenuBtn.disabled = true;
        toast(err.message, 'error');
    } finally {
        updateLoadButton();
    }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function formatCell(col, value) {
    if (value == null) return '';
    if (col === 'time' || /(_|^)time$/.test(col)) {
        const d = new Date(value);
        if (!isNaN(d.getTime())) return d.toLocaleString();
    }
    return String(value);
}

function visibleColumnSet() {
    const hidden = new Set(prefs.hiddenColumns);
    return state.columns.filter(c => !hidden.has(c));
}

function renderTable() {
    const visible = visibleColumnSet();

    els.head.replaceChildren();
    for (const col of visible) {
        const th = document.createElement('th');
        th.textContent = col;
        els.head.append(th);
    }

    els.body.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const row of state.rows) {
        const tr = document.createElement('tr');
        for (const col of visible) {
            const td = document.createElement('td');
            const idx = state.columns.indexOf(col);
            td.textContent = idx === -1 ? '' : formatCell(col, row[idx]);
            tr.append(td);
        }
        frag.append(tr);
    }
    els.body.append(frag);

    els.empty.hidden = state.rows.length > 0;
    if (state.rows.length === 0) {
        els.empty.textContent = state.selectedBot
            ? 'No rows match this query.'
            : 'No rows loaded yet.';
    }
    els.rowCount.textContent = state.rows.length
        ? `Showing ${state.rows.length} row${state.rows.length === 1 ? '' : 's'}`
        : '';
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

function onExport() {
    if (!state.rows.length) return;
    const visible = visibleColumnSet();
    const lines = [visible.map(csvCell).join(',')];
    for (const row of state.rows) {
        lines.push(visible.map(col => {
            const idx = state.columns.indexOf(col);
            return csvCell(idx === -1 ? '' : row[idx]);
        }).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const site = state.selectedSite ? state.selectedSite.name : 'export';
    const bot = (state.selectedBot || 'bot').replace(/[^a-zA-Z0-9_\-.]/g, '_');
    a.href = url;
    a.download = `${site}_${bot}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${state.rows.length} rows`, 'success');
}

init();
