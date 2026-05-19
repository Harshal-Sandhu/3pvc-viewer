'use strict';

const SECTION_HEADER_RE = /^\[([a-zA-Z0-9_]+)\]\s*$/;
const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isMetaSection(name) {
    return name === 'all'
        || name.startsWith('all:')
        || name.endsWith(':vars')
        || name.endsWith(':children');
}

function parseInventory(text) {
    const lines = String(text || '').split('\n');
    const sections = {};
    let current = null;
    let skipping = false;
    for (const raw of lines) {
        const m = raw.match(SECTION_HEADER_RE);
        if (m) {
            current = m[1];
            skipping = isMetaSection(current);
            if (!skipping && !sections[current]) sections[current] = [];
            continue;
        }
        if (!current || skipping) continue;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const commented = trimmed.startsWith('#');
        const ip = (commented ? trimmed.slice(1) : trimmed).trim();
        if (IP_RE.test(ip)) {
            sections[current].push({ ip, active: !commented });
        }
    }
    return sections;
}

function applyActiveIps(text, sectionName, activeIps) {
    const activeSet = new Set(activeIps);
    const out = [];
    const lines = String(text || '').split('\n');
    let inAnySection = false;
    let currentSection = null;
    let isMeta = false;
    for (const raw of lines) {
        const m = raw.match(SECTION_HEADER_RE);
        if (m) {
            inAnySection = true;
            currentSection = m[1];
            isMeta = isMetaSection(currentSection);
            out.push(raw);
            continue;
        }
        if (!currentSection || isMeta) {
            out.push(raw);
            continue;
        }
        const trimmed = raw.trim();
        if (!trimmed) { out.push(raw); continue; }
        const commented = trimmed.startsWith('#');
        const ip = (commented ? trimmed.slice(1) : trimmed).trim();
        if (!IP_RE.test(ip)) {
            out.push(raw);
            continue;
        }
        if (currentSection === sectionName) {
            out.push(activeSet.has(ip) ? ip : '#' + ip);
        } else {
            out.push(commented ? raw : '#' + ip);
        }
    }
    if (!inAnySection) throw new Error('Inventory has no section headers');
    return out.join('\n');
}

function updateGroupVars(text, updates) {
    const allowedKeys = new Set(['venv_version', 'emqx_mqtt_host']);
    const lines = String(text || '').split('\n');
    const seen = new Set();
    const out = lines.map(line => {
        const m = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*?)\s*$/);
        if (!m) return line;
        const [, indent, key] = m;
        if (!allowedKeys.has(key)) return line;
        if (!Object.prototype.hasOwnProperty.call(updates, key)) return line;
        seen.add(key);
        const v = updates[key];
        return `${indent}${key}: ${v}`;
    });
    for (const k of allowedKeys) {
        if (!seen.has(k) && Object.prototype.hasOwnProperty.call(updates, k)) {
            out.push(`${k}: ${updates[k]}`);
        }
    }
    return out.join('\n');
}

module.exports = { parseInventory, applyActiveIps, updateGroupVars };
