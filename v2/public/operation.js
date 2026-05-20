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
    pingBotBtn: $('#ping-bot-btn'),
    opsHint: $('#site-ops-hint'),
    opsOutput: $('#site-ops-output'),

    vdaCard: $('#vda-deploy-card'),
    vdaLoadBtn: $('#vda-load-inventory'),
    vdaHint: $('#vda-hint'),
    vdaForm: $('#vda-form'),
    vdaFile: $('#vda-file'),
    vdaFileHint: $('#vda-file-hint'),
    vdaVersion: $('#vda-vda-version'),
    vdaEmqxHost: $('#vda-emqx-host'),
    vdaBotSection: $('#vda-bot-section'),
    vdaIpsWrap: $('#vda-ips-wrap'),
    vdaIpsList: $('#vda-ips-list'),
    vdaIpsAll: $('#vda-ips-all'),
    vdaIpsNone: $('#vda-ips-none'),
    vdaBasket: $('#vda-basket'),
    vdaBasketSummary: $('#vda-basket-summary'),
    vdaBasketClear: $('#vda-basket-clear'),
    vdaDeployBtn: $('#vda-deploy-btn'),
    vdaDeployStatus: $('#vda-deploy-status'),
    vdaOutput: $('#vda-output'),

    mtCard: $('#bot-maintenance-card'),
    mtHint: $('#mt-hint'),
    mtForm: $('#mt-form'),
    mtSection: $('#mt-section'),
    mtCommand: $('#mt-command'),
    mtIpsWrap: $('#mt-ips-wrap'),
    mtIpsList: $('#mt-ips-list'),
    mtIpsAll: $('#mt-ips-all'),
    mtIpsNone: $('#mt-ips-none'),
    mtBasket: $('#mt-basket'),
    mtBasketSummary: $('#mt-basket-summary'),
    mtBasketClear: $('#mt-basket-clear'),
    mtRunBtn: $('#mt-run-btn'),
    mtStatus: $('#mt-status'),
    mtOutput: $('#mt-output'),

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
    rows: [],                  // rows returned by the last query
    vdaSections: null,         // { section_name: [{ip, active}, ...] } or null
    vdaIpToBot: {},            // { "10.95.246.101": "42", ... }
    vdaSelections: {},         // { section_name: Set<ip>, ... } accumulated across section switches
    mtSelections: {}           // same shape, for the maintenance widget
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
        updateOpsCard();
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
    els.pingBotBtn.addEventListener('click', onPingBot);

    els.vdaLoadBtn.addEventListener('click', onVdaLoadInventory);
    els.vdaFile.addEventListener('change', onVdaFileChange);
    els.vdaVersion.addEventListener('input', updateVdaDeployButton);
    els.vdaEmqxHost.addEventListener('input', updateVdaDeployButton);
    els.vdaBotSection.addEventListener('change', onVdaSectionChange);
    els.vdaIpsAll.addEventListener('click', () => setAllIpCheckboxes(true));
    els.vdaIpsNone.addEventListener('click', () => setAllIpCheckboxes(false));
    els.vdaBasketClear.addEventListener('click', clearAllSelections);
    els.vdaDeployBtn.addEventListener('click', onVdaDeploy);

    els.mtSection.addEventListener('change', onMtSectionChange);
    els.mtIpsAll.addEventListener('click', () => setAllMtIpCheckboxes(true));
    els.mtIpsNone.addEventListener('click', () => setAllMtIpCheckboxes(false));
    els.mtBasketClear.addEventListener('click', clearAllMtSelections);
    els.mtRunBtn.addEventListener('click', onMtRun);

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
    const botSelected = !!state.selectedBot;
    els.runAliasBtn.disabled = !configured;
    els.pingBotBtn.disabled = !(configured && botSelected);
    if (!site) {
        els.opsHint.textContent = 'Select a site that has SSH details configured in admin.';
    } else if (!configured) {
        els.opsHint.textContent = `${site.name} has no SSH chain configured. Ask an admin to set Butler IP, Target IP, and gor password.`;
    } else if (!botSelected) {
        els.opsHint.textContent = `SSH chain ready. Pick a bot above to enable "Ping bot".`;
    } else {
        els.opsHint.textContent = `Will SSH via jumper → ${site.butlerIp} → gor@${site.targetIp}.`;
    }
    updateVdaCard();
    updateMtCard();
}

