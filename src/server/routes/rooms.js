// Xike Lab — Rooms routes (S18-2e2 + P3 compact list)
// 6 个核心 routes：GET list / GET search / POST create / GET :id / DELETE :id / PATCH :id
// list 默认返回轻量摘要；旧完整列表保留为 GET /api/rooms?full=1
//
// 不在本 module 范围（仍留 server.js）：
//   - POST /api/rooms/:id/debate / forward / retry-turn / retry-task / resume / abort / chat / quick
//   - 这些 advanced endpoints 依赖更多 helpers（broadcastRoom/roomAdapterPool/etc）和 ws 状态

import { statSync } from 'fs';
import { homedir } from 'os';
import { hasFeature, getCurrentTier } from '../../license/LicenseManager.js';
import { objectiveSummary, sanitizeLineage, sanitizeObjective } from '../../room/RoomLineage.js';
import { buildRoleCardsForMembers, summarizeRoleCards } from '../../room/roleCards.js';
// Round 5 H#6：rooms 写端点会拉起 LLM dispatcher 烧配额、注入 adapter、毁聊天 → 全部 owner-token
import { requireOwnerToken } from '../auth/owner-token.js';

const ROOM_LIST_FULL_VALUES = new Set(['1', 'true', 'yes', 'on']);

function wantsFullRoomList(query = {}) {
  return ROOM_LIST_FULL_VALUES.has(String(query.full || '').toLowerCase());
}

function countTurns(rounds) {
  if (!Array.isArray(rounds)) return 0;
  return rounds.reduce((sum, round) => sum + (Array.isArray(round?.turns) ? round.turns.length : 0), 0);
}

function memberSummary(member = {}) {
  return {
    adapterId: typeof member.adapterId === 'string' ? member.adapterId : '',
    displayName: typeof member.displayName === 'string' ? member.displayName : '',
    model: typeof member.model === 'string' ? member.model : '',
    role: typeof member.role === 'string' ? member.role : undefined,
    enabled: member.enabled !== false,
  };
}

export function summarizeRoom(room = {}) {
  const rounds = Array.isArray(room.rounds) ? room.rounds : [];
  const taskList = Array.isArray(room.taskList) ? room.taskList : [];
  const conversation = Array.isArray(room.conversation) ? room.conversation : [];
  const userInterventions = Array.isArray(room.userInterventions) ? room.userInterventions : [];
  return {
    id: room.id,
    name: room.name,
    mode: room.mode,
    status: room.status,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    cwd: room.cwd,
    archived: room.archived === true,
    archivedAt: room.archivedAt || null,
    currentRound: room.currentRound,
    currentMacroRound: room.currentMacroRound,
    debateRounds: room.debateRounds,
    qaStrictness: room.qaStrictness,
    skills: Array.isArray(room.skills) ? room.skills : undefined,
    exportPath: typeof room.exportPath === 'string' ? room.exportPath : undefined,
    members: Array.isArray(room.members) ? room.members.map(memberSummary) : [],
    roundCount: rounds.length,
    turnCount: countTurns(rounds),
    taskCount: taskList.length,
    conversationCount: conversation.length,
    userInterventionCount: userInterventions.length,
    hasFinalConsensus: typeof room.finalConsensus === 'string' && room.finalConsensus.length > 0,
    objective: objectiveSummary(room.objective),
    projectContext: room.projectContextSummary || (room.projectContext ? {
      fileCount: Array.isArray(room.projectContext.files) ? room.projectContext.files.length : 0,
      totalChars: Number(room.projectContext.totalChars) || 0,
      truncated: !!room.projectContext.truncated,
    } : null),
    roleCards: summarizeRoleCards(room.roleCards),
    lineage: room.lineage ? {
      projectId: room.lineage.projectId || '',
      parentRoomId: room.lineage.parentRoomId || null,
      parentTaskId: room.lineage.parentTaskId || null,
      taskId: room.lineage.taskId || null,
      objectiveId: room.lineage.objectiveId || room.objective?.id || null,
      source: room.lineage.source || 'manual',
    } : undefined,
  };
}

function roomListResponse(rooms, query = {}) {
  if (wantsFullRoomList(query)) {
    return { ok: true, rooms, compact: false };
  }
  return { ok: true, rooms: rooms.map(summarizeRoom), compact: true };
}

