// dsh-release-notes — 只读更新日志，给人看，不给模型看。
//
// 设计（Owner 2026-10-30）：不注册任何模型工具——"有新版本可看"不改变模型的任何一次决策，
// 却要每轮为一条 schema 付费。宿主只提供鉴权 GET 路由，客户端面板负责渲染。
//
//   GET /release-notes/api/report          当前版本 / 最新版本 / 落后几个版本 / 逐版更新点
//   GET /release-notes/api/report?force=1  跳过 30 分钟缓存重新拉 GitHub
//
// 缓存写在 $DSH_HOME/release-notes/cache.json；失败降级为 JSON 错误，不抛进会话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-release-notes';
export const inject = ['webServer'];

const REPO = 'deepseek-ai/deepseek-harness';
const LIMITS = { ttlMs: 30 * 60 * 1000, maxEntries: 8, maxBullets: 4 };


const CHANNEL_RANK = { alpha: 0, next: 1, rc: 2, stable: 3 };

function homeDir() {
    const env = process.env.DSH_HOME;
    return typeof env === 'string' && env.length > 0 ? env : path.join(os.homedir(), '.dsh');
}

function cacheFile() {
    return path.join(homeDir(), 'release-notes', 'cache.json');
}

function readCache() {
    try {
        const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
        if (raw && typeof raw === 'object' && Array.isArray(raw.releases)) return raw;
    } catch {
        /* no cache yet */
    }
    return null;
}

function writeCache(releases) {
    try {
        const file = cacheFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ at: Date.now(), releases }, null, 0), 'utf8');
    } catch {
        /* cache is best-effort */
    }
}

/** Running build version, best effort (desktop installs carry it one level above the asar). */
function runningVersion() {
    try {
        const base = process.resourcesPath || '';
        const pkg = JSON.parse(fs.readFileSync(path.join(base, 'app.asar', 'dsh', 'package.json'), 'utf8'));
        if (typeof pkg.version === 'string') return pkg.version;
    } catch {
        /* not a desktop install */
    }
    return null;
}

function parseVersion(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/.exec(String(v || '').trim());
    if (m === null) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], channel: m[4] ? m[4] : 'stable', serial: m[5] ? +m[5] : 0 };
}

export function compareVersions(a, b) {
    const A = parseVersion(a);
    const B = parseVersion(b);
    if (A === null || B === null) return String(a).localeCompare(String(b));
    if (A.major !== B.major) return A.major - B.major;
    if (A.minor !== B.minor) return A.minor - B.minor;
    if (A.patch !== B.patch) return A.patch - B.patch;
    if (A.channel !== B.channel) return CHANNEL_RANK[A.channel] - CHANNEL_RANK[B.channel];
    return A.serial - B.serial;
}

async function fetchReleases(force) {
    const cached = readCache();
    if (!force && cached !== null && Date.now() - cached.at < LIMITS.ttlMs) return { releases: cached.releases, cached: true };
    const res = await fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=30', {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-release-notes' },
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error('GitHub releases request failed: HTTP ' + res.status);
    const list = await res.json();
    const releases = (Array.isArray(list) ? list : [])
        .map((r) => ({ tag: String(r.tag_name || '').replace(/^dsh-v/, ''), at: String(r.published_at || '').slice(0, 10), body: String(r.body || '') }))
        .filter((r) => /^\d+\.\d+\.\d+/.test(r.tag))
        .sort((a, b) => compareVersions(a.tag, b.tag));
    writeCache(releases);
    return { releases, cached: false };
}

/** Only the bullets a reader needs; capped so one release never dominates the panel. */
function bullets(body) {
    const out = [];
    for (const line of String(body).split('\n')) {
        const m = /^\s*[-*]\s+(.+)$/.exec(line);
        if (m !== null && m[1].trim().length > 0) out.push(m[1].trim().slice(0, 160));
        if (out.length >= LIMITS.maxBullets) break;
    }
    return out;
}

/** The report the panel renders: pure JSON, no formatting. */
export async function buildReport(args) {
    const { releases, cached } = await fetchReleases(args?.force === true);
    const current = typeof args?.current === 'string' && args.current.length > 0 ? args.current : runningVersion();
    if (releases.length === 0) return { current, newest: null, behind: 0, entries: [], cached, at: Date.now() };
    const newest = releases[releases.length - 1].tag;
    const newer = current === null ? [] : releases.filter((r) => compareVersions(r.tag, current) > 0);
    const entries = (current === null ? releases.slice(-LIMITS.maxEntries) : newer.slice(-LIMITS.maxEntries))
        .reverse()
        .map((r) => ({ tag: r.tag, at: r.at, bullets: bullets(r.body) }));
    return { current, newest, behind: current === null ? null : newer.length, entries, cached, at: Date.now() };
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
    });
    res.end(body);
}

export function apply(ctx) {
    ctx.effect(() => {
        const handler = async (req, res) => {
            try {
                const url = new URL(req.url || '/', 'http://localhost');
                if (url.pathname !== '/release-notes/api/report') {
                    sendJson(res, 404, { ok: false, error: 'unknown release-notes endpoint' });
                    return;
                }
                if (req.method !== 'GET') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' });
                    return;
                }
                sendJson(res, 200, await buildReport({ force: url.searchParams.get('force') === '1' }));
            } catch (error) {
                console.warn('[dsh-release-notes] report failed:', error);
                sendJson(res, 502, { ok: false, error: 'release notes unavailable' });
            }
        };
        overlayStored('release-notes', SETTINGS_FIELDS, LIMITS);
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact',
            path: '/api/release-notes/config',
            handler: (req, res) => handleSettings('release-notes', SETTINGS_FIELDS, LIMITS, req, res),
        }), 'release-notes: settings');

        return ctx.webServer.register({ kind: 'prefix', path: '/release-notes', handler });
    }, 'dsh-release-notes: report route');
}

import { overlayStored, handleSettings } from './settings.js';

/** Settings surface for the Web UI (persisted at ~/.dsh/release-notes/config.json). */
export const SETTINGS_FIELDS = Object.freeze([
    { key: 'ttlMs', type: 'number', min: 0, max: 86400000, label: '缓存有效期(ms)', hint: '到期后重新拉取发布说明。' },
    { key: 'maxEntries', type: 'number', min: 1, max: 50, label: '最多条目', hint: '列表里保留的版本条数。' },
    { key: 'maxBullets', type: 'number', min: 1, max: 20, label: '每条要点上限' },
]);