function updateVdaCard() {
    const site = state.selectedSite;
    const configured = !!(site && site.butlerIp && site.targetIp && site.hasGorPassword);
    els.vdaLoadBtn.disabled = !configured;
    if (!configured) {
        els.vdaHint.textContent = 'Select a configured site first.';
        els.vdaForm.hidden = true;
        state.vdaSections = null;
    } else if (!state.vdaSections) {
        els.vdaHint.textContent = 'Click "Load bot inventory" to fetch the current _vda_remote from the target.';
        els.vdaForm.hidden = true;
    } else {
        els.vdaHint.textContent = '';
        els.vdaForm.hidden = false;
    }
}

async function onVdaLoadInventory() {
    if (!state.selectedSite) return;
    const site = state.selectedSite;
    els.vdaLoadBtn.disabled = true;
    const originalLabel = els.vdaLoadBtn.textContent;
    els.vdaLoadBtn.textContent = 'Loading…';
    try {
        const r = await api(`/api/operations/vda/inventory?site=${encodeURIComponent(site.name)}`);
        state.vdaSections = r.sections || {};
        state.vdaIpToBot = r.ipToBot || {};
        state.vdaSelections = {};
        state.mtSelections = {};
        populateBotSectionSelect();
        populateMtSectionSelect();
        renderBasket();
        renderMtBasket();
        updateVdaCard();
        updateMtCard();
    } catch (err) {
        els.vdaHint.textContent = 'Failed to load inventory: ' + err.message;
        state.vdaSections = null;
        state.vdaIpToBot = {};
        state.vdaSelections = {};
        state.mtSelections = {};
        renderBasket();
        renderMtBasket();
        updateMtCard();
    } finally {
        els.vdaLoadBtn.disabled = false;
        els.vdaLoadBtn.textContent = originalLabel;
    }
}

function ipSortKey(ip) {
    return ip.split('.').reduce((acc, part) => acc * 256 + (parseInt(part, 10) || 0), 0);
}

function populateBotSectionSelect() {
    els.vdaBotSection.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a section…';
    els.vdaBotSection.append(placeholder);
    const sections = Object.keys(state.vdaSections || {}).sort();
    for (const name of sections) {
        const opt = document.createElement('option');
        opt.value = name;
        const ips = state.vdaSections[name] || [];
        const activeCount = ips.filter(x => x.active).length;
        opt.textContent = `${name}  (${ips.length} bots, ${activeCount} active)`;
        els.vdaBotSection.append(opt);
    }
    els.vdaBotSection.disabled = sections.length === 0;
    els.vdaBotSection.value = '';
    renderIpCheckboxes(null);
}

function onVdaSectionChange() {
    renderIpCheckboxes(els.vdaBotSection.value || null);
    updateVdaDeployButton();
}

function renderIpCheckboxes(sectionName) {
    els.vdaIpsList.replaceChildren();
    if (!sectionName || !state.vdaSections || !state.vdaSections[sectionName]) {
        els.vdaIpsWrap.hidden = true;
        return;
    }
    const ips = state.vdaSections[sectionName].slice().sort((a, b) => ipSortKey(a.ip) - ipSortKey(b.ip));
    if (ips.length === 0) {
        els.vdaIpsWrap.hidden = false;
        const note = document.createElement('p');
        note.className = 'muted small';
        note.textContent = 'No bots listed in this section yet.';
        els.vdaIpsList.append(note);
        return;
    }
    els.vdaIpsWrap.hidden = false;
    const selectedSet = state.vdaSelections[sectionName] || new Set();
    for (const { ip, active } of ips) {
        const label = document.createElement('label');
        label.className = 'vda-ip-row';
        if (active) label.classList.add('vda-ip-currently-active');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = ip;
        cb.checked = selectedSet.has(ip);
        cb.addEventListener('change', () => onIpToggle(sectionName, ip, cb.checked));
        const span = document.createElement('span');
        const botId = state.vdaIpToBot[ip];
        const idPart = botId ? ` (bot ${botId})` : '';
        const activePart = active ? ' • currently active' : '';
        span.textContent = ip + idPart + activePart;
        label.append(cb, span);
        els.vdaIpsList.append(label);
    }
}

