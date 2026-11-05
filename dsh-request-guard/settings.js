// settings.js — one JSON file + one HTTP endpoint for this plugin's knobs.
//
// WHY a file instead of the cordis config: knobs must be switchable from the Web
// Settings UI without editing the profile YAML and without a reload. The stored
// value is overlaid onto the live config object at boot and after every save, so
// consumers that read `cfg.x` at call time see changes immediately.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

export function settingsDir(plugin) {
    return path.join(HOME, plugin);
}

export function settingsFile(plugin) {
    return path.join(settingsDir(plugin), 'config.json');
}

export function readStored(plugin) {
    try {
        const raw = JSON.parse(fs.readFileSync(settingsFile(plugin), 'utf8'));
        return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
        return {};
    }
}

export function writeStored(plugin, values) {
    const file = settingsFile(plugin);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
}

/** Coerce one submitted value against its field descriptor; throws on bad input. */
export function coerce(field, value) {
    if (field.type === 'boolean') {
        if (typeof value !== 'boolean') throw new Error(field.key + ': expected boolean');
        return value;
    }
    if (field.type === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new Error(field.key + ': expected number');
        const min = field.min === undefined ? -Infinity : field.min;
        const max = field.max === undefined ? Infinity : field.max;
        if (n < min || n > max) throw new Error(field.key + ': out of range [' + min + ', ' + max + ']');
        return Math.trunc(n);
    }
    if (field.type === 'string') {
        if (typeof value !== 'string') throw new Error(field.key + ': expected string');
        if (field.maxLength !== undefined && value.length > field.maxLength) throw new Error(field.key + ': too long');
        return value;
    }
    throw new Error(field.key + ': unsupported type ' + String(field.type));
}

/** Overlay stored values onto a live config object (in place). */
export function overlayStored(plugin, fields, cfg) {
    const stored = readStored(plugin);
    for (const field of fields) {
        if (stored[field.key] === undefined) continue;
        try {
            cfg[field.key] = coerce(field, stored[field.key]);
        } catch {
            // A hand-edited bad value must not break boot; the default stays.
        }
    }
    return cfg;
}

function snapshot(plugin, fields, cfg) {
    const values = {};
    for (const field of fields) {
        values[field.key] = cfg[field.key] === undefined ? null : cfg[field.key];
    }
    return { ok: true, plugin, values, fields, rev: Date.now() };
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 64 * 1024) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (text === '') return resolve({});
            try {
                resolve(JSON.parse(text));
            } catch {
                reject(new Error('invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

/**
 * GET  -> current live values + field descriptors for rendering
 * POST -> whole-object patch; unknown keys are rejected (400), never ignored.
 */
export async function handleSettings(plugin, fields, cfg, req, res) {
    const byKey = new Map(fields.map((field) => [field.key, field]));
    try {
        if (req.method === 'GET') return send(res, 200, snapshot(plugin, fields, cfg));
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' });

        const body = await readJson(req);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return send(res, 400, { ok: false, error: 'body must be an object of {key: value}' });
        }
        const patch = {};
        for (const [key, value] of Object.entries(body)) {
            const field = byKey.get(key);
            if (field === undefined) return send(res, 400, { ok: false, error: 'unknown key: ' + key });
            patch[key] = coerce(field, value);
        }
        if (Object.keys(patch).length === 0) return send(res, 400, { ok: false, error: 'empty patch' });

        const merged = { ...readStored(plugin), ...patch };
        writeStored(plugin, merged);
        Object.assign(cfg, patch); // live, in-place: consumers read cfg.x at call time
        return send(res, 200, snapshot(plugin, fields, cfg));
    } catch (error) {
        return send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}
