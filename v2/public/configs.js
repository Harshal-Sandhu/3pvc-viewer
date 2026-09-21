// 3PVC Configs page.
// - ES module, no globals on window
// - All rendered values go through textContent (no innerHTML interpolation)
// - Rows = bots, columns = the curated featured settings (see
//   configs-logic.js FEATURED_FIELDS). Each bot's firmware_configs JSON is
//   fetched on demand with a small concurrency pool and fills its row in
//   place, so one huge config can't stall the whole table.

import { configValuesEqual, findComplianceValue, getBotModel, getConfigCompliance, getFeaturedValueMap, parseGroupedByBot, parseInflux, parseSingleBotValue, FEATURED_FIELDS } from './configs-logic.js';

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
    load: $('#load-btn'),
    filter: $('#config-filter'),

    status: $('#config-status'),
    modelTabs: $('#model-tabs'),
    modelTables: $('#config-model-tables'),
    empty: $('#config-empty'),
    rowCount: $('#config-row-count'),
    chipsBar: $('#chips-bar'),
    chips: $('#config-chips'),
    clearFilters: $('#clear-filters'),
    colMenuBtn: $('#col-menu-btn'),
    colMenu: $('#col-menu'),
    filterPop: $('#config-filter-popover'),
    filterPopSearch: $('#config-filter-search'),
    filterPopList: $('#config-filter-list'),
    filterPopClear: $('#config-filter-clear'),
    filterPopApply: $('#config-filter-apply')
};

const state = {
    sites: [],
    selectedSite: null,
    bots: [],                 // [{ ip, botId, status, versionVal }] in Influx order
    configs: new Map(),       // ip -> { stage: 'ok'|'error'|'missing', raw, parsed, features }
    compliance: { columns: [], rows: [] },   // the site's expected-values measurement
    complianceByVersion: new Map(),          // version key -> latest compliance row
    sortKey: null,
    sortDir: 1,
    filters: new Map(),                      // column label -> Set of allowed display strings
    activeFunnelCol: null,
    activeFunnelDraft: null,
    activeModelGroup: null        // null = auto-pick the first non-empty model table
};

// Number of per-bot config fetches running at once. Config blobs can be
// hundreds of KB each, so keep the concurrency modest to avoid hammering
// InfluxDB and the server's 30s proxy timeout.
const CONFIG_FETCH_CONCURRENCY = 6;

// Grid columns: identity + compliance summary + the curated featured settings.
// Hidden-column state persists in localStorage under its own key so it never
// collides with the viewer's preferences.
const PREFS_KEY = '3pvc:configs:prefs';
const BASE_COLUMNS = ['Config', 'Bot ID', 'IP', 'Model', 'Status', 'Config compliance', ...FEATURED_FIELDS.map(f => f.label)];
const defaultPrefs = { hiddenColumns: [] };

function loadPrefs() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return { ...defaultPrefs };
        const saved = JSON.parse(raw);
        return { ...defaultPrefs, ...saved };
    } catch { return { ...defaultPrefs }; }
}
function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}
const prefs = loadPrefs();

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

// Runs `jobs` with at most `limit` in flight at a time, resolving with all
// results in input order. Failures are caught by callers per job.
async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    }
    const workers = [];
    for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
    await Promise.all(workers);
    return results;
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
    els.load.addEventListener('click', () => loadConfigs());
    els.filter.addEventListener('input', () => renderGrid());
    els.colMenuBtn.addEventListener('click', toggleColMenu);
    els.filterPopApply.addEventListener('click', applyFilterPop);
    els.filterPopClear.addEventListener('click', clearFilterPop);
    els.filterPopSearch.addEventListener('input', renderFilterPopList);
    els.clearFilters.addEventListener('click', clearAllFilters);

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.col-menu-wrap')) els.colMenu.hidden = true;
        if (!e.target.closest('#config-filter-popover') && !e.target.closest('.funnel')) hideFilterPop();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { hideFilterPop(); els.colMenu.hidden = true; }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); els.filter.focus(); }
    });
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
        clearGrid();
        setStatus(sites.length ? '' : 'No site has a configDb set — nothing to show here yet.');
    } catch (err) {
        if (err.status === 401) setView(false);
        else setStatus(err.message, true);
    }
}

function onSiteChange() {
    state.selectedSite = state.sites.find(s => s.name === els.site.value) || null;
    clearGrid();
    setStatus('');
}