function onIpToggle(sectionName, ip, checked) {
    if (!state.vdaSelections[sectionName]) state.vdaSelections[sectionName] = new Set();
    if (checked) {
        state.vdaSelections[sectionName].add(ip);
    } else {
        state.vdaSelections[sectionName].delete(ip);
        if (state.vdaSelections[sectionName].size === 0) delete state.vdaSelections[sectionName];
    }
    renderBasket();
    updateVdaDeployButton();
}

function setAllIpCheckboxes(checked) {
    const sectionName = els.vdaBotSection.value;
    if (!sectionName || !state.vdaSections[sectionName]) return;
    if (!state.vdaSelections[sectionName]) state.vdaSelections[sectionName] = new Set();
    for (const { ip } of state.vdaSections[sectionName]) {
        if (checked) state.vdaSelections[sectionName].add(ip);
        else state.vdaSelections[sectionName].delete(ip);
    }
    if (!checked) delete state.vdaSelections[sectionName];
    renderIpCheckboxes(sectionName);
    renderBasket();
    updateVdaDeployButton();
}

function clearAllSelections() {
    state.vdaSelections = {};
    const sectionName = els.vdaBotSection.value;
    if (sectionName) renderIpCheckboxes(sectionName);
    renderBasket();
    updateVdaDeployButton();
}

// Empty all editable VDA-deploy inputs (file, version, emqx, basket).
// Called after every deploy attempt regardless of outcome so the next run
// starts from a clean slate. Loaded inventory (sections, IPs) is preserved.
function resetVdaForm() {
    els.vdaFile.value = '';
    els.vdaVersion.value = '';
    els.vdaEmqxHost.value = '';
    els.vdaFileHint.textContent = 'No file selected.';
    els.vdaFileHint.classList.remove('error');
    clearAllSelections();
}

function renderBasket() {
    els.vdaBasket.replaceChildren();
    const entries = Object.entries(state.vdaSelections).filter(([, s]) => s.size > 0);
    if (entries.length === 0) {
        els.vdaBasket.textContent = 'No bots selected yet.';
        els.vdaBasketSummary.textContent = '';
        els.vdaBasketClear.disabled = true;
        return;
    }
    els.vdaBasketClear.disabled = false;
    let total = 0;
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [section, ipSet] of entries) {
        total += ipSet.size;
        const row = document.createElement('div');
        row.className = 'vda-basket-row';
        const header = document.createElement('div');
        header.className = 'vda-basket-row-header';
        const sectionLabel = document.createElement('strong');
        sectionLabel.textContent = `${section} (${ipSet.size})`;
        const removeAll = document.createElement('button');
        removeAll.type = 'button';
        removeAll.className = 'btn-subtle btn-small';
        removeAll.textContent = 'remove section';
        removeAll.addEventListener('click', () => {
            delete state.vdaSelections[section];
            if (els.vdaBotSection.value === section) renderIpCheckboxes(section);
            renderBasket();
            updateVdaDeployButton();
        });
        header.append(sectionLabel, removeAll);
        row.append(header);
        const chips = document.createElement('div');
        chips.className = 'vda-chips';
        const ipsSorted = Array.from(ipSet).sort((a, b) => ipSortKey(a) - ipSortKey(b));
        for (const ip of ipsSorted) {
            const chip = document.createElement('span');
            chip.className = 'vda-chip';
            const botId = state.vdaIpToBot[ip];
            const labelText = botId ? `${ip} (bot ${botId})` : ip;
            chip.textContent = labelText;
            const x = document.createElement('button');
            x.type = 'button';
            x.className = 'vda-chip-x';
            x.textContent = '×';
            x.title = 'Remove';
            x.addEventListener('click', () => onIpToggle(section, ip, false));
            chip.append(x);
            chips.append(chip);
        }
        row.append(chips);
        els.vdaBasket.append(row);
    }
    els.vdaBasketSummary.textContent = `${total} bot${total !== 1 ? 's' : ''} across ${entries.length} section${entries.length !== 1 ? 's' : ''}`;
}

const VDA_TAR_NAME_RE = /\.(tar|tar\.gz|tgz)$/i;
const VDA_MAX_FILE_BYTES = 100 * 1024 * 1024;

