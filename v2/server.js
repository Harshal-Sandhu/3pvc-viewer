'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { runOnSiteServer, runOnBot, readRemoteFile, writeRemoteFile } = require('./lib/sshChain');
const { parseInventory, parseInventoryPorts, applyActiveIps, applyMultiSectionActiveIps, updateGroupVars } = require('./lib/vdaInventory');
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
        hasGorPassword: !!s.gorPassword,
        hasBotSudoPassword: !!s.botSudoPassword
    };
}

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

app.get('/api/compliance-fields', requireAuth, (req, res) => {
    res.json(COMPLIANCE_FIELDS);
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

    const filtered = {};
    for (const [k, v] of Object.entries(body)) {
        if (!COMPLIANCE_FIELD_SET.has(k)) continue;
        if (typeof v !== 'string') continue;
        const trimmed = v.trim();
        if (!trimmed) continue;
        if (trimmed.length > 256) return res.status(400).json({ error: `${k} is too long` });
        filtered[k] = trimmed;
    }
    if (!filtered.api_version) {
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
        const result = await alerts.sendReport(site, sites[site]);
        res.json({ ok: true, recipients: result.recipients, totals: result.totals });
    } catch (err) {
        console.error(`Alert send failed for ${site}:`, err);
        res.status(502).json({ error: err.message || 'Failed to send alert' });
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
const VDA_GROUP_VARS_PATH = '/opt/ranger_deployer/inventory/group_vars/vda_remote';
const VDA_INVENTORY_PATH = '/opt/ranger_deployer/inventory/vda_remote';
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
    try {
        const [text, ipToBot] = await Promise.all([
            readRemoteFile(cfg.opts, VDA_INVENTORY_PATH),
            fetchIpToBotMap(sites[siteName])
        ]);
        const sections = parseInventory(text);
        const ports = parseInventoryPorts(text);
        console.error('[ops]', new Date().toISOString(), 'inventory parsed', { sectionCount: Object.keys(sections).length, ipMapSize: Object.keys(ipToBot).length });
        res.json({ ok: true, sections, ports, ipToBot });
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
        if (!tarFile) return res.status(400).json({ error: 'tar file is required' });

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
        if (!/\.(tar|tar\.gz|tgz)$/i.test(tarFile.originalname)) {
            cleanupUpload(tarFile);
            return res.status(400).json({ error: 'tar filename must end with .tar, .tar.gz, or .tgz' });
        }
        const safeTarName = tarFile.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 200);
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
            addStep('upload-received', { size: tarFile.size, filename: safeTarName });

            addStep('scp-tar-start');
            const fileStream = fs.createReadStream(tarFile.path);
            await writeRemoteFile(
                { ...cfg.opts, useSudo: true, chownTo: 'gor:gor', timeoutMs: 15 * 60 * 1000 },
                `${VDA_REMOTE_BUILD_DIR}/${safeTarName}`,
                fileStream
            );
            addStep('scp-tar-done');

            addStep('patch-group-vars-start');
            const groupVarsText = await readRemoteFile(cfg.opts, VDA_GROUP_VARS_PATH);
            const newGroupVars = updateGroupVars(groupVarsText, {
                vda_remote_version: vdaRemoteVersion,
                emqx_mqtt_host: emqxHost
            });
            await writeRemoteFile({ ...cfg.opts, useSudo: true }, VDA_GROUP_VARS_PATH, newGroupVars);
            addStep('patch-group-vars-done');

            addStep('patch-inventory-start');
            const invText = await readRemoteFile(cfg.opts, VDA_INVENTORY_PATH);
            const newInv = applyMultiSectionActiveIps(invText, selections);
            await writeRemoteFile({ ...cfg.opts, useSudo: true }, VDA_INVENTORY_PATH, newInv);
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
    const botTag = await discoverBotTag(site);
    if (!botTag) return {};
    const j = await influxQuery(site, `SELECT last("vda_version") FROM "${site.measurement}" GROUP BY "${botTag}", "ip"`);
    const series = (j && j.results && j.results[0] && j.results[0].series) || [];
    const map = {};
    for (const s of series) {
        const t = s.tags || {};
        const ip = t.ip;
        const botId = t[botTag];
        if (ip && botId) map[ip] = botId;
    }
    if (Object.keys(map).length === 0) {
        // ip may be a field rather than a tag (e.g. walmartpot). Fall back to one row per bot.
        const j2 = await influxQuery(site, `SELECT last("ip"), last("vda_version") FROM "${site.measurement}" GROUP BY "${botTag}"`);
        const series2 = (j2 && j2.results && j2.results[0] && j2.results[0].series) || [];
        for (const s of series2) {
            const t = s.tags || {};
            const botId = t[botTag];
            const cols = s.columns || [];
            const ipIdx = cols.indexOf('last');
            const row = (s.values && s.values[0]) || [];
            const ip = ipIdx !== -1 ? row[ipIdx] : null;
            if (ip && botId && typeof ip === 'string') map[ip] = botId;
        }
    }
    return map;
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
        let invText, ports;
        try {
            invText = await readRemoteFile(cfg.opts, VDA_INVENTORY_PATH);
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