function clearGrid() {
    state.bots = [];
    state.configs.clear();
    state.compliance.columns = [];
    state.compliance.rows = [];
    state.complianceByVersion.clear();
    state.activeModelGroup = null;
    els.modelTabs.replaceChildren();
    els.modelTabs.hidden = true;
    els.modelTables.replaceChildren();
    els.empty.hidden = false;
}

function setStatus(message, isError = false) {
    els.status.textContent = message;
    els.status.classList.toggle('error', isError);
}

// ---------------------------------------------------------------------------
// Grid: columns can be hidden, sorted, and filtered per-column (mirroring the
// viewer). Filters, sorting, and the funnel value lists all run on the same
// display text a cell shows, so dropdown values always match the screen.
// ---------------------------------------------------------------------------

function getVisibleColumns() {
    const hidden = new Set(prefs.hiddenColumns);
    return BASE_COLUMNS.filter(c => !hidden.has(c));
}

// The text a row's cell would display for a column label.
function modelText(bot) {
    const cfg = state.configs.get(bot.ip);
    if (cfg && cfg.stage === 'ok') return getBotModel(cfg.parsed) || '—';
    if (cfg && cfg.stage === 'dead') return 'dead';
    return cfg ? '—' : '…';
}

function complianceText(bot) {
    const cfg = state.configs.get(bot.ip);
    const compRow = bot.versionVal != null ? state.complianceByVersion.get(String(bot.versionVal)) : undefined;
    if (cfg && cfg.stage === 'ok' && compRow) {
        const { matched, diffs } = getConfigCompliance(cfg.features, state.compliance.columns, compRow);
        if (matched > 0) return diffs.length ? `${diffs.length}/${matched} differ` : `${matched} matching`;
        return 'n/a';
    }
    return '—';
}