function searchRooms({ roomStore, query }) {
  const q = query.q;
  if (!q || typeof q !== 'string' || !q.trim()) return { status: 400, body: { error: 'q required' } };
  if (q.length > 200) return { status: 400, body: { error: 'q 过长（>200）' } };
  const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 30));
  const includeArchived = query.includeArchived === '1';
  const needle = q.toLowerCase();
  const perRoomCap = Math.max(3, Math.ceil(limit / 4));
  const hardCap = limit * 5;
  const hits = [];

  function pushHit(room, where, snippet, extra = {}) {
    const lc = String(snippet || '').toLowerCase();
    const idx = lc.indexOf(needle);
    if (idx < 0) return false;
    const s = String(snippet);
    const start = Math.max(0, idx - 60);
    const end = Math.min(s.length, idx + needle.length + 60);
    hits.push({
      roomId: room.id,
      roomName: room.name,
      mode: room.mode,
      where,
      snippet: (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : ''),
      updatedAt: room.updatedAt || room.createdAt,
      ...extra,
    });
    return true;
  }

  const allRooms = includeArchived
    ? [...roomStore.list(), ...roomStore.listArchived()]
    : roomStore.list();

  outer: for (const room of allRooms) {
    let perRoomHits = 0;
    for (const field of ['name', 'topic', 'finalConsensus']) {
      if (pushHit(room, field, room[field])) perRoomHits++;
      if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
    }
    if (perRoomHits < perRoomCap && hits.length < hardCap && room.objective) {
      if (pushHit(room, 'objective:title', room.objective.title)) perRoomHits++;
      if (pushHit(room, 'objective:description', room.objective.description)) perRoomHits++;
      for (const [i, criterion] of (room.objective.acceptanceCriteria || []).entries()) {
        if (pushHit(room, `objective:acceptance:${i + 1}`, criterion)) perRoomHits++;
        if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
      }
    }
    if (perRoomHits >= perRoomCap || hits.length >= hardCap) {
      if (hits.length >= hardCap) break outer;
      continue;
    }
    for (const r of (room.rounds || [])) {
      for (const t of (r.turns || [])) {
        if (pushHit(room, `turn:${r.kind}`, t.content, { speaker: t.speaker })) perRoomHits++;
        if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
      }
      if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
    }
    if (perRoomHits >= perRoomCap || hits.length >= hardCap) {
      if (hits.length >= hardCap) break outer;
      continue;
    }
    for (const c of (room.conversation || [])) {
      if (pushHit(room, `chat:${c.from}`, c.content)) perRoomHits++;
      if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
    }
    if (perRoomHits >= perRoomCap || hits.length >= hardCap) {
      if (hits.length >= hardCap) break outer;
      continue;
    }
    for (const task of (room.taskList || [])) {
      if (pushHit(room, `task:${task.id}.title`, task.title)) perRoomHits++;
      if (pushHit(room, `task:${task.id}.desc`, task.desc)) perRoomHits++;
      for (const at of (task.attempts || [])) {
        if (pushHit(room, `task:${task.id}.attempt`, at.content)) perRoomHits++;
        if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
      }
      if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
    }
    if (hits.length >= hardCap) break outer;
  }

  hits.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const finalHits = hits.slice(0, limit);
  return { status: 200, body: { ok: true, query: q, count: finalHits.length, total: hits.length, hits: finalHits } };
}

