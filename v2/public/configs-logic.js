// Pure, DOM-free logic for the Configs page — split out from configs.js so it
// can be unit tested directly under Node (configs.js itself can't be
// imported outside a browser since it touches `document` at module load).

export function getPath(obj, path) {
    let cur = obj;
    for (const key of path) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[key];
    }
    return cur;
}

// /system/nav/signals is a list of {name, params}; pull params[index] from
// the entry whose name matches (e.g. the "LowPower" signal).
export function getSignalParam(cfg, signalName, index) {
    const list = cfg && cfg['/system/nav/signals'];
    if (!Array.isArray(list)) return undefined;
    const entry = list.find((e) => e && e.name === signalName);
    if (!entry || entry.params == null) return undefined;
    return entry.params[index];
}

// Curated settings shown as columns on the Configs page. Each row records
// `key` -- the name the setting is stored under in the bot's firmware config
// (and therefore the natural column name for an admin to copy when filling
// expected values into the site's compliance measurement). The compliance
// matcher accepts EITHER the key or the human label as the expectation column.
export const FEATURED_FIELDS = [
    { label: 'Audio volume', key: 'audio_volume', path: ['/system/nav/config', 'audio_volume'] },
    { label: 'CIP disconnect detect', key: 'cip_disconnect_detect', path: ['/system/nav/config', 'cip_disconnect_detect'] },
    { label: 'Mute CIP disconnect', key: 'mute_cip_disconnect', path: ['/system/nav/config', 'mute_cip_disconnect'] },
    { label: 'RCS protocol type', key: 'rcs_protocol_type', path: ['/system/nav/config', 'rcs_protocol_type'] },
    { label: 'Update map on startup', key: 'update_map_on_startup', path: ['/system/nav/config', 'update_map_on_startup'] },
    { label: 'Low battery value', key: 'low_battery_value', path: ['/system/nav/config', 'low_battery_value'] },
    { label: 'AGV idle time check', key: 'agv_idle_time_check', path: ['/system/nav/config', 'agv_idle_time_check'] },
    { label: 'Side camera delta take', key: 'side_camera_delta_take', path: ['/system/nav/config', 'side_camera_delta_take'] },
    { label: 'Barrier obstacle error time', key: 'obs_error_time', path: ['/system/nav/config', 'barrier_params', 'obs_error_time'] },
    { label: 'Barrier start motion delay', key: 'start_motion_delay', path: ['/system/nav/config', 'barrier_params', 'start_motion_delay'] },
    { label: 'Detection before lifting', key: 'detection_and_positioning_before_lifting', path: ['/system/nav/config', 'detection_and_positioning_before_lifting'] },
    { label: 'Detection before rotate', key: 'detection_and_positioning_before_rotate', path: ['/system/nav/config', 'detection_and_positioning_before_rotate'] },
    { label: 'Detection before target', key: 'detection_and_positioning_before_target', path: ['/system/nav/config', 'detection_and_positioning_before_target'] },
    { label: 'Follow acceleration', key: 'follow_acc', path: ['/system/nav/config', 'follow_acc'] },
    { label: 'Follow max velocity', key: 'follow_max_vel', path: ['/system/nav/config', 'follow_max_vel'] },
    { label: 'Follow position tolerance', key: 'follow_pos_tolerance', path: ['/system/nav/config', 'follow_pos_tolerance'] },
    { label: 'Follow sleep time', key: 'follow_sleep_time', path: ['/system/nav/config', 'follow_sleep_time'] },
    { label: 'Follow stay distance', key: 'follow_stay_distance', path: ['/system/nav/config', 'follow_stay_distance'] },
    { label: 'Load soft stop deceleration', key: 'load_soft_stop_dec', path: ['/system/nav/config', 'load_soft_stop_dec'] },
    { label: 'No-load soft stop deceleration', key: 'noload_soft_stop_dec', path: ['/system/nav/config', 'noload_soft_stop_dec'] },
    { label: 'LowPower signal threshold', key: 'signal_low_power_threshold', get: (cfg) => getSignalParam(cfg, 'LowPower', 1) },
    { label: 'Safety height', key: 'safety_height', path: ['/hardware/basic', 'safety_height'] },
    { label: 'Safe height descent height', key: 'safe_height_descent_height', path: ['/hardware/basic', 'safe_height_descent_height'] },
    { label: 'Limit speed', key: 'limit_speed', path: ['/hardware/basic', 'limit_speed'] },
    { label: 'Limit acceleration speed', key: 'limit_acc_speed', path: ['/hardware/basic', 'limit_acc_speed'] }
];

export function getFeaturedSettings(cfg) {
    const rows = [];
    for (const field of FEATURED_FIELDS) {
        const value = field.get ? field.get(cfg) : getPath(cfg, field.path);
        if (value !== undefined) rows.push({ label: field.label, value });
    }
    return rows;
}

// Label -> value map of every featured setting present in the config, for
// driving the bot-per-row grid (one column per field label). Absent settings
// simply produce no entry, so the cell renders as a blank.
export function getFeaturedValueMap(cfg) {
    const map = new Map();
    for (const { label, value } of getFeaturedSettings(cfg)) {
        map.set(label, value);
    }
    return map;
}

