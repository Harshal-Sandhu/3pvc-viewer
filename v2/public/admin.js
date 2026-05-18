// 3PVC Admin frontend.
// Shares the same session cookie as the viewer (/api/login etc.).
// No globals; all DOM updates use textContent / DOM APIs (no innerHTML).

const $ = (sel) => document.querySelector(sel);
const els = {
    loginView: $('#login-view'),
    adminView: $('#admin-view'),
    loginForm: $('#login-form'),
    loginUser: $('#login-user'),
    loginPass: $('#login-pass'),
    loginError: $('#login-error'),
    who: $('#who'),
    logout: $('#logout-btn'),

    sitesBody: $('#sites-body'),
    addSiteBtn: $('#add-site-btn'),

    siteModal: $('#site-modal'),
    siteModalTitle: $('#site-modal-title'),
    siteModalClose: $('#site-modal-close'),
    siteForm: $('#site-form'),
    siteOriginalName: $('#site-original-name'),
    siteName: $('#site-name'),
    siteIp: $('#site-ip'),
    sitePort: $('#site-port'),
    siteDb: $('#site-db'),
    siteMeasurement: $('#site-measurement'),
    siteComplianceMeasurement: $('#site-compliance-measurement'),
    siteRecipients: $('#site-recipients'),
    siteAlertEnabled: $('#site-alert-enabled'),
    siteAlertFrequency: $('#site-alert-frequency'),
    siteAlertTime: $('#site-alert-time'),
    siteAlertDow: $('#site-alert-dow'),
    siteAlertDowWrap: $('#site-alert-dow-wrap'),
    siteButlerIp: $('#site-butler-ip'),
    siteTargetIp: $('#site-target-ip'),
    siteGorPassword: $('#site-gor-password'),
    siteSave: $('#site-save'),
    siteCancel: $('#site-cancel'),
    siteError: $('#site-error'),

    deleteModal: $('#delete-modal'),
    deleteModalClose: $('#delete-modal-close'),
    deleteSiteName: $('#delete-site-name'),
    deleteConfirm: $('#delete-confirm'),
    deleteCancel: $('#delete-cancel'),

    compForm: $('#compliance-form'),
    compSite: $('#comp-site'),
    compTarget: $('#comp-target'),
    compFields: $('#comp-fields'),
    compSubmit: $('#comp-submit'),
    compClear: $('#comp-clear'),

    toasts: $('#toasts')
};

const state = {
    sites: [],
    fields: [],
    pendingDelete: null
};

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

function setView(authenticated) {
    els.loginView.hidden = authenticated;
    els.adminView.hidden = !authenticated;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
    wireEvents();
    const me = await api('/api/me').catch(() => ({ authenticated: false }));
    if (me.authenticated && me.role === 'admin') {
        els.who.textContent = me.user || '';
        setView(true);
        await refreshAll();
    } else if (me.authenticated) {
        showAccessDenied(me.user);
    } else {
        setView(false);
    }
}

function showAccessDenied(user) {
    setView(false);
    els.loginError.textContent = `Signed in as "${user}" (viewer role). Admin role required — sign in with an admin account.`;
    els.loginError.hidden = false;
}

function wireEvents() {
    els.loginForm.addEventListener('submit', onLogin);
    els.logout.addEventListener('click', onLogout);

    els.addSiteBtn.addEventListener('click', () => openSiteModal(null));
    els.siteModalClose.addEventListener('click', closeSiteModal);
    els.siteCancel.addEventListener('click', closeSiteModal);
    els.siteForm.addEventListener('submit', onSiteSave);
    els.siteModal.addEventListener('click', (e) => { if (e.target === els.siteModal) closeSiteModal(); });

    els.deleteModalClose.addEventListener('click', closeDeleteModal);
    els.deleteCancel.addEventListener('click', closeDeleteModal);
    els.deleteConfirm.addEventListener('click', onDeleteConfirm);
    els.deleteModal.addEventListener('click', (e) => { if (e.target === els.deleteModal) closeDeleteModal(); });

    els.compSite.addEventListener('change', updateCompTarget);
    els.compForm.addEventListener('submit', onCompSubmit);
    els.compClear.addEventListener('click', () => {
        for (const input of els.compFields.querySelectorAll('input')) input.value = '';
    });

    els.siteAlertFrequency.addEventListener('change', () => {
        els.siteAlertDowWrap.hidden = els.siteAlertFrequency.value !== 'weekly';
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (!els.siteModal.hidden) closeSiteModal();
            else if (!els.deleteModal.hidden) closeDeleteModal();
        }
    });
}