function onVdaFileChange() {
    const file = els.vdaFile.files && els.vdaFile.files[0];
    els.vdaFileHint.classList.remove('error');
    if (!file) {
        els.vdaFileHint.textContent = 'No file selected.';
        updateVdaDeployButton();
        return;
    }
    if (!VDA_TAR_NAME_RE.test(file.name)) {
        els.vdaFileHint.textContent = `"${file.name}" is not a .tar / .tar.gz / .tgz file. Pick a VDA tarball.`;
        els.vdaFileHint.classList.add('error');
        els.vdaFile.value = '';
        updateVdaDeployButton();
        return;
    }
    if (file.size > VDA_MAX_FILE_BYTES) {
        els.vdaFileHint.textContent = `"${file.name}" is ${formatBytes(file.size)} — limit is ${formatBytes(VDA_MAX_FILE_BYTES)}.`;
        els.vdaFileHint.classList.add('error');
        els.vdaFile.value = '';
        updateVdaDeployButton();
        return;
    }
    els.vdaFileHint.textContent = `${file.name} (${formatBytes(file.size)})`;
    const m = file.name.match(/_v([0-9]+(?:\.[0-9]+){0,3})_/);
    if (m && !els.vdaVersion.value) els.vdaVersion.value = m[1];
    updateVdaDeployButton();
}

function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function updateVdaDeployButton() {
    const file = els.vdaFile.files && els.vdaFile.files[0];
    const vdaVersion = els.vdaVersion.value.trim();
    const emqx = els.vdaEmqxHost.value.trim();
    const hasSelections = Object.values(state.vdaSelections || {}).some(s => s.size > 0);
    els.vdaDeployBtn.disabled = !(file && vdaVersion && emqx && hasSelections);
}

// ---------------------------------------------------------------------------
// Bot maintenance widget
// ---------------------------------------------------------------------------

function updateMtCard() {
    const site = state.selectedSite;
    const configured = !!(site && site.butlerIp && site.targetIp && site.hasGorPassword);
    if (!configured) {
        els.mtHint.textContent = 'Select a configured site and load inventory above.';
        els.mtForm.hidden = true;
        return;
    }
    if (!state.vdaSections) {
        els.mtHint.textContent = 'Load inventory above first.';
        els.mtForm.hidden = true;
        return;
    }
    els.mtHint.textContent = '';
    els.mtForm.hidden = false;
}

function populateMtSectionSelect() {
    els.mtSection.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a section…';
    els.mtSection.append(placeholder);
    const sections = Object.keys(state.vdaSections || {}).sort();
    for (const name of sections) {
        const opt = document.createElement('option');
        opt.value = name;
        const ips = state.vdaSections[name] || [];
        opt.textContent = `${name}  (${ips.length} bots)`;
        els.mtSection.append(opt);
    }
    els.mtSection.disabled = sections.length === 0;
    els.mtSection.value = '';
    renderMtIpCheckboxes(null);
}

function onMtSectionChange() {
    renderMtIpCheckboxes(els.mtSection.value || null);
    updateMtRunButton();
}

function renderMtIpCheckboxes(sectionName) {
    els.mtIpsList.replaceChildren();
    if (!sectionName || !state.vdaSections || !state.vdaSections[sectionName]) {
        els.mtIpsWrap.hidden = true;
        return;
    }
    const ips = state.vdaSections[sectionName].slice().sort((a, b) => ipSortKey(a.ip) - ipSortKey(b.ip));
    if (ips.length === 0) {
        els.mtIpsWrap.hidden = false;
        const note = document.createElement('p');
        note.className = 'muted small';
        note.textContent = 'No bots listed in this section.';
        els.mtIpsList.append(note);
        return;
    }
    els.mtIpsWrap.hidden = false;
    const selectedSet = state.mtSelections[sectionName] || new Set();
    for (const { ip, active } of ips) {
        const label = document.createElement('label');
        label.className = 'vda-ip-row';
        if (active) label.classList.add('vda-ip-currently-active');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = ip;
        cb.checked = selectedSet.has(ip);
        cb.addEventListener('change', () => onMtIpToggle(sectionName, ip, cb.checked));
        const span = document.createElement('span');
        const botId = state.vdaIpToBot[ip];
        const idPart = botId ? ` (bot ${botId})` : '';
        const activePart = active ? ' • currently active' : '';
        span.textContent = ip + idPart + activePart;
        label.append(cb, span);
        els.mtIpsList.append(label);
    }
}

function onMtIpToggle(sectionName, ip, checked) {
    if (!state.mtSelections[sectionName]) state.mtSelections[sectionName] = new Set();
    if (checked) state.mtSelections[sectionName].add(ip);
    else {
        state.mtSelections[sectionName].delete(ip);
        if (state.mtSelections[sectionName].size === 0) delete state.mtSelections[sectionName];
    }
    renderMtBasket();
    updateMtRunButton();
}

