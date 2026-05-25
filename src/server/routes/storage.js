// panel v2.0 Task 4.1 — SQLite 存储 REST API
//
// Round 4 P1：events 表是审计/路由依据，kv 表存任意配置，写端点必须 owner-token

import { requireOwnerToken } from '../auth/owner-token.js';

export function registerStorageRoutes(app) {
  // Round 5 7M：所有 GET 都加 token — stats 信息少但 events/kv 全是房间路由/任意配置，统一鉴权
  app.get('/api/storage/stats', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../storage/SqliteStore.js');
      m.initSqlite();
      res.json({ ok: true, ...m.getStats() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/storage/events', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../storage/SqliteStore.js');
      m.initSqlite();
      const { kind, room, roomId, session, sessionId, tag, entityType, entityId, taskId, since, until, limit } = req.query;
      const events = m.listEvents({
        kind: kind || undefined,
        roomId: roomId || room || undefined,
        sessionId: sessionId || session || undefined,
        tag: tag || undefined,
        entityType: entityType || undefined,
        entityId: entityId || undefined,
        taskId: taskId || undefined,
        sinceTs: since ? parseInt(since, 10) : undefined,
        untilTs: until ? parseInt(until, 10) : undefined,
        limit: limit ? Math.min(parseInt(limit, 10), 1000) : 200,
      });
      res.json({ ok: true, count: events.length, events });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/storage/events', requireOwnerToken, async (req, res) => {
    try {
      const { kind, ts, roomId, sessionId, tag, entityType, entityId, taskId, ...rest } = req.body || {};
      if (!kind) return res.status(400).json({ error: 'kind required' });
      const m = await import('../../storage/SqliteStore.js');
      m.initSqlite();
      const id = m.appendEvent({ kind, ts, roomId, sessionId, tag, entityType, entityId, taskId, ...rest });
      res.json({ ok: true, id: Number(id) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/storage/kv/:key', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../storage/SqliteStore.js');
      m.initSqlite();
      res.json({ ok: true, key: req.params.key, value: m.kvGet(req.params.key) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.put('/api/storage/kv/:key', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../storage/SqliteStore.js');
      m.initSqlite();
      const changes = m.kvSet(req.params.key, req.body?.value);
      res.json({ ok: true, key: req.params.key, changes });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
