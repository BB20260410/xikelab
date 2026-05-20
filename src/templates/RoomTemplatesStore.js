// v0.53 Sprint 3 — 房间模板存储
// 持久化用户保存的"快速创建模板"，附带 6 个内置模板（不可删）
// 文件：~/.claude-panel/room-templates.json

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const DIR = join(homedir(), '.claude-panel');
const FILE = join(DIR, 'room-templates.json');

const MAX_USER_TEMPLATES = 50;
const MAX_TEMPLATE_NAME = 80;
const MAX_TEMPLATE_DESC = 400;
const MAX_TEMPLATE_TOPIC_PH = 1000;

/** 6 个内置模板（builtin: true，永不可删/改）。前端按 id 排序展示。 */
const BUILTIN_TEMPLATES = [
  {
    id: 'builtin:debate-tech-review',
    name: '技术方案三方评审',
    description: 'Claude / GPT / Gemini-CLI 三方分别站架构/实现/挑刺立场，3 大轮收敛',
    builtin: true,
    mode: 'debate',
    preset: {
      members: [
        { adapterId: 'claude',     displayName: '🟣 Claude（架构师视角）', model: 'sonnet', enabled: true },
        { adapterId: 'codex',      displayName: '🟢 GPT（实现派视角）',    model: '', enabled: true },
        { adapterId: 'gemini-cli', displayName: '🔷 Gemini（挑刺派视角）', model: '', enabled: true },
      ],
      debateRounds: 3,
      qaStrictness: 'standard',
      topicPlaceholder: '粘贴你要评审的方案 / API 设计 / 重构计划',
    },
  },
  {
    id: 'builtin:arena-fact-check',
    name: '事实型问题多组对决（带联网核对）',
    description: 'N 个 AI 并行各自答 → Claude judge 联网核实 → 综合最优。适合需要权威事实/最新数据的问题',
    builtin: true,
    mode: 'arena',
    preset: {
      members: [
        { adapterId: 'claude',     displayName: '🟣 Claude（提案 + Judge）', role: 'judge', model: 'sonnet', enabled: true },
        { adapterId: 'codex',      displayName: '🟢 GPT',  model: '', enabled: true },
        { adapterId: 'gemini-cli', displayName: '🔷 Gemini-CLI', model: '', enabled: true },
        { adapterId: 'minimax',    displayName: '🟡 MiniMax', model: '', enabled: false },
      ],
      topicPlaceholder: '提一个需要权威事实/最新数据的问题，比如"2026 年 iOS 18 引入了哪些 SwiftUI API？"',
    },
  },
  {
    id: 'builtin:squad-impl',
    name: '一句话需求 → 拆分实现',
    description: 'PM 拆任务 → 并行 Dev 实现 → QA 审查循环到 pass。适合具体可分解的开发任务',
    builtin: true,
    mode: 'squad',
    preset: {
      members: [
        { adapterId: 'claude', displayName: '🟣 Claude · PM',  role: 'pm',  model: 'sonnet', enabled: true },
        { adapterId: 'claude', displayName: '🟣 Claude · Dev', role: 'dev', model: 'sonnet', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT · Dev',    role: 'dev', model: '',       enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT · QA',     role: 'qa',  model: '',       enabled: true },
      ],
      qaStrictness: 'standard',
      topicPlaceholder: '描述一个具体需求，含验收标准。例：实现一个 Express 中间件，记录每个请求的 latency 到 prometheus',
    },
  },
  {
    id: 'builtin:debate-quick',
    name: '快速二方对辩（2 轮）',
    description: 'Claude vs GPT 2 大轮，适合不需要深度但要双视角的问题',
    builtin: true,
    mode: 'debate',
    preset: {
      members: [
        { adapterId: 'claude', displayName: '🟣 Claude', model: 'sonnet', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT',    model: '', enabled: true },
      ],
      debateRounds: 2,
      qaStrictness: 'standard',
      topicPlaceholder: '提一个需要双视角的问题',
    },
  },
  {
    id: 'builtin:arena-translation',
    name: '长文翻译质量对决',
    description: '多模型并行翻译同一段 → judge 综合给出最优译本（带改进建议）',
    builtin: true,
    mode: 'arena',
    preset: {
      members: [
        { adapterId: 'claude',     displayName: '🟣 Claude', role: 'judge', model: 'sonnet', enabled: true },
        { adapterId: 'codex',      displayName: '🟢 GPT', model: '', enabled: true },
        { adapterId: 'gemini-cli', displayName: '🔷 Gemini', model: '', enabled: true },
        { adapterId: 'minimax',    displayName: '🟡 MiniMax', model: '', enabled: false },
      ],
      topicPlaceholder: '粘贴英文原文 + 翻译要求（领域 / 语气 / 长度限制）',
    },
  },
  {
    id: 'builtin:chat-gemini',
    name: '和 Gemini 闲聊（带联网）',
    description: '1v1 持续对话，gemini-cli 有 Google Search 工具，适合查询/求建议',
    builtin: true,
    mode: 'chat',
    preset: {
      members: [
        { adapterId: 'gemini-cli', displayName: '🔷 Gemini CLI', model: '', enabled: true },
      ],
      topicPlaceholder: '直接开聊',
    },
  },
];

function sanitizeMember(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {
    adapterId: String(m.adapterId || '').slice(0, 64),
    displayName: String(m.displayName || '').slice(0, 200),
  };
  if (!out.adapterId) return null;
  if (m.role && ['pm', 'dev', 'qa', 'judge'].includes(m.role)) out.role = m.role;
  if (typeof m.model === 'string') out.model = m.model.slice(0, 100);
  out.enabled = m.enabled !== false;
  return out;
}

function sanitizeTemplate(t, { allowBuiltinFlag = false } = {}) {
  if (!t || typeof t !== 'object') return null;
  const mode = ['debate', 'squad', 'arena', 'chat'].includes(t.mode) ? t.mode : null;
  if (!mode) return null;
  const name = String(t.name || '').slice(0, MAX_TEMPLATE_NAME).trim();
  if (!name) return null;
  const description = String(t.description || '').slice(0, MAX_TEMPLATE_DESC);
  const preset = t.preset || {};
  const members = Array.isArray(preset.members)
    ? preset.members.map(sanitizeMember).filter(Boolean).slice(0, 20)
    : [];
  if (members.length === 0) return null;
  const out = {
    name,
    description,
    mode,
    preset: {
      members,
      topicPlaceholder: String(preset.topicPlaceholder || '').slice(0, MAX_TEMPLATE_TOPIC_PH),
    },
    builtin: allowBuiltinFlag ? !!t.builtin : false,
  };
  if (mode === 'debate' && Number.isFinite(Number(preset.debateRounds))) {
    let n = Math.trunc(Number(preset.debateRounds));
    if (n < 1) n = 1;
    if (n > 10) n = 10;
    out.preset.debateRounds = n;
  }
  if (mode === 'squad' && ['loose', 'standard', 'strict'].includes(preset.qaStrictness)) {
    out.preset.qaStrictness = preset.qaStrictness;
  }
  return out;
}

export class RoomTemplatesStore {
  constructor() {
    this.userTemplates = [];   // builtin 在 BUILTIN_TEMPLATES 常量里，不入 userTemplates
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
      if (Array.isArray(data?.templates)) {
        this.userTemplates = data.templates
          .map((t) => {
            const clean = sanitizeTemplate(t);
            if (!clean) return null;
            return {
              id: typeof t.id === 'string' && t.id ? t.id : 'user:' + randomUUID().slice(0, 8),
              ...clean,
              builtin: false,
              createdAt: t.createdAt || new Date().toISOString(),
            };
          })
          .filter(Boolean)
          .slice(0, MAX_USER_TEMPLATES);
      }
    } catch (e) {
      console.warn('[room-templates] load failed:', e.message);
    }
  }

  _save() {
    try {
      const data = { version: 1, templates: this.userTemplates };
      writeFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
      try { chmodSync(FILE, 0o600); } catch {}
    } catch (e) {
      console.warn('[room-templates] save failed:', e.message);
    }
  }

  list() {
    return [
      ...BUILTIN_TEMPLATES.map((t) => ({ ...t, builtin: true })),
      ...this.userTemplates,
    ];
  }

  get(id) {
    if (!id) return null;
    return this.list().find((t) => t.id === id) || null;
  }

  create(input) {
    if (this.userTemplates.length >= MAX_USER_TEMPLATES) {
      throw new Error(`用户模板已达上限 ${MAX_USER_TEMPLATES}`);
    }
    const clean = sanitizeTemplate(input);
    if (!clean) throw new Error('模板内容不合法：mode/members/name 必填');
    const id = 'user:' + randomUUID().slice(0, 8);
    const created = {
      id,
      ...clean,
      builtin: false,
      createdAt: new Date().toISOString(),
    };
    this.userTemplates.push(created);
    this._save();
    return created;
  }

  delete(id) {
    if (!id || id.startsWith('builtin:')) return false;
    const idx = this.userTemplates.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this.userTemplates.splice(idx, 1);
    this._save();
    return true;
  }
}

export const roomTemplatesStore = new RoomTemplatesStore();
