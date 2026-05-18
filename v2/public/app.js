// 3PVC Viewer frontend.
// - ES module, no globals on window
// - All cell values rendered via textContent (no innerHTML interpolation)
// - SVG built via createElementNS (no innerHTML)
// - All long-lived UI state persists in localStorage

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------

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
    autoRefresh: $('#auto-refresh'),
    lastRefreshed: $('#last-refreshed'),
    helpBtn: $('#help-btn'),

    site: $('#site-select'),
    lookback: $('#lookback'),
    lookbackCustom: $('#lookback-custom'),
    lookbackCustomWrap: $('#lookback-custom-wrap'),
    load: $('#load-btn'),
    exportBtn: $('#export-btn'),
    filter: $('#filter-input'),
    uniqueOnly: $('#unique-only'),

    chartCard: $('#chart-card'),
    chart: $('#chart'),

    vdaAlertSection: $('#vda-alert-section'),
    vdaAlertCount: $('#vda-alert-count'),
    vdaAlertList: $('#vda-alert-list'),

    chipsBar: $('#chips-bar'),
    chips: $('#chips'),
    clearFilters: $('#clear-filters'),

    head: $('#data-head'),
    body: $('#data-body'),
    empty: $('#empty-state'),
    rowCount: $('#row-count'),

    colMenuBtn: $('#col-menu-btn'),
    colMenu: $('#col-menu'),

    filterPop: $('#filter-popover'),
    filterPopSearch: $('#filter-popover-search'),
    filterPopList: $('#filter-popover-list'),
    filterPopClear: $('#filter-popover-clear'),
    filterPopApply: $('#filter-popover-apply'),

    detail: $('#detail-panel'),
    detailTitle: $('#detail-title'),
    detailBody: $('#detail-body'),
    detailClose: $('#detail-close'),

    helpModal: $('#help-modal'),
    helpClose: $('#help-close'),

    toasts: $('#toasts'),

    stats: {
        bots: $('#stat-bots'),
        vda: $('#stat-vda'),
        matched: $('#stat-matched'),
        mismatch: $('#stat-mismatch')
    },

    complianceMeasurement: $('#compliance-measurement'),
    complianceStatus: $('#compliance-status'),
    complianceLoad: $('#compliance-load'),
    complianceExport: $('#compliance-export'),
    complianceFilter: $('#compliance-filter'),
    complianceHead: $('#compliance-head'),
    complianceBody: $('#compliance-body'),
    complianceEmpty: $('#compliance-empty'),
    complianceCount: $('#compliance-count')
};

// ---------------------------------------------------------------------------
// State + persistence
// ---------------------------------------------------------------------------

const PREFS_KEY = 'viewer.prefs.v1';
// New synthetic columns get hidden by default. Stored as a string here because
// it needs to be referenced from loadPrefs(), which runs before the column
// constants below are defined.
const DEFAULT_HIDDEN_COLS = ['expected_values'];
const defaultPrefs = {
    lastSite: null,
    lookback: '1d',
    uniqueOnly: false,
    autoRefresh: 0,
    hiddenColumns: [...DEFAULT_HIDDEN_COLS],
    quickFilter: null,  // 'matched' | 'mismatched' | null
    _hideMigrations: []  // names already auto-hidden once for this browser
};

function loadPrefs() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return { ...defaultPrefs };
        const saved = JSON.parse(raw);
        const out = { ...defaultPrefs, ...saved };
        // For each default-hidden column that hasn't been migrated yet, hide it
        // once. After that, the user's manual toggle wins forever.
        const migrated = new Set(out._hideMigrations || []);
        const hidden = new Set(out.hiddenColumns || []);
        let changed = false;
        for (const col of DEFAULT_HIDDEN_COLS) {
            if (!migrated.has(col)) {
                hidden.add(col);
                migrated.add(col);
                changed = true;
            }
        }
        if (changed) {
            out.hiddenColumns = Array.from(hidden);
            out._hideMigrations = Array.from(migrated);
        }
        return out;
    } catch { return { ...defaultPrefs }; }
}
function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}
const prefs = loadPrefs();

const state = {
    sites: [],
    selectedSite: null,
    columns: [],
    rows: [],
    sortKey: null,
    sortDir: 1,
    columnFilters: new Map(),  // column name -> Set of allowed values
    lastLoadedAt: null,
    refreshTimer: null,
    refreshCountdown: null,
    activeFunnelCol: null,

    // Secondary table: compliance_details (or whatever the site has configured)
    compliance: {
        columns: [],
        rows: [],
        sortKey: null,
        sortDir: 1
    },

    // bot_id values whose Expected column is currently expanded inline.
    expandedExpected: new Set()
};

// Synthetic column: the expected VDA for each bot, looked up from
// compliance_details by api_version. Resolved per-row at render time.
const RELEASED_COL = 'released_version';

// Synthetic column: overall compatibility verdict per bot (Compatible /
// Incompatible / Unknown), based on diffs across every overlapping field
// — vda_version + master_version + every app_* firmware column.
const STATUS_COL = 'compatibility';

// Synthetic column: full expected-values snapshot from compliance_details
// for this bot's api_version. Lives at the very end of the table, hidden by
// default (see DEFAULT_HIDDEN_COLS), and expands inline when clicked.
const EXPECTED_COL = 'expected_values';

// Preferred display order. Identity columns first, then the VDA pair, then
// every other column (firmware details, time, etc.) in InfluxDB's native order.
const COLUMN_ORDER = ['time', 'bot_id', 'ip', 'api_version', 'vda_version'];

function getAllColumns() {
    if (state.columns.length === 0) return [];
    const present = new Set(state.columns);
    const out = [];
    for (const c of COLUMN_ORDER) {
        if (present.has(c)) {
            out.push(c);
            if (c === 'bot_id') out.push(STATUS_COL);
        }
    }
    if (present.has('vda_version')) out.push(RELEASED_COL);
    const pinned = new Set(COLUMN_ORDER);
    for (const c of state.columns) {
        if (!pinned.has(c)) out.push(c);
    }
    out.push(EXPECTED_COL);
    return out;
}