function setAllMtIpCheckboxes(checked) {
    const sectionName = els.mtSection.value;
    if (!sectionName || !state.vdaSections[sectionName]) return;
    if (!state.mtSelections[sectionName]) state.mtSelections[sectionName] = new Set();
    for (const { ip } of state.vdaSections[sectionName]) {
        if (checked) state.mtSelections[sectionName].add(ip);
        else state.mtSelections[sectionName].delete(ip);
    }
    if (!checked) delete state.mtSelections[sectionName];
    renderMtIpCheckboxes(sectionName);
    renderMtBasket();
    updateMtRunButton();
}

function clearAllMtSelections() {
    state.mtSelections = {};
    const sectionName = els.mtSection.value;
    if (sectionName) renderMtIpCheckboxes(sectionName);
    renderMtBasket();
    updateMtRunButton();
}

// Empty all editable bot-maintenance inputs (basket). Loaded inventory and
// the command dropdown are preserved.
function resetMtForm() {
    clearAllMtSelections();
}

function renderMtBasket() {
    els.mtBasket.replaceChildren();
    const entries = Object.entries(state.mtSelections).filter(([, s]) => s.size > 0);
    if (entries.length === 0) {
        els.mtBasket.textContent = 'No bots selected yet.';
        els.mtBasketSummary.textContent = '';
        els.mtBasketClear.disabled = true;
        return;
    }
    els.mtBasketClear.disabled = false;
    let total = 0;
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [section, ipSet] of entries) {
        total += ipSet.size;
        const row = document.createElement('div');
        row.className = 'vda-basket-row';
        const header = document.createElement('div');
        header.className = 'vda-basket-row-header';
        const sectionLabel = document.createElement('strong');
        sectionLabel.textContent = `${section} (${ipSet.size})`;
        const removeAll = document.createElement('button');
        removeAll.type = 'button';
        removeAll.className = 'btn-subtle btn-small';
        removeAll.textContent = 'remove section';
        removeAll.addEventListener('click', () => {
            delete state.mtSelections[section];
            if (els.mtSection.value === section) renderMtIpCheckboxes(section);
            renderMtBasket();
            updateMtRunButton();
        });
        header.append(sectionLabel, removeAll);
        row.append(header);
        const chips = document.createElement('div');
        chips.className = 'vda-chips';
        const ipsSorted = Array.from(ipSet).sort((a, b) => ipSortKey(a) - ipSortKey(b));
        for (const ip of ipsSorted) {
            const chip = document.createElement('span');
            chip.className = 'vda-chip';
            const botId = state.vdaIpToBot[ip];
            chip.textContent = botId ? `${ip} (bot ${botId})` : ip;
            const x = document.createElement('button');
            x.type = 'button';
            x.className = 'vda-chip-x';
            x.textContent = '×';
            x.title = 'Remove';
            x.addEventListener('click', () => onMtIpToggle(section, ip, false));
            chip.append(x);
            chips.append(chip);
        }
        row.append(chips);
        els.mtBasket.append(row);
    }
    els.mtBasketSummary.textContent = `${total} bot${total !== 1 ? 's' : ''} across ${entries.length} section${entries.length !== 1 ? 's' : ''}`;
}

function updateMtRunButton() {
    const hasSelections = Object.values(state.mtSelections || {}).some(s => s.size > 0);
    els.mtRunBtn.disabled = !hasSelections;
}

