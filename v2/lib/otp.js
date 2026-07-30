'use strict';

// In-memory one-time-code store for email-based login (greyorange.com only).
// Single-process, single-use, short-TTL — consistent with this app's existing
// in-memory session store (a server restart already logs everyone out; this
// doesn't add a new class of problem).

const crypto = require('crypto');

const CODE_TTL_MS = 5 * 60 * 1000;    // 5 minutes
const RESEND_COOLDOWN_MS = 30 * 1000; // 30s between sends to the same email
const MAX_ATTEMPTS = 5;
const HOURLY_CAP = 5;                 // max requests/hour per email
const HOUR_MS = 60 * 60 * 1000;

const codes = new Map();      // email -> { code, expiresAt, attempts }
const requestLog = new Map(); // email -> { lastSentAt, timestamps: number[] }

const DOMAIN_RE = /^[^\s@]+@greyorange\.com$/i;

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function isAllowedEmail(email) {
    return DOMAIN_RE.test(String(email || '').trim());
}

// Reserves a request slot and mints a code. Returns { ok: true, email, code }
// or { ok: false, error }. The caller sends `code` by email — nothing here
// touches email delivery.
function beginRequest(emailRaw) {
    const email = normalizeEmail(emailRaw);
    if (!isAllowedEmail(email)) {
        return { ok: false, error: 'Only greyorange.com email addresses are allowed' };
    }
    const now = Date.now();
    const log = requestLog.get(email) || { lastSentAt: 0, timestamps: [] };
    if (now - log.lastSentAt < RESEND_COOLDOWN_MS) {
        return { ok: false, error: 'Please wait before requesting another code' };
    }
    log.timestamps = log.timestamps.filter(ts => now - ts < HOUR_MS);
    if (log.timestamps.length >= HOURLY_CAP) {
        return { ok: false, error: 'Too many codes requested for this email — try again later' };
    }
    // Reserve the slot before the (async) email send happens, so a rapid
    // double-click can't race past the cooldown check.
    log.lastSentAt = now;
    log.timestamps.push(now);
    requestLog.set(email, log);

    const code = String(crypto.randomInt(100000, 1000000));
    codes.set(email, { code, expiresAt: now + CODE_TTL_MS, attempts: 0 });
    return { ok: true, email, code };
}

// Returns { ok: true, email } or { ok: false, error }.
function verify(emailRaw, codeRaw) {
    const email = normalizeEmail(emailRaw);
    const code = String(codeRaw || '').trim();
    const entry = codes.get(email);
    if (!entry || Date.now() > entry.expiresAt) {
        codes.delete(email);
        return { ok: false, error: 'Invalid or expired code' };
    }
    if (entry.code !== code) {
        entry.attempts += 1;
        if (entry.attempts >= MAX_ATTEMPTS) codes.delete(email);
        return { ok: false, error: 'Invalid or expired code' };
    }
    codes.delete(email); // single-use
    return { ok: true, email };
}

module.exports = { isAllowedEmail, beginRequest, verify };
