// Pure, DOM-free logic for the Firmware versions grid — split out from app.js
// so it can be unit tested directly under Node (app.js can't be imported
// outside a browser since it touches `document` at module load).

// Fields that carry a firmware version for some component of the bot
// software: docker container tags (meli/RTP), fwv/API app versions and vv
// keys (RELAY/TTP). Everything else (time, ids, vda, config blobs) is skipped.
const FW_COL_RE = /^(app_|container_|vv_)/;

// Acronyms worth uppercasing in the humanised component label.
const FW_ACRONYMS = /\b(ipu|ros|vda|os|qr|msg|nav)\b/gi;

export function isFirmwareColumn(col) {
    return FW_COL_RE.test(col);
}

export function firmwareColumns(columns) {
    return columns.filter(isFirmwareColumn);
}

// Turn `container_camera_server_ipu` into something readable, keeping the
// common acronyms uppercase ("Camera Server IPU", "ROS Master").
export function prettyFirmwareName(col) {
    const name = col.replace(FW_COL_RE, '').replace(/_/g, ' ');
    return name
        .replace(FW_ACRONYMS, m => m.toUpperCase())
        .replace(/(^|\s)([a-z])/g, (_, sp, ch) => sp + ch.toUpperCase());
}

// Compute the fleet-wide variant counts for every firmware component.

// rows are arrays of field values aligned to `columns` (Influx-style row).
// Returns one block per component that has any values:
//   { col, label, entries: [{value, count}], totalVariants, truncated }
// entries are sorted by count (desc) then value; only the top `maxChips`
// variants are included and `truncated` reports how many were cut.
export function buildFirmwareGrid(columns, rows, maxChips = 20) {
    const blocks = [];
    for (const col of firmwareColumns(columns)) {
        const idx = columns.indexOf(col);
        if (idx === -1) continue;
        const counts = new Map();
        for (const r of rows) {
            const v = r[idx];
            if (v == null) continue;
            const key = String(v);
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        if (counts.size === 0) continue;
        const entries = Array.from(counts.entries())
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
        blocks.push({
            col,
            label: prettyFirmwareName(col),
            entries: entries.slice(0, maxChips),
            totalVariants: entries.length,
            truncated: Math.max(0, entries.length - maxChips)
        });
    }
    return blocks;
}