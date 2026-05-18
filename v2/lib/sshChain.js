'use strict';

const { Client } = require('ssh2');

function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function runOnSiteServer({ command, butlerIp, targetIp, gorPassword, gorUser = 'gor' }) {
    const {
        JUMPER_HOST,
        JUMPER_USER,
        JUMPER_PASSWORD,
        JUMPER_KEY_PATH,
        BUTLER_USER,
        SSH_TIMEOUT_MS = '60000'
    } = process.env;

    const missingEnv = ['JUMPER_HOST', 'JUMPER_USER', 'JUMPER_PASSWORD', 'JUMPER_KEY_PATH', 'BUTLER_USER']
        .filter(k => !process.env[k]);
    if (missingEnv.length) {
        return Promise.reject(new Error(`Missing env vars: ${missingEnv.join(', ')}`));
    }
    if (!butlerIp || !targetIp || !gorPassword) {
        return Promise.reject(new Error('Site missing butlerIp / targetIp / gorPassword'));
    }
    if (!command) {
        return Promise.reject(new Error('command is required'));
    }

    const innerCmd = `SSHPASS=${shellQuote(gorPassword)} sshpass -e `
        + `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 `
        + `${gorUser}@${targetIp} ${shellQuote(command)}`;

    const middleCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 `
        + `-i ${shellQuote(JUMPER_KEY_PATH)} `
        + `${BUTLER_USER}@${butlerIp} `
        + shellQuote(innerCmd);

    return new Promise((resolve, reject) => {
        const conn = new Client();
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { conn.end(); } catch (_) { /* ignore */ }
            fn(arg);
        };
        const timer = setTimeout(() => {
            finish(reject, new Error(`SSH chain timed out after ${SSH_TIMEOUT_MS}ms`));
        }, Number(SSH_TIMEOUT_MS));

        conn.on('ready', () => {
            conn.exec(middleCmd, (err, stream) => {
                if (err) return finish(reject, err);
                stream.on('data', d => { stdout += d.toString(); });
                stream.stderr.on('data', d => { stderr += d.toString(); });
                stream.on('close', (code) => {
                    finish(resolve, { code, stdout, stderr });
                });
            });
        });
        conn.on('error', err => finish(reject, err));
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

module.exports = { runOnSiteServer };
