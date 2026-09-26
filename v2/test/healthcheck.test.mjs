'use strict';

// Unit tests for lib/healthcheck.js pure logic (no network).
// Run: node --test test/healthcheck.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hc = require('../lib/healthcheck.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T12:00:00Z');

// --- isStale ---------------------------------------------------------------
test('isStale: data exactly at threshold is not stale', () => {
    assert.equal(hc.isStale(NOW - 3 * DAY, 3, NOW), false);
});
test('isStale: data older than threshold is stale', () => {
    assert.equal(hc.isStale(NOW - 3.1 * DAY, 3, NOW), true);
});
test('isStale: fresh data is not stale', () => {
    assert.equal(hc.isStale(NOW - 1 * DAY, 3, NOW), false);
});
test('isStale: no data (null) counts as stale', () => {
    assert.equal(hc.isStale(null, 3, NOW), true);
});

// --- ageInDays -------------------------------------------------------------
test('ageInDays: computes fractional days', () => {
    assert.ok(Math.abs(hc.ageInDays(NOW - 2.5 * DAY, NOW) - 2.5) < 0.001);
});
test('ageInDays: null for no data', () => {
    assert.equal(hc.ageInDays(null, NOW), null);
});

// --- summarize -------------------------------------------------------------
test('summarize: all healthy -> healthy true, no issues', () => {
    const s = hc.summarize([
        { name: 'a', reachable: true, latestMs: NOW - 1 * DAY, staleDays: 3, nowMs: NOW },
        { name: 'b', reachable: true, latestMs: NOW - 2 * DAY, staleDays: 3, nowMs: NOW }
    ], NOW);
    assert.equal(s.healthy, true);
    assert.equal(s.issues.length, 0);
    assert.equal(s.ok, 2);
    assert.equal(s.total, 2);
});

test('summarize: unreachable site flagged as unreachable', () => {
    const s = hc.summarize([
        { name: 'a', reachable: true, latestMs: NOW - 1 * DAY, staleDays: 3, nowMs: NOW },
        { name: 'b', reachable: false, error: 'tcp timeout', staleDays: 3, nowMs: NOW }
    ], NOW);
    assert.equal(s.healthy, false);
    assert.equal(s.unreachable, 1);
    assert.equal(s.issues.length, 1);
    assert.equal(s.issues[0].name, 'b');
    assert.equal(s.issues[0].kind, 'unreachable');
});

test('summarize: stale site flagged as stale', () => {
    const s = hc.summarize([
        { name: 'a', reachable: true, latestMs: NOW - 4 * DAY, staleDays: 3, nowMs: NOW }
    ], NOW);
    assert.equal(s.healthy, false);
    assert.equal(s.stale, 1);
    assert.equal(s.issues[0].kind, 'stale');
    assert.ok(s.issues[0].detail.includes('old'));
});

test('summarize: reachable but no data flagged as no-data (counts as stale)', () => {
    const s = hc.summarize([
        { name: 'a', reachable: true, latestMs: null, rowCount: 0, staleDays: 3, nowMs: NOW }
    ], NOW);
    assert.equal(s.healthy, false);
    assert.equal(s.stale, 1);
    assert.equal(s.issues[0].kind, 'no-data');
});

test('summarize: reachable with no measurement configured is healthy', () => {
    const s = hc.summarize([
        { name: 'a', reachable: true, noMeasurement: true, staleDays: 3, nowMs: NOW }
    ], NOW);
    assert.equal(s.healthy, true);
});

test('summarize: reachable but freshness query failed -> check-failed, not unreachable', () => {
    const s = hc.summarize([
        { name: 'a', reachable: true, probeFailed: true, error: 'query timed out', staleDays: 3, nowMs: NOW }
    ], NOW);
    assert.equal(s.healthy, false);
    assert.equal(s.unreachable, 0, 'must not be counted as unreachable');
    assert.equal(s.checkFailed, 1);
    assert.equal(s.issues[0].kind, 'check-failed');
});

