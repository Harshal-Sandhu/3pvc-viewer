'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { runOnSiteServer, runOnBot, readRemoteFile, writeRemoteFile } = require('./lib/sshChain');
const { parseInventory, parseInventoryPorts, applyActiveIps, applyMultiSectionActiveIps, updateGroupVars, parseGroupVars } = require('./lib/vdaInventory');
const multer = require('multer');
const os = require('os');
const crypto = require('crypto');

const {
    HOST = '127.0.0.1',
    PORT = '3000',
    SESSION_SECRET,
    ADMIN_USER,
    ADMIN_PASSWORD_HASH,
    VIEWER_USER = '',
    VIEWER_PASSWORD_HASH = '',
    NODE_ENV = 'development'
} = process.env;

for (const [k, v] of Object.entries({ SESSION_SECRET, ADMIN_USER, ADMIN_PASSWORD_HASH })) {
    if (!v) {
        console.error(`Missing required env var: ${k}`);
        process.exit(1);
    }
}
const hasViewer = !!(VIEWER_USER && VIEWER_PASSWORD_HASH);
if (hasViewer) {
    console.log(`Viewer login enabled: ${VIEWER_USER}`);
} else {
    console.log('No VIEWER_USER set — only the admin account can log in (admin has both view + admin access).');
}

const SITES_PATH = path.join(__dirname, 'sites.json');
let sites;
try {
    sites = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));
} catch (e) {
    console.error('Failed to load sites.json:', e.message);
    process.exit(1);
}

// Per-agent-type recipient lists. Shared across all sites of a given agent
// type. Shape: { TTP: { to: [], cc: [], bcc: [] }, RELAY: { to: [], cc: [], bcc: [] } }.
// Persisted alongside sites.json. Old format `{TTP: [emails...]}` (a bare array)
// is auto-migrated to `{ bcc: [...] }` so existing config keeps working.
const AGENT_RECIPIENTS_PATH = path.join(__dirname, 'agent-recipients.json');
function emptyBucket() { return { to: [], cc: [], bcc: [] }; }
function normalizeBucket(raw) {
    if (Array.isArray(raw)) return { to: [], cc: [], bcc: raw.filter(s => typeof s === 'string') };
    const o = (raw && typeof raw === 'object') ? raw : {};
    return {
        to:  Array.isArray(o.to)  ? o.to.filter(s => typeof s === 'string')  : [],
        cc:  Array.isArray(o.cc)  ? o.cc.filter(s => typeof s === 'string')  : [],
        bcc: Array.isArray(o.bcc) ? o.bcc.filter(s => typeof s === 'string') : []
    };
}
let agentRecipients = { TTP: emptyBucket(), RELAY: emptyBucket() };
try {
    const raw = JSON.parse(fs.readFileSync(AGENT_RECIPIENTS_PATH, 'utf8'));
    for (const k of ['TTP', 'RELAY']) {
        agentRecipients[k] = normalizeBucket(raw[k]);
    }
} catch (e) {
    if (e.code !== 'ENOENT') console.error('Failed to load agent-recipients.json:', e.message);
}
function saveAgentRecipients() {
    const tmp = AGENT_RECIPIENTS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(agentRecipients, null, 2));
    fs.renameSync(tmp, AGENT_RECIPIENTS_PATH);
}

for (const [name, s] of Object.entries(sites)) {
    if (!s.ip || !s.port || !s.db || !s.measurement) {
        console.error(`sites.json: site "${name}" is missing required fields`);
        process.exit(1);
    }
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "connect-src 'self'; " +
        "frame-ancestors 'none'; " +
        "base-uri 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
});

app.use(express.json({ limit: '64kb' }));
app.use(session({
    name: 'sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: NODE_ENV === 'production',
        maxAge: 12 * 60 * 60 * 1000
    }
}));

const failedLogins = new Map();
const LOCK_AFTER = 5;
const LOCK_FOR_MS = 15 * 60 * 1000;

function loginThrottle(req, res, next) {
    const entry = failedLogins.get(req.ip);
    if (entry && entry.until > Date.now()) {
        const seconds = Math.ceil((entry.until - Date.now()) / 1000);
        return res.status(429).json({ error: `Too many attempts. Try again in ${seconds}s.` });
    }
    next();
}

function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    if (req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Admin role required' });
    }
    next();
}

async function authenticate(username, password) {
    // Admin first — admin role is a superset of viewer.
    if (username === ADMIN_USER && await bcrypt.compare(password, ADMIN_PASSWORD_HASH)) {
        return 'admin';
    }
    if (hasViewer && username === VIEWER_USER && await bcrypt.compare(password, VIEWER_PASSWORD_HASH)) {
        return 'viewer';
    }
    return null;
}

app.post('/api/login', loginThrottle, async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Invalid request' });
    }

    const role = await authenticate(username, password);

    if (role) {
        failedLogins.delete(req.ip);
        req.session.regenerate(err => {
            if (err) return res.status(500).json({ error: 'Session error' });
            req.session.user = username;
            req.session.role = role;
            res.json({ ok: true, role });
        });
        return;
    }

    const entry = failedLogins.get(req.ip) || { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= LOCK_AFTER) entry.until = Date.now() + LOCK_FOR_MS;
    failedLogins.set(req.ip, entry);
    res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
    if (!req.session) return res.json({ ok: true });
    req.session.destroy(() => {
        res.clearCookie('sid');
        res.json({ ok: true });
    });
});

app.get('/api/me', (req, res) => {
    res.json({
        authenticated: !!(req.session && req.session.user),
        user: (req.session && req.session.user) || null,
        role: (req.session && req.session.role) || null
    });
});

// Compliance fields whitelist. Same set as the legacy 3pvc-admin viewer.
const COMPLIANCE_FIELDS = [
    'api_version', 'app_agent_assistant', 'app_audio_package', 'app_audio_proxy',
    'app_camera_server_ipu', 'app_error_mapper', 'app_flashholdmc', 'app_fusion_server',
    'app_h100_driver', 'app_laser_scan_image_saver', 'app_log_extractor', 'app_mcu_logger',
    'app_metrics_monitor', 'app_msg_broker', 'app_nav_client', 'app_nav_process',
    'app_ntpdate', 'app_obstacle_detection_all_sensors', 'app_obstacle_detection_driver',
    'app_openresty', 'app_params_server', 'app_qrlocation_net', 'app_robot_ops_agent',
    'app_route_check', 'app_sick_safetyscanners', 'app_vector', 'app_victoria_metrics',
    'bot_id', 'bot_status', 'ip', 'master_version', 'vda_version'
];
const COMPLIANCE_FIELD_SET = new Set(COMPLIANCE_FIELDS);

function siteToPublic(name, s) {
    return {
        name,
        ip: s.ip,
        port: s.port,
        db: s.db,
        measurement: s.measurement,
        complianceMeasurement: s.complianceMeasurement || 'compliance_details',
        releasedVdaVersion: s.releasedVdaVersion || '',
        recipients: Array.isArray(s.recipients) ? s.recipients : [],
        alertSchedule: normalizeSchedule(s.alertSchedule),
        butlerIp: s.butlerIp || '',
        targetIp: s.targetIp || '',
        gpmsBridgeIp: s.gpmsBridgeIp || '',
        agentType: s.agentType || '',
        hasGorPassword: !!s.gorPassword,
        hasBotSudoPassword: !!s.botSudoPassword
    };
}

