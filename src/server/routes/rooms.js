// Xikely — Rooms 主 CRUD routes (S18-2e2)
// 5 个核心 routes：GET list / POST create / GET :id / DELETE :id / PATCH :id
// 从 server.js 2086-2271 提取，行为完全一致
//
// 不在本 module 范围（仍留 server.js）：
//   - POST /api/rooms/:id/debate / forward / retry-turn / retry-task / resume / abort / chat / quick / search
//   - 这些 advanced endpoints 依赖更多 helpers（broadcastRoom/roomAdapterPool/etc）和 ws 状态

import { statSync } from 'fs';
import { homedir } from 'os';
import { hasFeature, getCurrentTier } from '../../license/LicenseManager.js';

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
      return res.json({ ok: true, rooms: roomStore.listArchived() });
    }
    res.json({ ok: true, rooms: roomStore.list() });
  });

  // 创建房间
  app.post('/api/rooms', (req, res) => {
    if (roomStore.list().length >= MAX_ROOMS) {
      return res.status(429).json({ error: `已达房间总数上限（${MAX_ROOMS}）。先删除一些旧房间` });
    }
    const { name, cwd, members, mode, defaultPartner } = req.body || {};
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
      } catch (e) {
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
    const room = roomStore.create({ name, cwd: roomCwd, members: defaultMembers, mode: roomMode });
    res.json({ ok: true, room });
  });

  // 获取单房间
  app.get('/api/rooms/:id', (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, room: r });
  });

  // 删除房间
  app.delete('/api/rooms/:id', (req, res) => {
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
  app.patch('/api/rooms/:id', (req, res) => {
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
    }
    if (typeof req.body?.qaStrictness === 'string' && ['loose', 'standard', 'strict'].includes(req.body.qaStrictness)) {
      patch.qaStrictness = req.body.qaStrictness;
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
