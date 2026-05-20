// v0.56 Sprint 15-R4 — Autopilot + Claim
//
// 学 ruflo @claude-flow/cli autopilot：让房自动续跑 + 跨房 forward
// 但更克制：默认关闭、需用户显式开启；每条链路最多 N hop；用户能随时关
//
// 持久化：~/.claude-panel/autopilot.json
//   {
//     version: 1,
//     enabled: false,                    // 全局开关
//     maxHopsDefault: 5,                 // 全局链路上限
//     rules: [
//       {
//         id: 'rule-debate-to-squad',
//         name: 'debate 完成→落地到 squad',
//         enabled: true,
//         when: 'debate_done',           // 事件类型
//         sourceMode: 'debate',           // 仅 debate 模式房触发
//         action: 'forward',              // forward | notify | retry
//         targetMode: 'squad',            // forward 用：转哪个模式
//         autoStart: true,                // forward 后是否自动启动
//       },
//       ...
//     ]
//   }

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const DIR = join(homedir(), '.claude-panel');
const FILE = join(DIR, 'autopilot.json');
const LOG_FILE = join(DIR, 'autopilot-log.jsonl');

export const VALID_EVENTS = [
  'debate_done', 'squad_done', 'arena_done', 'chat_done',
  'debate_error', 'squad_error', 'arena_error',
  'room_auto_paused',
];
export const VALID_MODES = ['debate', 'squad', 'arena', 'chat'];
export const VALID_ACTIONS = ['forward', 'notify', 'noop'];

const MAX_RULES = 30;
const MAX_RULE_NAME = 100;

// 内置默认规则（首次用户开启 autopilot 时挂载）—— 都默认 enabled=false 让用户挑
const BUILTIN_RULES = [
  {
    id: 'builtin-debate-to-squad',
    name: 'debate 完成 → 转 squad 落地',
    enabled: false,
    when: 'debate_done', sourceMode: 'debate',
    action: 'forward', targetMode: 'squad', autoStart: true,
  },
  {
    id: 'builtin-arena-to-chat',
    name: 'arena 完成 → 转 chat 继续追问',
    enabled: false,
    when: 'arena_done', sourceMode: 'arena',
    action: 'forward', targetMode: 'chat', autoStart: false,
  },
  {
    id: 'builtin-squad-to-arena',
    name: 'squad 完成 → 转 arena 多方核对',
    enabled: false,
    when: 'squad_done', sourceMode: 'squad',
    action: 'forward', targetMode: 'arena', autoStart: true,
  },
  {
    id: 'builtin-error-notify',
    name: '任何房出错 → 仅记录日志（不自动操作）',
    enabled: true,
    when: 'debate_error', sourceMode: null,
    action: 'notify', targetMode: null, autoStart: false,
  },
  {
    id: 'builtin-auto-paused-notify',
    name: '房自动暂停 → 仅记录（不重启）',
    enabled: true,
    when: 'room_auto_paused', sourceMode: null,
    action: 'notify', targetMode: null, autoStart: false,
  },
];

function sanitizeRule(input) {
  if (!input || typeof input !== 'object') return null;
  const id = (typeof input.id === 'string' && input.id) ? input.id.slice(0, 60) : 'rule-' + randomUUID().slice(0, 8);
  const name = (typeof input.name === 'string' ? input.name : '').slice(0, MAX_RULE_NAME).trim();
  if (!name) return null;
  const when = VALID_EVENTS.includes(input.when) ? input.when : null;
  if (!when) return null;
  const action = VALID_ACTIONS.includes(input.action) ? input.action : 'noop';
  const sourceMode = (input.sourceMode && VALID_MODES.includes(input.sourceMode)) ? input.sourceMode : null;
  const targetMode = (input.targetMode && VALID_MODES.includes(input.targetMode)) ? input.targetMode : null;
  if (action === 'forward' && !targetMode) return null;
  return {
    id, name, when, action, sourceMode, targetMode,
    enabled: input.enabled !== false,
    autoStart: input.autoStart !== false,
  };
}

