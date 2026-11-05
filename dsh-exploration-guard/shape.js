// dsh-exploration-guard — read shaping（read 结果的"地图化"）。
//
// 纯函数 + node:crypto，不碰 ctx、不读配置：所有判定由 index.js 的
// tools/post-execute 钩子做，这里只负责"把文本变成大纲/窗口"和"拼文案"。
// 契约：任何不确定都返回 null——调用方拿到 null 就必须原样放行原始结果，
// 绝不可以用猜测的内容替换文件文本。
import { createHash } from 'node:crypto';

/** 文件/结果文本的短指纹（12 位十六进制）。 */
export function fingerprint(text) {
    if (typeof text !== 'string') return null;
    return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/**
 * 按行切分。行数与编辑器口径一致：末尾换行不算多一行；UTF-8 BOM 不是内容，
 * 先剥掉（否则 BOM 文件的第一行标题会整条丢掉——实测事故）。
 * @returns {string[]|null}
 */
export function splitLines(text) {
    if (typeof text !== 'string') return null;
    let body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    if (body.length === 0) return null;
    if (body.endsWith('\n')) body = body.slice(0, -1);
    return body.split('\n');
}

const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * Markdown 标题大纲。围栏代码块（``` / ~~~）内的 # 不算标题——
 * 这是最容易把大纲写成假话的地方，所以围栏状态优先于标题匹配。
 * @returns {{entries:{line:number,level:number,text:string}[], total:number, truncated:boolean}|null}
 */
export function mdOutline(lines, maxEntries = 200) {
    if (!Array.isArray(lines)) return null;
    const entries = [];
    let fenced = false;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (FENCE.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) continue;
        const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (match !== null) entries.push({ line: i + 1, level: match[1].length, text: line.trimEnd() });
    }
    // 标题太少时大纲不比原文省，也不比原文有用：交还原文。
    if (entries.length < 3) return null;
    return {
        entries: entries.length > maxEntries ? entries.slice(0, maxEntries) : entries,
        total: entries.length,
        truncated: entries.length > maxEntries,
    };
}

// 行首（第 0 列）才可能是成员声明；函数体里的局部 var/const 一律不算。
// 允许前置注解：@export var、@onready var、@rpc("any_peer") func。
const GD_MEMBER = /^(?:@[A-Za-z_]\w*(?:\([^)]*\))?\s+)*(?:static\s+)?(class_name|extends|class|signal|enum|const|var|func)\b/;

/** @returns {{entries:{line:number,kind:string,text:string}[], total:number, truncated:boolean}|null} */
export function gdMembers(lines, maxEntries = 200) {
    if (!Array.isArray(lines)) return null;
    const entries = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.length === 0) continue;
        if (/^\s/.test(line)) continue;
        const match = GD_MEMBER.exec(line);
        if (match !== null) entries.push({ line: i + 1, kind: match[1], text: line.trimEnd() });
    }
    if (entries.length < 3) return null;
    return {
        entries: entries.length > maxEntries ? entries.slice(0, maxEntries) : entries,
        total: entries.length,
        truncated: entries.length > maxEntries,
    };
}

/**
 * 在文本里定位编辑锚点（行内容），返回 1 基行号；多处命中取第一处。
 * 锚点必须逐字出现，否则返回 null——宁可退回原文，也不编位置。
 */
export function locateAnchor(lines, anchor) {
    if (!Array.isArray(lines)) return null;
    if (typeof anchor !== 'string' || anchor.trim().length === 0) return null;
    const needle = anchor.trim();
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].trim() === needle) hits.push(i + 1);
    }
    if (hits.length === 0) {
        for (let i = 0; i < lines.length; i += 1) {
            if (lines[i].includes(needle)) return i + 1;
        }
        return null;
    }
    return hits[0];
}

/**
 * 解析 `grep` 工具的输出文本。实测两种头：
 *   Found 12 matches                    —— 完整
 *   Found 250 of 769 matches            —— 工具自身截断（还带一行 spill 路径）
 * 明细行为 `path` / `Line N: 原文`。
 * 任何不符（计数与明细对不上、行不认得、无文件）都返回 null——
 * 调用方必须原样放行，绝不按猜测重排别人的输出。
 * @returns {{shown:number, total:number, files:{path:string, matches:{line:number,text:string}[]}[], spillPath:string|null, notes:string[]}|null}
 */
export function parseGrepOutput(text) {
    if (typeof text !== 'string') return null;
    const lines = text.split('\n');
    const complete = /^Found (\d+) match(?:es)?\b/.exec(lines[0] ?? '');
    const partial = /^Found (\d+) of (\d+) match(?:es)?\b/.exec(lines[0] ?? '');
    if (complete === null && partial === null) return null;
    const shown = Number((complete ?? partial)[1]);
    const total = complete !== null ? shown : Number(partial[2]);
    const files = [];
    let current = null;
    let spillPath = null;
    const notes = [];
    for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.trim().length === 0) continue;
        const spill = /^\(Full grep result stored at: (.+?)\)$/.exec(line.trim());
        if (spill !== null) {
            spillPath = spill[1];
            continue;
        }
        // 工具自己的括注（例如"完整结果未能保存"）不是文件路径，原样带到摘要顶上。
        if (line.trim().startsWith('(')) {
            notes.push(line.trim());
            continue;
        }
        const hit = /^Line (\d+): ?(.*)$/.exec(line);
        if (hit !== null) {
            if (current === null) return null;
            current.matches.push({ line: Number(hit[1]), text: hit[2] });
            continue;
        }
        current = { path: line, matches: [] };
        files.push(current);
    }
    if (files.length === 0) return null;
    const counted = files.reduce((n, file) => n + file.matches.length, 0);
    // 计数不符说明输出被改写过（例如 save-token 的裁剪），此时重排会丢信息。
    if (counted !== shown) return null;
    return { shown, total, files, spillPath, notes };
}

/**
 * grep 摘要文案：每文件只留少量命中原文，其余给行号；全量在 locator。
 * 三条硬约束：
 * - 总行数 ≤ maxLines、文件数 ≤ maxFiles（否则 dsh-plugin-save-token 的 240 行窗口
 *   会把索引中段裁掉，等于二次整形，还多一个 locator）；
 * - 行号全部保留，"读某行"与"再搜一次"两条出路都不受影响；
 * - 稠密文件（>20 条命中）只留 1 条样例，>100 条只给行号——否则样例本身就成了体积。
 */
export function buildGrepSummaryStub({ shown, total, files, perFile, locator, spillPath, notes, hint, listingLines, maxLines = 200, maxFiles = 40 }) {
    const scope = shown === total
        ? `${total} matches in ${files.length} files`
        : `${shown} of ${total} matches shown, ${files.length} files in this slice`;
    const out = [
        `[exploration-guard grepSummary] Index, NOT all matches: ${scope}. This listing saved to: ${locator}`,
    ];
    if (typeof spillPath === 'string') out.push(`Full ${total}-match list (tool spill): ${spillPath}`);
    for (const note of Array.isArray(notes) ? notes : []) out.push(note);

    let listed = 0;
    for (const file of files) {
        if (listed >= maxFiles || out.length >= maxLines) break;
        const count = file.matches.length;
        const samples = count > 100 ? 0 : (count > 20 ? 1 : perFile);
        out.push(`${file.path} (${count} matches)`);
        for (const hit of file.matches.slice(0, samples)) out.push(`Line ${hit.line}: ${hit.text}`);
        const rest = file.matches.slice(samples);
        if (rest.length > 0) out.push(`+${rest.length} more at lines ${rest.map((hit) => hit.line).join(', ')}`);
        listed += 1;
    }
    if (listed < files.length) {
        out.push(`+${files.length - listed} more files (not listed here) — their matches are in the saved listing below`);
    }
    const limit = Number.isInteger(listingLines) && listingLines > 0 ? ` offset=1 limit=${listingLines}` : ' offset=<line> limit=<count>';
    out.push(`Get a full listing: read file_path="${locator}"${limit} (offset/limit is never reshaped). ${hint ?? ''}`.trim());
    return out.join('\n');
}

/**
 * 编辑后验证读的窗口：总共 spanLines 行（面板文案的口径就是"合计行数"），
 * 锚点行居中偏上；锚点缺失（write 整写）时退回文件开头。
 * @returns {{start:number,end:number,anchorLine:number|null}|null}
 */
export function verifyWindow(lines, anchor, spanLines = 24) {
    if (!Array.isArray(lines) || lines.length === 0) return null;
    const span = Math.max(1, Math.min(spanLines, lines.length));
    const anchorLine = locateAnchor(lines, anchor);
    if (anchorLine === null) {
        if (typeof anchor === 'string' && anchor.trim().length > 0) return null;
        return { start: 1, end: span, anchorLine: null };
    }
    let start = Math.max(1, anchorLine - Math.floor((span - 1) / 2));
    let end = start + span - 1;
    if (end > lines.length) {
        end = lines.length;
        start = Math.max(1, end - span + 1);
    }
    return { start, end, anchorLine };
}

/** 行号右对齐宽度：让 4 位与 5 位行号不参差。 */
function pad(n, width) {
    const s = String(n);
    return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function numbered(lines, from, to, width) {
    const out = [];
    for (let i = from; i <= to; i += 1) out.push(`${pad(i, width)}: ${lines[i - 1]}`);
    return out;
}

const KIND_LABEL = { md: 'markdown', gd: 'GDScript' };

/** 大纲文案。第一行让模型立刻明白"这不是正文"；条目给**每节的行区间**，
 * 选读因此落在"两个标题之间"，而不是被教成"再读一遍全文"。末行只写意图，
 * 不写可照抄的命令：示例照抄出来就是整文件重读，与整形目的相反。
 * 文件尾行由最后一条区间的终点给出（模型看不到正文，尾行位置本来只有这里知道）。 */
export function buildOutlineStub({ kind, total, sha, outline }) {
    const width = String(total).length + 1;
    const unit = kind === 'gd' ? 'member declarations' : 'sections';
    const body = outline.entries.map((entry, i) => {
        const next = outline.entries[i + 1];
        const end = next === undefined ? total : next.line - 1;
        return `${pad(entry.line, width)}-${pad(end, width)}: ${entry.text}`;
    });
    const lines = [
        `[exploration-guard outline] Partial map, NOT file text: ${total}-line ${KIND_LABEL[kind]} file, ${outline.total} ${unit}, sha256:${sha}`,
        ...body,
    ];
    if (outline.truncated) lines.push(`  ... ${outline.total - outline.entries.length} more ${unit} omitted; the file ends at line ${total}`);
    lines.push('Read one section by its line range (offset/limit) instead of the whole file.');
    return lines.join('\n');
}

/** 编辑后验证读文案：只给编辑窗口 + 文件指纹 + 总行数；不给"重读全文"的示例。 */
export function buildVerifyStub({ total, sha, anchor, window, lines }) {
    const width = String(total).length + 1;
    const afterWrite = window.anchorLine === null;
    const where = afterWrite
        ? 'file head (whole-file write, no anchor line)'
        : `anchor "${anchor}" at line ${window.anchorLine}`;
    const head = afterWrite
        ? `[exploration-guard verifyRead] Re-read after your write returned ONLY the file head, not the whole file (${total} lines, file sha256:${sha}; hash of current content, not a version id).`
        : `[exploration-guard verifyRead] Re-read after your edit returned ONLY the edited region, not the whole file (${total} lines, file sha256:${sha}; hash of current content, not a version id).`;
    return [
        head,
        `${where} — showing lines ${window.start}-${window.end}:`,
        ...numbered(lines, window.start, window.end, width),
    ].join('\n');
}
