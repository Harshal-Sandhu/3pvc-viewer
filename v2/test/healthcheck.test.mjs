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
