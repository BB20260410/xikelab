// PluginRegistry — 加载内置 + 用户 plugin manifest，校验 + 探测 bin
// v0.52 W1 T2 通用 CLI Wrapper 起点
//
// 数据流：
//   启动期 load() → 扫 src/plugin/builtin/*.json + ~/.claude-panel/cli-plugins/*.json
//                 → ajv 校 schema → 探测 bin（spawn 类）→ 注册到 this.plugins Map
//   运行期：list() / get() / install(manifest) / uninstall(id) / reload()
//
// 注意：本模块只管 manifest 装配。真正 spawn 跑命令交给 PluginSpawnAdapter。

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, chmodSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, 'builtin');
const USER_DIR = join(homedir(), '.claude-panel', 'cli-plugins');
const SCHEMA_PATH = join(__dirname, '..', '..', 'docs', 'plugin-manifest.schema.json');

// ajv 6 不支持 draft-2020-12 meta，但 schema 用的关键字都 draft-07 兼容
const require = createRequire(import.meta.url);
function makeValidator() {
  // 动态 import 以容错 ajv 缺失
  let Ajv;
  try { Ajv = require('ajv'); } catch { return null; }
  try {
    const ajv = new Ajv({ allErrors: true, meta: false, schemaId: 'auto' });
    ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-07.json'));
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    delete schema.$schema; // 让 ajv 6 用 draft-07 校
    return ajv.compile(schema);
  } catch (e) {
    console.warn('PluginRegistry: schema 加载失败，跳过校验:', e.message);
    return null;
  }
}

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** 探测 manifest.bin.cmd 是否真存在；返回 absolute path 或 null */
function probeBin(manifest) {
  if (manifest.type !== 'spawn' || !manifest.bin) return { ok: true, resolved: null };
  const bin = manifest.bin;
  // 1. env var override
  if (bin.env && process.env[bin.env]) {
    const p = expandHome(process.env[bin.env]);
    if (existsSync(p)) return { ok: true, resolved: p };
  }
  // 2. 绝对路径
  if (bin.cmd && bin.cmd.startsWith('/')) {
    return existsSync(bin.cmd) ? { ok: true, resolved: bin.cmd } : { ok: false, error: 'bin 不存在: ' + bin.cmd };
  }
  // 3. which
  try {
    const r = spawnSync('which', [bin.cmd], { encoding: 'utf-8', env: process.env });
    if (r.status === 0 && r.stdout.trim()) return { ok: true, resolved: r.stdout.trim() };
  } catch {}
  // 4. fallback
  if (bin.fallback) {
    const p = expandHome(bin.fallback);
    if (existsSync(p)) return { ok: true, resolved: p };
  }
  return { ok: false, error: `bin "${bin.cmd}" 找不到（which 未命中、fallback 不存在）` };
}

export class PluginRegistry {
  constructor({ validate = true } = {}) {
    this.plugins = new Map(); // id → { manifest, source: 'builtin'|'user', resolvedBin, valid: true|false, error? }
    this.validator = validate ? makeValidator() : null;
  }

  /** 扫两个目录 + 注册 */
  load() {
    this.plugins.clear();
    this._loadDir(BUILTIN_DIR, 'builtin');
    this._loadDir(USER_DIR, 'user', { silentMissing: true });
    return this.list();
  }

  _loadDir(dir, source, { silentMissing = false } = {}) {
    if (!existsSync(dir)) {
      if (!silentMissing) console.warn(`PluginRegistry: 目录不存在 ${dir}`);
      return;
    }
    let files;
    try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch (e) {
      console.warn(`PluginRegistry: 读 ${dir} 失败:`, e.message);
      return;
    }
    for (const f of files) {
      const path = join(dir, f);
      try {
        const manifest = JSON.parse(readFileSync(path, 'utf-8'));
        const r = this._register(manifest, source);
        if (!r.ok) console.warn(`PluginRegistry: ${source}/${f} 注册失败 — ${r.error}`);
      } catch (e) {
        console.warn(`PluginRegistry: 解析 ${source}/${f} 失败:`, e.message);
      }
    }
  }

  _register(manifest, source) {
    // 1. schema 校验
    if (this.validator) {
      if (!this.validator(manifest)) {
        const msg = this.validator.errors.map(e => `${e.dataPath || '/'} ${e.message}`).join('; ');
        return { ok: false, error: 'schema 校验失败: ' + msg };
      }
    }
    // 2. id 冲突
    if (this.plugins.has(manifest.id)) {
      // 用户 plugin 覆盖内置允许（向后扩展）；内置覆盖内置禁止
      const existing = this.plugins.get(manifest.id);
      if (existing.source === 'builtin' && source === 'builtin') {
        return { ok: false, error: `id "${manifest.id}" 内置冲突` };
      }
    }
    // 3. 探测 bin
    const probe = probeBin(manifest);
    const entry = {
      manifest,
      source,
      resolvedBin: probe.resolved,
      valid: probe.ok,
      error: probe.error || null,
    };
    this.plugins.set(manifest.id, entry);
    return { ok: true, entry };
  }

  list() {
    return [...this.plugins.values()].map(e => ({
      id: e.manifest.id,
      displayName: e.manifest.displayName,
      icon: e.manifest.icon || '',
      version: e.manifest.version || '',
      type: e.manifest.type,
      source: e.source,
      valid: e.valid,
      error: e.error,
      resolvedBin: e.resolvedBin,
      commands: (e.manifest.commands || []).map(c => ({ id: c.id, name: c.name })),
    }));
  }

  get(id) {
    return this.plugins.get(id);
  }

  /** 安装用户 plugin manifest（落盘到 ~/.claude-panel/cli-plugins/<id>.json） */
  install(manifest) {
    // 校 schema 先
    if (this.validator && !this.validator(manifest)) {
      return { ok: false, error: 'schema 校验失败: ' + this.validator.errors.map(e => e.message).join('; ') };
    }
    if (!manifest.id) return { ok: false, error: 'manifest 缺 id' };
    // 内置 id 不允许被用户 plugin 覆盖（避免 claude 这种被 hack）
    const existing = this.plugins.get(manifest.id);
    if (existing && existing.source === 'builtin') {
      return { ok: false, error: `id "${manifest.id}" 是内置 plugin，不可被用户 manifest 覆盖` };
    }
    try {
      if (!existsSync(USER_DIR)) {
        mkdirSync(USER_DIR, { recursive: true });
        try { chmodSync(USER_DIR, 0o700); } catch {}
      }
      const path = join(USER_DIR, `${manifest.id}.json`);
      const tmp = path + '.tmp';
      writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch {}
      renameSync(tmp, path);
    } catch (e) {
      return { ok: false, error: '写盘失败: ' + e.message };
    }
    // 注册到内存
    const r = this._register(manifest, 'user');
    return r;
  }

  /** 卸载用户 plugin（内置不允许卸） */
  uninstall(id) {
    const e = this.plugins.get(id);
    if (!e) return { ok: false, error: 'plugin 不存在' };
    if (e.source === 'builtin') return { ok: false, error: '内置 plugin 不可卸载' };
    try {
      const path = join(USER_DIR, `${id}.json`);
      if (existsSync(path)) unlinkSync(path);
    } catch (e2) {
      return { ok: false, error: '删除文件失败: ' + e2.message };
    }
    this.plugins.delete(id);
    return { ok: true };
  }

  reload() {
    return this.load();
  }
}