// Best-effort bot hardware model, inferred from which config keys are present.
// VTM and HTM bots populate different subsets of /system/nav/config and
// /hardware/basic (the FEATURED_FIELDS taxonomy), so a bot whose config has
// HTM-only keys but no VTM-only keys (and vice versa) is identified without
// needing a dedicated model tag.
export function getBotModel(cfg) {
    if (!cfg || typeof cfg !== 'object') return null;
    const nav = cfg['/system/nav/config'];
    const hard = cfg['/hardware/basic'];
    const has = (obj, key) => obj != null && typeof obj === 'object' && key in obj;
    let vtm = 0;
    let htm = 0;
    if (has(nav, 'side_camera_delta_take')) vtm += 1;
    if (has(hard, 'safety_height')) vtm += 1;
    if (has(hard, 'safe_height_descent_height')) vtm += 1;
    if (has(hard, 'limit_speed')) htm += 1;
    if (has(hard, 'limit_acc_speed')) htm += 1;
    if (has(nav, 'follow_acc') || has(nav, 'follow_max_vel')) htm += 1;
    if (vtm > htm) return 'VTM';
    if (htm > vtm) return 'HTM';
    return null;
}

// Parses an InfluxDB response shaped by `SELECT last(<field>) AS <fieldAlias>
// ... GROUP BY bot_id,ip` -- one series per bot, each with a single [time,
// value...] row. GROUP BY's last() only ever considers points where that field
// was actually written, so a stale/duplicate ingestion job writing a point
// without the field is naturally skipped server-side -- no JS-side "find the
// latest non-null" dedup needed, and no need to transfer more than one row
// per bot regardless of how large that field's value is.
//
// `fieldAlias` may be a single alias (kept for backwards compatibility) or an
// array of aliases; every alias present in the series is emitted as a column
// (missing ones come back null).
export function parseGroupedByBot(result, fieldAlias) {
    const aliases = Array.isArray(fieldAlias) ? fieldAlias : [fieldAlias];
    const columns = ['ip', 'bot_id', ...aliases];
    if (!result || !result.results || !result.results[0]) return { columns, rows: [] };
    const r0 = result.results[0];
    if (r0.error) return { error: r0.error, columns: [], rows: [] };
    const rows = (r0.series || []).map((s) => {
        const tags = s.tags || {};
        const valueRow = (s.values && s.values[0]) || [];
        const out = [tags.ip ?? null, tags.bot_id ?? null];
        for (const alias of aliases) {
            const idx = s.columns.indexOf(alias);
            out.push(idx >= 0 && idx < valueRow.length ? valueRow[idx] : null);
        }
        return out;
    });
    return { columns, rows };
}

// Parses a single-series SELECT result into { columns, rows }. Used for the
// compliance lookup table on the configs page (mirrors the viewer's parser).
export function parseInflux(result) {
    if (!result || !result.results || !result.results[0]) return { columns: [], rows: [] };
    const r0 = result.results[0];
    if (r0.error) return { error: r0.error, columns: [], rows: [] };
    if (!r0.series || !r0.series[0]) return { columns: [], rows: [] };
    const s = r0.series[0];
    return { columns: s.columns || [], rows: s.values || [] };
}

// Expected value for a featured setting, looked up in a compliance row. A
// compliance column may be named after the config key (e.g. `limit_speed`) or
// the human label (e.g. `Limit speed`) -- whichever matches first wins.
export function findComplianceValue(columns, row, field) {
    if (!columns || !row) return undefined;
    const at = (name) => {
        const i = columns.indexOf(name);
        return i >= 0 && i < row.length ? row[i] : undefined;
    };
    if (field.key) {
        const byKey = at(field.key);
        if (byKey !== undefined) return byKey;
    }
    return at(field.label);
}

// Compares an actual config value against an expected compliance value.
// Numbers are compared numerically so "2" never false-alarms against "2.0"
// (config JSON collapses 2.0 -> 2); anything non-numeric falls back to a
// trimmed string compare.
export function configValuesEqual(actual, expected) {
    const aNum = Number(actual);
    const eNum = Number(expected);
    const aIsNumeric = actual != null && String(actual).trim() !== '' && !Number.isNaN(aNum);
    const eIsNumeric = expected != null && String(expected).trim() !== '' && !Number.isNaN(eNum);
    if (aIsNumeric && eIsNumeric) return aNum === eNum;
    return String(actual).trim() === String(expected).trim();
}

// Diffs a bot's featured config values against a compliance row (the admin's
// "expected" record). Only settings the bot actually has are considered.
// Returns { matched, diffs } where diffs = [{ label, actual, expected }].
export function getConfigCompliance(features, columns, row) {
    const diffs = [];
    let matched = 0;
    for (const field of FEATURED_FIELDS) {
        const actual = features.get(field.label);
        if (actual === undefined) continue;             // bot has no such setting
        const expected = findComplianceValue(columns, row, field);
        if (expected === undefined) continue;           // no expectation recorded
        matched += 1;
        if (!configValuesEqual(actual, expected)) {
            diffs.push({ label: field.label, actual, expected });
        }
    }
    return { matched, diffs };
}

// Parses `SELECT last(<field>) AS <fieldAlias> ... WHERE bot_id = '...'`
// (no GROUP BY -- a single bot's value, fetched on demand). Returns just the
// value, or null if that bot has never had the field recorded.
export function parseSingleBotValue(result) {
    if (!result || !result.results || !result.results[0]) return null;
    const r0 = result.results[0];
    if (r0.error) throw new Error(r0.error);
    const series = r0.series;
    const valueRow = series && series[0] && series[0].values && series[0].values[0];
    return valueRow && valueRow.length > 1 ? valueRow[1] : null;
}