function getCellValue(row, col) {
    if (col === RELEASED_COL) {
        const expected = getExpectedVdaForRow(row);
        return expected == null ? '' : String(expected);
    }
    if (col === STATUS_COL) {
        const { ref, diffs } = getDiffForRow(row);
        if (!ref) return 'Unknown';
        return diffs.length === 0 ? 'Compatible' : `Incompatible (${diffs.length})`;
    }
    if (col === EXPECTED_COL) {
        // Flat one-liner of all expected values for this row. Used by CSV export
        // and any text-context caller; the table cell renders the expandable UI
        // directly (see renderBody).
        const pairs = getExpectedPairsForRow(row);
        if (!pairs) return '';
        return pairs.map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return row[state.columns.indexOf(col)];
}

// Returns an ordered [field, value] list of the compliance row matched to this
// bot's api_version, or null if no match. `time` is dropped; everything else
// the site's compliance row records is included.
function getExpectedPairsForRow(row) {
    const apiIdx = state.columns.indexOf('api_version');
    if (apiIdx === -1 || row[apiIdx] == null) return null;
    const compRow = getComplianceByApi().get(String(row[apiIdx]));
    if (!compRow) return null;
    const pairs = [];
    for (let i = 0; i < state.compliance.columns.length; i++) {
        const col = state.compliance.columns[i];
        if (col === 'time') continue;
        const v = compRow[i];
        if (v == null || String(v).trim() === '') continue;
        pairs.push([col, String(v)]);
    }
    return pairs;
}

// ---------------------------------------------------------------------------
// API helper
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
// Toasts
// ---------------------------------------------------------------------------

function toast(message, kind = 'info', ms = 3500) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    els.toasts.append(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 200ms'; }, ms - 200);
    setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------------------
// View toggle + init
// ---------------------------------------------------------------------------

function setView(authenticated) {
    els.loginView.hidden = authenticated;
    els.appView.hidden = !authenticated;
}

async function init() {
    wireEvents();
    applyPrefsToControls();
    const me = await api('/api/me').catch(() => ({ authenticated: false }));
    if (me.authenticated) {
        els.who.textContent = me.user || '';
        els.adminLink.hidden = me.role !== 'admin';
        setView(true);
        await loadSites();
        if (state.selectedSite) await loadData({ silent: true });
    } else {
        setView(false);
    }
    startLastRefreshedTicker();
    applyAutoRefresh();
}

// Restores the lookback select. If the saved value isn't one of the preset
// options (e.g. user picked a custom range last time), drops it into the
// Custom input and shows it.
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
    els.uniqueOnly.checked = prefs.uniqueOnly;
    els.autoRefresh.value = String(prefs.autoRefresh || 0);
}

// InfluxDB duration: digits + unit (m/h/d/w). Used for the Custom input.
const INFLUX_DURATION_RE = /^[1-9]\d*(ms|m|h|d|w)$/;

function isValidLookback(s) {
    return typeof s === 'string' && INFLUX_DURATION_RE.test(s);
}

function wireEvents() {
    els.loginForm.addEventListener('submit', onLogin);
    els.logout.addEventListener('click', onLogout);

    els.load.addEventListener('click', () => loadData());
    els.exportBtn.addEventListener('click', onExport);
    els.filter.addEventListener('input', () => { renderTable(); });

    els.uniqueOnly.addEventListener('change', () => {
        prefs.uniqueOnly = els.uniqueOnly.checked;
        savePrefs();
        renderTable();
    });

    els.lookback.addEventListener('change', () => {
        if (els.lookback.value === '__custom') {
            els.lookbackCustomWrap.hidden = false;
            els.lookbackCustom.focus();
            // Don't persist anything yet — wait for the custom input.
            return;
        }
        els.lookbackCustomWrap.hidden = true;
        els.lookbackCustom.value = '';
        prefs.lookback = els.lookback.value;
        savePrefs();
    });

    els.lookbackCustom.addEventListener('input', () => {
        const v = els.lookbackCustom.value.trim().toLowerCase();
        if (!v) {
            els.lookbackCustom.classList.remove('invalid');
            return;
        }
        if (!isValidLookback(v)) {
            els.lookbackCustom.classList.add('invalid');
            return;
        }
        els.lookbackCustom.classList.remove('invalid');
        prefs.lookback = v;
        savePrefs();
    });

    els.site.addEventListener('change', () => {
        const next = state.sites.find(s => s.name === els.site.value) || null;
        state.selectedSite = next;
        prefs.lastSite = next ? next.name : null;
        savePrefs();
        state.rows = [];
        state.columns = [];
        state.columnFilters.clear();
        state.compliance.columns = [];
        state.compliance.rows = [];
        state.expandedExpected.clear();
        invalidateComplianceLookup();
        prefs.quickFilter = null;
        savePrefs();
        updateComplianceLabel();
        renderTable();
        renderCompliance();
    });

    els.autoRefresh.addEventListener('change', () => {
        prefs.autoRefresh = Number(els.autoRefresh.value) || 0;
        savePrefs();
        applyAutoRefresh();
    });

    els.clearFilters.addEventListener('click', clearAllFilters);

    // Stat-card drill-downs
    document.querySelectorAll('.stat-card').forEach(card => {
        card.addEventListener('click', () => onStatClick(card.dataset.action));
    });

    // Column menu
    els.colMenuBtn.addEventListener('click', toggleColMenu);

    // Filter popover
    els.filterPopSearch.addEventListener('input', renderFilterPopList);
    els.filterPopClear.addEventListener('click', () => {
        if (state.activeFunnelCol) {
            state.columnFilters.delete(state.activeFunnelCol);
            hideFilterPop();
            renderTable();
        }
    });
    els.filterPopApply.addEventListener('click', applyFilterPop);

    // Detail panel
    els.detailClose.addEventListener('click', closeDetail);

    // Help
    els.helpBtn.addEventListener('click', () => { els.helpModal.hidden = false; });
    els.helpClose.addEventListener('click', () => { els.helpModal.hidden = true; });
    els.helpModal.addEventListener('click', (e) => {
        if (e.target === els.helpModal) els.helpModal.hidden = true;
    });

    // Compliance table
    els.complianceLoad.addEventListener('click', () => loadCompliance());
    els.complianceExport.addEventListener('click', onComplianceExport);
    els.complianceFilter.addEventListener('input', renderCompliance);

    // Global dismissals
    document.addEventListener('click', onGlobalClick);
    document.addEventListener('keydown', onGlobalKey);
    document.addEventListener('visibilitychange', applyAutoRefresh);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

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
        if (state.selectedSite) await loadData({ silent: true });
    } catch (err) {
        els.loginError.textContent = err.message;
        els.loginError.hidden = false;
    }
}

