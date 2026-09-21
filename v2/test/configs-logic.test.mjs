// Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPath, getSignalParam, getFeaturedSettings, getFeaturedValueMap, getBotModel, findComplianceValue, configValuesEqual, getConfigCompliance, parseGroupedByBot, parseInflux, parseSingleBotValue } from '../public/configs-logic.js';

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

test('getFeaturedValueMap returns one label->value entry per present field', () => {
    const map = getFeaturedValueMap(VTM_CONFIG);
    assert.equal(map.get('Side camera delta take'), 15);
    assert.equal(map.get('Safety height'), 3850);
    assert.equal(map.get('Audio volume'), 0);
    assert.equal(map.get('Limit speed'), undefined, 'absent fields have no entry');
    assert.equal(map.size, 11);
});

test('getFeaturedValueMap is empty for an empty config', () => {
    assert.equal(getFeaturedValueMap({}).size, 0);
});

test('getBotModel recognises VTM-only vs HTM-only config keys', () => {
    assert.equal(getBotModel(VTM_CONFIG), 'VTM');
    assert.equal(getBotModel(HTM_CONFIG), 'HTM');
});

test('getBotModel returns null when the config is empty or ambiguous', () => {
    assert.equal(getBotModel({}), null);
    assert.equal(getBotModel(null), null);
    assert.equal(getBotModel({ '/hardware/basic': { limit_speed: 4.5, safety_height: 3850 } }), null);
});

test('parseGroupedByBot extracts multiple aliases in a single response', () => {
    const result = {
        results: [{
            statement_id: 0,
            series: [
                { name: 'm', tags: { bot_id: '180', ip: '10.0.0.1' }, columns: ['time', 'bot_status', 'vda_version'], values: [['t1', 'ready', 'v3.2.0']] },
                { name: 'm', tags: { bot_id: '188', ip: '10.0.0.2' }, columns: ['time', 'bot_status', 'vda_version'], values: [['t2', 'processing', 'v3.1.0']] }
            ]
        }]
    };
    const parsed = parseGroupedByBot(result, ['bot_status', 'vda_version']);
    assert.deepEqual(parsed.columns, ['ip', 'bot_id', 'bot_status', 'vda_version']);
    assert.deepEqual(parsed.rows, [
        ['10.0.0.1', '180', 'ready', 'v3.2.0'],
        ['10.0.0.2', '188', 'processing', 'v3.1.0']
    ]);
});

test('parseGroupedByBot fills null for aliases missing from a series', () => {
    const result = {
        results: [{
            statement_id: 0,
            series: [
                { name: 'm', tags: { bot_id: '180', ip: '10.0.0.1' }, columns: ['time', 'bot_status'], values: [['t1', 'ready']] }
            ]
        }]
    };
    const parsed = parseGroupedByBot(result, ['bot_status', 'vda_version']);
    assert.deepEqual(parsed.rows, [['10.0.0.1', '180', 'ready', null]]);
});

test('parseGroupedByBot extracts one row per series with its tags and last() value', () => {
    const result = {
        results: [{
            statement_id: 0,
            series: [
                { name: 'm', tags: { bot_id: '180', ip: '10.0.0.1' }, columns: ['time', 'bot_status'], values: [['t1', 'ready']] },
                { name: 'm', tags: { bot_id: '188', ip: '10.0.0.2' }, columns: ['time', 'bot_status'], values: [['t2', 'processing']] }
            ]
        }]
    };
    const parsed = parseGroupedByBot(result, 'bot_status');
    assert.deepEqual(parsed.columns, ['ip', 'bot_id', 'bot_status']);
    assert.deepEqual(parsed.rows, [
        ['10.0.0.1', '180', 'ready'],
        ['10.0.0.2', '188', 'processing']
    ]);
});

test('parseGroupedByBot surfaces an InfluxDB-reported error instead of throwing', () => {
    const result = { results: [{ statement_id: 0, error: 'database not found' }] };
    assert.equal(parseGroupedByBot(result, 'bot_status').error, 'database not found');
});

test('parseGroupedByBot returns no rows when there are no matching series', () => {
    assert.deepEqual(parseGroupedByBot({ results: [{ statement_id: 0 }] }, 'bot_status').rows, []);
    assert.deepEqual(parseGroupedByBot(null, 'bot_status').rows, []);
});

test('parseSingleBotValue reads the value out of a single-series response', () => {
    const result = {
        results: [{ statement_id: 0, series: [{ columns: ['time', 'firmware_configs'], values: [['t1', 'the-config-blob']] }] }]
    };
    assert.equal(parseSingleBotValue(result), 'the-config-blob');
});