function cellTextOf(bot, label) {
    const cfg = state.configs.get(bot.ip);
    switch (label) {
        case 'Bot ID': return String(bot.botId ?? bot.ip);
        case 'IP': return String(bot.ip ?? '');
        case 'Model': return modelText(bot);
        case 'Status': return String(bot.status ?? '');
        case 'Config compliance': return complianceText(bot);
        case 'Config': return '';
        default: {
            if (!cfg || cfg.stage !== 'ok') return '';
            const v = cfg.features.get(label);
            if (v === undefined) return '—';
            return typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
    }
}

function sortValue(s) {
    if (s == null || s === '' || s === '—' || s === '…' || s === 'n/a') return null;
    return s;
}

function compareCells(a, b) {
    const av = sortValue(a), bv = sortValue(b);
    if (av === bv) return 0;
    if (av === null) return 1;    // blanks sort last
    if (bv === null) return -1;
    const an = Number(av), bn = Number(bv);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an > bn ? 1 : -1;
    return av > bv ? 1 : -1;
}

function getFilteredBots() {
    let bots = state.bots.slice();
    if (state.filters.size > 0) {
        bots = bots.filter(bot => {
            for (const [label, allowed] of state.filters) {
                if (!allowed.has(cellTextOf(bot, label))) return false;
            }
            return true;
        });
    }
    const needle = els.filter.value.trim().toLowerCase();
    if (needle) {
        const visible = getVisibleColumns();
        bots = bots.filter(bot => visible.some(col => {
            const t = cellTextOf(bot, col);
            return t != null && t.toLowerCase().includes(needle);
        }));
    }
    if (state.sortKey) {
        bots.sort((a, b) => compareCells(cellTextOf(a, state.sortKey), cellTextOf(b, state.sortKey)) * state.sortDir);
    }
    return bots;
}

function renderHeader(thead) {
    thead.replaceChildren();
    for (const col of getVisibleColumns()) {
        const th = document.createElement('th');
        if (col === 'Bot ID') th.classList.add('pinned');
        const inner = document.createElement('span');
        inner.className = 'th-inner';
        const sortBtn = document.createElement('button');
        sortBtn.type = 'button';
        sortBtn.className = 'sort-btn';
        sortBtn.textContent = col + (state.sortKey === col ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '');
        sortBtn.addEventListener('click', () => {
            if (state.sortKey === col) state.sortDir *= -1;
            else { state.sortKey = col; state.sortDir = 1; }
            renderGrid();
        });
        inner.append(sortBtn);
        if (col !== 'Config') {
            const funnel = document.createElement('button');
            funnel.type = 'button';
            funnel.className = 'funnel' + (state.filters.has(col) ? ' active' : '');
            funnel.textContent = '▾';
            funnel.title = 'Filter';
            funnel.addEventListener('click', (e) => { e.stopPropagation(); openFilterPop(col, funnel); });
            inner.append(funnel);
        }
        th.append(inner);
        thead.append(th);
    }
}

function buildRow(bot) {
    const tr = document.createElement('tr');
    tr.dataset.ip = String(bot.ip);
    const cfg = state.configs.get(bot.ip);
    const compRow = bot.versionVal != null ? state.complianceByVersion.get(String(bot.versionVal)) : undefined;
    const compCols = state.compliance.columns;

    for (const col of getVisibleColumns()) {
        const td = document.createElement('td');
        if (col === 'Bot ID') {
            td.classList.add('pinned');
            td.textContent = cellTextOf(bot, col);
        } else if (col === 'Config compliance') {
            const text = complianceText(bot);
            if (cfg && cfg.stage === 'ok' && compRow) {
                const { matched, diffs } = getConfigCompliance(cfg.features, compCols, compRow);
                if (matched > 0) {
                    const pill = document.createElement('span');
                    pill.className = 'status-pill ' + (diffs.length ? 'bad' : 'ok');
                    pill.textContent = text;
                    pill.title = diffs.map(d => `${d.label}: ${d.actual} ≠ ${d.expected}`).join('\n');
                    td.append(pill);
                } else {
                    td.textContent = text;
                }
            } else {
                td.textContent = text;
            }
        } else if (col === 'Config') {
            td.className = 'config-cell config-raw';
            td.append(buildConfigDetail(cfg));
        } else {
            td.textContent = cellTextOf(bot, col);
            if (col === 'Model') td.title = td.textContent;
            if (col !== 'Model' && col !== 'Status' && col !== 'IP') td.classList.add('config-cell');
            // Compliance coloring on the featured settings themselves.
            if (cfg && cfg.stage === 'ok' && compRow) {
                const value = cfg.features.get(col);
                if (value !== undefined) {
                    const field = FEATURED_FIELDS.find(f => f.label === col);
                    const expected = field && findComplianceValue(compCols, compRow, field);
                    if (expected !== undefined) {
                        td.classList.add(configValuesEqual(value, expected) ? 'cell-match' : 'cell-mismatch');
                    }
                }
            }
        }
        tr.append(td);
    }
    return tr;
}

function buildConfigDetail(cfg) {
    const wrap = document.createElement('span');
    if (!cfg) {
        const loading = document.createElement('span');
        loading.className = 'muted small';
        loading.textContent = 'loading…';
        wrap.append(loading);
        return wrap;
    }
    if (cfg.stage === 'missing') {
        const note = document.createElement('span');
        note.className = 'muted small';
        note.textContent = 'No firmware config recorded';
        wrap.append(note);
        return wrap;
    }
    if (cfg.stage === 'dead') {
        const note = document.createElement('span');
        note.className = 'muted small';
        note.textContent = 'SSH unreachable — no config';
        note.title = 'firmware_configs is the "dead_bot" marker: SSH to the bot failed during ingestion, so no config was recorded.';
        wrap.append(note);
        return wrap;
    }
    if (cfg.stage === 'error') {
        const note = document.createElement('span');
        note.className = 'small';
        note.textContent = cfg.message;
        note.title = cfg.message;
        wrap.append(note);
        return wrap;
    }
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.className = 'muted small';
    summary.textContent = cfg.features.size > 0
        ? `Show all config (${cfg.features.size} settings)`
        : 'Show all config (none featured)';
    details.append(summary);
    const pre = document.createElement('pre');
    pre.className = 'config-blob';
    pre.textContent = cfg.raw;
    details.append(pre);
    wrap.append(details);
    return wrap;
}

// Which model table a bot belongs to. HTM/VTM come from the parsed config;
// everything unresolved (dead marker, fetch errors, still loading) lands in
// the Other table rather than being dropped.
function modelGroupOf(bot) {
    const cfg = state.configs.get(bot.ip);
    if (cfg && cfg.stage === 'ok') {
        const model = getBotModel(cfg.parsed);
        if (model === 'HTM' || model === 'VTM') return model;
    }
    return 'Other';
}

// Builds the always-visible model tab bar and marks the active one.
function renderModelTabs(groups) {
    els.modelTabs.replaceChildren();
    els.modelTabs.hidden = state.bots.length === 0;
    const active = state.activeModelGroup;
    for (const group of ['HTM', 'VTM', 'Other']) {
        const bots = groups[group] || [];
        if (group === 'Other' && bots.length === 0) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tab-btn' + (group === active ? ' active' : '');
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', group === active ? 'true' : 'false');
        btn.textContent = `${group} (${bots.length})`;
        btn.addEventListener('click', () => {
            state.activeModelGroup = group;
            renderGrid();
        });
        els.modelTabs.append(btn);
    }
}

function renderGrid() {
    const rows = getFilteredBots();
    const groups = { HTM: [], VTM: [], Other: [] };
    for (const bot of rows) groups[modelGroupOf(bot)].push(bot);
    let active = state.activeModelGroup;
    if (!active || !groups[active] || groups[active].length === 0) {
        active = groups.HTM.length ? 'HTM' : groups.VTM.length ? 'VTM' : 'Other';
    }
    renderModelTabs(groups);
    els.modelTables.replaceChildren();
    if (rows.length > 0) {
        const bots = groups[active] || [];
        const section = document.createElement('section');
        section.className = 'model-table-block';
        const title = document.createElement('h3');
        title.className = 'model-title';
        const name = document.createElement('span');
        name.textContent = active;
        const count = document.createElement('span');
        count.className = 'muted small';
        count.textContent = ` (${bots.length} bot${bots.length === 1 ? '' : 's'})`;
        title.append(name, count);
        section.append(title);
        const table = document.createElement('table');
        table.className = 'model-grid';
        const thead = document.createElement('thead');
        renderHeader(thead);
        const tbody = document.createElement('tbody');
        for (const bot of bots) tbody.append(buildRow(bot));
        table.append(thead, tbody);
        section.append(table);
        els.modelTables.append(section);
    }
    els.empty.hidden = rows.length > 0;
    els.empty.textContent = state.bots.length === 0
        ? 'No bots loaded yet. Select a site and click Load configs.'
        : 'No bots match the current filter.';
    els.rowCount.textContent = state.bots.length ? `Showing ${rows.length} of ${state.bots.length} bots` : '';
    renderChips();
}

// ---------------------------------------------------------------------------
// Per-column filter popover (mirrors the viewer's funnel lists)
// ---------------------------------------------------------------------------

function openFilterPop(col, anchor) {
    state.activeFunnelCol = col;
    state.activeFunnelDraft = new Set(state.filters.get(col) || []);
    els.filterPopSearch.value = '';
    renderFilterPopList();
    const rect = anchor.getBoundingClientRect();
    els.filterPop.hidden = false;
    const popRect = els.filterPop.getBoundingClientRect();
    let left = window.scrollX + rect.left;
    if (left + popRect.width > window.scrollX + window.innerWidth - 8) {
        left = window.scrollX + window.innerWidth - popRect.width - 8;
    }
    els.filterPop.style.left = left + 'px';
    els.filterPop.style.top = window.scrollY + rect.bottom + 4 + 'px';
    els.filterPopSearch.focus();
}

function hideFilterPop() {
    els.filterPop.hidden = true;
    state.activeFunnelCol = null;
    state.activeFunnelDraft = null;
}

function renderFilterPopList() {
    const col = state.activeFunnelCol;
    if (!col) return;
    const counts = new Map();
    // Distinct values come from bots passing every OTHER funnel (Excel-style).
    const others = state.bots.filter(bot => {
        for (const [c, allowed] of state.filters) {
            if (c === col) continue;
            if (!allowed.has(cellTextOf(bot, c))) return false;
        }
        return true;
    });
    for (const bot of others) {
        const v = cellTextOf(bot, col);
        counts.set(v, (counts.get(v) || 0) + 1);
    }
    const search = els.filterPopSearch.value.trim().toLowerCase();
    const items = Array.from(counts.entries())
        .filter(([v]) => !search || v.toLowerCase().includes(search))
        .sort((a, b) => b[1] - a[1]);

    els.filterPopList.replaceChildren();
    if (items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'muted small';
        empty.style.padding = '0.5rem 0.75rem';
        empty.textContent = 'No values.';
        els.filterPopList.append(empty);
        return;
    }
    for (const [value, count] of items) {
        const opt = document.createElement('label');
        opt.className = 'opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.activeFunnelDraft.size === 0 || state.activeFunnelDraft.has(value);
        cb.addEventListener('change', () => {
            // Start narrowing only on first interaction.
            if (state.activeFunnelDraft.size === 0) {
                for (const [v] of items) state.activeFunnelDraft.add(v);
            }
            if (cb.checked) state.activeFunnelDraft.add(value);
            else state.activeFunnelDraft.delete(value);
        });
        const label = document.createElement('span');
        label.className = 'opt-label';
        label.textContent = value === '' ? '(empty)' : value;
        const c = document.createElement('span');
        c.className = 'opt-count';
        c.textContent = String(count);
        opt.append(cb, label, c);
        els.filterPopList.append(opt);
    }
}

function applyFilterPop() {
    const col = state.activeFunnelCol;
    if (!col) return;
    const draft = state.activeFunnelDraft;
    if (draft && draft.size > 0) state.filters.set(col, draft);
    else state.filters.delete(col);
    hideFilterPop();
    renderGrid();
}

function clearFilterPop() {
    state.activeFunnelDraft = new Set();
    renderFilterPopList();
}

// ---------------------------------------------------------------------------
// Column visibility menu + active-filter chips
// ---------------------------------------------------------------------------

function toggleColMenu() {
    if (!els.colMenu.hidden) { els.colMenu.hidden = true; return; }
    renderColMenu();
    const rect = els.colMenuBtn.getBoundingClientRect();
    els.colMenu.hidden = false;
    els.colMenu.style.position = 'absolute';
    els.colMenu.style.right = '0';
    els.colMenu.style.top = (els.colMenuBtn.offsetHeight + 6) + 'px';
}

function renderColMenu() {
    els.colMenu.replaceChildren();
    const hidden = new Set(prefs.hiddenColumns);
    for (const col of BASE_COLUMNS) {
        const opt = document.createElement('label');
        opt.className = 'opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !hidden.has(col);
        cb.addEventListener('change', () => {
            if (cb.checked) hidden.delete(col); else hidden.add(col);
            prefs.hiddenColumns = Array.from(hidden);
            savePrefs();
            renderGrid();
        });
        const label = document.createElement('span');
        label.className = 'opt-label';
        label.textContent = col;
        opt.append(cb, label);
        els.colMenu.append(opt);
    }
}

function renderChips() {
    els.chips.replaceChildren();
    els.chipsBar.hidden = state.filters.size === 0;
    for (const [col, allowed] of state.filters) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        const list = Array.from(allowed);
        chip.textContent = `${col}: ${list.length > 1 ? `${list.length} values` : list[0]}`;
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.addEventListener('click', () => { state.filters.delete(col); renderGrid(); });
        chip.append(x);
        els.chips.append(chip);
    }
}