async function onMtRun() {
    const site = state.selectedSite;
    if (!site) return;
    const command = els.mtCommand.value;
    const selectionsObj = {};
    let total = 0;
    for (const [section, ipSet] of Object.entries(state.mtSelections || {})) {
        if (ipSet.size > 0) {
            selectionsObj[section] = Array.from(ipSet);
            total += ipSet.size;
        }
    }
    if (total === 0) return;
    const confirmed = window.confirm(
        `Run "${command}" on ${total} bot${total !== 1 ? 's' : ''} of ${site.name}?\n\n`
        + `Sections: ${Object.keys(selectionsObj).join(', ')}\n\n`
        + `All other operations will be disabled while it runs.`
    );
    if (!confirmed) return;

    setOpsBusy(true);
    const startedAt = Date.now();
    const tick = setInterval(() => {
        const secs = Math.floor((Date.now() - startedAt) / 1000);
        const mm = String(Math.floor(secs / 60)).padStart(2, '0');
        const ss = String(secs % 60).padStart(2, '0');
        els.mtStatus.textContent = `Running ${command} — elapsed ${mm}:${ss}. All other ops disabled.`;
    }, 1000);
    els.mtOutput.hidden = false;
    els.mtOutput.textContent = `Running ${command} on ${total} bot${total !== 1 ? 's' : ''}…`;

    // key = `${section}|${ip}`. Holds status, port, workerId, optional result fields.
    const botState = new Map();
    let plan = null;
    let doneEvt = null;
    let errorEvt = null;

    const fmtElapsed = (ms) => (ms / 1000).toFixed(1) + 's';
    const renderMt = () => {
        const lines = [];
        if (plan) {
            const finished = [...botState.values()].filter(b => b.status === 'ok' || b.status === 'fail').length;
            lines.push(`command: ${plan.command}    concurrency: ${plan.concurrency}    progress: ${finished}/${plan.total}`);
            lines.push('');
        }
        for (const [key, b] of botState) {
            let head;
            if (b.status === 'pending') head = `[pending]  ${b.section}  ${b.ip}:${b.port}`;
            else if (b.status === 'running') head = `[running w${b.workerId}]  ${b.section}  ${b.ip}:${b.port}`;
            else if (b.status === 'ok') head = `────── ${b.section}  ${b.ip}:${b.port}  OK  (${fmtElapsed(b.elapsedMs)}) ──────`;
            else head = `────── ${b.section}  ${b.ip}:${b.port}  FAILED (exit ${b.code})  (${fmtElapsed(b.elapsedMs)}) ──────`;
            lines.push(head);
            if (b.status === 'ok' || b.status === 'fail') {
                if (b.stdout) lines.push(b.stdout.trimEnd());
                if (b.stderr) lines.push('[stderr] ' + b.stderr.trimEnd());
                if (!b.stdout && !b.stderr) lines.push('(no output)');
                lines.push('');
            }
        }
        if (doneEvt) {
            lines.push('');
            lines.push(`done: ${doneEvt.ok}/${doneEvt.total} OK    elapsed: ${fmtElapsed(doneEvt.elapsedMs)}`);
        }
        if (errorEvt) {
            lines.push('');
            lines.push(`Error: ${errorEvt.error || 'unknown'}`);
        }
        els.mtOutput.textContent = lines.join('\n');
        els.mtOutput.scrollTop = els.mtOutput.scrollHeight;
    };

    try {
        const res = await fetch('/api/operations/bot/run', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ site: site.name, command, selections: selectionsObj })
        });
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/x-ndjson')) {
            // Pre-stream error (validation, 400, 429, 502 inventory read)
            const body = await res.json().catch(() => ({}));
            els.mtOutput.textContent = `Error: ${body.error || res.statusText}`;
            return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const keyOf = (e) => `${e.section}|${e.ip}`;
        const handleLine = (line) => {
            if (!line.trim()) return;
            let ev;
            try { ev = JSON.parse(line); } catch (e) { console.error('NDJSON parse', e, line); return; }
            if (ev.type === 'plan') {
                plan = ev;
                for (const t of ev.targets) {
                    botState.set(keyOf(t), { ip: t.ip, section: t.section, port: t.port, status: 'pending' });
                }
            } else if (ev.type === 'start') {
                const b = botState.get(keyOf(ev)) || { ip: ev.ip, section: ev.section, port: ev.port };
                b.status = 'running';
                b.workerId = ev.workerId;
                botState.set(keyOf(ev), b);
            } else if (ev.type === 'result') {
                const b = botState.get(keyOf(ev)) || { ip: ev.ip, section: ev.section, port: ev.port };
                b.status = ev.code === 0 ? 'ok' : 'fail';
                b.code = ev.code;
                b.stdout = ev.stdout;
                b.stderr = ev.stderr;
                b.elapsedMs = ev.elapsedMs;
                botState.set(keyOf(ev), b);
            } else if (ev.type === 'done') {
                doneEvt = ev;
            } else if (ev.type === 'error') {
                errorEvt = ev;
            }
            renderMt();
        };
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                handleLine(buffer.slice(0, nl));
                buffer = buffer.slice(nl + 1);
            }
        }
        if (buffer.trim()) handleLine(buffer);
    } catch (err) {
        errorEvt = { error: err.message };
        renderMt();
    } finally {
        clearInterval(tick);
        els.mtStatus.textContent = '';
        setOpsBusy(false);
        // SSH chains close automatically server-side (see [ops] chain-closed in server.log).
        // Empty basket so the next maintenance run starts fresh.
        resetMtForm();
    }
}