async function onLogout() {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    stopAutoRefresh();
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
        placeholder.textContent = 'Select site...';
        els.site.append(placeholder);
        for (const s of sites) {
            const opt = document.createElement('option');
            opt.value = s.name;
            opt.textContent = s.name;
            els.site.append(opt);
        }
        const preferred = prefs.lastSite && sites.find(s => s.name === prefs.lastSite);
        const target = preferred || sites[0];
        if (target) {
            els.site.value = target.name;
            state.selectedSite = target;
            prefs.lastSite = target.name;
            savePrefs();
        }
        updateComplianceLabel();
    } catch (err) {
        if (err.status === 401) setView(false);
        else toast(err.message, 'error');
    }
}

function updateComplianceLabel() {
    const m = state.selectedSite && state.selectedSite.complianceMeasurement;
    els.complianceMeasurement.textContent = m || '—';
}

// ---------------------------------------------------------------------------
// Compliance lookup: api_version → reference row from compliance_details.
// Built lazily after compliance data loads; the cache is invalidated whenever
// site changes or compliance data is refreshed.
// ---------------------------------------------------------------------------

let _complianceByApi = null;

function invalidateComplianceLookup() {
    _complianceByApi = null;
}

function getComplianceByApi() {
    if (_complianceByApi) return _complianceByApi;
    const map = new Map();
    const c = state.compliance;
    const apiIdx = c.columns.indexOf('api_version');
    if (apiIdx === -1) { _complianceByApi = map; return map; }
    // compliance is fetched ORDER BY time DESC, so the first row seen for an
    // api_version is the most recent — keep that one.
    for (const row of c.rows) {
        const api = row[apiIdx];
        if (api == null) continue;
        const key = String(api);
        if (!map.has(key)) map.set(key, row);
    }
    _complianceByApi = map;
    return map;
}

function getExpectedVdaForRow(row) {
    const apiIdx = state.columns.indexOf('api_version');
    if (apiIdx === -1) return null;
    const api = row[apiIdx];
    if (api == null) return null;
    const compRow = getComplianceByApi().get(String(api));
    if (!compRow) return null;
    const cVdaIdx = state.compliance.columns.indexOf('vda_version');
    if (cVdaIdx === -1) return null;
    return compRow[cVdaIdx];
}

// Fields not considered when computing a diff against compliance_details.
const DIFF_IGNORE = new Set(['time', 'api_version']);

// Returns { ref: complianceRow | null, diffs: [{field, actual, expected}] }
// - ref === null: no compliance row matched this bot's api_version (status unknown)
// - diffs === []: every overlapping field matched the compliance record
// - diffs.length > 0: at least one overlapping field differs
function getDiffForRow(row) {
    const apiIdx = state.columns.indexOf('api_version');
    if (apiIdx === -1) return { ref: null, diffs: [] };
    const api = row[apiIdx];
    if (api == null) return { ref: null, diffs: [] };
    const compRow = getComplianceByApi().get(String(api));
    if (!compRow) return { ref: null, diffs: [] };

    const diffs = [];
    for (let i = 0; i < state.columns.length; i++) {
        const col = state.columns[i];
        if (DIFF_IGNORE.has(col)) continue;
        const ci = state.compliance.columns.indexOf(col);
        if (ci === -1) continue;  // compliance doesn't track this field — skip
        const actual = row[i];
        const expected = compRow[ci];
        if (actual == null || expected == null) continue;  // missing on either side: don't false-alarm
        if (String(actual).trim() !== String(expected).trim()) {
            diffs.push({ field: col, actual, expected });
        }
    }
    return { ref: compRow, diffs };
}

// ---------------------------------------------------------------------------
// Data load
// ---------------------------------------------------------------------------

