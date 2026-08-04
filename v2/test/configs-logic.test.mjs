// Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPath, getSignalParam, getFeaturedSettings, parseInflux, getLatestPerBot } from '../public/configs-logic.js';

const VTM_CONFIG = {
    '/system/nav/config': {
        audio_volume: 0,
        cip_disconnect_detect: true,
        rcs_protocol_type: '3RD_SINGLE',
        update_map_on_startup: 0,
        low_battery_value: 10,
        barrier_params: { obs_error_time: 300, start_motion_delay: 100 },
        side_camera_delta_take: 15
    },
    '/system/nav/signals': [{ name: 'LowPower', params: [0, 10] }],
    '/hardware/basic': { safety_height: 3850, safe_height_descent_height: 3850 }
};

const HTM_CONFIG = {
    '/system/nav/config': {
        detection_and_positioning_before_lifting: false,
        audio_volume: 0,
        cip_disconnect_detect: false,
        follow_acc: 2,
        barrier_params: { obs_error_time: 30, start_motion_delay: 150 }
    },
    '/system/nav/signals': [{ name: 'LowPower', params: [0, 10] }],
    '/hardware/basic': { limit_speed: 4.5, limit_acc_speed: 2.0 }
};

test('getPath walks nested objects and returns undefined on a missing branch', () => {
    assert.equal(getPath(VTM_CONFIG, ['/system/nav/config', 'audio_volume']), 0);
    assert.equal(getPath(VTM_CONFIG, ['/system/nav/config', 'barrier_params', 'obs_error_time']), 300);
    assert.equal(getPath(VTM_CONFIG, ['/hardware/basic', 'limit_speed']), undefined);
    assert.equal(getPath(VTM_CONFIG, ['/does/not/exist', 'x']), undefined);
});

test('getPath does not throw when a value along the path is not an object', () => {
    assert.equal(getPath({ a: 5 }, ['a', 'b']), undefined);
    assert.equal(getPath(null, ['a']), undefined);
});

test('getSignalParam finds the entry by name and reads the param index', () => {
    assert.equal(getSignalParam(VTM_CONFIG, 'LowPower', 1), 10);
    assert.equal(getSignalParam(VTM_CONFIG, 'LowPower', 0), 0);
    assert.equal(getSignalParam(VTM_CONFIG, 'NoSuchSignal', 1), undefined);
});

test('getSignalParam is safe against a missing/malformed signals list', () => {
    assert.equal(getSignalParam({}, 'LowPower', 1), undefined);
    assert.equal(getSignalParam({ '/system/nav/signals': 'not-an-array' }, 'LowPower', 1), undefined);
    assert.equal(getSignalParam({ '/system/nav/signals': [{ name: 'LowPower' }] }, 'LowPower', 1), undefined);
});

test('getFeaturedSettings only includes rows whose path resolves for VTM', () => {
    const rows = getFeaturedSettings(VTM_CONFIG);
    const labels = rows.map(r => r.label);
    assert.ok(labels.includes('Side camera delta take'));
    assert.ok(labels.includes('Safety height'));
    assert.ok(!labels.includes('Limit speed'), 'HTM-only field leaked into a VTM config');
    assert.ok(!labels.includes('Follow acceleration'), 'HTM-only field leaked into a VTM config');
    assert.equal(rows.find(r => r.label === 'LowPower signal threshold').value, 10);
});

test('getFeaturedSettings only includes rows whose path resolves for HTM', () => {
    const rows = getFeaturedSettings(HTM_CONFIG);
    const labels = rows.map(r => r.label);
    assert.ok(labels.includes('Limit speed'));
    assert.ok(labels.includes('Follow acceleration'));
    assert.ok(!labels.includes('Safety height'), 'VTM-only field leaked into an HTM config');
    assert.ok(!labels.includes('Side camera delta take'), 'VTM-only field leaked into an HTM config');
});

test('getFeaturedSettings returns nothing for an empty config', () => {
    assert.deepEqual(getFeaturedSettings({}), []);
});

test('parseInflux extracts columns/rows from a healthy InfluxDB response', () => {
    const result = {
        results: [{ statement_id: 0, series: [{ columns: ['time', 'ip'], values: [['t1', '1.2.3.4']] }] }]
    };
    assert.deepEqual(parseInflux(result), { columns: ['time', 'ip'], rows: [['t1', '1.2.3.4']] });
});

test('parseInflux surfaces an InfluxDB-reported error instead of throwing', () => {
    const result = { results: [{ statement_id: 0, error: 'database not found' }] };
    assert.equal(parseInflux(result).error, 'database not found');
});

test('parseInflux handles an empty series (no matching rows) without throwing', () => {
    assert.deepEqual(parseInflux({ results: [{ statement_id: 0 }] }), { columns: [], rows: [] });
    assert.deepEqual(parseInflux(null), { columns: [], rows: [] });
});

test('getLatestPerBot keeps only the first (most recent) row per ip', () => {
    const columns = ['time', 'ip', 'firmware_configs'];
    const rows = [
        ['t2', '1.1.1.1', 'newest-for-1.1.1.1'],
        ['t1', '1.1.1.1', 'older-for-1.1.1.1'],
        ['t2', '2.2.2.2', 'only-row-for-2.2.2.2']
    ];
    const latest = getLatestPerBot(columns, rows);
    assert.equal(latest.length, 2);
    assert.equal(latest.find(r => r[1] === '1.1.1.1')[2], 'newest-for-1.1.1.1');
});

test('getLatestPerBot returns nothing when the dataset has no ip column', () => {
    assert.deepEqual(getLatestPerBot(['time', 'value'], [['t1', 5]]), []);
});