const VALID_AGENT_TYPES = new Set(['', 'TTP', 'RELAY']);

function normalizeSchedule(sched) {
    const s = sched && typeof sched === 'object' ? sched : {};
    return {
        enabled: !!s.enabled,
        frequency: VALID_FREQUENCIES.has(s.frequency) ? s.frequency : 'daily',
        time: typeof s.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) ? s.time : '08:00',
        dayOfWeek: Number.isInteger(s.dayOfWeek) && s.dayOfWeek >= 0 && s.dayOfWeek <= 6 ? s.dayOfWeek : 1
    };
}

const VALID_FREQUENCIES = new Set(['hourly', 'daily', 'weekdays', 'weekly']);

function validateRecipients(input) {
    if (input == null) return { ok: true, value: [] };
    let list;
    if (Array.isArray(input)) list = input;
    else if (typeof input === 'string') list = input.split(',');
    else return { ok: false, error: 'recipients must be an array or comma-separated string' };
    const out = [];
    for (const raw of list) {
        const v = String(raw).trim();
        if (!v) continue;
        if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
            return { ok: false, error: `Invalid email: ${v}` };
        }
        out.push(v);
    }
    return { ok: true, value: out };
}

function validateAlertSchedule(input) {
    if (input == null) return { ok: true, value: undefined };
    if (typeof input !== 'object') return { ok: false, error: 'alertSchedule must be an object' };
    if (input.frequency != null && !VALID_FREQUENCIES.has(input.frequency)) {
        return { ok: false, error: `alertSchedule.frequency must be one of: ${Array.from(VALID_FREQUENCIES).join(', ')}` };
    }
    if (input.time != null && !(typeof input.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time))) {
        return { ok: false, error: 'alertSchedule.time must be HH:MM (24h)' };
    }
    if (input.dayOfWeek != null && !(Number.isInteger(input.dayOfWeek) && input.dayOfWeek >= 0 && input.dayOfWeek <= 6)) {
        return { ok: false, error: 'alertSchedule.dayOfWeek must be 0-6 (0=Sun)' };
    }
    return { ok: true, value: normalizeSchedule(input) };
}

app.get('/api/sites', requireAuth, (req, res) => {
    res.json(Object.entries(sites).map(([name, s]) => siteToPublic(name, s)));
});

// Per-agent-type recipient lists (shared by every site with that agentType).
// Anyone authenticated can read; only admin can update.
app.get('/api/agent-recipients', requireAuth, (req, res) => {
    res.json(agentRecipients);
});

app.put('/api/agent-recipients', requireAdmin, (req, res) => {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Body must be {TTP:{to:[],cc:[],bcc:[]}, RELAY:{...}}' });
    }
    const next = {
        TTP:   { ...agentRecipients.TTP },
        RELAY: { ...agentRecipients.RELAY }
    };
    for (const agent of ['TTP', 'RELAY']) {
        if (body[agent] === undefined) continue;
        const bucket = body[agent];
        // Backward-compat: bare array means "bcc" only.
        if (Array.isArray(bucket)) {
            const check = validateRecipients(bucket);
            if (!check.ok) return res.status(400).json({ error: `${agent}: ${check.error}` });
            next[agent] = { to: [], cc: [], bcc: check.value };
            continue;
        }
        if (!bucket || typeof bucket !== 'object') continue;
        const fresh = { to: next[agent].to, cc: next[agent].cc, bcc: next[agent].bcc };
        for (const field of ['to', 'cc', 'bcc']) {
            if (bucket[field] === undefined) continue;
            const check = validateRecipients(bucket[field]);
            if (!check.ok) return res.status(400).json({ error: `${agent}.${field}: ${check.error}` });
            fresh[field] = check.value;
        }
        next[agent] = fresh;
    }
    agentRecipients = next;
    try {
        saveAgentRecipients();
    } catch (err) {
        console.error('Failed to persist agent-recipients.json:', err);
        return res.status(500).json({ error: 'Failed to save' });
    }
    res.json({ ok: true, agentRecipients });
});

app.get('/api/compliance-fields', requireAuth, (req, res) => {
    res.json(COMPLIANCE_FIELDS);
});

// Per-site compliance fields, discovered live from InfluxDB.
// Runs SHOW FIELD KEYS + SHOW TAG KEYS against the site's bot measurement
// (compliance records have the same shape as bot data). 60s memo to keep
// admin form snappy without hammering Influx.
const SITE_COLUMNS_CACHE = new Map();
const SITE_COLUMNS_TTL_MS = 60 * 1000;

async function influxShow(s, q) {
    const url = `http://${s.ip}:${s.port}/query?db=${encodeURIComponent(s.db)}&q=${encodeURIComponent(q)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
        const r = await fetch(url, { signal: ac.signal });
        if (!r.ok) throw new Error(`InfluxDB HTTP ${r.status}`);
        return await r.json();
    } finally {
        clearTimeout(timer);
    }
}

function extractShowKeys(json, keyName) {
    const series = json && json.results && json.results[0] && json.results[0].series && json.results[0].series[0];
    if (!series) return [];
    const idx = series.columns.indexOf(keyName);
    if (idx === -1) return [];
    return (series.values || []).map(row => row[idx]).filter(Boolean);
}

async function fetchSiteColumns(siteName) {
    const cached = SITE_COLUMNS_CACHE.get(siteName);
    if (cached && Date.now() - cached.at < SITE_COLUMNS_TTL_MS) return cached.columns;
    const s = sites[siteName];
    if (!s) throw new Error('Unknown site');
    const measurement = s.measurement || 'bot_firmware_version_details';
    const fq = `SHOW FIELD KEYS FROM "${measurement.replace(/"/g, '')}"`;
    const tq = `SHOW TAG KEYS FROM "${measurement.replace(/"/g, '')}"`;
    const [fieldsJson, tagsJson] = await Promise.all([influxShow(s, fq), influxShow(s, tq)]);
    const set = new Set();
    for (const k of extractShowKeys(fieldsJson, 'fieldKey')) set.add(k);
    for (const k of extractShowKeys(tagsJson, 'tagKey')) set.add(k);
    const columns = Array.from(set).sort();
    SITE_COLUMNS_CACHE.set(siteName, { columns, at: Date.now() });
    return columns;
}

app.get('/api/compliance-fields/:site', requireAuth, async (req, res) => {
    const { site } = req.params;
    if (!sites[site]) return res.status(404).json({ error: 'Unknown site' });
    try {
        const columns = await fetchSiteColumns(site);
        if (columns.length === 0) {
            // Site has no data yet — fall back to legacy global list so admin
            // can still enter the first compliance record.
            return res.json({ columns: COMPLIANCE_FIELDS, source: 'fallback' });
        }
        res.json({ columns, source: 'discovered' });
    } catch (err) {
        const msg = err.name === 'AbortError' ? 'InfluxDB timed out' : err.message;
        res.status(502).json({ error: 'Could not read site columns: ' + msg });
    }
});