async function loadData({ silent = false } = {}) {
    if (!state.selectedSite) {
        if (!silent) toast('Select a site first', 'warn');
        return;
    }
    const site = state.selectedSite;
    if (!isValidLookback(prefs.lookback)) {
        if (!silent) toast(`Invalid lookback "${prefs.lookback}". Use e.g. 30m, 48h, 3d, 2w.`, 'warn');
        return;
    }
    const q = `SELECT * FROM "${site.measurement}" WHERE time > now() - ${prefs.lookback} ORDER BY time DESC LIMIT 10000`;
    els.load.disabled = true;
    try {
        const params = new URLSearchParams({ site: site.name, q });
        // Kick off the secondary compliance fetch in parallel — don't block the main UI on it.
        const compliancePromise = loadCompliance({ silent: true });
        const result = await api('/api/query?' + params.toString());
        const parsed = parseInflux(result);
        if (parsed.error) throw new Error(parsed.error);
        state.columns = parsed.columns;
        state.rows = parsed.rows;
        state.lastLoadedAt = new Date();
        renderTable();
        if (!silent) toast(`Loaded ${parsed.rows.length} rows from ${site.name}`, 'success');
        els.exportBtn.disabled = parsed.rows.length === 0;
        updateLastRefreshed();
        await compliancePromise;
    } catch (err) {
        if (err.status === 401) { setView(false); return; }
        toast(err.message, 'error');
        state.columns = [];
        state.rows = [];
        renderTable();
    } finally {
        els.load.disabled = false;
    }
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
// Compliance details (secondary table — different measurement, same site)
// ---------------------------------------------------------------------------

async function loadCompliance({ silent = false } = {}) {
    if (!state.selectedSite) return;
    const site = state.selectedSite;
    const measurement = site.complianceMeasurement || 'compliance_details';
    const q = `SELECT * FROM "${measurement}" ORDER BY time DESC LIMIT 10000`;
    els.complianceLoad.disabled = true;
    els.complianceStatus.textContent = 'Loading...';
    try {
        const params = new URLSearchParams({ site: site.name, q });
        const result = await api('/api/query?' + params.toString());
        const parsed = parseInflux(result);
        if (parsed.error) throw new Error(parsed.error);
        state.compliance.columns = parsed.columns;
        state.compliance.rows = parsed.rows;
        invalidateComplianceLookup();
        els.complianceStatus.textContent = '';
        renderCompliance();
        renderTable();  // refresh stats / alerts / coloring now that lookup exists
        els.complianceExport.disabled = parsed.rows.length === 0;
        if (!silent) toast(`Loaded ${parsed.rows.length} compliance rows`, 'success');
    } catch (err) {
        if (err.status === 401) { setView(false); return; }
        state.compliance.columns = [];
        state.compliance.rows = [];
        invalidateComplianceLookup();
        els.complianceStatus.textContent = '';
        renderCompliance();
        renderTable();
        els.complianceEmpty.textContent = `Could not load ${measurement}: ${err.message}`;
        els.complianceExport.disabled = true;
        if (!silent) toast(`Compliance load failed: ${err.message}`, 'error');
    } finally {
        els.complianceLoad.disabled = false;
    }
}

function getFilteredComplianceRows() {
    let rows = state.compliance.rows;
    const needle = els.complianceFilter.value.trim().toLowerCase();
    if (needle) {
        rows = rows.filter(row => row.some(c => c != null && String(c).toLowerCase().includes(needle)));
    }
    if (state.compliance.sortKey != null) {
        const idx = state.compliance.columns.indexOf(state.compliance.sortKey);
        if (idx !== -1) {
            rows = rows.slice().sort((a, b) => {
                const av = a[idx], bv = b[idx];
                if (av === bv) return 0;
                if (av == null) return 1;
                if (bv == null) return -1;
                return (av > bv ? 1 : -1) * state.compliance.sortDir;
            });
        }
    }
    return rows;
}

function renderCompliance() {
    const c = state.compliance;
    const rows = getFilteredComplianceRows();

    // Header
    els.complianceHead.replaceChildren();
    for (const col of c.columns) {
        const th = document.createElement('th');
        if (col === 'bot_id') th.classList.add('pinned');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sort-btn';
        const arrow = c.sortKey === col ? (c.sortDir === 1 ? ' ▲' : ' ▼') : '';
        btn.textContent = col + arrow;
        btn.addEventListener('click', () => {
            if (c.sortKey === col) c.sortDir *= -1;
            else { c.sortKey = col; c.sortDir = (col === 'time' || /(_|^)time$/.test(col)) ? -1 : 1; }
            renderCompliance();
        });
        th.append(btn);
        els.complianceHead.append(th);
    }

    // Body
    els.complianceBody.replaceChildren();
    const MAX = 1000;
    const display = rows.slice(0, MAX);
    const frag = document.createDocumentFragment();
    for (const row of display) {
        const tr = document.createElement('tr');
        for (let i = 0; i < c.columns.length; i++) {
            const td = document.createElement('td');
            const col = c.columns[i];
            if (col === 'bot_id') td.classList.add('pinned');
            td.textContent = formatCell(col, row[i]);
            tr.append(td);
        }
        frag.append(tr);
    }
    els.complianceBody.append(frag);
    if (rows.length > MAX) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = c.columns.length;
        td.style.textAlign = 'center';
        td.style.color = 'var(--muted)';
        td.textContent = `Showing first ${MAX} of ${rows.length} matching rows. Refine your filter to see more.`;
        tr.append(td);
        els.complianceBody.append(tr);
    }

    els.complianceCount.textContent = c.rows.length
        ? `Showing ${rows.length} of ${c.rows.length} rows`
        : '';
    els.complianceEmpty.hidden = rows.length > 0;
    if (rows.length === 0) {
        els.complianceEmpty.textContent = c.rows.length === 0
            ? 'No compliance data loaded yet.'
            : 'No rows match the filter.';
    }
}

function onComplianceExport() {
    const c = state.compliance;
    const rows = getFilteredComplianceRows();
    if (!rows.length) return;
    const lines = [c.columns.map(csvCell).join(',')];
    for (const row of rows) lines.push(row.map(csvCell).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const site = state.selectedSite ? state.selectedSite.name : 'export';
    const meas = (state.selectedSite && state.selectedSite.complianceMeasurement) || 'compliance';
    a.href = url;
    a.download = `${site}_${meas}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} compliance rows`, 'success');
}

// ---------------------------------------------------------------------------
// Filtering pipeline (used by table, stats, chart)
// ---------------------------------------------------------------------------

function getVisibleColumns() {
    const hidden = new Set(prefs.hiddenColumns);
    return getAllColumns().filter(c => !hidden.has(c));
}

function getRowsAfterUnique(rows) {
    if (!els.uniqueOnly.checked) return rows;
    const botIdx = state.columns.indexOf('bot_id');
    if (botIdx === -1) return rows;
    const seen = new Set();
    const out = [];
    for (const row of rows) {
        const id = row[botIdx];
        if (!seen.has(id)) { seen.add(id); out.push(row); }
    }
    return out;
}

function getRowsAfterColumnFilters(rows) {
    if (state.columnFilters.size === 0) return rows;
    const entries = Array.from(state.columnFilters.entries()).map(([col, allowed]) => ({
        idx: state.columns.indexOf(col),
        allowed
    }));
    return rows.filter(row => entries.every(({ idx, allowed }) => {
        if (idx === -1) return true;
        return allowed.has(String(row[idx] == null ? '' : row[idx]));
    }));
}

