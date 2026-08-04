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

export const FEATURED_FIELDS = [
    { label: 'Audio volume', path: ['/system/nav/config', 'audio_volume'] },
    { label: 'CIP disconnect detect', path: ['/system/nav/config', 'cip_disconnect_detect'] },
    { label: 'Mute CIP disconnect', path: ['/system/nav/config', 'mute_cip_disconnect'] },
    { label: 'RCS protocol type', path: ['/system/nav/config', 'rcs_protocol_type'] },
    { label: 'Update map on startup', path: ['/system/nav/config', 'update_map_on_startup'] },
    { label: 'Low battery value', path: ['/system/nav/config', 'low_battery_value'] },
    { label: 'AGV idle time check', path: ['/system/nav/config', 'agv_idle_time_check'] },
    { label: 'Side camera delta take', path: ['/system/nav/config', 'side_camera_delta_take'] },
    { label: 'Barrier obstacle error time', path: ['/system/nav/config', 'barrier_params', 'obs_error_time'] },
    { label: 'Barrier start motion delay', path: ['/system/nav/config', 'barrier_params', 'start_motion_delay'] },
    { label: 'Detection before lifting', path: ['/system/nav/config', 'detection_and_positioning_before_lifting'] },
    { label: 'Detection before rotate', path: ['/system/nav/config', 'detection_and_positioning_before_rotate'] },
    { label: 'Detection before target', path: ['/system/nav/config', 'detection_and_positioning_before_target'] },
    { label: 'Follow acceleration', path: ['/system/nav/config', 'follow_acc'] },
    { label: 'Follow max velocity', path: ['/system/nav/config', 'follow_max_vel'] },
    { label: 'Follow position tolerance', path: ['/system/nav/config', 'follow_pos_tolerance'] },
    { label: 'Follow sleep time', path: ['/system/nav/config', 'follow_sleep_time'] },
    { label: 'Follow stay distance', path: ['/system/nav/config', 'follow_stay_distance'] },
    { label: 'Load soft stop deceleration', path: ['/system/nav/config', 'load_soft_stop_dec'] },
    { label: 'No-load soft stop deceleration', path: ['/system/nav/config', 'noload_soft_stop_dec'] },
    { label: 'LowPower signal threshold', get: (cfg) => getSignalParam(cfg, 'LowPower', 1) },
    { label: 'Safety height', path: ['/hardware/basic', 'safety_height'] },
    { label: 'Safe height descent height', path: ['/hardware/basic', 'safe_height_descent_height'] },
    { label: 'Limit speed', path: ['/hardware/basic', 'limit_speed'] },
    { label: 'Limit acceleration speed', path: ['/hardware/basic', 'limit_acc_speed'] }
];

export function getFeaturedSettings(cfg) {
    const rows = [];
    for (const field of FEATURED_FIELDS) {
        const value = field.get ? field.get(cfg) : getPath(cfg, field.path);
        if (value !== undefined) rows.push({ label: field.label, value });
    }
    return rows;
}

export function parseInflux(result) {
    if (!result || !result.results || !result.results[0]) return { columns: [], rows: [] };
    const r0 = result.results[0];
    if (r0.error) return { error: r0.error, columns: [], rows: [] };
    if (!r0.series || !r0.series[0]) return { columns: [], rows: [] };
    const s = r0.series[0];
    return { columns: s.columns || [], rows: s.values || [] };
}

// First-row-wins dedup keyed on the `ip` field, relying on the query's
// `ORDER BY time DESC` — mirrors app.js's getLatestNonDeadPerBot(), but this
// dataset has no `bot_id` tag (main4.py writes fields only), so `ip` is the
// bot identity here instead.
export function getLatestPerBot(columns, rows) {
    const ipIdx = columns.indexOf('ip');
    if (ipIdx === -1) return [];
    const latest = new Map();
    for (const r of rows) {
        const ip = r[ipIdx];
        if (ip == null || latest.has(ip)) continue;
        latest.set(ip, r);
    }
    return [...latest.values()];
}
