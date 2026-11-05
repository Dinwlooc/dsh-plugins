// lib/fsops.js — filesystem walking for dsh-file-ops (read-only; every write goes through the host tools).
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', '.godot', '.import', '.trash', '.tmp', 'node_modules', '__pycache__']);

export function listFiles(root, ext) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(ext)) out.push(full);
    }
  };
  walk(root);
  out.sort();
  return out;
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

/** Identity of the version on disk; a commit refuses to run when it changed after the read. */
export function statStamp(file) {
  const info = fs.statSync(file);
  return { mtimeMs: info.mtimeMs, size: info.size };
}