function getRowsAfterQuickFilter(rows) {
    if (!prefs.quickFilter) return rows;
    if (prefs.quickFilter === 'matched') {
        return rows.filter(r => {
            const { ref, diffs } = getDiffForRow(r);
            return ref && diffs.length === 0;
        });
    }
    if (prefs.quickFilter === 'mismatched') {
        return rows.filter(r => {
            const { ref, diffs } = getDiffForRow(r);
            return ref && diffs.length > 0;
        });
    }
    return rows;
}

function getRowsAfterGlobalText(rows) {
    const needle = els.filter.value.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(row => row.some(c => c != null && String(c).toLowerCase().includes(needle)));
}

function getRowsAfterSort(rows) {
    if (state.sortKey == null) return rows;
    const idx = state.columns.indexOf(state.sortKey);
    if (idx === -1) return rows;
    return rows.slice().sort((a, b) => {
        const av = a[idx], bv = b[idx];
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return (av > bv ? 1 : -1) * state.sortDir;
    });
}

function getFilteredRows() {
    let rows = state.rows;
    rows = getRowsAfterUnique(rows);
    rows = getRowsAfterColumnFilters(rows);
    rows = getRowsAfterQuickFilter(rows);
    rows = getRowsAfterGlobalText(rows);
    rows = getRowsAfterSort(rows);
    return rows;
}

// ---------------------------------------------------------------------------
// Rendering: table + stats + chips + chart
// ---------------------------------------------------------------------------

function renderTable() {
    const rows = getFilteredRows();
    renderHead();
    renderBody(rows);
    renderChips();
    renderStats(rows);
    renderChart(rows);
    renderVdaAlerts(rows);
    renderColMenu();
    updateActiveStatCard();
    els.rowCount.textContent = state.rows.length
        ? `Showing ${rows.length} of ${state.rows.length} rows`
        : '';
    els.empty.hidden = rows.length > 0;
    els.empty.textContent = state.rows.length === 0
        ? 'Select a site and click Load data.'
        : 'No rows match the current filter.';
}

function renderHead() {
    els.head.replaceChildren();
    const visible = getVisibleColumns();
    for (const col of visible) {
        const th = document.createElement('th');
        th.classList.add('col-' + col.replace(/[^a-zA-Z0-9_-]/g, '_'));
        if (col === 'bot_id') th.classList.add('pinned');

        const inner = document.createElement('span');
        inner.className = 'th-inner';

        const sortBtn = document.createElement('button');
        sortBtn.type = 'button';
        sortBtn.className = 'sort-btn';
        const arrow = state.sortKey === col ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '';
        sortBtn.textContent = col + arrow;
        sortBtn.addEventListener('click', () => {
            if (state.sortKey === col) state.sortDir *= -1;
            else { state.sortKey = col; state.sortDir = (col === 'time' || /(_|^)time$/.test(col)) ? -1 : 1; }
            renderTable();
        });
        inner.append(sortBtn);

        if (col !== RELEASED_COL && col !== STATUS_COL && col !== EXPECTED_COL) {
            const funnel = document.createElement('button');
            funnel.type = 'button';
            funnel.className = 'funnel' + (state.columnFilters.has(col) ? ' active' : '');
            funnel.textContent = '▾';
            funnel.title = 'Filter';
            funnel.addEventListener('click', (e) => {
                e.stopPropagation();
                openFilterPop(col, funnel);
            });
            inner.append(funnel);
        }

        th.append(inner);
        els.head.append(th);
    }
}

function renderBody(rows) {
    const visible = getVisibleColumns();

    els.body.replaceChildren();
    const MAX_VISIBLE = 1000;
    const display = rows.slice(0, MAX_VISIBLE);

    const frag = document.createDocumentFragment();
    for (const row of display) {
        const tr = document.createElement('tr');
        const { ref, diffs } = getDiffForRow(row);
        if (ref) tr.classList.add(diffs.length === 0 ? 'match' : 'mismatch');
        const diffFields = new Set(diffs.map(d => d.field));
        tr.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            showDetail(row);
        });
        for (const col of visible) {
            const td = document.createElement('td');
            td.classList.add('col-' + col.replace(/[^a-zA-Z0-9_-]/g, '_'));
            if (col === 'bot_id') td.classList.add('pinned');
            if (diffFields.has(col)) td.classList.add('diff');
            if (col === STATUS_COL) {
                const pill = document.createElement('span');
                pill.className = 'status-pill';
                if (!ref) {
                    pill.classList.add('unknown');
                    pill.textContent = 'Unknown';
                    pill.title = 'No compliance row matches this bot\'s api_version';
                } else if (diffs.length === 0) {
                    pill.classList.add('ok');
                    pill.textContent = '✓ Compatible';
                } else {
                    pill.classList.add('bad');
                    pill.textContent = `✗ Incompatible (${diffs.length})`;
                    pill.title = diffs.map(d => `${d.field}: ${d.actual} → ${d.expected}`).join('\n');
                }
                td.append(pill);
            } else if (col === EXPECTED_COL) {
                renderExpectedCell(td, row, diffFields);
            } else {
                const raw = getCellValue(row, col);
                td.textContent = formatCell(col, raw);
            }
            tr.append(td);
        }
        frag.append(tr);
    }
    els.body.append(frag);

    if (rows.length > MAX_VISIBLE) {
        const note = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = visible.length;
        td.style.textAlign = 'center';
        td.style.color = 'var(--muted)';
        td.textContent = `Showing first ${MAX_VISIBLE} of ${rows.length} matching rows. Refine your filter to see more.`;
        note.append(td);
        els.body.append(note);
    }
}