test('parseSingleBotValue returns null when the bot has no matching series', () => {
    assert.equal(parseSingleBotValue({ results: [{ statement_id: 0 }] }), null);
    assert.equal(parseSingleBotValue(null), null);
});

test('parseSingleBotValue throws on an InfluxDB-reported error', () => {
    const result = { results: [{ statement_id: 0, error: 'measurement not found' }] };
    assert.throws(() => parseSingleBotValue(result), /measurement not found/);
});

test('parseInflux returns columns and all rows of the first series', () => {
    const result = {
        results: [{ statement_id: 0, series: [{ columns: ['time', 'api_version', 'vda_version'], values: [['t1', 'v3.2.0', 'v3.2.0'], ['t2', 'v3.1.0', 'v3.1.0']] }] }]
    };
    assert.deepEqual(parseInflux(result), {
        columns: ['time', 'api_version', 'vda_version'],
        rows: [['t1', 'v3.2.0', 'v3.2.0'], ['t2', 'v3.1.0', 'v3.1.0']]
    });
});

test('parseInflux is empty-safe and surfaces errors', () => {
    assert.deepEqual(parseInflux(null), { columns: [], rows: [] });
    assert.deepEqual(parseInflux({ results: [{ statement_id: 0 }] }), { columns: [], rows: [] });
    assert.equal(parseInflux({ results: [{ statement_id: 0, error: 'nope' }] }).error, 'nope');
});

test('configValuesEqual treats numerically-equal values as a match', () => {
    assert.equal(configValuesEqual(2, '2.0'), true);
    assert.equal(configValuesEqual('4.5', 4.5), true);
    assert.equal(configValuesEqual(true, 'true'), true);
    assert.equal(configValuesEqual(4.5, '6.0'), false);
    assert.equal(configValuesEqual('v3.2.0', 'v3.2.0'), true);
    assert.equal(configValuesEqual('v3.2.0', 'v3.1.0'), false);
    assert.equal(configValuesEqual(null, '1'), false);
    assert.equal(configValuesEqual('', '0'), false);
});

test('findComplianceValue looks up a setting by its config key or label', () => {
    const cols = ['time', 'api_version', 'limit_speed', 'Safety height'];
    const row = ['t1', 'v3.2.0', '4.5', '3850'];
    const limitSpeed = { label: 'Limit speed', key: 'limit_speed' };
    const safety = { label: 'Safety height', key: 'safety_height' };
    assert.equal(findComplianceValue(cols, row, limitSpeed), '4.5');
    assert.equal(findComplianceValue(cols, row, safety), '3850');  // by label fallback
    assert.equal(findComplianceValue(cols, row, { label: 'Side camera delta take', key: 'side_camera_delta_take' }), undefined);
    assert.equal(findComplianceValue(null, row, limitSpeed), undefined);
    assert.equal(findComplianceValue(cols, null, limitSpeed), undefined);
});

test('getConfigCompliance matches a bot config against expected values', () => {
    const features = getFeaturedValueMap(HTM_CONFIG);  // limit_speed 4.5, follow_acc 2, ...
    const cols = ['time', 'api_version', 'limit_speed', 'limit_acc_speed', 'follow_acc'];
    const row = ['t1', 'v3.2.0', '4.5', '2.0', '2'];
    const { matched, diffs } = getConfigCompliance(features, cols, row);
    assert.equal(matched, 3);
    assert.deepEqual(diffs, []);
});

test('getConfigCompliance reports settings that differ and skips unmatched ones', () => {
    const features = getFeaturedValueMap(HTM_CONFIG);  // limit_speed 4.5
    const cols = ['time', 'api_version', 'limit_speed', 'safety_height'];
    const row = ['t1', 'v3.2.0', '6.0', '3850'];
    const { matched, diffs } = getConfigCompliance(features, cols, row);
    assert.equal(matched, 1);                                   // safety_height: bot has none
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].label, 'Limit speed');
    assert.equal(diffs[0].actual, 4.5);
    assert.equal(diffs[0].expected, '6.0');
});

test('getConfigCompliance ignores settings with no recorded expectation', () => {
    const features = getFeaturedValueMap(VTM_CONFIG);
    const { matched, diffs } = getConfigCompliance(features, ['time', 'api_version'], ['t1', 'v3.2.0']);
    assert.equal(matched, 0);
    assert.deepEqual(diffs, []);
});
