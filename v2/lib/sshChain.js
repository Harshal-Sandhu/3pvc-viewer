'use strict';

const { Client } = require('ssh2');

function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function buildMiddleCmd({ command, butlerIp, targetIp, gorPassword, gorUser = 'gor' }) {
    const { JUMPER_KEY_PATH, BUTLER_USER } = process.env;
    const innerCmd = `SSHPASS=${shellQuote(gorPassword)} sshpass -e `
        + `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 `
        + `${gorUser}@${targetIp} ${shellQuote(command)}`;
    return `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 `
        + `-i ${shellQuote(JUMPER_KEY_PATH)} `
        + `${BUTLER_USER}@${butlerIp} `
        + shellQuote(innerCmd);
}

function preflightEnv() {
    const missing = ['JUMPER_HOST', 'JUMPER_USER', 'JUMPER_PASSWORD', 'JUMPER_KEY_PATH', 'BUTLER_USER']
        .filter(k => !process.env[k]);
    if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
}

function preflightSite({ butlerIp, targetIp, gorPassword }) {
    if (!butlerIp || !targetIp || !gorPassword) {
        throw new Error('Site missing butlerIp / targetIp / gorPassword');
    }
}

function connectJumper() {
    const { JUMPER_HOST, JUMPER_USER, JUMPER_PASSWORD } = process.env;
    return new Promise((resolve, reject) => {
        const conn = new Client();
        let settled = false;
        conn.on('ready', () => {
            if (settled) return;
            settled = true;
            resolve(conn);
        });
        conn.on('error', err => {
            if (settled) return;
            settled = true;
            reject(err);
        });
        conn.connect({
            host: JUMPER_HOST,
            port: 22,
            username: JUMPER_USER,
            password: JUMPER_PASSWORD,
            readyTimeout: 10000,
            keepaliveInterval: 10000,
            tryKeyboard: false
        });
    });
}

function execOnce(conn, cmd, { inputStream, timeoutMs }) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(arg);
        };
        const timer = setTimeout(() => {
            finish(reject, new Error(`SSH chain timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        conn.exec(cmd, (err, stream) => {
            if (err) return finish(reject, err);
            stream.on('data', d => { stdout += d.toString(); });
            stream.stderr.on('data', d => { stderr += d.toString(); });
            stream.on('close', (code) => finish(resolve, { code, stdout, stderr }));
            if (inputStream) {
                inputStream.on('error', e => finish(reject, e));
                inputStream.pipe(stream);
            } else {
                stream.end();
            }
        });
    });
}

function debugOps(...args) {
    console.error('[ops]', new Date().toISOString(), ...args);
}

async function runOnSiteServer(opts) {
    preflightEnv();
    preflightSite(opts);
    if (!opts.command) throw new Error('command is required');
    const timeoutMs = Number(opts.timeoutMs || process.env.SSH_TIMEOUT_MS || 60000);
    debugOps('exec start', { butlerIp: opts.butlerIp, targetIp: opts.targetIp, command: opts.command, timeoutMs });
    const cmd = buildMiddleCmd(opts);
    const conn = await connectJumper();
    try {
        const result = await execOnce(conn, cmd, { timeoutMs });
        debugOps('exec done', {
            code: result.code,
            stdoutLen: result.stdout.length,
            stderrLen: result.stderr.length,
            stderrHead: result.stderr.slice(0, 200)
        });
        return result;
    } catch (err) {
        debugOps('exec error', { error: err.message });
        throw err;
    } finally {
        try { conn.end(); } catch (_) { /* ignore */ }
        debugOps('chain-closed', { butlerIp: opts.butlerIp, targetIp: opts.targetIp });
    }
}

// Run `cat <path>` on target, return stdout (the file contents).
async function readRemoteFile(opts, remotePath) {
    debugOps('readRemoteFile', { remotePath });
    const result = await runOnSiteServer({
        ...opts,
        command: `cat ${shellQuote(remotePath)}`
    });
    if (result.code !== 0) {
        const err = new Error(`Read failed (exit ${result.code}): ${result.stderr.trim() || 'unknown error'}`);
        err.code = result.code;
        throw err;
    }
    return result.stdout;
}

// Pipe `content` (Buffer/string/stream) to `cat > <path>` on target.
// Pass opts.useSudo=true to wrap with `sudo tee` for paths gor can't write directly.
async function writeRemoteFile(opts, remotePath, content) {
    preflightEnv();
    preflightSite(opts);
    const timeoutMs = Number(opts.timeoutMs || process.env.SSH_TIMEOUT_MS || 60000);
    const isStream = content && typeof content.pipe === 'function';
    debugOps('writeRemoteFile', { remotePath, isStream, useSudo: !!opts.useSudo, size: isStream ? '(stream)' : (content ? content.length : 0) });
    let writeCmd;
    if (opts.useSudo) {
        const chownPart = opts.chownTo
            ? ` && sudo -n chown ${shellQuote(opts.chownTo)} ${shellQuote(remotePath)}`
            : '';
        writeCmd = `sudo -n tee ${shellQuote(remotePath)} > /dev/null${chownPart}`;
    } else {
        writeCmd = `cat > ${shellQuote(remotePath)}`;
    }
    const cmd = buildMiddleCmd({ ...opts, command: writeCmd });
    const conn = await connectJumper();
    try {
        let inputStream;
        if (content && typeof content.pipe === 'function') {
            inputStream = content;
        } else {
            const { Readable } = require('stream');
            inputStream = Readable.from(content || '');
        }
        const result = await execOnce(conn, cmd, { inputStream, timeoutMs });
        if (result.code !== 0) {
            const err = new Error(`Write failed (exit ${result.code}): ${result.stderr.trim() || 'unknown error'}`);
            err.code = result.code;
            throw err;
        }
        return result;
    } finally {
        try { conn.end(); } catch (_) { /* ignore */ }
        debugOps('chain-closed', { butlerIp: opts.butlerIp, targetIp: opts.targetIp, remotePath });
    }
}

// Run a shell command on an individual bot reached via the site server:
//   v2 -> jumper -> butler -> site server -> bot (gor@<botIp>:<botPort>)
// Re-uses opts.gorPassword as the bot password (same shared default).
async function runOnBot(opts, { botIp, botPort = 22, command, botUser = 'gor', timeoutMs } = {}) {
    if (!botIp) throw new Error('botIp is required');
    if (!command) throw new Error('command is required');
    const inner = `SSHPASS=${shellQuote(opts.gorPassword)} sshpass -e `
        + `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 `
        + `-p ${botPort} ${botUser}@${botIp} ${shellQuote(command)}`;
    return runOnSiteServer({ ...opts, command: inner, timeoutMs });
}

module.exports = { runOnSiteServer, runOnBot, readRemoteFile, writeRemoteFile };
