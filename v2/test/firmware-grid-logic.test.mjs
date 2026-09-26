// Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isFirmwareColumn,
    firmwareColumns,
    prettyFirmwareName,
    buildFirmwareGrid
} from '../public/firmware-grid-logic.js';

// Sample columns matching the meli/RTP (container_*), RELAY/TTP (app_*, vv_*)
// shapes plus the always-present identity/version columns.
const COLUMNS = [
    'time', 'bot_id', 'ip', 'api_version', 'vda_version',
    'container_camera_server_ipu', 'container_quicktron_wrapper', 'container_lidar_driver',
    'app_ros_master', 'app_nav_client',
    'vv_file_version', 'vv_model_name'
];
// 5 rows: 3 bots one version of camera ipu, 2 bots another; one lidar value
// missing entirely; one quicktron dead (string 'dead_bot').
const ROWS = [
    ['t', '42', '10.0.0.1', 'v1', 'v3.22.1_1', '2.0.1', 'v3.22.1_1', '1.4.0', '7.8.0', '2.0', '1.2.3', 'C500'],
    ['t', '43', '10.0.0.2', 'v1', 'v3.22.1_1', '2.0.1', 'v3.22.1_1', '1.4.0', '7.8.0', '2.0', '1.2.3', 'C500'],
    ['t', '44', '10.0.0.3', 'v1', 'v3.22.1_1', '2.0.1', 'v3.22.1_1', null, '7.9.0', '2.1', '1.2.3', 'C500'],
    ['t', '45', '10.0.0.4', 'v1', 'v3.22.1_1', '2.0.2', 'v3.22.1_1', '1.4.0', '7.8.0', '2.0', '1.2.3', 'C500'],
    ['t', '46', '10.0.0.5', 'v1', 'v3.22.1_1', '2.0.2', 'dead_bot', '1.4.0', null, '2.1', '1.2.3', 'C500']
];

test('isFirmwareColumn matches container_/app_/vv_ only', () => {
    assert.equal(isFirmwareColumn('container_camera_server_ipu'), true);
    assert.equal(isFirmwareColumn('app_ros_master'), true);
    assert.equal(isFirmwareColumn('vv_file_version'), true);
    assert.equal(isFirmwareColumn('time'), false);
    assert.equal(isFirmwareColumn('bot_id'), false);
    assert.equal(isFirmwareColumn('vda_version'), false);
    assert.equal(isFirmwareColumn('firmware_configs'), false);
});

test('firmwareColumns returns only the firmware fields, in order', () => {
    assert.deepEqual(firmwareColumns(COLUMNS), [
        'container_camera_server_ipu', 'container_quicktron_wrapper', 'container_lidar_driver',
        'app_ros_master', 'app_nav_client',
        'vv_file_version', 'vv_model_name'
    ]);
});

test('prettyFirmwareName strips prefixes and uppercases acronyms', () => {
    assert.equal(prettyFirmwareName('container_camera_server_ipu'), 'Camera Server IPU');
    assert.equal(prettyFirmwareName('container_quicktron_wrapper'), 'Quicktron Wrapper');
    assert.equal(prettyFirmwareName('app_ros_master'), 'ROS Master');
    assert.equal(prettyFirmwareName('vv_file_version'), 'File Version');
});

test('buildFirmwareGrid counts variants per component, skips null/missing', () => {
    const blocks = buildFirmwareGrid(COLUMNS, ROWS);
    const byCol = new Map(blocks.map(b => [b.col, b]));
    assert.deepEqual([...byCol.keys()], [
        'container_camera_server_ipu', 'container_quicktron_wrapper', 'container_lidar_driver',
        'app_ros_master', 'app_nav_client',
        'vv_file_version', 'vv_model_name'
    ]);

    const cam = byCol.get('container_camera_server_ipu');
    assert.deepEqual(cam.entries, [
        { value: '2.0.1', count: 3 },
        { value: '2.0.2', count: 2 }
    ]);
    assert.equal(cam.totalVariants, 2);
    assert.equal(cam.truncated, 0);
    assert.equal(cam.label, 'Camera Server IPU');

    // null lidar value on bot 44 is skipped, not counted.
    const lidar = byCol.get('container_lidar_driver');
    assert.equal(lidar.entries.length, 1);
    assert.equal(lidar.entries[0].count, 4);

    // 'dead_bot' is still a string value and counts as a variant of the field.
    const qtw = byCol.get('container_quicktron_wrapper');
    assert.equal(qtw.totalVariants, 2);

    const ros = byCol.get('app_ros_master');
    // 4 non-null values, split 3× 7.8.0 and 1× 7.9.0.
    assert.equal(ros.entries[0].count, 3);
    assert.equal(ros.totalVariants, 2);
});

test('buildFirmwareGrid caps entries and reports truncation', () => {
    const manyCols = ['container_x'];
    const manyRows = Array.from({ length: 30 }, (_, i) => [`v${i}`]);
    const blocks = buildFirmwareGrid(manyCols, manyRows, 5);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].entries.length, 5);
    assert.equal(blocks[0].totalVariants, 30);
    assert.equal(blocks[0].truncated, 25);
});

test('buildFirmwareGrid returns nothing when no component has values', () => {
    const blocks = buildFirmwareGrid(['container_x', 'time'], [[null, 't'], [null, 't']]);
    assert.deepEqual(blocks, []);
});