// Renders the per-row "Expected" cell. Collapsed by default: shows a button
// that toggles an inline list of every field from the matched compliance row.
// Fields that differ from the bot row are highlighted (uses diffFields, the
// set of fields where this bot disagrees with compliance).
function renderExpectedCell(td, row, diffFields) {
    const pairs = getExpectedPairsForRow(row);
    if (!pairs) {
        const muted = document.createElement('span');
        muted.className = 'muted';
        muted.textContent = '—';
        td.append(muted);
        return;
    }
    const botIdx = state.columns.indexOf('bot_id');
    const botId = botIdx === -1 ? null : row[botIdx];
    const key = botId == null ? null : String(botId);
    const expanded = key != null && state.expandedExpected.has(key);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'expected-toggle';
    btn.textContent = expanded ? `▾ Hide (${pairs.length})` : `▸ Show (${pairs.length})`;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (key == null) return;
        if (state.expandedExpected.has(key)) state.expandedExpected.delete(key);
        else state.expandedExpected.add(key);
        renderTable();
    });
    td.append(btn);

    if (expanded) {
        const list = document.createElement('dl');
        list.className = 'expected-list';
        for (const [field, value] of pairs) {
            const dt = document.createElement('dt');
            dt.textContent = field;
            const dd = document.createElement('dd');
            dd.textContent = value;
            if (diffFields.has(field)) {
                dt.classList.add('diff');
                dd.classList.add('diff');
            }
            list.append(dt, dd);
        }
        td.append(list);
    }
}

function formatCell(col, value) {
    if (value == null) return '';
    if (col === 'time' || /(_|^)time$/.test(col)) {
        const d = new Date(value);
        if (!isNaN(d.getTime())) return d.toLocaleString();
    }
    return String(value);
}

function renderChips() {
    els.chips.replaceChildren();
    const haveChips = state.columnFilters.size > 0 || !!prefs.quickFilter;
    els.chipsBar.hidden = !haveChips;

    if (prefs.quickFilter) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = prefs.quickFilter === 'matched' ? 'Compliant only' : 'Mismatched only';
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.addEventListener('click', () => { prefs.quickFilter = null; savePrefs(); renderTable(); });
        chip.append(x);
        els.chips.append(chip);
    }

    for (const [col, allowed] of state.columnFilters) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        const list = Array.from(allowed);
        const summary = list.length > 2 ? `${list.length} values` : list.join(', ');
        chip.textContent = `${col}: ${summary}`;
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.addEventListener('click', () => { state.columnFilters.delete(col); renderTable(); });
        chip.append(x);
        els.chips.append(chip);
    }
}

function renderStats(rows) {
    const vdaIdx = state.columns.indexOf('vda_version');

    els.stats.bots.textContent = String(rows.length);
    const vdaSet = vdaIdx === -1 ? new Set() : new Set(rows.map(r => r[vdaIdx]).filter(v => v != null));
    els.stats.vda.textContent = String(vdaSet.size);

    const haveCompliance = state.compliance.rows.length > 0
        && state.compliance.columns.indexOf('api_version') !== -1
        && state.columns.indexOf('api_version') !== -1;

    if (haveCompliance) {
        let m = 0, x = 0;
        for (const r of rows) {
            const { ref, diffs } = getDiffForRow(r);
            if (!ref) continue;
            if (diffs.length === 0) m++; else x++;
        }
        els.stats.matched.textContent = String(m);
        els.stats.mismatch.textContent = String(x);
    } else {
        els.stats.matched.textContent = '—';
        els.stats.mismatch.textContent = '—';
    }
}

function updateActiveStatCard() {
    document.querySelectorAll('.stat-card').forEach(card => {
        const a = card.dataset.action;
        card.classList.toggle('active',
            (a === 'matched' && prefs.quickFilter === 'matched') ||
            (a === 'mismatch' && prefs.quickFilter === 'mismatched'));
    });
}

function onStatClick(action) {
    if (action === 'all') {
        clearAllFilters();
        return;
    }
    if (action === 'matched' || action === 'mismatch') {
        const target = action === 'matched' ? 'matched' : 'mismatched';
        prefs.quickFilter = prefs.quickFilter === target ? null : target;
        savePrefs();
        renderTable();
        return;
    }
    // For vda: open the per-column filter dropdown
    const colMap = { vda: 'vda_version' };
    const col = colMap[action];
    if (col && state.columns.includes(col)) {
        // Anchor the popover under the matching stat card
        const anchor = document.querySelector(`.stat-card[data-action="${action}"]`);
        openFilterPop(col, anchor);
    }
}

function clearAllFilters() {
    state.columnFilters.clear();
    prefs.quickFilter = null;
    els.filter.value = '';
    savePrefs();
    renderTable();
}

// ---------------------------------------------------------------------------
// SVG bar chart
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function renderChart(rows) {
    const vdaIdx = state.columns.indexOf('vda_version');
    if (vdaIdx === -1 || rows.length === 0) {
        els.chartCard.hidden = true;
        els.chart.replaceChildren();
        return;
    }
    const counts = new Map();
    for (const r of rows) {
        const v = r[vdaIdx];
        if (v == null) continue;
        const key = String(v);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (counts.size === 0) {
        els.chartCard.hidden = true;
        els.chart.replaceChildren();
        return;
    }
    els.chartCard.hidden = false;
    const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    // A version is "released" if any bot's api_version maps to it via compliance_details.
    const expectedSet = new Set();
    for (const r of rows) {
        const e = getExpectedVdaForRow(r);
        if (e != null) expectedSet.add(String(e));
    }

    const barW = 60, gap = 18, leftPad = 12, rightPad = 12, topPad = 24, botPad = 40;
    const maxH = 140;
    const max = Math.max(...entries.map(e => e[1]));
    const width = leftPad + rightPad + entries.length * (barW + gap) - gap;
    const height = topPad + maxH + botPad;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    entries.forEach(([version, count], i) => {
        const x = leftPad + i * (barW + gap);
        const h = Math.max(2, Math.round((count / max) * maxH));
        const y = topPad + maxH - h;

        const isReleased = expectedSet.has(version);
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('class', 'bar' + (isReleased ? ' bar-released' : ''));
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(barW));
        rect.setAttribute('height', String(h));
        rect.setAttribute('rx', '4');
        rect.setAttribute('fill', isReleased ? '#00c853' : '#4facfe');
        rect.addEventListener('click', () => {
            state.columnFilters.set('vda_version', new Set([version]));
            renderTable();
        });
        const title = document.createElementNS(SVG_NS, 'title');
        title.textContent = `${version}: ${count}${isReleased ? ' (released)' : ''}`;
        rect.append(title);
        svg.append(rect);

        const value = document.createElementNS(SVG_NS, 'text');
        value.setAttribute('class', 'bar-value');
        value.setAttribute('x', String(x + barW / 2));
        value.setAttribute('y', String(y - 4));
        value.setAttribute('text-anchor', 'middle');
        value.textContent = String(count);
        svg.append(value);

        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('class', 'bar-label');
        label.setAttribute('x', String(x + barW / 2));
        label.setAttribute('y', String(topPad + maxH + 16));
        label.setAttribute('text-anchor', 'middle');
        label.textContent = version.length > 12 ? version.slice(0, 11) + '…' : version;
        const labelTitle = document.createElementNS(SVG_NS, 'title');
        labelTitle.textContent = version;
        label.append(labelTitle);
        svg.append(label);
    });

    els.chart.replaceChildren(svg);
}

