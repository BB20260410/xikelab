// panel v2.0 Task 4.3 — 多 workspace 隔离
// 每个 workspace 独立目录：~/.claude-panel/workspaces/{name}/
// 默认 workspace 名 'default'，向后兼容旧 ~/.claude-panel/ 直接放数据的形态
// license team-tier 才能创建额外 workspace（hasFeature('workspaces')）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = path.join(os.homedir(), '.claude-panel');
const WORKSPACES_DIR = path.join(HOME, 'workspaces');
const ACTIVE_FILE = path.join(HOME, 'active-workspace.txt');
const META_FILE = (name) => path.join(WORKSPACES_DIR, name, 'workspace.json');

const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const DEFAULT_NAME = 'default';

function ensureDirs() {
  if (!fs.existsSync(HOME)) fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(WORKSPACES_DIR)) fs.mkdirSync(WORKSPACES_DIR, { recursive: true, mode: 0o700 });
}

function validateName(name) {
  if (!name || typeof name !== 'string') throw new Error('workspace 名必须是非空字符串');
  if (!NAME_RE.test(name)) throw new Error(`workspace 名只允许 a-zA-Z0-9_- 且 1-32 字符`);
}

// 列出所有 workspace
export function listWorkspaces() {
  ensureDirs();
  const items = [{ name: DEFAULT_NAME, builtin: true, createdAt: null }];
  if (fs.existsSync(WORKSPACES_DIR)) {
    for (const entry of fs.readdirSync(WORKSPACES_DIR)) {
      if (entry === DEFAULT_NAME) continue;
      const dir = path.join(WORKSPACES_DIR, entry);
      if (!fs.statSync(dir).isDirectory()) continue;
      let meta = {};
      if (fs.existsSync(META_FILE(entry))) {
        try { meta = JSON.parse(fs.readFileSync(META_FILE(entry), 'utf8')); } catch {}
      }
      items.push({ name: entry, builtin: false, ...meta });
    }
  }
  return items;
}

export function getActive() {
  ensureDirs();
  try {
    if (fs.existsSync(ACTIVE_FILE)) {
      const n = fs.readFileSync(ACTIVE_FILE, 'utf8').trim();
      if (NAME_RE.test(n)) return n;
    }
  } catch {}
  return DEFAULT_NAME;
}

export function setActive(name) {
  ensureDirs();
  validateName(name);
  const all = listWorkspaces();
  if (!all.find(w => w.name === name)) throw new Error(`workspace '${name}' 不存在`);
  fs.writeFileSync(ACTIVE_FILE, name, { mode: 0o600 });
  return name;
}

export function createWorkspace(name, { description = '' } = {}) {
  ensureDirs();
  validateName(name);
  if (name === DEFAULT_NAME) throw new Error("'default' 是保留名");
  const dir = path.join(WORKSPACES_DIR, name);
  if (fs.existsSync(dir)) throw new Error(`workspace '${name}' 已存在`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const meta = { name, description, createdAt: new Date().toISOString() };
  fs.writeFileSync(META_FILE(name), JSON.stringify(meta, null, 2), { mode: 0o600 });
  return meta;
}

export function deleteWorkspace(name) {
  ensureDirs();
  validateName(name);
  if (name === DEFAULT_NAME) throw new Error("'default' 不能删除");
  const dir = path.join(WORKSPACES_DIR, name);
  if (!fs.existsSync(dir)) throw new Error(`workspace '${name}' 不存在`);
  fs.rmSync(dir, { recursive: true, force: true });
  if (getActive() === name) {
    try { fs.unlinkSync(ACTIVE_FILE); } catch {}
  }
  return { deleted: name };
}

// 获取当前 active workspace 的数据目录（对外暴露给 ArchiveStore / SqliteStore 等）
export function getWorkspaceDir(name = null) {
  const ws = name || getActive();
  if (ws === DEFAULT_NAME) return HOME; // default workspace 直接落 ~/.claude-panel/ 兼容旧版
  return path.join(WORKSPACES_DIR, ws);
}

// 返回某 workspace 的 SQLite db 路径
export function getDbPath(name = null) {
  return path.join(getWorkspaceDir(name), 'panel.db');
}

export { HOME, WORKSPACES_DIR, DEFAULT_NAME };