function saveSites() {
    const tmp = SITES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sites, null, 2));
    fs.renameSync(tmp, SITES_PATH);
}

function validateSiteFields(body, { allowName = false } = {}) {
    const errors = [];
    if (allowName) {
        if (!body.name || typeof body.name !== 'string') errors.push('name is required');
        else if (!/^[a-zA-Z0-9_\-]+$/.test(body.name)) errors.push('name may only contain letters, numbers, "_", and "-"');
        else if (body.name.length > 64) errors.push('name is too long');
    }
    if (body.ip != null) {
        if (typeof body.ip !== 'string' || !/^[a-zA-Z0-9.\-]{1,253}$/.test(body.ip)) errors.push('ip must be a valid hostname or IPv4');
    }
    if (body.port != null) {
        const p = Number(body.port);
        if (!Number.isInteger(p) || p <= 0 || p > 65535) errors.push('port must be an integer 1-65535');
    }
    if (body.db != null) {
        if (typeof body.db !== 'string' || !body.db || body.db.length > 128) errors.push('db must be a non-empty string');
    }
    if (body.measurement != null) {
        if (typeof body.measurement !== 'string' || !body.measurement || body.measurement.length > 128) errors.push('measurement must be a non-empty string');
    }
    if (body.complianceMeasurement != null) {
        if (typeof body.complianceMeasurement !== 'string' || body.complianceMeasurement.length > 128) errors.push('complianceMeasurement must be a string');
    }
    if (body.releasedVdaVersion != null) {
        if (typeof body.releasedVdaVersion !== 'string' || body.releasedVdaVersion.length > 64) errors.push('releasedVdaVersion must be a string up to 64 chars');
    }
    if (body.recipients !== undefined) {
        const r = validateRecipients(body.recipients);
        if (!r.ok) errors.push(r.error);
    }
    if (body.alertSchedule !== undefined) {
        const r = validateAlertSchedule(body.alertSchedule);
        if (!r.ok) errors.push(r.error);
    }
    if (body.butlerIp != null && body.butlerIp !== '') {
        if (typeof body.butlerIp !== 'string' || !/^[a-zA-Z0-9.\-]{1,253}$/.test(body.butlerIp)) errors.push('butlerIp must be a valid hostname or IPv4');
    }
    if (body.targetIp != null && body.targetIp !== '') {
        if (typeof body.targetIp !== 'string' || !/^[a-zA-Z0-9.\-]{1,253}$/.test(body.targetIp)) errors.push('targetIp must be a valid hostname or IPv4');
    }
    if (body.gorPassword != null && body.gorPassword !== '') {
        if (typeof body.gorPassword !== 'string' || body.gorPassword.length > 256) errors.push('gorPassword must be a string up to 256 chars');
    }
    if (body.botSudoPassword != null && body.botSudoPassword !== '') {
        if (typeof body.botSudoPassword !== 'string' || body.botSudoPassword.length > 256) errors.push('botSudoPassword must be a string up to 256 chars');
    }
    if (body.gpmsBridgeIp != null && body.gpmsBridgeIp !== '') {
        if (typeof body.gpmsBridgeIp !== 'string' || !/^[a-zA-Z0-9.\-]{1,253}$/.test(body.gpmsBridgeIp)) errors.push('gpmsBridgeIp must be a valid hostname or IPv4');
    }
    if (body.agentType != null && body.agentType !== '') {
        if (!VALID_AGENT_TYPES.has(body.agentType)) errors.push('agentType must be TTP or RELAY');
    }
    return errors;
}

app.post('/api/sites', requireAdmin, (req, res) => {
    const body = req.body || {};
    const errors = validateSiteFields(body, { allowName: true });
    if (!body.ip) errors.push('ip is required');
    if (!body.port) errors.push('port is required');
    if (!body.db) errors.push('db is required');
    if (!body.measurement) errors.push('measurement is required');
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    if (sites[body.name]) return res.status(409).json({ error: 'Site already exists' });

    const recipientsCheck = validateRecipients(body.recipients);
    if (!recipientsCheck.ok) return res.status(400).json({ error: recipientsCheck.error });
    const scheduleCheck = validateAlertSchedule(body.alertSchedule);
    if (!scheduleCheck.ok) return res.status(400).json({ error: scheduleCheck.error });

    sites[body.name] = {
        ip: body.ip,
        port: Number(body.port),
        db: body.db,
        measurement: body.measurement,
        complianceMeasurement: body.complianceMeasurement || 'compliance_details',
        releasedVdaVersion: (body.releasedVdaVersion || '').trim(),
        recipients: recipientsCheck.value,
        alertSchedule: scheduleCheck.value || normalizeSchedule(),
        butlerIp: (body.butlerIp || '').trim(),
        targetIp: (body.targetIp || '').trim(),
        gpmsBridgeIp: (body.gpmsBridgeIp || '').trim(),
        agentType: (body.agentType || '').trim(),
        gorPassword: (body.gorPassword || '').trim(),
        botSudoPassword: (body.botSudoPassword || '').trim()
    };
    try {
        saveSites();
    } catch (err) {
        delete sites[body.name];
        console.error('Failed to persist sites.json:', err);
        return res.status(500).json({ error: 'Failed to save' });
    }
    res.status(201).json({ ok: true, site: siteToPublic(body.name, sites[body.name]) });
});

