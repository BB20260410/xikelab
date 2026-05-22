// panel v2.0 Task 4.1 — SQLite 存储 REST API
//
// Round 4 P1：events 表是审计/路由依据，kv 表存任意配置，写端点必须 owner-token

import { requireOwnerToken } from '../auth/owner-token.js';

export function registerStorageRoutes(app) {
  app.get('/api/storage/stats', async (req, res) => {
    try {
      const m = await import('../../storage/SqliteStore.js');
      m.initSqlite();
      res.json({ ok: true, ...m.getStats() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/storage/events', async (req, res) => {
    try {
      const m = await import('../../storage/SqliteStore.js');
      m.initSqlite();
      const { kind, room, tag, since, limit } = req.query;
      const events = m.listEvents({
        kind: kind || undefined,
        roomId: room || undefined,
        tag: tag || undefined,
        sinceTs: since ? parseInt(since, 10) : undefined,
        limit: limit ? Math.min(parseInt(limit, 10), 1000) : 200,
      });
      res.json({ ok: true, count: events.length, events });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/storage/events', requireOwnerToken, async (req, res) => {
    try {
      const { kind, ts, roomId, tag, ...rest } = req.body || {};
      if (!kind) return res.status(400).json({ error: 'kind required' });
      const m = await import('../../storage/SqliteStore.js');
      m.initSqlite();
      const id = m.appendEvent({ kind, ts, roomId, tag, ...rest });
      res.json({ ok: true, id: Number(id) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/storage/kv/:key', async (req, res) => {
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