// ---------------------------------------------------------------------------
// VDA Version Alerts panel (ported from legacy 3pvc viewer)
// Lists every bot whose vda_version differs from the site's released version.
// ---------------------------------------------------------------------------

function renderVdaAlerts(rows) {
    const botIdx = state.columns.indexOf('bot_id');
    const ipIdx = state.columns.indexOf('ip');
    const apiIdx = state.columns.indexOf('api_version');

    if (apiIdx === -1 || rows.length === 0 || state.compliance.rows.length === 0) {
        els.vdaAlertSection.hidden = true;
        els.vdaAlertList.replaceChildren();
        return;
    }

    // Group by bot_id; show the most-recent mismatched record per bot.
    const seen = new Set();
    const alerts = [];
    for (const row of rows) {
        const { ref, diffs } = getDiffForRow(row);
        if (!ref || diffs.length === 0) continue;
        const botId = botIdx !== -1 ? row[botIdx] : '';
        if (botId == null || botId === '') continue;
        if (seen.has(botId)) continue;
        seen.add(botId);
        const ip = ipIdx !== -1 ? row[ipIdx] : '';
        alerts.push({
            botId: String(botId),
            ip: ip == null ? '' : String(ip),
            diffs
        });
    }

    if (alerts.length === 0) {
        els.vdaAlertSection.hidden = true;
        els.vdaAlertList.replaceChildren();
        return;
    }

    els.vdaAlertSection.hidden = false;
    els.vdaAlertCount.textContent = String(alerts.length);

    const MAX_DIFFS_PER_BOT = 6;
    els.vdaAlertList.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const a of alerts) {
        const item = document.createElement('div');
        item.className = 'alert-item';

        const head = document.createElement('div');
        head.className = 'alert-head';

        const bot = document.createElement('span');
        bot.className = 'alert-bot';
        bot.textContent = a.botId;
        head.append(bot);

        if (a.ip) {
            const ip = document.createElement('span');
            ip.className = 'alert-ip';
            ip.textContent = `(${a.ip})`;
            head.append(ip);
        }

        const meta = document.createElement('span');
        meta.className = 'alert-meta';
        meta.textContent = `${a.diffs.length} field${a.diffs.length === 1 ? '' : 's'} differ`;
        head.append(meta);
        item.append(head);

        const diffsEl = document.createElement('div');
        diffsEl.className = 'alert-diffs';
        for (const d of a.diffs.slice(0, MAX_DIFFS_PER_BOT)) {
            const line = document.createElement('div');
            line.className = 'alert-diff';

            const field = document.createElement('span');
            field.className = 'alert-field';
            field.textContent = d.field + ':';
            line.append(field);

            const bad = document.createElement('span');
            bad.className = 'alert-bad';
            bad.textContent = formatCell(d.field, d.actual);
            line.append(bad);

            const arrow = document.createElement('span');
            arrow.className = 'alert-arrow';
            arrow.textContent = '→';
            line.append(arrow);

            const good = document.createElement('span');
            good.className = 'alert-good';
            good.textContent = formatCell(d.field, d.expected);
            line.append(good);

            diffsEl.append(line);
        }
        if (a.diffs.length > MAX_DIFFS_PER_BOT) {
            const more = document.createElement('div');
            more.className = 'alert-more';
            more.textContent = `+ ${a.diffs.length - MAX_DIFFS_PER_BOT} more field${a.diffs.length - MAX_DIFFS_PER_BOT === 1 ? '' : 's'}`;
            diffsEl.append(more);
        }
        item.append(diffsEl);

        frag.append(item);
    }
    els.vdaAlertList.append(frag);
}

// ---------------------------------------------------------------------------
// Filter popover (per-column)
// ---------------------------------------------------------------------------

function openFilterPop(col, anchor) {
    state.activeFunnelCol = col;
    state.activeFunnelDraft = new Set(state.columnFilters.get(col) || []);
    els.filterPopSearch.value = '';
    renderFilterPopList();

    const rect = anchor.getBoundingClientRect();
    els.filterPop.hidden = false;
    // Render once to measure
    const popRect = els.filterPop.getBoundingClientRect();
    let left = window.scrollX + rect.left;
    if (left + popRect.width > window.scrollX + window.innerWidth - 8) {
        left = window.scrollX + window.innerWidth - popRect.width - 8;
    }
    const top = window.scrollY + rect.bottom + 4;
    els.filterPop.style.left = left + 'px';
    els.filterPop.style.top = top + 'px';
    els.filterPopSearch.focus();
}

function hideFilterPop() {
    els.filterPop.hidden = true;
    state.activeFunnelCol = null;
}