app.put('/api/sites/:name', requireAdmin, (req, res) => {
    const { name } = req.params;
    if (!sites[name]) return res.status(404).json({ error: 'Unknown site' });
    const body = req.body || {};
    const errors = validateSiteFields(body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const s = sites[name];
    if (body.ip != null) s.ip = body.ip;
    if (body.port != null) s.port = Number(body.port);
    if (body.db != null) s.db = body.db;
    if (body.measurement != null) s.measurement = body.measurement;
    if (body.complianceMeasurement != null) s.complianceMeasurement = body.complianceMeasurement || 'compliance_details';
    if (body.releasedVdaVersion != null) s.releasedVdaVersion = body.releasedVdaVersion.trim();
    if (body.recipients !== undefined) {
        const r = validateRecipients(body.recipients);
        if (!r.ok) return res.status(400).json({ error: r.error });
        s.recipients = r.value;
    }
    if (body.alertSchedule !== undefined) {
        const r = validateAlertSchedule(body.alertSchedule);
        if (!r.ok) return res.status(400).json({ error: r.error });
        s.alertSchedule = r.value;
    }
    if (body.butlerIp != null) s.butlerIp = body.butlerIp.trim();
    if (body.targetIp != null) s.targetIp = body.targetIp.trim();
    if (body.gpmsBridgeIp != null) s.gpmsBridgeIp = body.gpmsBridgeIp.trim();
    if (body.agentType != null) s.agentType = body.agentType.trim();
    if (body.gorPassword != null && body.gorPassword !== '') s.gorPassword = body.gorPassword.trim();
    if (body.botSudoPassword != null && body.botSudoPassword !== '') s.botSudoPassword = body.botSudoPassword.trim();

    try {
        saveSites();
    } catch (err) {
        console.error('Failed to persist sites.json:', err);
        return res.status(500).json({ error: 'Failed to save' });
    }
    res.json({ ok: true, site: siteToPublic(name, s) });
});

app.delete('/api/sites/:name', requireAdmin, (req, res) => {
    const { name } = req.params;
    if (!sites[name]) return res.status(404).json({ error: 'Unknown site' });
    const backup = sites[name];
    delete sites[name];
    try {
        saveSites();
    } catch (err) {
        sites[name] = backup;
        console.error('Failed to persist sites.json:', err);
        return res.status(500).json({ error: 'Failed to save' });
    }
    res.json({ ok: true });
});

// InfluxDB line-protocol field value escaping: backslash and double-quote.
function escapeFieldString(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

app.post('/api/compliance/:site', requireAdmin, async (req, res) => {
    const { site } = req.params;
    if (!sites[site]) return res.status(404).json({ error: 'Unknown site' });
    const body = req.body || {};
    if (typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });

    // Validate against the site's *actual* columns when available; fall back
    // to the legacy global allowlist if discovery fails.
    let allowed;
    try {
        const cols = await fetchSiteColumns(site);
        allowed = new Set(cols.length > 0 ? cols : COMPLIANCE_FIELDS);
    } catch {
        allowed = COMPLIANCE_FIELD_SET;
    }

    const filtered = {};
    const rejected = [];
    for (const [k, v] of Object.entries(body)) {
        if (!allowed.has(k)) { rejected.push(k); continue; }
        if (typeof v !== 'string') continue;
        const trimmed = v.trim();
        if (!trimmed) continue;
        if (trimmed.length > 256) return res.status(400).json({ error: `${k} is too long` });
        filtered[k] = trimmed;
    }
    if (rejected.length) {
        return res.status(400).json({ error: `Unknown columns for this site: ${rejected.join(', ')}` });
    }
    if (allowed.has('api_version') && !filtered.api_version) {
        return res.status(400).json({ error: 'api_version is required' });
    }
    if (Object.keys(filtered).length === 0) {
        return res.status(400).json({ error: 'No valid fields provided' });
    }

    const s = sites[site];
    const measurement = s.complianceMeasurement || 'compliance_details';
    const fieldStr = Object.entries(filtered)
        .map(([k, v]) => `${k}="${escapeFieldString(v)}"`)
        .join(',');
    const line = `${measurement} ${fieldStr}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
        const url = `http://${s.ip}:${s.port}/write?db=${encodeURIComponent(s.db)}`;
        const r = await fetch(url, { method: 'POST', body: line, signal: ac.signal });
        if (!r.ok) {
            const text = await r.text();
            return res.status(502).json({ error: `InfluxDB write failed (HTTP ${r.status}): ${text || r.statusText}` });
        }
        res.json({ ok: true, written: Object.keys(filtered).length });
    } catch (err) {
        const msg = err.name === 'AbortError' ? 'InfluxDB write timed out' : 'InfluxDB write failed: ' + err.message;
        res.status(502).json({ error: msg });
    } finally {
        clearTimeout(timer);
    }
});

const alerts = require('./lib/alerts');

app.post('/api/alerts/:site/send', requireAdmin, async (req, res) => {
    const { site } = req.params;
    if (!sites[site]) return res.status(404).json({ error: 'Unknown site' });
    try {
        const extra = agentRecipients[sites[site].agentType] || [];
        const result = await alerts.sendReport(site, sites[site], { agentTypeRecipients: extra });
        res.json({ ok: true, recipients: result.recipients, totals: result.totals });
    } catch (err) {
        console.error(`Alert send failed for ${site}:`, err);
        res.status(502).json({ error: err.message || 'Failed to send alert' });
    }
});

// Send ONE combined compliance email covering every site whose agentType matches.
// Body is an aggregated summary table; one xlsx attachment per site.
// BCC'd to the per-agent recipient list (plus any per-site recipients merged in
// would be confusing for a combined mail — we deliberately use ONLY the agent
// list here, not per-site recipients).
app.post('/api/alerts/by-agent/:agentType/send', requireAdmin, async (req, res) => {
    const { agentType } = req.params;
    if (!['TTP', 'RELAY'].includes(agentType)) {
        return res.status(400).json({ error: 'agentType must be TTP or RELAY' });
    }
    const targets = Object.entries(sites).filter(([, s]) => s.agentType === agentType);
    if (targets.length === 0) {
        return res.status(400).json({ error: `No sites configured with agentType=${agentType}` });
    }
    const bucket = agentRecipients[agentType] || { to: [], cc: [], bcc: [] };
    const totalAddrs = (bucket.to || []).length + (bucket.cc || []).length + (bucket.bcc || []).length;
    if (totalAddrs === 0) {
        return res.status(400).json({ error: `Agent recipients for ${agentType} are empty. Add at least one To / CC / BCC address.` });
    }
    try {
        const result = await alerts.sendCombinedReport(agentType, targets, { bucket });
        res.json({
            ok: true,
            agentType,
            sites: targets.length,
            sentTo: result.recipients.length,
            totals: result.totals,
            perSite: result.perSite
        });
    } catch (err) {
        console.error(`Combined alert send failed for ${agentType}:`, err);
        res.status(502).json({ error: err.message || 'Failed to send combined alert' });
    }
});

function isReadOnlyInfluxQL(q) {
    if (typeof q !== 'string') return false;
    const trimmed = q.trim();
    if (!trimmed || trimmed.length > 4096) return false;
    if (trimmed.includes(';')) return false;
    const upper = trimmed.toUpperCase();
    if (!(upper.startsWith('SELECT ') || upper.startsWith('SHOW '))) return false;
    const forbidden = [' INTO ', ' DROP ', ' DELETE ', ' ALTER ', ' GRANT ', ' REVOKE ', ' CREATE ', ' KILL '];
    return !forbidden.some(w => upper.includes(w));
}

