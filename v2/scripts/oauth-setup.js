'use strict';

// One-shot helper to mint a Gmail OAuth2 refresh token.
//
// Run once:  npm run oauth-setup
// Prereq:    GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET must be set in .env
//            (or exported in your shell)
//
// What it does:
//   1. Starts a tiny local HTTP server on 127.0.0.1:8765
//   2. Opens your browser to Google's OAuth consent screen with scope
//      `https://www.googleapis.com/auth/gmail.send` and prompt=consent so the
//      refresh token is guaranteed.
//   3. Receives the redirect, exchanges the code for tokens, writes the
//      refresh token back into .env, and exits.

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ENV_PATH = path.join(__dirname, '..', '.env');
const PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET in .env.');
    console.error('Get them from https://console.cloud.google.com/ → APIs & Services → Credentials → "+ Create credentials" → OAuth client ID → "Desktop app".');
    console.error('Then paste them into .env and run this script again.');
    process.exit(1);
}

const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent'  // forces a refresh_token even on repeat consent
    }).toString();

function openBrowser(url) {
    const cmd = process.platform === 'darwin' ? `open "${url}"`
              : process.platform === 'win32' ? `start "" "${url}"`
              : `xdg-open "${url}"`;
    exec(cmd, () => { /* ignore */ });
}

function writeEnvKey(key, value) {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    const re = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}=${value}`;
    const updated = re.test(raw) ? raw.replace(re, line) : raw.trimEnd() + '\n' + line + '\n';
    fs.writeFileSync(ENV_PATH, updated);
}

async function exchangeCodeForTokens(code) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code'
        }).toString()
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Token exchange failed: ${JSON.stringify(body)}`);
    return body;
}

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, REDIRECT_URI);
    if (u.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
    }
    const code = u.searchParams.get('code');
    const error = u.searchParams.get('error');
    if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Auth error: ${error}`);
        console.error('Auth error:', error);
        server.close();
        process.exit(1);
    }
    if (!code) {
        res.writeHead(400).end('missing code');
        return;
    }
    try {
        const tokens = await exchangeCodeForTokens(code);
        if (!tokens.refresh_token) {
            res.writeHead(500, { 'Content-Type': 'text/html' }).end(
                '<h2>No refresh_token returned</h2>' +
                '<p>This happens if you\'ve already granted consent before. ' +
                'Revoke at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and try again.</p>');
            console.error('\nNo refresh_token returned. Revoke prior access at https://myaccount.google.com/permissions and rerun.');
            server.close();
            process.exit(1);
        }
        writeEnvKey('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(
            '<h2>Success</h2><p>Refresh token written to .env. You can close this tab.</p>');
        console.log('\n✓ Refresh token written to .env (GOOGLE_REFRESH_TOKEN=…)');
        console.log('  Done. The app can now send mail without further prompts.');
        server.close();
        process.exit(0);
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err));
        console.error('Token exchange failed:', err.message);
        server.close();
        process.exit(1);
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('Opening browser for Google consent...');
    console.log('If it does not open automatically, visit:\n  ' + authUrl + '\n');
    openBrowser(authUrl);
});
