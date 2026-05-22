// Xike Lab — Archive routes (S18-2b)
// v0.54 Sprint 4.5 — 归档配置 / 手动归档 / 列归档
// 从 server.js 1752-1788 提取，行为完全一致
//
// Round 4 P1：rootPath 是任意文件系统写入根目录 → 必须 owner-token

import { requireOwnerToken } from '../auth/owner-token.js';

export function registerArchiveRoutes(app, deps) {
  const { archiveStore, safeResolveFsPath, roomStore } = deps;

  app.get('/api/archive/config', (req, res) => {
    try {
      res.json({ ok: true, config: archiveStore.getConfig() });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.put('/api/archive/config', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 4 * 1024) return res.status(413).json({ error: 'body 过大' });
      // rootPath 沙箱
      if (typeof body.rootPath === 'string' && body.rootPath.trim()) {
        const safe = safeResolveFsPath(body.rootPath.trim());
        if (!safe) return res.status(403).json({ error: 'rootPath 越权或敏感目录' });
        body.rootPath = safe;
      }
      const cfg = archiveStore.updateConfig(body);
      res.json({ ok: true, config: cfg });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.post('/api/archive/rooms/:id', requireOwnerToken, (req, res) => {
    try {
      const room = roomStore.get(req.params.id);
      if (!room) return res.status(404).json({ ok: false, error: 'room not found' });
      const r = archiveStore.archiveRoom(room);
      if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
      res.json({ ok: true, dir: r.dir, files: r.files });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/archive/list', (req, res) => {
    try {
      res.json(archiveStore.listArchives());
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}