function renderFilterPopList() {
    const col = state.activeFunnelCol;
    if (!col) return;
    const idx = state.columns.indexOf(col);
    const counts = new Map();
    // Distinct values are computed from rows AFTER all OTHER filters apply
    // (so funnels behave like Excel)
    const baseRows = getRowsAfterUnique(state.rows);
    const otherFiltered = baseRows.filter(row => {
        for (const [c, allowed] of state.columnFilters) {
            if (c === col) continue;
            const i = state.columns.indexOf(c);
            if (i === -1) continue;
            const v = row[i] == null ? '' : String(row[i]);
            if (!allowed.has(v)) return false;
        }
        return true;
    });
    for (const r of otherFiltered) {
        const v = r[idx] == null ? '' : String(r[idx]);
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
            // Start narrowing only on first interaction
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
    if (draft && draft.size > 0) state.columnFilters.set(col, draft);
    else state.columnFilters.delete(col);
    hideFilterPop();
    renderTable();
}

// ---------------------------------------------------------------------------
// Column visibility menu
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
    if (state.columns.length === 0) {
        const p = document.createElement('p');
        p.className = 'muted small';
        p.style.padding = '0.5rem 0.75rem';
        p.textContent = 'Load data first.';
        els.colMenu.append(p);
        return;
    }
    const hidden = new Set(prefs.hiddenColumns);
    for (const col of getAllColumns()) {
        const opt = document.createElement('label');
        opt.className = 'opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !hidden.has(col);
        cb.addEventListener('change', () => {
            if (cb.checked) hidden.delete(col); else hidden.add(col);
            prefs.hiddenColumns = Array.from(hidden);
            savePrefs();
            renderTable();
        });
        const label = document.createElement('span');
        label.className = 'opt-label';
        label.textContent = col;
        opt.append(cb, label);
        els.colMenu.append(opt);
    }
}

// ---------------------------------------------------------------------------
// Row detail panel
// ---------------------------------------------------------------------------

function showDetail(row) {
    els.detailBody.replaceChildren();
    const botIdx = state.columns.indexOf('bot_id');
    els.detailTitle.textContent = botIdx !== -1 && row[botIdx]
        ? `Bot: ${row[botIdx]}`
        : 'Row details';

    // Find the matched compliance reference row by api_version, if any.
    const apiIdx = state.columns.indexOf('api_version');
    const cApiIdx = state.compliance.columns.indexOf('api_version');
    let compRow = null;
    if (apiIdx !== -1 && cApiIdx !== -1 && row[apiIdx] != null) {
        compRow = getComplianceByApi().get(String(row[apiIdx])) || null;
    }

    for (const col of getAllColumns()) {
        const dt = document.createElement('dt');
        dt.textContent = col;
        const dd = document.createElement('dd');
        const actual = getCellValue(row, col);
        dd.textContent = formatCell(col, actual);

        // For real bot columns (not the synthetic columns), if the matched
        // compliance row has the same column and the values differ, annotate it.
        if (col !== RELEASED_COL && col !== STATUS_COL && col !== EXPECTED_COL && compRow) {
            const ci = state.compliance.columns.indexOf(col);
            if (ci !== -1) {
                const expected = compRow[ci];
                if (expected != null && actual != null && String(expected) !== String(actual)) {
                    dt.classList.add('diff');
                    const note = document.createElement('span');
                    note.className = 'diff-note';
                    note.textContent = `  expected: ${formatCell(col, expected)}`;
                    dd.append(note);
                }
            }
        }
        els.detailBody.append(dt, dd);
    }
    els.detail.hidden = false;
}

function closeDetail() { els.detail.hidden = true; }

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function onExport() {
    const rows = getFilteredRows();
    if (!rows.length) return;
    const visible = getVisibleColumns();
    const lines = [visible.map(csvCell).join(',')];
    for (const row of rows) lines.push(visible.map(col => csvCell(getCellValue(row, col))).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const site = state.selectedSite ? state.selectedSite.name : 'export';
    a.href = url;
    a.download = `${site}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} rows`, 'success');
}

function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

// ---------------------------------------------------------------------------
// Auto-refresh + last-refreshed indicator
// ---------------------------------------------------------------------------

function applyAutoRefresh() {
    stopAutoRefresh();
    const seconds = Number(els.autoRefresh.value) || 0;
    if (seconds <= 0) return;
    if (document.hidden) return;
    state.refreshTimer = setInterval(() => {
        if (!document.hidden && state.selectedSite) {
            loadData({ silent: true });
        }
    }, seconds * 1000);
}

function stopAutoRefresh() {
    if (state.refreshTimer) {
        clearInterval(state.refreshTimer);
        state.refreshTimer = null;
    }
}

function startLastRefreshedTicker() {
    setInterval(updateLastRefreshed, 5000);
}

function updateLastRefreshed() {
    if (!state.lastLoadedAt) {
        els.lastRefreshed.hidden = true;
        return;
    }
    const ms = Date.now() - state.lastLoadedAt.getTime();
    els.lastRefreshed.hidden = false;
    els.lastRefreshed.textContent = 'Updated ' + relativeTime(ms);
}

function relativeTime(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s <= 5 ? 'just now' : `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return `${h}h ago`;
}

// ---------------------------------------------------------------------------
// Global click + keyboard
// ---------------------------------------------------------------------------

function onGlobalClick(e) {
    if (!els.filterPop.hidden) {
        if (!els.filterPop.contains(e.target) && !e.target.closest('.funnel') && !e.target.closest('.stat-card')) {
            hideFilterPop();
        }
    }
    if (!els.colMenu.hidden) {
        if (!els.colMenu.contains(e.target) && e.target !== els.colMenuBtn) {
            els.colMenu.hidden = true;
        }
    }
}

function onGlobalKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    const inField = tag === 'input' || tag === 'textarea' || tag === 'select';

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        els.filter.focus();
        els.filter.select();
        return;
    }
    if (e.key === 'Escape') {
        if (!els.filterPop.hidden) { hideFilterPop(); return; }
        if (!els.colMenu.hidden) { els.colMenu.hidden = true; return; }
        if (!els.detail.hidden) { closeDetail(); return; }
        if (!els.helpModal.hidden) { els.helpModal.hidden = true; return; }
    }
    if (inField) return;

    if (e.key === '?') { els.helpModal.hidden = false; return; }
    if (e.key.toLowerCase() === 'r' && state.selectedSite) { loadData(); return; }
    if (e.key.toLowerCase() === 'u') {
        els.uniqueOnly.checked = !els.uniqueOnly.checked;
        prefs.uniqueOnly = els.uniqueOnly.checked;
        savePrefs();
        renderTable();
    }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init();