app.get('/api/query', requireAuth, async (req, res) => {
    const { site, q } = req.query;
    if (typeof site !== 'string' || !sites[site]) {
        return res.status(400).json({ error: 'Unknown site' });
    }
    if (!isReadOnlyInfluxQL(q)) {
        return res.status(400).json({ error: 'Only single SELECT or SHOW statements are allowed' });
    }
    const s = sites[site];
    const url = `http://${s.ip}:${s.port}/query?db=${encodeURIComponent(s.db)}&q=${encodeURIComponent(q)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
        const r = await fetch(url, { signal: ac.signal });
        const text = await r.text();
        res.status(r.status).type('application/json').send(text);
    } catch (err) {
        const msg = err.name === 'AbortError' ? 'InfluxDB request timed out' : 'InfluxDB request failed';
        res.status(502).json({ error: msg });
    } finally {
        clearTimeout(timer);
    }
});

const OPS_AUDIT_PATH = path.join(__dirname, 'ops-audit.log');
function appendOpsAudit(user, siteName, command, outcome) {
    const line = [new Date().toISOString(), user || '-', siteName, command, outcome].join('\t') + '\n';
    fs.appendFile(OPS_AUDIT_PATH, line, err => {
        if (err) console.error('Audit log write failed:', err.message);
    });
}

const opsRunning = new Set();

const VDA_REMOTE_BUILD_DIR = '/home/gor/vda_remote_build';
// Inventory and group_vars filenames vary per agent type. TTP sites use `ttp`;
// everything else uses `vda_remote` (the legacy default).
function vdaPaths(site) {
    const filename = site && site.agentType === 'TTP' ? 'ttp' : 'vda_remote';
    return {
        inventoryPath: `/opt/ranger_deployer/inventory/${filename}`,
        groupVarsPath: `/opt/ranger_deployer/inventory/group_vars/${filename}`
    };
}

// Where to stage the uploaded VDA tar on the bridge. Prefers an explicit
// `vda_remote_build_location` from group_vars; falls back to per-agent default.
//   TTP   → /tmp/vda_remote             (contains release_<ver>/ subfolders)
//   RELAY → /home/gor/vda_remote_build  (flat tars)
function vdaBuildLocation(site, groupVars) {
    if (groupVars && typeof groupVars.vda_remote_build_location === 'string' && groupVars.vda_remote_build_location.trim()) {
        return groupVars.vda_remote_build_location.trim().replace(/^['"]|['"]$/g, '');
    }
    return site && site.agentType === 'TTP' ? '/tmp/vda_remote' : '/home/gor/vda_remote_build';
}
const VDA_DEPLOY_DIR = '/opt/ranger_deployer';
const VDA_DEPLOY_TIMEOUT_MS = 60 * 60 * 1000;

const vdaUpload = multer({
    storage: multer.diskStorage({
        destination: os.tmpdir(),
        filename: (req, file, cb) => {
            const rand = crypto.randomBytes(8).toString('hex');
            const safeName = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 200);
            cb(null, `vda-${rand}-${safeName}`);
        }
    }),
    limits: { fileSize: 100 * 1024 * 1024, files: 1 }
});

function siteOpsConfig(siteName) {
    const s = sites[siteName];
    if (!s) return { error: 'Unknown site' };
    if (!s.butlerIp || !s.targetIp || !s.gorPassword) {
        return { error: 'Site is not configured for operations: set Butler IP, Target IP, and gor password in the admin UI.' };
    }
    return { ok: true, opts: { butlerIp: s.butlerIp, targetIp: s.targetIp, gorPassword: s.gorPassword } };
}

app.get('/api/operations/vda/inventory', requireAuth, async (req, res) => {
    const siteName = req.query && req.query.site;
    console.error('[ops]', new Date().toISOString(), 'GET /api/operations/vda/inventory', { user: req.session.user, site: siteName });
    const cfg = siteOpsConfig(siteName);
    if (cfg.error) return res.status(400).json({ error: cfg.error });
    const { inventoryPath, groupVarsPath } = vdaPaths(sites[siteName]);
    // Use the per-agent default for the listing command (parallel with group_vars read).
    const site = sites[siteName];
    const defaultBuildDir = vdaBuildLocation(site, null);
    const isTtp = site && site.agentType === 'TTP';
    // TTP   → list release_* DIRECTORIES under build dir (e.g. release_v1.3.11)
    // RELAY → list *.tar.gz FILES (one level deep)
    const listCmd = isTtp
        ? `find ${defaultBuildDir} -maxdepth 1 -type d -name 'release*' -printf '%T@ %f\\n' 2>/dev/null | sort -rn | cut -d' ' -f2-`
        : `find ${defaultBuildDir} -maxdepth 2 -type f \\( -name '*.tar.gz' -o -name '*.tgz' -o -name '*.tar' \\) -printf '%T@ %P\\n' 2>/dev/null | sort -rn | cut -d' ' -f2-`;
    try {
        const [text, groupVarsText, tarListResult, ipDetails] = await Promise.all([
            readRemoteFile(cfg.opts, inventoryPath),
            readRemoteFile(cfg.opts, groupVarsPath).catch(() => ''),
            runOnSiteServer({
                ...cfg.opts,
                command: listCmd,
                timeoutMs: 20000
            }).catch(() => ({ code: 1, stdout: '', stderr: '' })),
            fetchIpDetails(sites[siteName]).catch(() => ({ ipToBot: {}, ipToVersion: {} }))
        ]);
        const sections = parseInventory(text);
        const ports = parseInventoryPorts(text);
        const groupVars = parseGroupVars(groupVarsText);
        // tarFiles are paths RELATIVE to defaultBuildDir (e.g. "release_v1.3.11/vda_remote_v1.3.11.tar.gz" for TTP).
        const tarFiles = String(tarListResult.stdout || '')
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean);
        console.error('[ops]', new Date().toISOString(), 'inventory parsed', {
            sectionCount: Object.keys(sections).length,
            ipMapSize: Object.keys(ipDetails.ipToBot).length,
            versionMapSize: Object.keys(ipDetails.ipToVersion).length,
            tarCount: tarFiles.length,
            emqxHost: groupVars.emqx_mqtt_host
        });
        // Resolved build location (group_vars override if present, else default).
        const buildLocation = vdaBuildLocation(sites[siteName], groupVars);
        res.json({
            ok: true,
            sections,
            ports,
            ipToBot: ipDetails.ipToBot,
            ipToVersion: ipDetails.ipToVersion,
            groupVars,
            tarFiles,
            tarListMode: isTtp ? 'release-folders' : 'tar-files',
            buildLocation
        });
    } catch (err) {
        console.error('[ops]', new Date().toISOString(), 'inventory load failed', { error: err.message });
        res.status(502).json({ error: err.message });
    }
});

app.post(
    '/api/operations/vda/deploy',
    requireAuth,
    (req, res, next) => {
        req.setTimeout(VDA_DEPLOY_TIMEOUT_MS + 60000);
        res.setTimeout(VDA_DEPLOY_TIMEOUT_MS + 60000);
        next();
    },
    vdaUpload.single('tar'),
    async (req, res) => {
        const siteName = req.body && req.body.site;
        const cfg = siteOpsConfig(siteName);
        if (cfg.error) {
            cleanupUpload(req.file);
            return res.status(400).json({ error: cfg.error });
        }
        const tarFile = req.file;
        const existingTar = String((req.body && req.body.existingTar) || '').trim();
        if (!tarFile && !existingTar) {
            return res.status(400).json({ error: 'Provide either a new tar upload or pick an existing tar on the bridge.' });
        }
        if (tarFile && existingTar) {
            cleanupUpload(tarFile);
            return res.status(400).json({ error: 'Send only one of: uploaded tar OR existingTar.' });
        }
        // existingTar may be:
        //   - a release folder name for TTP (e.g. "release_v1.3.11")
        //   - a bare tar filename or "<subfolder>/<filename>" for RELAY
        // Path traversal is blocked.
        if (existingTar && (
            existingTar.includes('..') || existingTar.startsWith('/') ||
            !/^[a-zA-Z0-9._\-]+(\/[a-zA-Z0-9._\-]+)?$/.test(existingTar)
        )) {
            return res.status(400).json({ error: 'existingTar must be a filename, release folder, or "<subfolder>/<filename>".' });
        }

        const vdaRemoteVersion = String(req.body.vdaRemoteVersion || '').trim();
        const emqxHost = String(req.body.emqxMqttHost || '').trim();
        let selections;
        try {
            selections = JSON.parse(req.body.selections || '{}');
            if (!selections || typeof selections !== 'object' || Array.isArray(selections)) throw new Error();
        } catch {
            cleanupUpload(tarFile);
            return res.status(400).json({ error: 'selections must be a JSON object {section: [ips]}' });
        }

        if (!/^[a-zA-Z0-9._\-]{1,32}$/.test(vdaRemoteVersion)) {
            cleanupUpload(tarFile);
            return res.status(400).json({ error: 'vdaRemoteVersion must be 1-32 chars of [a-zA-Z0-9._-]' });
        }
        if (!/^[a-zA-Z0-9.\-]{1,253}$/.test(emqxHost)) {
            cleanupUpload(tarFile);
            return res.status(400).json({ error: 'emqxMqttHost must be a valid hostname or IPv4' });
        }
        const sectionEntries = Object.entries(selections);
        if (sectionEntries.length === 0) {
            cleanupUpload(tarFile);
            return res.status(400).json({ error: 'Pick at least one bot in at least one section' });
        }
        let totalIps = 0;
        for (const [section, ips] of sectionEntries) {
            if (!/^[a-zA-Z0-9_]+_production$/.test(section)) {
                cleanupUpload(tarFile);
                return res.status(400).json({ error: `Invalid section name: ${section}` });
            }
            if (!Array.isArray(ips)) {
                cleanupUpload(tarFile);
                return res.status(400).json({ error: `selections.${section} must be an array` });
            }
            for (const ip of ips) {
                if (typeof ip !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
                    cleanupUpload(tarFile);
                    return res.status(400).json({ error: `Invalid IP in selections.${section}: ${ip}` });
                }
                totalIps += 1;
            }
        }
        if (totalIps === 0) {
            cleanupUpload(tarFile);
            return res.status(400).json({ error: 'No IPs selected for deploy' });
        }
        if (tarFile && !/\.(tar|tar\.gz|tgz)$/i.test(tarFile.originalname)) {
            cleanupUpload(tarFile);
            return res.status(400).json({ error: 'tar filename must end with .tar, .tar.gz, or .tgz' });
        }
        const safeTarName = existingTar
            ? existingTar
            : tarFile.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 200);
        const lockKey = `site:${siteName}`;
        if (opsRunning.has(lockKey)) {
            cleanupUpload(tarFile);
            return res.status(429).json({ error: 'Another operation is already in progress for this site.' });
        }
        opsRunning.add(lockKey);
        // Stream NDJSON: one event per line, flush as each step completes so the
        // client sees progress in real time instead of after the whole deploy.
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no'); // disable nginx response buffering
        res.flushHeaders();
        const steps = [];
        const writeEvent = (obj) => {
            if (res.writableEnded) return;
            res.write(JSON.stringify(obj) + '\n');
        };
        const addStep = (label, info = {}) => {
            const step = { type: 'step', label, at: new Date().toISOString(), ...info };
            steps.push(step);
            writeEvent(step);
        };
        try {
            // Resolve per-site paths and the tar build location BEFORE we upload, so the file
            // lands at the location ansible actually reads from (TTP uses /tmp/vda_remote/...).
            const { inventoryPath, groupVarsPath } = vdaPaths(sites[siteName]);
            addStep('read-group-vars-start', { path: groupVarsPath });
            const groupVarsText = await readRemoteFile(cfg.opts, groupVarsPath);
            const parsedGroupVars = parseGroupVars(groupVarsText);
            const buildLocation = vdaBuildLocation(sites[siteName], parsedGroupVars);
            addStep('read-group-vars-done', { buildLocation });

            if (existingTar) {
                // For TTP, existingTar is typically a release_<ver>/ folder under buildLocation.
                // No upload needed — the tar is already on the bridge.
                addStep('using-existing', { selection: safeTarName, buildLocation });
            } else {
                addStep('upload-received', { size: tarFile.size, filename: safeTarName });
                addStep('scp-tar-start', { dest: `${buildLocation}/${safeTarName}` });
                // Ensure the directory exists (TTP's /tmp/vda_remote may not exist yet on a fresh site).
                await runOnSiteServer({
                    ...cfg.opts,
                    command: `mkdir -p ${shellQuote(buildLocation)} && sudo -n chown gor:gor ${shellQuote(buildLocation)} 2>/dev/null || true`,
                    timeoutMs: 15000
                }).catch(() => {});
                const fileStream = fs.createReadStream(tarFile.path);
                await writeRemoteFile(
                    { ...cfg.opts, useSudo: true, chownTo: 'gor:gor', timeoutMs: 15 * 60 * 1000 },
                    `${buildLocation}/${safeTarName}`,
                    fileStream
                );
                addStep('scp-tar-done');
            }

            addStep('patch-group-vars-start', { path: groupVarsPath });
            const newGroupVars = updateGroupVars(groupVarsText, {
                vda_remote_version: vdaRemoteVersion,
                emqx_mqtt_host: emqxHost
            });
            await writeRemoteFile({ ...cfg.opts, useSudo: true }, groupVarsPath, newGroupVars);
            addStep('patch-group-vars-done');

            addStep('patch-inventory-start', { path: inventoryPath });
            const invText = await readRemoteFile(cfg.opts, inventoryPath);
            const newInv = applyMultiSectionActiveIps(invText, selections);
            await writeRemoteFile({ ...cfg.opts, useSudo: true }, inventoryPath, newInv);
            addStep('patch-inventory-done');

            addStep('vda-deploy-start');
            const deployResult = await runOnSiteServer({
                ...cfg.opts,
                command: `cd ${VDA_DEPLOY_DIR} && bash vda_deploy.sh`,
                timeoutMs: VDA_DEPLOY_TIMEOUT_MS
            });
            addStep('vda-deploy-done', { code: deployResult.code });

            const summary = sectionEntries.map(([s, ips]) => `${s}(${ips.length})`).join(',');
            appendOpsAudit(
                req.session.user,
                siteName,
                `vda-deploy ${safeTarName} ${summary} vda_remote_version=${vdaRemoteVersion}`,
                `exit=${deployResult.code}`
            );
            writeEvent({
                type: 'result',
                ok: true,
                code: deployResult.code,
                stdout: deployResult.stdout.slice(0, 256 * 1024),
                stderr: deployResult.stderr.slice(0, 256 * 1024),
                steps
            });
            res.end();
        } catch (err) {
            appendOpsAudit(req.session.user, siteName, `vda-deploy ${safeTarName}`, `error: ${err.message}`);
            writeEvent({ type: 'error', error: err.message, steps });
            if (!res.writableEnded) res.end();
        } finally {
            opsRunning.delete(lockKey);
            cleanupUpload(tarFile);
        }
    }
);

function cleanupUpload(file) {
    if (!file) return;
    fs.unlink(file.path, () => { /* ignore */ });
}

async function influxQuery(site, q, timeoutMs = 10000) {
    const url = `http://${site.ip}:${site.port}/query?db=${encodeURIComponent(site.db)}&q=${encodeURIComponent(q)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const r = await fetch(url, { signal: ac.signal });
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const BOT_TAG_CACHE = new Map();
async function discoverBotTag(site) {
    if (BOT_TAG_CACHE.has(site.ip)) return BOT_TAG_CACHE.get(site.ip);
    const j = await influxQuery(site, `SHOW TAG KEYS FROM "${site.measurement}"`);
    const tags = ((j && j.results && j.results[0] && j.results[0].series && j.results[0].series[0] && j.results[0].series[0].values) || []).map(v => v[0]);
    let chosen = null;
    if (tags.includes('bot_id')) chosen = 'bot_id';
    else if (tags.includes('butler_id')) chosen = 'butler_id';
    BOT_TAG_CACHE.set(site.ip, chosen);
    return chosen;
}

async function fetchIpToBotMap(site) {
    const d = await fetchIpDetails(site);
    return d.ipToBot;
}

// Returns { ipToBot, ipToVersion } from the site's latest bot_firmware records.
// Uses a single InfluxDB query when ip is a tag (Apotek-style) and a fallback
// when ip is a field (walmartpot-style).
async function fetchIpDetails(site) {
    const botTag = await discoverBotTag(site);
    if (!botTag) return { ipToBot: {}, ipToVersion: {} };
    const j = await influxQuery(site, `SELECT last("vda_version") FROM "${site.measurement}" GROUP BY "${botTag}", "ip"`);
    const series = (j && j.results && j.results[0] && j.results[0].series) || [];
    const ipToBot = {};
    const ipToVersion = {};
    for (const s of series) {
        const t = s.tags || {};
        const ip = t.ip;
        const botId = t[botTag];
        if (ip && botId) ipToBot[ip] = botId;
        const row = (s.values && s.values[0]) || [];
        const v = row[1]; // [time, last]
        if (ip && v != null && typeof v === 'string') ipToVersion[ip] = v;
    }
    if (Object.keys(ipToBot).length === 0) {
        // ip is a field, not a tag (walmartpot). Fall back to one row per bot.
        const j2 = await influxQuery(site, `SELECT last("ip"), last("vda_version") FROM "${site.measurement}" GROUP BY "${botTag}"`);
        const series2 = (j2 && j2.results && j2.results[0] && j2.results[0].series) || [];
        for (const s of series2) {
            const t = s.tags || {};
            const botId = t[botTag];
            const cols = s.columns || [];
            const ipIdx = cols.findIndex(c => c === 'last' || c === 'last_1' || c === 'last_ip');
            const verIdx = cols.findIndex(c => c === 'last_1' || c === 'last_vda_version');
            const row = (s.values && s.values[0]) || [];
            const ip = ipIdx !== -1 ? row[ipIdx] : null;
            const ver = verIdx !== -1 && verIdx !== ipIdx ? row[verIdx] : null;
            if (ip && botId && typeof ip === 'string') ipToBot[ip] = botId;
            if (ip && ver && typeof ver === 'string') ipToVersion[ip] = ver;
        }
    }
    return { ipToBot, ipToVersion };
}

async function fetchBotIp(site, botId) {
    const botTag = await discoverBotTag(site);
    if (!botTag) return null;
    const escaped = String(botId).replace(/'/g, "");
    const q = `SELECT * FROM "${site.measurement}" WHERE "${botTag}" = '${escaped}' ORDER BY time DESC LIMIT 1`;
    const url = `http://${site.ip}:${site.port}/query?db=${encodeURIComponent(site.db)}&q=${encodeURIComponent(q)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
        const r = await fetch(url, { signal: ac.signal });
        if (!r.ok) throw new Error(`InfluxDB returned ${r.status}`);
        const j = await r.json();
        const series = j && j.results && j.results[0] && j.results[0].series && j.results[0].series[0];
        if (!series || !series.columns || !series.values || !series.values.length) return null;
        const ipIdx = series.columns.indexOf('ip');
        if (ipIdx === -1) return null;
        const ip = series.values[0][ipIdx];
        return typeof ip === 'string' && ip ? ip : null;
    } finally {
        clearTimeout(timer);
    }
}

app.post('/api/operations/ping-bot', requireAuth, async (req, res) => {
    const siteName = req.body && req.body.site;
    const botId = req.body && req.body.botId;
    if (typeof siteName !== 'string' || !sites[siteName]) {
        return res.status(400).json({ error: 'Unknown site' });
    }
    if (typeof botId !== 'string' || !/^[a-zA-Z0-9._\-]+$/.test(botId) || botId.length > 64) {
        return res.status(400).json({ error: 'Invalid botId' });
    }
    const s = sites[siteName];
    if (!s.butlerIp || !s.targetIp || !s.gorPassword) {
        return res.status(400).json({ error: 'Site is not configured for operations: set Butler IP, Target IP, and gor password in the admin UI.' });
    }
    const lockKey = `site:${siteName}`;
    if (opsRunning.has(lockKey)) {
        return res.status(429).json({ error: 'Another operation is already in progress for this site.' });
    }
    opsRunning.add(lockKey);
    try {
        let botIp;
        try {
            botIp = await fetchBotIp(s, botId);
        } catch (err) {
            appendOpsAudit(req.session.user, siteName, `ping ${botId}`, `influx-error: ${err.message}`);
            return res.status(502).json({ error: `InfluxDB lookup failed: ${err.message}` });
        }
        if (!botIp) {
            appendOpsAudit(req.session.user, siteName, `ping ${botId}`, 'no-ip-found');
            return res.status(404).json({ error: `No IP recorded in InfluxDB for bot_id "${botId}"` });
        }
        if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(botIp)) {
            appendOpsAudit(req.session.user, siteName, `ping ${botId}`, `invalid-ip: ${botIp}`);
            return res.status(502).json({ error: `Bot IP in InfluxDB is not a valid IPv4: ${botIp}` });
        }
        const result = await runOnSiteServer({
            command: `ping -c 4 -W 2 ${botIp}`,
            butlerIp: s.butlerIp,
            targetIp: s.targetIp,
            gorPassword: s.gorPassword
        });
        appendOpsAudit(req.session.user, siteName, `ping ${botId} (${botIp})`, `exit=${result.code}`);
        res.json({
            ok: true,
            botIp,
            code: result.code,
            stdout: result.stdout.slice(0, 64 * 1024),
            stderr: result.stderr.slice(0, 64 * 1024)
        });
    } catch (err) {
        appendOpsAudit(req.session.user, siteName, `ping ${botId}`, `error: ${err.message}`);
        res.status(502).json({ error: err.message });
    } finally {
        opsRunning.delete(lockKey);
    }
});

const MAINTENANCE_COMMANDS = {
    vdarestart: { sudo: true,  cmd: 'systemctl restart vda_remote.service' },
    vdastop:    { sudo: true,  cmd: 'systemctl stop vda_remote.service' },
    vdastart:   { sudo: true,  cmd: 'systemctl start vda_remote.service' },
    savelog:    { sudo: false, cmd: 'bash /home/gor/save_all_logs_ttp.sh' }
};

function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

const MAINTENANCE_PER_BOT_TIMEOUT_MS = 2 * 60 * 1000;
const MAINTENANCE_REQ_TIMEOUT_MS    = 30 * 60 * 1000;
const MAINTENANCE_CONCURRENCY       = 7;

app.post(
    '/api/operations/bot/run',
    requireAuth,
    (req, res, next) => {
        req.setTimeout(MAINTENANCE_REQ_TIMEOUT_MS + 60000);
        res.setTimeout(MAINTENANCE_REQ_TIMEOUT_MS + 60000);
        next();
    },
    async (req, res) => {
        const siteName = req.body && req.body.site;
        const cfg = siteOpsConfig(siteName);
        if (cfg.error) return res.status(400).json({ error: cfg.error });
        const command = String(req.body.command || '');
        if (!Object.prototype.hasOwnProperty.call(MAINTENANCE_COMMANDS, command)) {
            return res.status(400).json({ error: `Unknown command. Allowed: ${Object.keys(MAINTENANCE_COMMANDS).join(', ')}` });
        }
        const selections = (req.body && req.body.selections) || {};
        if (typeof selections !== 'object' || Array.isArray(selections)) {
            return res.status(400).json({ error: 'selections must be a JSON object {section: [ips]}' });
        }
        const targets = [];
        for (const [section, ips] of Object.entries(selections)) {
            if (!/^[a-zA-Z0-9_]+_production$/.test(section)) {
                return res.status(400).json({ error: `Invalid section: ${section}` });
            }
            if (!Array.isArray(ips)) {
                return res.status(400).json({ error: `selections.${section} must be an array` });
            }
            for (const ip of ips) {
                if (typeof ip !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
                    return res.status(400).json({ error: `Invalid IP in selections.${section}: ${ip}` });
                }
                targets.push({ section, ip });
            }
        }
        if (targets.length === 0) return res.status(400).json({ error: 'No bots selected' });

        const lockKey = `site:${siteName}`;
        if (opsRunning.has(lockKey)) {
            return res.status(429).json({ error: 'Another operation is already in progress for this site.' });
        }
        opsRunning.add(lockKey);
        const startedAt = Date.now();

        // Read inventory BEFORE streaming so we can still 502 cleanly if it fails
        const { inventoryPath: botInventoryPath } = vdaPaths(sites[siteName]);
        let invText, ports;
        try {
            invText = await readRemoteFile(cfg.opts, botInventoryPath);
            ports = parseInventoryPorts(invText);
        } catch (err) {
            opsRunning.delete(lockKey);
            return res.status(502).json({ error: 'Could not read inventory to get bot SSH ports: ' + err.message });
        }

        // Stream NDJSON: one event per bot start/result so the client renders
        // each bot's outcome the moment it lands.
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const writeEvent = (obj) => {
            if (res.writableEnded) return;
            res.write(JSON.stringify(obj) + '\n');
        };

        const spec = MAINTENANCE_COMMANDS[command];
        const sudoPassword = sites[siteName].botSudoPassword || cfg.opts.gorPassword;
        const shellCmd = spec.sudo
            ? `echo ${shellQuote(sudoPassword)} | sudo -S ${spec.cmd}`
            : spec.cmd;

        writeEvent({
            type: 'plan',
            command,
            total: targets.length,
            concurrency: Math.min(MAINTENANCE_CONCURRENCY, targets.length),
            targets: targets.map(t => ({ ip: t.ip, section: t.section, port: ports[t.section] || 22 }))
        });

        const results = [];
        let nextIdx = 0;
        const worker = async (workerId) => {
            while (true) {
                const i = nextIdx++;
                if (i >= targets.length) return;
                const t = targets[i];
                const port = ports[t.section] || 22;
                const bStart = Date.now();
                writeEvent({ type: 'start', workerId, ip: t.ip, section: t.section, port });
                console.error('[ops]', new Date().toISOString(), 'bot/run', { worker: workerId, ip: t.ip, port, command });
                let evt;
                try {
                    const r = await runOnBot(cfg.opts, {
                        botIp: t.ip,
                        botPort: port,
                        command: shellCmd,
                        timeoutMs: MAINTENANCE_PER_BOT_TIMEOUT_MS
                    });
                    evt = {
                        type: 'result', workerId, ip: t.ip, section: t.section, port,
                        code: r.code,
                        stdout: r.stdout.slice(0, 16384),
                        stderr: r.stderr.slice(0, 16384),
                        elapsedMs: Date.now() - bStart
                    };
                } catch (err) {
                    evt = {
                        type: 'result', workerId, ip: t.ip, section: t.section, port,
                        code: -1, stdout: '', stderr: 'ERROR: ' + err.message,
                        elapsedMs: Date.now() - bStart
                    };
                }
                results.push(evt);
                writeEvent(evt);
            }
        };

        try {
            const poolSize = Math.min(MAINTENANCE_CONCURRENCY, targets.length);
            await Promise.all(Array.from({ length: poolSize }, (_, idx) => worker(idx + 1)));
            const ok = results.filter(r => r.code === 0).length;
            appendOpsAudit(
                req.session.user,
                siteName,
                `bot-run ${command} (${targets.length} bots, ${ok} ok, conc=${poolSize})`,
                `done`
            );
            writeEvent({ type: 'done', ok, total: results.length, elapsedMs: Date.now() - startedAt });
            res.end();
        } catch (err) {
            writeEvent({ type: 'error', error: err.message });
            if (!res.writableEnded) res.end();
        } finally {
            opsRunning.delete(lockKey);
        }
    }
);

app.post('/api/operations/run-alias', requireAuth, async (req, res) => {
    const siteName = req.body && req.body.site;
    if (typeof siteName !== 'string' || !sites[siteName]) {
        return res.status(400).json({ error: 'Unknown site' });
    }
    const s = sites[siteName];
    if (!s.butlerIp || !s.targetIp || !s.gorPassword) {
        return res.status(400).json({ error: 'Site is not configured for operations: set Butler IP, Target IP, and gor password in the admin UI.' });
    }
    const lockKey = `site:${siteName}`;
    if (opsRunning.has(lockKey)) {
        return res.status(429).json({ error: 'Another operation is already in progress for this site.' });
    }
    opsRunning.add(lockKey);
    try {
        const result = await runOnSiteServer({
            command: 'alias',
            butlerIp: s.butlerIp,
            targetIp: s.targetIp,
            gorPassword: s.gorPassword
        });
        appendOpsAudit(req.session.user, siteName, 'alias', `exit=${result.code}`);
        res.json({
            ok: true,
            code: result.code,
            stdout: result.stdout.slice(0, 64 * 1024),
            stderr: result.stderr.slice(0, 64 * 1024)
        });
    } catch (err) {
        appendOpsAudit(req.session.user, siteName, 'alias', `error: ${err.message}`);
        res.status(502).json({ error: err.message });
    } finally {
        opsRunning.delete(lockKey);
    }
});

app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    }
}));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Server error' });
});

const port = Number(PORT);
app.listen(port, HOST, () => {
    console.log(`influxdb-ui v2 listening on http://${HOST}:${port}`);
    console.log(`NODE_ENV=${NODE_ENV}`);
});