test('normalizeHealthConfig: partial/garbage file falls back to defaults field by field', () => {
    const c = hc.normalizeHealthConfig({ enabled: false, schedule: { time: '99:99' }, staleDays: 'x' });
    assert.equal(c.enabled, false, 'valid field is kept');
    assert.equal(c.schedule.time, '08:00', 'invalid time falls back');
    assert.equal(c.staleDays, hc.DEFAULT_STALE_DAYS, 'non-numeric staleDays falls back');
    assert.deepEqual(c.recipients, { to: [], cc: [], bcc: [] });
});

test('normalizeHealthConfig: null config yields usable defaults', () => {
    const c = hc.normalizeHealthConfig(null);
    assert.equal(c.enabled, true);
    assert.equal(c.schedule.time, '08:00');
    assert.deepEqual(c.schedule.dayOfWeek, [0, 1, 2, 3, 4, 5, 6]);
});

test('validateHealthConfig: accepts a full valid config', () => {
    const r = hc.validateHealthConfig({
        enabled: true,
        staleDays: 5,
        sendWhenAllHealthy: false,
        alertOnNewOutage: true,
        recipients: { to: ['A@greyorange.com'], cc: 'b@x.com, c@x.com', bcc: [] },
        schedule: { time: '07:30', dayOfWeek: [1, 2, 3, 4, 5] }
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.staleDays, 5);
    assert.equal(r.value.schedule.time, '07:30');
    assert.deepEqual(r.value.schedule.dayOfWeek, [1, 2, 3, 4, 5]);
    assert.deepEqual(r.value.recipients.cc, ['b@x.com', 'c@x.com'], 'comma string is split');
    assert.deepEqual(r.value.recipients.to, ['a@greyorange.com'], 'lower-cased and deduped');
});

test('validateHealthConfig: rejects bad email, time, day and range', () => {
    assert.equal(hc.validateHealthConfig({ recipients: { to: ['nope'] } }).ok, false);
    assert.equal(hc.validateHealthConfig({ recipients: { cc: ['a@b'] } }).ok, false);
    assert.equal(hc.validateHealthConfig({ schedule: { time: '25:00' } }).ok, false);
    assert.equal(hc.validateHealthConfig({ schedule: { time: '7:30' } }).ok, false);
    assert.equal(hc.validateHealthConfig({ schedule: { dayOfWeek: [9] } }).ok, false);
    assert.equal(hc.validateHealthConfig({ schedule: { dayOfWeek: [] } }).ok, false);
    assert.equal(hc.validateHealthConfig({ staleDays: 0 }).ok, false);
    assert.equal(hc.validateHealthConfig({ staleDays: 400 }).ok, false);
    assert.equal(hc.validateHealthConfig({ enabled: 'yes' }).ok, false);
    assert.equal(hc.validateHealthConfig({ recipients: 'a@b.com' }).ok, false);
});

// 2026-09-26 is a Saturday (weekday 6).
const SAT_10AM = new Date(2026, 8, 26, 10, 0, 0).getTime();
const SAT_7AM  = new Date(2026, 8, 26, 7, 0, 0).getTime();
const todayKey = (ms) => hc.localDateKey(ms);

test('dueForDailySend: not due before the configured time', () => {
    const r = hc.dueForDailySend({ nowMs: SAT_7AM, schedule: { time: '08:00', dayOfWeek: [0, 1, 2, 3, 4, 5, 6] }, lastSentDate: null });
    assert.equal(r.due, false);
    assert.equal(r.markDate, null);
});

test('dueForDailySend: due once the time has passed and today is unsent', () => {
    const r = hc.dueForDailySend({ nowMs: SAT_10AM, schedule: { time: '08:00', dayOfWeek: [0, 1, 2, 3, 4, 5, 6] }, lastSentDate: null });
    assert.equal(r.due, true);
});

test('dueForDailySend: only once per day', () => {
    const r = hc.dueForDailySend({ nowMs: SAT_10AM, schedule: { time: '08:00', dayOfWeek: [0, 1, 2, 3, 4, 5, 6] }, lastSentDate: todayKey(SAT_10AM) });
    assert.equal(r.due, false);
});

test('dueForDailySend: skips a day not in dayOfWeek but marks it', () => {
    const r = hc.dueForDailySend({ nowMs: SAT_10AM, schedule: { time: '08:00', dayOfWeek: [1, 2, 3, 4, 5] }, lastSentDate: null });
    assert.equal(r.due, false);
    assert.equal(r.markDate, todayKey(SAT_10AM), 'skipped day is recorded so it is not re-evaluated');
});

test('dueForDailySend: a later tick the same day still does not send twice', () => {
    const later = new Date(2026, 8, 26, 23, 30).getTime();
    const r = hc.dueForDailySend({ nowMs: later, schedule: { time: '08:00', dayOfWeek: [0, 1, 2, 3, 4, 5, 6] }, lastSentDate: todayKey(SAT_10AM) });
    assert.equal(r.due, false);
});

test('nextSendAt: today before the time -> today; after -> next allowed day', () => {
    const before = hc.nextSendAt({ nowMs: SAT_7AM, schedule: { time: '08:00', dayOfWeek: [0, 1, 2, 3, 4, 5, 6] } });
    assert.equal(hc.localDateKey(before), todayKey(SAT_7AM));
    assert.equal(new Date(before).getHours(), 8);

    // Saturday 10:00, Mondays only -> next is Monday 08:00
    const after = hc.nextSendAt({ nowMs: SAT_10AM, schedule: { time: '08:00', dayOfWeek: [1] } });
    assert.equal(new Date(after).getDay(), 1);
    assert.equal(new Date(after).getHours(), 8);
    assert.ok(after > SAT_10AM);
});

test('summarize: mixed unreachable + stale', () => {
    const s = hc.summarize([
        { name: 'ok',   reachable: true,  latestMs: NOW - 1 * DAY, staleDays: 3, nowMs: NOW },
        { name: 'down', reachable: false, error: 'refused',      staleDays: 3, nowMs: NOW },
        { name: 'old',  reachable: true,  latestMs: NOW - 5 * DAY, staleDays: 3, nowMs: NOW }
    ], NOW);
    assert.equal(s.healthy, false);
    assert.equal(s.unreachable, 1);
    assert.equal(s.stale, 1);
    assert.equal(s.ok, 1);
    assert.equal(s.total, 3);
});

// --- decideAlert -----------------------------------------------------------
test('decideAlert: healthy -> no send', () => {
    const d = hc.decideAlert({ summary: { healthy: true }, lastSentMs: null, throttleMs: DAY, nowMs: NOW });
    assert.equal(d.send, false);
    assert.equal(d.reason, 'healthy');
});
test('decideAlert: issues and never alerted -> send', () => {
    const d = hc.decideAlert({ summary: { healthy: false }, lastSentMs: null, throttleMs: DAY, nowMs: NOW });
    assert.equal(d.send, true);
    assert.equal(d.reason, 'issues-detected');
});
test('decideAlert: issues within throttle window -> no send', () => {
    const d = hc.decideAlert({ summary: { healthy: false }, lastSentMs: NOW - 3600 * 1000, throttleMs: DAY, nowMs: NOW });
    assert.equal(d.send, false);
    assert.equal(d.reason, 'throttled');
});
test('decideAlert: issues outside throttle window -> re-send', () => {
    const d = hc.decideAlert({ summary: { healthy: false }, lastSentMs: NOW - 2 * DAY, throttleMs: DAY, nowMs: NOW });
    assert.equal(d.send, true);
    assert.equal(d.reason, 'issues-detected');
});
