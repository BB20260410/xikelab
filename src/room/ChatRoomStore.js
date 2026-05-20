// ChatRoomStore — 房间数据结构 + 持久化（~/.claude-panel/rooms.json）
//
// 数据模型：
// room = {
//   id, name, createdAt, cwd,
//   members: [{ adapterId, displayName, model, enabled }],
//   topic: string,                  // 当前讨论的任务
//   debateRounds: number,           // v0.52 大轮数 N（R1→R2→R3 整组重复 N 次后跑一次 R4），默认 2，1~10
//   rounds: [                       // 每轮发言
//     { roundNo, kind:'r1_propose@<n>'|'r2_critique@<n>'|'r3_final@<n>'|'r4_judge'|'user',
//       turns: [{ speaker, displayName, content, at, tokensIn, tokensOut, error? }] }
//   ],
//   status: 'idle'|'running'|'paused'|'done'|'error',
//   currentRound: 0,                // 0=未开始, 1-3 phase 编号, 4=R4 judge, -1=已完成
//   currentMacroRound: 0,           // v0.52 当前大轮号（1..N）
//   finalConsensus: string|null,    // R4 judge 输出
//   userInterventions: [{ at, content }], // 用户中途插话
// }
//
// v0.52 兼容：老房间存的 kind 是 `r1_propose`（无 @n 后缀），前端 renderRounds 当作大轮 1 渲染。

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ROOM_LIMITS, DEBATE_LIMITS, CONTENT_LIMITS } from './squad-limits.js';

const STORE_FILE = join(homedir(), '.claude-panel', 'rooms.json');
const STORE_DIR = dirname(STORE_FILE);

export class ChatRoomStore {
  constructor() {
    this.rooms = new Map();
    this._saveTimer = null;
    this._savePending = false;
    this.load();
  }

  /** v0.44 P1 #15: debounce 异步写盘，避免高频 turn 风暴 */
  save() {
    this._savePending = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._savePending = false;
      this._doSave();
    }, ROOM_LIMITS.saveDebounceMs);
  }

  /** gracefulShutdown 时强制同步落盘（v0.45 P0-2: 无论 pending 与否都写一次，保证 in-memory state 一定落盘） */
  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._savePending = false;
    this._doSave();
  }

  load() {
    try {
      if (!existsSync(STORE_FILE)) return;
      const data = JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
      // v0.51 Y-03 fix: load 时 cap 200，避免 rooms.json 异常增长撑爆内存
      let rooms = Array.isArray(data.rooms) ? data.rooms : [];
      if (rooms.length > 200) {
        console.warn(`[ChatRoomStore.load] rooms.json 含 ${rooms.length} 个房间，超过 200 上限，仅加载最新 200`);
        rooms = [...rooms].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 200);
      }
      for (const r of rooms) {
        // v0.51 T-40 fix: 严格字段校验，跳过损坏条目避免 dispatcher 异常
        if (!r || typeof r.id !== 'string' || !r.id) continue;
        if (typeof r.name !== 'string') r.name = '未命名讨论';
        if (!Array.isArray(r.members)) r.members = [];
        if (!Array.isArray(r.rounds)) r.rounds = [];
        if (!Array.isArray(r.conversation)) r.conversation = [];
        if (!Array.isArray(r.taskList)) r.taskList = [];
        // 重启时把 running 改回 idle，避免假状态
        if (r.status === 'running') r.status = 'paused';
        this.rooms.set(r.id, r);
      }
    } catch (e) {
      // v0.51 B-01 fix: rooms.json 损坏时备份（避免下次 _doSave 原子写覆盖 → debate/squad 房间历史彻底丢）
      try {
        if (existsSync(STORE_FILE)) {
          const bak = STORE_FILE + '.corrupted-' + Date.now() + '.bak';
          copyFileSync(STORE_FILE, bak);
          console.error(`❌ rooms.json 损坏，已备份到 ${bak}：${e.message}`);
        } else {
          console.warn('ChatRoomStore.load failed:', e.message);
        }
      } catch (bakErr) {
        console.warn('ChatRoomStore.load failed (备份也失败):', e.message, '/', bakErr.message);
      }
    }
  }

  _doSave() {
    try {
      mkdirSync(STORE_DIR, { recursive: true });
      try { chmodSync(STORE_DIR, 0o700); } catch {}
      const data = { rooms: [...this.rooms.values()] };
      // v0.51 Y-05 fix: 原子写（tmp + rename）防 panel 崩溃中写入截断丢全部 rooms
      const tmp = STORE_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch {}
      renameSync(tmp, STORE_FILE);
    } catch (e) {
      console.warn('ChatRoomStore.save failed:', e.message);
    }
  }

  list() {
    // v0.52 默认只返非归档；想要归档列表用 listArchived()
    return [...this.rooms.values()].filter(r => !r.archived).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  listArchived() {
    return [...this.rooms.values()].filter(r => r.archived).sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''));
  }

  get(id) {
    return this.rooms.get(id);
  }

  create({ name, cwd, members, mode }) {
    const id = randomUUID();
    const room = {
      id,
      name: name || '未命名讨论',
      mode: ['squad', 'chat', 'debate', 'arena'].includes(mode) ? mode : 'debate',
      qaStrictness: 'standard',
      createdAt: new Date().toISOString(),
      cwd: cwd || process.cwd(),
      members: members || [],
      topic: '',
      debateRounds: DEBATE_LIMITS.defaultMacroRounds,
      rounds: [],
      taskList: [],
      conversation: [],
      status: 'idle',
      currentRound: 0,
      currentMacroRound: 0,
      finalConsensus: null,
      userInterventions: [],
      archived: false,                  // v0.52 归档标记
      archivedAt: null,
    };
    this.rooms.set(id, room);
    this.save();
    return room;
  }

  update(id, patch) {
    const r = this.rooms.get(id);
    if (!r) return null;
    // v0.51 S-14 fix: 防原型污染（即使调用方传 raw req.body）
    const safe = {};
    for (const k of Object.keys(patch || {})) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      safe[k] = patch[k];
    }
    Object.assign(r, safe);
    this.save();
    return r;
  }

  delete(id) {
    const ok = this.rooms.delete(id);
    if (ok) this.save();
    return ok;
  }

  appendTurn(roomId, roundKind, turn) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    // v0.51 ZZZZ-01 fix: 防 AI 输出 5MB 撑爆 rooms.json
    const MAX_TURN_CONTENT = CONTENT_LIMITS.maxReplyChars; // v0.52 256KB
    if (turn && typeof turn.content === 'string' && turn.content.length > MAX_TURN_CONTENT) {
      turn = { ...turn, content: turn.content.slice(0, MAX_TURN_CONTENT) + `\n\n…（已截断，原 ${turn.content.length} 字符）` };
    }
    // 找到当前 round 或新建
    let round = room.rounds[room.rounds.length - 1];
    if (!round || round.kind !== roundKind) {
      round = { roundNo: room.rounds.length + 1, kind: roundKind, turns: [] };
      room.rounds.push(round);
    }
    round.turns.push({ at: new Date().toISOString(), ...turn });
    this.save();
    return round;
  }

  setStatus(roomId, status, extras = {}) {
    const r = this.rooms.get(roomId);
    if (!r) return null;
    r.status = status;
    // v0.51 W-07 fix: 同 update 防原型污染一致
    for (const k of Object.keys(extras || {})) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      r[k] = extras[k];
    }
    this.save();
    return r;
  }
}