export class AutopilotStore {
  constructor() {
    this.config = {
      version: 1,
      enabled: false,
      maxHopsDefault: 5,
      rules: BUILTIN_RULES.map((r) => ({ ...r })),
    };
    this._ensureDir();
    this._load();
  }

  _ensureDir() {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
  }

  _load() {
    if (!existsSync(FILE)) return;
    try {
      const raw = readFileSync(FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (typeof data.enabled === 'boolean') this.config.enabled = data.enabled;
      if (Number.isFinite(data.maxHopsDefault)) {
        this.config.maxHopsDefault = Math.max(1, Math.min(20, Math.trunc(data.maxHopsDefault)));
      }
      if (Array.isArray(data.rules)) {
        const sanitized = data.rules.map((r) => sanitizeRule(r)).filter(Boolean).slice(0, MAX_RULES);
        // 内置规则按 id 合并（用户改过的优先），新增的内置规则也加入
        const map = new Map(sanitized.map((r) => [r.id, r]));
        for (const b of BUILTIN_RULES) {
          if (!map.has(b.id)) map.set(b.id, { ...b });
        }
        this.config.rules = Array.from(map.values()).slice(0, MAX_RULES);
      }
    } catch (e) {
      console.warn('[autopilot] load failed:', e.message);
    }
  }

  _save() {
    try {
      writeFileSync(FILE, JSON.stringify(this.config, null, 2), { mode: 0o600 });
      try { chmodSync(FILE, 0o600); } catch {}
    } catch (e) {
      console.warn('[autopilot] save failed:', e.message);
    }
  }

  getConfig() { return JSON.parse(JSON.stringify(this.config)); }

  isEnabled() { return !!this.config.enabled; }

  setEnabled(b) {
    this.config.enabled = !!b;
    this._save();
    this.log({ type: 'global_toggle', enabled: this.config.enabled, at: new Date().toISOString() });
  }

  setMaxHops(n) {
    const v = Math.max(1, Math.min(20, Math.trunc(Number(n) || 5)));
    this.config.maxHopsDefault = v;
    this._save();
  }

  /** 增 / 改一条规则（按 id；内置规则 id 以 builtin- 前缀，可改但不能删 enabled 配置改为 false 即可） */
  upsertRule(input) {
    if (this.config.rules.length >= MAX_RULES && !this.config.rules.find((r) => r.id === input.id)) {
      throw new Error(`规则数已达上限 ${MAX_RULES}`);
    }
    const clean = sanitizeRule(input);
    if (!clean) throw new Error('规则不合法（name / when / action 必填，action=forward 时 targetMode 必填）');
    const i = this.config.rules.findIndex((r) => r.id === clean.id);
    if (i >= 0) this.config.rules[i] = clean;
    else this.config.rules.push(clean);
    this._save();
    return clean;
  }

  deleteRule(id) {
    if (typeof id !== 'string' || !id) return false;
    if (id.startsWith('builtin-')) return false;  // 内置不可删
    const i = this.config.rules.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.config.rules.splice(i, 1);
    this._save();
    return true;
  }

  /** 拿匹配的规则（按 event + 房 mode） */
  matchingRules(eventType, roomMode) {
    if (!this.isEnabled()) return [];
    return this.config.rules.filter((r) => {
      if (!r.enabled) return false;
      if (r.when !== eventType) return false;
      if (r.sourceMode && roomMode && r.sourceMode !== roomMode) return false;
      return true;
    });
  }

  /** 写日志（append-only） */
  log(entry) {
    try {
      const line = JSON.stringify({ ...entry, at: entry.at || new Date().toISOString() }) + '\n';
      appendFileSync(LOG_FILE, line, { mode: 0o600 });
    } catch (e) {
      console.warn('[autopilot] log append failed:', e.message);
    }
  }

  /** 读最近 N 条日志 */
  recentLogs(limit = 100) {
    if (!existsSync(LOG_FILE)) return [];
    try {
      const lines = readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean);
      const tail = lines.slice(-Math.max(1, Math.min(1000, limit)));
      return tail.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
}

export const autopilotStore = new AutopilotStore();
