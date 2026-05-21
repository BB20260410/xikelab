// v0.54 Sprint 4.5 — 聊天归档系统
//
// 功能：房完成时（debate_done/squad_done/arena_done）自动把内容导出成 markdown 文件存到用户指定路径，
//      按时间/房名分目录归档，支持房级别覆盖目标路径。
//
// 文件：~/.claude-panel/archive-config.json
//   {
//     version: 1,
//     rootPath: "/abs/path/or/~/...",
//     structure: "time-then-room" | "room-then-time" | "flat",
//     timeFormat: "YYYY-MM-DD" | "YYYY-MM",
//     autoArchive: true,
//     events: ["debate_done","squad_done","arena_done"]
//   }
//
// 房级 exportPath 在 ChatRoomStore.room.exportPath，覆盖 rootPath（其他配置仍用全局）

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DIR = join(homedir(), '.claude-panel');
const CONFIG_FILE = join(DIR, 'archive-config.json');

export const VALID_STRUCTURES = ['time-then-room', 'room-then-time', 'flat'];
export const VALID_TIME_FORMATS = ['YYYY-MM-DD', 'YYYY-MM'];
export const VALID_EVENTS = ['debate_done', 'squad_done', 'arena_done'];

const DEFAULT_ROOT = join(homedir(), 'Documents', 'roundtable-archive');
const DEFAULT_CONFIG = {
  version: 1,
  rootPath: DEFAULT_ROOT,
  structure: 'time-then-room',
  timeFormat: 'YYYY-MM-DD',
  autoArchive: false,                       // 默认关，让用户主动开
  events: ['debate_done', 'squad_done', 'arena_done'],
};

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

function timeStringFor(ts, format) {
  const d = new Date(ts);
  if (isNaN(d)) return new Date().toISOString().slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (format === 'YYYY-MM') return `${y}-${m}`;
  return `${y}-${m}-${dd}`;  // 默认 YYYY-MM-DD
}

/** 文件名 sanitize：去掉 / \ : * ? " < > | 和控制字符；保留中文 */
function safeFilename(s, maxLen = 60) {
  return String(s || '')
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')   // 防 hidden file
    .trim()
    .slice(0, maxLen) || '未命名';
}

/** 沙箱：path 必须在 home/tmp 内 + 不能命中敏感目录（复用 panel 的安全策略） */
function isPathSafe(absPath) {
  const home = homedir();
  const allowed = [home, '/tmp', '/private/tmp', '/Volumes'];
  if (!allowed.some((root) => absPath === root || absPath.startsWith(root + '/'))) return false;
  const forbidden = ['/.ssh', '/.aws', '/.gnupg', '/.docker', '/.kube', '/Library/Keychains'];
  if (forbidden.some((seg) => absPath.includes(home + seg))) return false;
  return true;
}