// ---------------------------------------------------------------------------
// Ops busy lockdown
// ---------------------------------------------------------------------------

function setOpsBusy(busy) {
    state.opsBusy = busy;
    document.body.classList.toggle('ops-busy', busy);
    const controls = [
        els.site, els.bot, els.lookback, els.lookbackCustom, els.rowLimit, els.rowLimitCustom,
        els.fieldsMenuBtn, els.colMenuBtn, els.load, els.exportBtn,
        els.runAliasBtn, els.pingBotBtn,
        els.vdaLoadBtn, els.vdaFile, els.vdaVersion, els.vdaEmqxHost,
        els.vdaBotSection, els.vdaIpsAll, els.vdaIpsNone, els.vdaBasketClear, els.vdaDeployBtn,
        els.mtSection, els.mtCommand, els.mtIpsAll, els.mtIpsNone, els.mtBasketClear, els.mtRunBtn
    ];
    if (busy) {
        controls.forEach(el => { if (el) el.disabled = true; });
        els.vdaIpsList.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.disabled = true; });
        els.mtIpsList.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.disabled = true; });
    } else {
        els.vdaIpsList.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.disabled = false; });
        els.mtIpsList.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.disabled = false; });
        if (els.site) els.site.disabled = false;
        if (els.bot) els.bot.disabled = !(state.bots && state.bots.length);
        if (els.lookback) els.lookback.disabled = false;
        if (els.lookbackCustom) els.lookbackCustom.disabled = false;
        if (els.rowLimit) els.rowLimit.disabled = false;
        if (els.rowLimitCustom) els.rowLimitCustom.disabled = false;
        if (els.fieldsMenuBtn) els.fieldsMenuBtn.disabled = !state.availableFields.length;
        if (els.colMenuBtn) els.colMenuBtn.disabled = !state.columns.length;
        if (els.vdaFile) els.vdaFile.disabled = false;
        if (els.vdaVersion) els.vdaVersion.disabled = false;
        if (els.vdaEmqxHost) els.vdaEmqxHost.disabled = false;
        if (els.vdaBotSection) els.vdaBotSection.disabled = !state.vdaSections;
        if (els.vdaIpsAll) els.vdaIpsAll.disabled = false;
        if (els.vdaIpsNone) els.vdaIpsNone.disabled = false;
        if (els.mtSection) els.mtSection.disabled = !state.vdaSections;
        if (els.mtCommand) els.mtCommand.disabled = false;
        if (els.mtIpsAll) els.mtIpsAll.disabled = false;
        if (els.mtIpsNone) els.mtIpsNone.disabled = false;
        updateLoadButton();
        updateOpsCard();
        updateVdaDeployButton();
        updateMtRunButton();
    }
}