async function refreshAll() {
    try {
        const [sites, fields] = await Promise.all([
            api('/api/sites'),
            api('/api/compliance-fields')
        ]);
        state.sites = sites;
        state.fields = fields;
        renderSites();
        renderCompliancePicker();
        renderComplianceFields();
        updateCompTarget();
    } catch (err) {
        if (err.status === 401) setView(false);
        else toast(err.message, 'error');
    }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function onLogin(e) {
    e.preventDefault();
    els.loginError.hidden = true;
    try {
        const r = await api('/api/login', {
            method: 'POST',
            body: JSON.stringify({ username: els.loginUser.value.trim(), password: els.loginPass.value })
        });
        els.loginPass.value = '';
        if (r.role !== 'admin') {
            // Log them out of this admin-page session so they can re-try with admin creds.
            try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
            els.loginError.textContent = 'Admin role required. That account is a viewer.';
            els.loginError.hidden = false;
            return;
        }
        els.who.textContent = els.loginUser.value.trim();
        setView(true);
        await refreshAll();
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
// Sites list
// ---------------------------------------------------------------------------

function renderSites() {
    els.sitesBody.replaceChildren();
    if (state.sites.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 7;
        td.className = 'muted center';
        td.textContent = 'No sites yet. Click "Add site" to create one.';
        tr.append(td);
        els.sitesBody.append(tr);
        return;
    }
    for (const s of state.sites) {
        const tr = document.createElement('tr');
        appendCell(tr, s.name);
        appendCell(tr, `${s.ip}:${s.port}`);
        appendCell(tr, s.db);
        appendCell(tr, s.measurement);
        appendCell(tr, s.complianceMeasurement);

        const alertCell = document.createElement('td');
        alertCell.append(scheduleSummary(s));
        tr.append(alertCell);

        const actions = document.createElement('td');
        actions.className = 'row-actions';
        const sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.className = 'btn-subtle';
        sendBtn.textContent = 'Send report';
        sendBtn.title = 'Build the compliance report for this site and email it now.';
        sendBtn.addEventListener('click', () => onSendReport(s, sendBtn));
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn-subtle';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => openSiteModal(s));
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn-danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => openDeleteModal(s));
        actions.append(sendBtn, editBtn, delBtn);
        tr.append(actions);

        els.sitesBody.append(tr);
    }
}

function scheduleSummary(s) {
    const wrap = document.createElement('span');
    wrap.className = 'small';
    const sched = s.alertSchedule || {};
    const recipients = (s.recipients || []).length;
    if (!sched.enabled) {
        wrap.classList.add('muted');
        wrap.textContent = recipients ? 'Off' : 'Off — no recipients';
        return wrap;
    }
    const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][sched.dayOfWeek] || 'Mon';
    const cadence = sched.frequency === 'hourly' ? `Hourly :${sched.time.slice(3)}`
        : sched.frequency === 'weekdays' ? `Weekdays ${sched.time}`
        : sched.frequency === 'weekly' ? `${dow} ${sched.time}`
        : `Daily ${sched.time}`;
    wrap.textContent = `${cadence} → ${recipients || 0} recip${recipients === 1 ? '' : 's'}`;
    return wrap;
}

async function onSendReport(site, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
        const r = await api(`/api/alerts/${encodeURIComponent(site.name)}/send`, { method: 'POST' });
        toast(`Sent to ${r.recipients.join(', ')} — ${r.totals.incompatible}/${r.totals.total} incompatible`, 'success');
    } catch (err) {
        if (err.status === 401) { setView(false); return; }
        toast(`Send failed: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

function appendCell(tr, text) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.append(td);
}

function openSiteModal(site) {
    els.siteError.hidden = true;
    if (site) {
        els.siteModalTitle.textContent = `Edit site: ${site.name}`;
        els.siteOriginalName.value = site.name;
        els.siteName.value = site.name;
        els.siteName.disabled = true;  // renaming would need a copy-then-delete; keep it simple
        els.siteIp.value = site.ip;
        els.sitePort.value = String(site.port);
        els.siteDb.value = site.db;
        els.siteMeasurement.value = site.measurement;
        els.siteComplianceMeasurement.value = site.complianceMeasurement;
        els.siteRecipients.value = (site.recipients || []).join(', ');
        const sched = site.alertSchedule || {};
        els.siteAlertEnabled.checked = !!sched.enabled;
        els.siteAlertFrequency.value = sched.frequency || 'daily';
        els.siteAlertTime.value = sched.time || '08:00';
        els.siteAlertDow.value = String(sched.dayOfWeek != null ? sched.dayOfWeek : 1);
        els.siteButlerIp.value = site.butlerIp || '';
        els.siteTargetIp.value = site.targetIp || '';
        els.siteGorPassword.value = '';
        els.siteGorPassword.placeholder = site.hasGorPassword ? 'Leave blank to keep existing password' : 'Set a password';
    } else {
        els.siteModalTitle.textContent = 'Add site';
        els.siteOriginalName.value = '';
        els.siteName.value = '';
        els.siteName.disabled = false;
        els.siteIp.value = '';
        els.sitePort.value = '8086';
        els.siteDb.value = 'GreyOrange';
        els.siteMeasurement.value = 'bot_firmware_version_details';
        els.siteComplianceMeasurement.value = 'compliance_details';
        els.siteRecipients.value = '';
        els.siteAlertEnabled.checked = false;
        els.siteAlertFrequency.value = 'daily';
        els.siteAlertTime.value = '08:00';
        els.siteAlertDow.value = '1';
        els.siteButlerIp.value = '';
        els.siteTargetIp.value = '';
        els.siteGorPassword.value = '';
        els.siteGorPassword.placeholder = 'Set a password';
    }
    els.siteAlertDowWrap.hidden = els.siteAlertFrequency.value !== 'weekly';
    els.siteModal.hidden = false;
    els.siteName.focus();
}

function closeSiteModal() {
    els.siteModal.hidden = true;
}

async function onSiteSave(e) {
    e.preventDefault();
    els.siteError.hidden = true;
    const editing = !!els.siteOriginalName.value;
    const payload = {
        name: els.siteName.value.trim(),
        ip: els.siteIp.value.trim(),
        port: Number(els.sitePort.value),
        db: els.siteDb.value.trim(),
        measurement: els.siteMeasurement.value.trim(),
        complianceMeasurement: els.siteComplianceMeasurement.value.trim(),
        recipients: els.siteRecipients.value
            .split(',').map(s => s.trim()).filter(Boolean),
        alertSchedule: {
            enabled: els.siteAlertEnabled.checked,
            frequency: els.siteAlertFrequency.value,
            time: els.siteAlertTime.value,
            dayOfWeek: Number(els.siteAlertDow.value)
        },
        butlerIp: els.siteButlerIp.value.trim(),
        targetIp: els.siteTargetIp.value.trim()
    };
    const gorPwd = els.siteGorPassword.value;
    if (gorPwd) payload.gorPassword = gorPwd;
    try {
        els.siteSave.disabled = true;
        if (editing) {
            await api(`/api/sites/${encodeURIComponent(els.siteOriginalName.value)}`, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            toast(`Updated site "${payload.name}"`, 'success');
        } else {
            await api('/api/sites', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            toast(`Added site "${payload.name}"`, 'success');
        }
        closeSiteModal();
        await refreshAll();
    } catch (err) {
        if (err.status === 401) { setView(false); return; }
        els.siteError.textContent = err.message;
        els.siteError.hidden = false;
    } finally {
        els.siteSave.disabled = false;
    }
}

function openDeleteModal(site) {
    state.pendingDelete = site;
    els.deleteSiteName.textContent = site.name;
    els.deleteModal.hidden = false;
}
function closeDeleteModal() {
    state.pendingDelete = null;
    els.deleteModal.hidden = true;
}
async function onDeleteConfirm() {
    if (!state.pendingDelete) return;
    const name = state.pendingDelete.name;
    try {
        els.deleteConfirm.disabled = true;
        await api(`/api/sites/${encodeURIComponent(name)}`, { method: 'DELETE' });
        toast(`Deleted site "${name}"`, 'success');
        closeDeleteModal();
        await refreshAll();
    } catch (err) {
        if (err.status === 401) { setView(false); return; }
        toast(err.message, 'error');
    } finally {
        els.deleteConfirm.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Compliance entry
// ---------------------------------------------------------------------------

function renderCompliancePicker() {
    els.compSite.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = state.sites.length ? 'Select site...' : 'No sites configured';
    els.compSite.append(placeholder);
    for (const s of state.sites) {
        const opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = s.name;
        els.compSite.append(opt);
    }
}

function renderComplianceFields() {
    els.compFields.replaceChildren();
    for (const field of state.fields) {
        const label = document.createElement('label');
        if (field === 'api_version') label.classList.add('required');
        const span = document.createElement('span');
        span.textContent = field;
        const input = document.createElement('input');
        input.type = 'text';
        input.name = field;
        input.autocomplete = 'off';
        input.placeholder = field === 'api_version' ? 'required' : '';
        label.append(span, input);
        els.compFields.append(label);
    }
}

function updateCompTarget() {
    const site = state.sites.find(s => s.name === els.compSite.value);
    if (!site) { els.compTarget.textContent = ''; return; }
    els.compTarget.textContent =
        `→ ${site.ip}:${site.port} / ${site.db} / ${site.complianceMeasurement}`;
}

async function onCompSubmit(e) {
    e.preventDefault();
    const siteName = els.compSite.value;
    if (!siteName) { toast('Select a site', 'warn'); return; }

    const fields = {};
    for (const input of els.compFields.querySelectorAll('input')) {
        const v = input.value.trim();
        if (v) fields[input.name] = v;
    }
    if (!fields.api_version) {
        toast('api_version is required', 'warn');
        return;
    }

    try {
        els.compSubmit.disabled = true;
        const res = await api(`/api/compliance/${encodeURIComponent(siteName)}`, {
            method: 'POST',
            body: JSON.stringify(fields)
        });
        toast(`Wrote ${res.written} field(s) to ${siteName}`, 'success');
        for (const input of els.compFields.querySelectorAll('input')) input.value = '';
    } catch (err) {
        if (err.status === 401) { setView(false); return; }
        toast(err.message, 'error');
    } finally {
        els.compSubmit.disabled = false;
    }
}

init();