function clearAllFilters() {
    state.filters.clear();
    els.filter.value = '';
    renderGrid();
}

// InfluxQL string literals use single quotes; escape any that appear in a
// tag value we didn't choose ourselves before interpolating it into a query.
function influxQuote(value) {
    return String(value).replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// Load: enumerate bots, then fill each row's config from its own on-demand
// query. Deliberately does NOT select firmware_configs in the enumeration
// query -- each bot's config can be hundreds of KB, so asking for every
// bot's config just to enumerate them can mean tens of MB in one request
// (confirmed: one site alone took 20s+ to transfer partial data before
// timing out).

// Per-site version-key column, mirroring the viewer: TTP sites record bot
// firmware under `version`, everything else under `api_version`.
function versionField(site) {
    return site && site.agentType === 'TTP' ? 'version' : 'api_version';
}

// Loads the site's compliance measurement -- the admin-filled "expected"
// table, picked the same way as the viewer (per-site name, stored in
// site.complianceMeasurement). Rows are keyed by the same version column as
// the viewer (getComplianceByApi): version for TTP, api_version otherwise.
async function loadCompliance(site) {
    state.complianceByVersion.clear();
    state.compliance.columns = [];
    state.compliance.rows = [];
    if (!site.complianceMeasurement) return;
    const measurement = site.complianceMeasurement || 'compliance_details';
    const vf = versionField(site);
    const q = `SELECT * FROM "${measurement}" ORDER BY time DESC LIMIT 10000`;
    const params = new URLSearchParams({ site: site.name, q });
    try {
        const result = await api('/api/query?' + params.toString());
        const parsed = parseInflux(result);
        if (parsed.error) throw new Error(parsed.error);
        state.compliance.columns = parsed.columns;
        state.compliance.rows = parsed.rows;
        const vfIdx = parsed.columns.indexOf(vf);
        if (vfIdx === -1) return;
        // Rows are newest-first — keep the first row seen per version key.
        for (const row of parsed.rows) {
            const key = row[vfIdx];
            if (key == null || state.complianceByVersion.has(String(key))) continue;
            state.complianceByVersion.set(String(key), row);
        }
    } catch (err) {
        if (err.status === 401) throw err;  // auth failure must abort the load
        // Non-fatal — rows still render, just without the compliance coloring.
        console.warn('Compliance lookup failed for', site.name, err);
    }
}

async function loadConfigs() {
    const site = state.selectedSite;
    if (!site) { setStatus('Select a site first', true); return; }
    const vf = versionField(site);
    // Dead bots (version key := 'dead_bot' or empty) are the same snapshots the
    // viewer drops, so only live bots get a row — and thus a Status at all.
    const q = `SELECT last(bot_status) AS bot_status, last(vda_version) AS vda_version, last(api_version) AS api_version, last(version) AS version, last(kubot_master_version) AS kubot_master_version FROM "${site.measurement}" WHERE "${vf}" != 'dead_bot' AND "${vf}" != '' AND time > now() - 7d GROUP BY bot_id,ip`;
    els.load.disabled = true;
    setStatus('Loading bots...');
    try {
        const params = new URLSearchParams({ site: site.name, db: site.configDb, q });
        const enumPromise = api('/api/query?' + params.toString());
        const compliancePromise = loadCompliance(site);  // best-effort; 401 rethrows below
        const result = await enumPromise;
        await compliancePromise;
        const parsed = parseGroupedByBot(result, ['bot_status', 'vda_version', 'api_version', 'version', 'kubot_master_version']);
        if (parsed.error) throw new Error(parsed.error);

        const ipIdx = parsed.columns.indexOf('ip');
        const botIdIdx = parsed.columns.indexOf('bot_id');
        const statusIdx = parsed.columns.indexOf('bot_status');
        const apiIdx = parsed.columns.indexOf('api_version');
        const versionIdx = parsed.columns.indexOf('version');
        const kubIdx = parsed.columns.indexOf('kubot_master_version');
        state.bots = parsed.rows.map(row => ({
            ip: row[ipIdx],
            botId: botIdIdx !== -1 ? row[botIdIdx] : null,
            status: statusIdx !== -1 ? row[statusIdx] : null,
            versionVal: (vf === 'version' ? row[versionIdx] : row[apiIdx]) ?? row[kubIdx] ?? null
        }));
        state.configs.clear();

        if (state.bots.length === 0) {
            clearGrid();
            setStatus(`0 live bots recorded for ${site.name} in the last 7d`);
            return;
        }

        renderGrid();
        setStatus(`Loading configs for ${state.bots.length} bot(s) from ${site.name}...`);

        let done = 0;
        await mapPool(state.bots, CONFIG_FETCH_CONCURRENCY, async (bot) => {
            const cfg = await fetchBotConfig(site, bot.botId, bot.ip);
            state.configs.set(bot.ip, cfg);
            renderGrid();
            done += 1;
            setStatus(`Loaded ${done}/${state.bots.length} bot configs from ${site.name}`);
            return cfg;
        });
    } catch (err) {
        if (err.status === 401) { setView(false); return; }
        setStatus(err.message, true);
    } finally {
        els.load.disabled = false;
    }
}

// Fetches a single bot's firmware_configs on demand -- a single-series
// query, so it's at most one bot's worth of data (~hundreds of KB), not
// every bot's at once. Returns an object describing the per-bot state:
//   { stage: 'ok', raw, features }      parsed JSON + featured-value map
//   { stage: 'missing' }                no firmware_configs recorded
//   { stage: 'dead' }                   firmware_configs is the "dead_bot" marker
//   { stage: 'error', message }         fetch/parse failure
async function fetchBotConfig(site, botId, ip) {
    const filter = botId != null
        ? `"bot_id" = '${influxQuote(botId)}'`
        : `"ip" = '${influxQuote(ip)}'`;
    const q = `SELECT last(firmware_configs) AS firmware_configs FROM "${site.measurement}" WHERE ${filter} AND time > now() - 7d`;
    const params = new URLSearchParams({ site: site.name, db: site.configDb, q });
    try {
        const result = await api('/api/query?' + params.toString());
        const raw = parseSingleBotValue(result);
        if (raw == null || raw === '') return { stage: 'missing' };
        if (typeof raw === 'string' && raw.trim() === 'dead_bot') return { stage: 'dead' };
        try {
            const parsed = JSON.parse(raw);
            return { stage: 'ok', raw, parsed, features: getFeaturedValueMap(parsed) };
        } catch {
            // Not JSON — e.g. an "ERROR: ..." marker from a failed SSH fetch.
            return { stage: 'error', message: String(raw) };
        }
    } catch (err) {
        return { stage: 'error', message: err.message };
    }
}

init();