async function onVdaDeploy() {
    const site = state.selectedSite;
    if (!site) return;
    const file = els.vdaFile.files && els.vdaFile.files[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) {
        els.vdaOutput.hidden = false;
        els.vdaOutput.textContent = 'File too large (limit 100 MB).';
        return;
    }
    const vdaVersion = els.vdaVersion.value.trim();
    const emqx = els.vdaEmqxHost.value.trim();
    const selectionsObj = {};
    let totalIps = 0;
    for (const [section, ipSet] of Object.entries(state.vdaSelections || {})) {
        if (ipSet.size > 0) {
            const arr = Array.from(ipSet);
            selectionsObj[section] = arr;
            totalIps += arr.length;
        }
    }
    if (totalIps === 0) return;
    const breakdown = Object.entries(selectionsObj)
        .map(([s, ips]) => `  ${s}: ${ips.length} bot${ips.length !== 1 ? 's' : ''}`)
        .join('\n');
    const confirmed = window.confirm(
        `Deploy ${file.name} to ${site.name}?\n\n`
        + `${breakdown}\n`
        + `Total: ${totalIps} bots across ${Object.keys(selectionsObj).length} sections\n`
        + `vda_remote_version: ${vdaVersion}\n`
        + `emqx_mqtt_host: ${emqx}\n\n`
        + `All other sections will be commented out.\n`
        + `This runs bash vda_deploy.sh on the target and may take several minutes.\n`
        + `All other operations will be disabled while it runs.`
    );
    if (!confirmed) return;

    const fd = new FormData();
    fd.append('site', site.name);
    fd.append('vdaRemoteVersion', vdaVersion);
    fd.append('emqxMqttHost', emqx);
    fd.append('selections', JSON.stringify(selectionsObj));
    fd.append('tar', file);

    setOpsBusy(true);
    const startedAt = Date.now();
    const tick = setInterval(() => {
        const secs = Math.floor((Date.now() - startedAt) / 1000);
        const mm = String(Math.floor(secs / 60)).padStart(2, '0');
        const ss = String(secs % 60).padStart(2, '0');
        els.vdaDeployStatus.textContent = `Deploying — elapsed ${mm}:${ss}. All other ops disabled.`;
    }, 1000);
    els.vdaOutput.hidden = false;
    els.vdaOutput.textContent = 'Uploading tar and patching inventory…';
    const streamedSteps = [];
    let finalEvent = null;
    const renderStream = () => {
        const lines = ['--- steps ---'];
        for (const s of streamedSteps) {
            lines.push(`${s.at}  ${s.label}${s.code != null ? ` (exit ${s.code})` : ''}`);
        }
        if (finalEvent && finalEvent.type === 'result') {
            lines.push('', `vda_deploy.sh exit code: ${finalEvent.code}`);
            if (finalEvent.stdout) lines.push('--- stdout ---', finalEvent.stdout);
            if (finalEvent.stderr) lines.push('--- stderr ---', finalEvent.stderr);
        } else if (finalEvent && finalEvent.type === 'error') {
            lines.push('', `Error: ${finalEvent.error || 'unknown'}`);
        }
        els.vdaOutput.textContent = lines.join('\n');
        els.vdaOutput.scrollTop = els.vdaOutput.scrollHeight;
    };
    try {
        const res = await fetch('/api/operations/vda/deploy', {
            method: 'POST',
            credentials: 'same-origin',
            body: fd
        });
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/x-ndjson')) {
            // Pre-stream error (validation/400/etc.) — comes back as plain JSON.
            const body = await res.json().catch(() => ({}));
            els.vdaOutput.textContent = `Error: ${body.error || res.statusText}`;
            return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const handleLine = (line) => {
            if (!line.trim()) return;
            let ev;
            try { ev = JSON.parse(line); } catch (e) { console.error('NDJSON parse', e, line); return; }
            if (ev.type === 'step') streamedSteps.push(ev);
            else if (ev.type === 'result' || ev.type === 'error') finalEvent = ev;
            renderStream();
        };
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                handleLine(buffer.slice(0, nl));
                buffer = buffer.slice(nl + 1);
            }
        }
        if (buffer.trim()) handleLine(buffer);
    } catch (err) {
        finalEvent = { type: 'error', error: err.message };
        renderStream();
    } finally {
        clearInterval(tick);
        els.vdaDeployStatus.textContent = '';
        setOpsBusy(false);
        // SSH chains close automatically server-side (see [ops] chain-closed in server.log).
        // Empty all input fields so the next deploy starts fresh.
        resetVdaForm();
    }
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

async function onPingBot() {
    if (!state.selectedSite || !state.selectedBot) return;
    const site = state.selectedSite;
    const botId = state.selectedBot;
    els.pingBotBtn.disabled = true;
    const originalLabel = els.pingBotBtn.textContent;
    els.pingBotBtn.textContent = 'Pinging…';
    els.opsOutput.hidden = false;
    els.opsOutput.textContent = `Looking up IP for bot ${botId}…`;
    try {
        const r = await api('/api/operations/ping-bot', {
            method: 'POST',
            body: JSON.stringify({ site: site.name, botId })
        });
        const lines = [];
        lines.push(`target: ${botId} (${r.botIp})`);
        lines.push(`exit code: ${r.code}`);
        if (r.stdout) lines.push('--- stdout ---', r.stdout);
        if (r.stderr) lines.push('--- stderr ---', r.stderr);
        if (!r.stdout && !r.stderr) lines.push('(no output)');
        els.opsOutput.textContent = lines.join('\n');
    } catch (err) {
        els.opsOutput.textContent = 'Error: ' + err.message;
    } finally {
        els.pingBotBtn.disabled = false;
        els.pingBotBtn.textContent = originalLabel;
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