export function registerRoomsRoutes(app, deps) {
  const {
    roomStore, safeResolveFsPath, safeSlice, roomAdapterPool,
    debateDispatcher, squadDispatcher, arenaDispatcher, soloChatDispatcher,
    roomWsClients,
    MAX_ROOMS = 500,
  } = deps;

  // 房间列表
  app.get('/api/rooms', (req, res) => {
    // v0.52 ?archived=1 返已归档列表；默认返活跃
    if (req.query?.archived === '1') {
      return res.json(roomListResponse(roomStore.listArchived(), req.query));
    }
    res.json(roomListResponse(roomStore.list(), req.query));
  });

  // 创建房间
  app.post('/api/rooms', requireOwnerToken, (req, res) => {
    if (roomStore.list().length >= MAX_ROOMS) {
      return res.status(429).json({ error: `已达房间总数上限（${MAX_ROOMS}）。先删除一些旧房间` });
    }
    const { name, cwd, members, mode, defaultPartner, objective, lineage } = req.body || {};
    // v0.49 N-07 fix: cwd 必须在沙箱内
    let roomCwd = homedir();
    if (cwd && typeof cwd === 'string' && cwd.trim()) {
      if (cwd.length > 1024) return res.status(400).json({ error: 'cwd 过长' });
      const safe = safeResolveFsPath(cwd.trim());
      if (!safe) return res.status(403).json({ error: 'cwd 越权或敏感目录' });
      try {
        const st = statSync(safe);
        if (!st.isDirectory()) return res.status(400).json({ error: 'cwd 不是目录' });
        roomCwd = safe;
      } catch {
        return res.status(400).json({ error: 'cwd 不存在' });
      }
    }
    if (typeof name === 'string' && name.length > 200) return res.status(400).json({ error: 'name 过长' });
    let roomMode;
    if (mode === 'squad') roomMode = 'squad';
    else if (mode === 'chat') roomMode = 'chat';
    else if (mode === 'arena') roomMode = 'arena';
    else roomMode = 'debate';

    // v1.5 Task 3.2 — Pro tier gate for squad/arena
    if ((roomMode === 'squad' || roomMode === 'arena') && !hasFeature(roomMode)) {
      return res.status(402).json({
        error: `${roomMode === 'squad' ? 'AI 团队拆活（squad）' : '多模型联网核对（arena）'} 模式需要 Pro license`,
        tier: getCurrentTier(),
        feature: roomMode,
        upgradeUrl: 'https://panel.app/pricing',
      });
    }

    let defaultMembers;
    if (roomMode === 'squad') {
      defaultMembers = members || [
        { adapterId: 'claude', displayName: '🟣 Claude · PM',  role: 'pm',  enabled: true },
        { adapterId: 'claude', displayName: '🟣 Claude · Dev', role: 'dev', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT · Dev',     role: 'dev', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT · QA',      role: 'qa',  enabled: true },
      ];
    } else if (roomMode === 'arena') {
      defaultMembers = members || [
        { adapterId: 'claude', displayName: '🟣 Claude（提案 + Judge）', role: 'judge', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT', enabled: true },
        { adapterId: 'gemini-cli', displayName: '🔷 Gemini CLI', enabled: roomAdapterPool.has('gemini-cli') },
        { adapterId: 'minimax', displayName: '🟡 MiniMax', enabled: roomAdapterPool.has('minimax') },
      ].filter(m => roomAdapterPool.has(m.adapterId));
    } else if (roomMode === 'chat') {
      const partner = (defaultPartner && roomAdapterPool.has(defaultPartner)) ? defaultPartner : 'codex';
      const partnerNames = { claude: '🟣 Claude', codex: '🟢 GPT', ollama: '🔵 Ollama', minimax: '🟡 MiniMax', ccr: '🔄 Claude Router' };
      const partnerDisplay = partnerNames[partner] || roomAdapterPool.get(partner)?.displayName || partner;
      defaultMembers = members || [
        { adapterId: partner, displayName: partnerDisplay, enabled: true },
      ];
    } else {
      defaultMembers = members || [
        { adapterId: 'claude', displayName: '🟣 Claude', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT',     enabled: true },
        { adapterId: 'ollama', displayName: '🔵 Ollama（顶位 MiniMax）', enabled: true },
      ];
    }
    const room = roomStore.create({
      name,
      cwd: roomCwd,
      members: defaultMembers,
      mode: roomMode,
      objective: sanitizeObjective(objective, { fallbackTitle: typeof name === 'string' ? name : '' }),
      lineage: sanitizeLineage(lineage, { projectId: roomCwd }),
    });
    res.json({ ok: true, room });
  });

  // v0.53 Sprint 3.5：跨房搜索（必须注册在 /api/rooms/:id 前，避免 search 被当成房间 id）
  app.get('/api/rooms/search', requireOwnerToken, (req, res) => {
    const result = searchRooms({ roomStore, query: req.query || {} });
    res.status(result.status).json(result.body);
  });

  // 获取单房间
  app.get('/api/rooms/:id', (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, room: r });
  });

  // 删除房间
  app.delete('/api/rooms/:id', requireOwnerToken, (req, res) => {
    const id = req.params.id;
    // v0.49 N-20 fix: 删房间前先 abort dispatcher + 关 ws clients，避免泄漏
    // v0.53 fix: 之前漏 arenaDispatcher
    try { debateDispatcher.abort(id); } catch {}
    try { squadDispatcher.abort(id); } catch {}
    try { arenaDispatcher.abort(id); } catch {}
    try { soloChatDispatcher.abort(id); } catch {}
    const set = roomWsClients.get(id);
    if (set) {
      for (const ws of set) { try { ws.close(); } catch {} }
      roomWsClients.delete(id);
    }
    const ok = roomStore.delete(id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // 更新成员 / 名字 / cwd / qaStrictness
  app.patch('/api/rooms/:id', requireOwnerToken, (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const patch = {};
    if (typeof req.body?.name === 'string') patch.name = safeSlice(String(req.body.name), 200);
    // v0.49 N-07 fix: PATCH cwd 也走沙箱
    if (typeof req.body?.cwd === 'string' && req.body.cwd.trim()) {
      if (req.body.cwd.length > 1024) return res.status(400).json({ error: 'cwd 过长' });
      const safe = safeResolveFsPath(req.body.cwd.trim());
      if (!safe) return res.status(403).json({ error: 'cwd 越权或敏感目录' });
      try {
        const st = statSync(safe);
        if (!st.isDirectory()) return res.status(400).json({ error: 'cwd 不是目录' });
        patch.cwd = safe;
      } catch { return res.status(400).json({ error: 'cwd 不存在' }); }
    }
    // v0.43 P1 #8: members 校验
    if (Array.isArray(req.body?.members)) {
      const validRoles = new Set(['pm', 'dev', 'qa', 'observer']);
      const validArenaRoles = new Set(['judge', 'observer']);
      const isSquad = r.mode === 'squad';
      const isArena = r.mode === 'arena';
      if (isSquad) {
        for (const [i, m] of req.body.members.entries()) {
          if (m?.role && !validRoles.has(m.role)) {
            return res.status(422).json({ error: `members[${i}].role 不合法（必须是 pm/dev/qa/observer），收到: ${m.role}` });
          }
        }
      } else if (isArena) {
        for (const [i, m] of req.body.members.entries()) {
          if (m?.role && !validArenaRoles.has(m.role)) {
            return res.status(422).json({ error: `members[${i}].role 不合法（arena 房仅支持 judge/observer 或留空），收到: ${m.role}` });
          }
        }
      }
      const members = req.body.members.slice(0, 30).map(m => ({
        adapterId: roomAdapterPool.has(m?.adapterId) ? m.adapterId : 'claude',
        displayName: safeSlice(String(m?.displayName || m?.adapterId || '成员'), 80),
        model: typeof m?.model === 'string' ? safeSlice(m.model, 80) : '',
        role: (isSquad && validRoles.has(m?.role)) ? m.role
            : (isArena && validArenaRoles.has(m?.role)) ? m.role
            : (isSquad ? 'dev' : undefined),
        enabled: m?.enabled !== false,
      }));
      patch.members = members;
      patch.roleCards = buildRoleCardsForMembers(members, { mode: r.mode, existing: r.roleCards });
    }
    if (Array.isArray(req.body?.roleCards)) {
      patch.roleCards = buildRoleCardsForMembers(r.members || [], { mode: r.mode, existing: req.body.roleCards });
    }
    if (typeof req.body?.qaStrictness === 'string' && ['loose', 'standard', 'strict'].includes(req.body.qaStrictness)) {
      patch.qaStrictness = req.body.qaStrictness;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'objective')) {
      patch.objective = sanitizeObjective(req.body.objective, { fallbackTitle: r.name || '' });
      const nextLineage = sanitizeLineage(r.lineage, { projectId: r.cwd || homedir() });
      nextLineage.objectiveId = patch.objective?.id || null;
      patch.lineage = nextLineage;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'lineage')) {
      patch.lineage = sanitizeLineage(req.body.lineage, { projectId: r.cwd || homedir() });
      if (r.objective && !patch.lineage.objectiveId) patch.lineage.objectiveId = r.objective.id;
    }
    if (typeof req.body?.archived === 'boolean') {
      patch.archived = req.body.archived;
      patch.archivedAt = req.body.archived ? new Date().toISOString() : null;
    }
    if (req.body?.debateRounds !== undefined) {
      const n = Number(req.body.debateRounds);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 10) {
        return res.status(422).json({ error: 'debateRounds 必须是 1-10 的整数' });
      }
      patch.debateRounds = n;
    }
    if (Array.isArray(req.body?.skills)) {
      patch.skills = req.body.skills
        .filter((n) => typeof n === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(n))
        .slice(0, 20);
    }
    if (typeof req.body?.exportPath === 'string') {
      const p = req.body.exportPath.trim();
      if (p === '') {
        patch.exportPath = '';
      } else {
        if (p.length > 1024) return res.status(400).json({ error: 'exportPath 过长' });
        const safe = safeResolveFsPath(p);
        if (!safe) return res.status(403).json({ error: 'exportPath 越权或敏感目录' });
        patch.exportPath = safe;
      }
    }
    const updated = roomStore.update(req.params.id, patch);
    res.json({ ok: true, room: updated });
  });
}