export class ArchiveStore {
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this._ensureDir();
    this._load();
  }

  _ensureDir() {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
  }

  _load() {
    if (!existsSync(CONFIG_FILE)) return;
    try {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      const data = JSON.parse(raw);
      this.config = { ...DEFAULT_CONFIG, ...this._sanitize(data) };
    } catch (e) {
      console.warn('[archive] load failed:', e.message);
    }
  }

  _sanitize(input) {
    const out = {};
    if (typeof input.rootPath === 'string' && input.rootPath.length > 0 && input.rootPath.length < 1024) {
      out.rootPath = input.rootPath;
    }
    if (VALID_STRUCTURES.includes(input.structure)) out.structure = input.structure;
    if (VALID_TIME_FORMATS.includes(input.timeFormat)) out.timeFormat = input.timeFormat;
    if (typeof input.autoArchive === 'boolean') out.autoArchive = input.autoArchive;
    if (Array.isArray(input.events)) {
      out.events = input.events.filter((e) => VALID_EVENTS.includes(e));
      if (out.events.length === 0) out.events = [...DEFAULT_CONFIG.events];
    }
    return out;
  }

  _save() {
    try {
      writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), { mode: 0o600 });
      try { chmodSync(CONFIG_FILE, 0o600); } catch {}
    } catch (e) {
      console.warn('[archive] save failed:', e.message);
    }
  }

  getConfig() { return { ...this.config }; }
  updateConfig(patch) {
    const cleaned = this._sanitize(patch || {});
    this.config = { ...this.config, ...cleaned };
    this._save();
    return this.getConfig();
  }

  /** 给一个 room 算出归档目录（绝对路径） */
  _resolveArchiveDir(room) {
    // 房 exportPath 覆盖 base
    const base = room?.exportPath
      ? expandHome(room.exportPath)
      : expandHome(this.config.rootPath || DEFAULT_ROOT);
    const struct = this.config.structure;
    const timeStr = timeStringFor(room.createdAt || new Date().toISOString(), this.config.timeFormat);
    const shortId = String(room.id || '').slice(0, 8);
    const roomDir = safeFilename(room.name || '') + '-' + shortId;
    let target;
    if (struct === 'flat') target = base;
    else if (struct === 'room-then-time') target = join(base, roomDir, timeStr);
    else target = join(base, timeStr, roomDir);   // 默认 time-then-room
    return target;
  }

  /** 把房导出成 markdown 文件 + meta.json 到目标目录 */
  archiveRoom(room) {
    if (!room || typeof room !== 'object') return { ok: false, error: 'room invalid' };

    const targetDir = this._resolveArchiveDir(room);
    if (!isPathSafe(targetDir)) {
      return { ok: false, error: `归档路径越权或位于敏感目录: ${targetDir}` };
    }

    try {
      mkdirSync(targetDir, { recursive: true });
    } catch (e) {
      return { ok: false, error: 'mkdir 失败: ' + e.message };
    }

    const files = [];

    // 1) final-consensus.md
    if (room.finalConsensus) {
      const f = join(targetDir, 'final-consensus.md');
      try {
        writeFileSync(f, this._renderFinalMd(room), 'utf-8');
        files.push('final-consensus.md');
      } catch (e) {
        return { ok: false, error: 'final 写盘失败: ' + e.message };
      }
    }

    // 2) full-transcript.md
    try {
      const f = join(targetDir, 'full-transcript.md');
      writeFileSync(f, this._renderTranscriptMd(room), 'utf-8');
      files.push('full-transcript.md');
    } catch (e) {
      return { ok: false, error: 'transcript 写盘失败: ' + e.message };
    }

    // 3) meta.json
    try {
      const f = join(targetDir, 'meta.json');
      const meta = {
        id: room.id,
        name: room.name,
        mode: room.mode,
        status: room.status,
        createdAt: room.createdAt,
        cwd: room.cwd,
        members: (room.members || []).map((m) => ({
          adapterId: m.adapterId, displayName: m.displayName, model: m.model, role: m.role, enabled: m.enabled !== false,
        })),
        debateRounds: room.debateRounds,
        qaStrictness: room.qaStrictness,
        topic: room.topic,
        finalDegraded: room.finalDegraded || false,
        roundCount: (room.rounds || []).length,
        taskCount: (room.taskList || []).length,
        conversationLen: (room.conversation || []).length,
        archivedAt: new Date().toISOString(),
        archivedBy: 'panel-v0.54-Sprint4.5',
      };
      writeFileSync(f, JSON.stringify(meta, null, 2), 'utf-8');
      files.push('meta.json');
    } catch (e) {
      return { ok: false, error: 'meta 写盘失败: ' + e.message };
    }

    return { ok: true, dir: targetDir, files };
  }

  _renderFinalMd(room) {
    const lines = [];
    lines.push(`# ${room.name || '未命名'} · 最终输出`);
    lines.push('');
    lines.push(`- **模式**：${room.mode}`);
    lines.push(`- **创建于**：${room.createdAt || '-'}`);
    lines.push(`- **房 ID**：${room.id}`);
    if (room.topic) {
      lines.push('');
      lines.push('## 任务 / topic');
      lines.push('');
      lines.push(room.topic);
    }
    lines.push('');
    lines.push('## 最终共识 / 输出');
    lines.push('');
    if (room.finalDegraded) lines.push('> ⚠️ Judge 失败，下面是降级版本');
    lines.push(room.finalConsensus || '（无 finalConsensus，房间可能未跑完或失败）');
    return lines.join('\n');
  }

  _renderTranscriptMd(room) {
    const lines = [];
    lines.push(`# ${room.name || '未命名'} · 完整记录`);
    lines.push('');
    lines.push(`- **模式**：${room.mode}`);
    lines.push(`- **创建于**：${room.createdAt || '-'}`);
    lines.push(`- **成员**：${(room.members || []).map((m) => m.displayName || m.adapterId).join(' / ')}`);
    if (room.topic) {
      lines.push('');
      lines.push('## 任务 / topic');
      lines.push('');
      lines.push(room.topic);
    }

    // chat 模式：conversation
    if (room.mode === 'chat' && Array.isArray(room.conversation)) {
      lines.push('');
      lines.push('## 对话');
      lines.push('');
      for (const c of room.conversation) {
        const who = c.from === 'user' ? '🧑 用户' : `🤖 ${c.displayName || c.from}`;
        lines.push(`### ${who} · ${c.at || ''}`);
        lines.push('');
        lines.push(c.content || '');
        lines.push('');
      }
    }

    // debate/arena/squad：rounds[].turns[]
    if (Array.isArray(room.rounds) && room.rounds.length > 0) {
      lines.push('');
      lines.push('## 轮次记录');
      lines.push('');
      for (const r of room.rounds) {
        lines.push(`### Round ${r.roundNo || '?'} · ${r.kind}`);
        lines.push('');
        for (const t of (r.turns || [])) {
          const tag = t.error ? '❌ ' : '';
          lines.push(`#### ${tag}${t.displayName || t.speaker} · ${t.at || ''}${t.tokensOut ? ` (${t.tokensOut} tok)` : ''}`);
          lines.push('');
          lines.push(t.content || '');
          lines.push('');
        }
      }
    }

    // squad 房：taskList
    if (Array.isArray(room.taskList) && room.taskList.length > 0) {
      lines.push('');
      lines.push('## 任务清单');
      lines.push('');
      for (const t of room.taskList) {
        lines.push(`### ${t.id} · ${t.title || ''}`);
        lines.push('');
        lines.push(`- **status**：${t.status} · **iterations**：${t.iterations}/${t.maxIterations}`);
        lines.push(`- **desc**：${(t.desc || '').replace(/\n/g, ' ')}`);
        if (t.escalateReason) lines.push(`- **升级原因**：${t.escalateReason}`);
        if (t.attempts?.length) {
          lines.push('');
          lines.push('**Dev 尝试**：');
          for (let i = 0; i < t.attempts.length; i++) {
            const a = t.attempts[i];
            lines.push('');
            lines.push(`<details><summary>尝试 #${i + 1}${a.error ? '（失败）' : ''} · ${a.by || '?'}</summary>\n\n${a.content || ''}\n\n</details>`);
          }
        }
        if (t.reviews?.length) {
          lines.push('');
          lines.push('**QA 审查**：');
          for (let i = 0; i < t.reviews.length; i++) {
            const r2 = t.reviews[i];
            lines.push(`- 第 ${i + 1} 次 · verdict=${r2.verdict} · confidence=${r2.confidence || '-'}：${r2.reasoning || ''}`);
            if (r2.issues?.length) for (const is of r2.issues) lines.push(`  - issue: ${is}`);
          }
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  /** 列已归档房（扫 rootPath 下的子目录拿 meta.json） */
  listArchives() {
    const root = expandHome(this.config.rootPath || DEFAULT_ROOT);
    if (!isPathSafe(root)) return { ok: false, error: '配置的 rootPath 越权', items: [] };
    if (!existsSync(root)) return { ok: true, root, items: [] };
    const items = [];
    const struct = this.config.structure;

    function scan(dir, depth) {
      if (depth > 4 || items.length > 500) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      // 看这一层有没有 meta.json
      const meta = entries.find((e) => e.isFile() && e.name === 'meta.json');
      if (meta) {
        try {
          const m = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
          items.push({
            dir,
            id: m.id,
            name: m.name,
            mode: m.mode,
            status: m.status,
            createdAt: m.createdAt,
            archivedAt: m.archivedAt,
          });
        } catch {}
        return;  // 这一层是房目录，不再深挖
      }
      // 否则继续往下挖
      for (const e of entries) {
        if (e.isDirectory()) scan(join(dir, e.name), depth + 1);
      }
    }
    scan(root, 0);
    items.sort((a, b) => String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')));
    return { ok: true, root, structure: struct, items };
  }
}

export const archiveStore = new ArchiveStore();
