// Xikely — Room Templates routes (S18-2e1)
// v0.53 Sprint 3 阶段 4：房间模板（builtin + user）
// 从 server.js 1877-1909 提取
// 注意：rooms 主 CRUD（list/create/get/delete/patch）+ advanced (debate/forward/retry/quick/search) 仍留 server.js，
// 依赖过多（10+ dispatchers + roomStore + safeResolveFsPath + ws clients 等）；按机制 D 锚仅提取 templates 子集

export function registerRoomTemplatesRoutes(app, deps) {
  const { roomTemplatesStore } = deps;

  app.get('/api/room-templates', (req, res) => {
    try {
      res.json({ ok: true, templates: roomTemplatesStore.list() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/room-templates', (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 32 * 1024) {
        return res.status(413).json({ error: '模板过大（>32KB）' });
      }
      const t = roomTemplatesStore.create(body);
      res.json({ ok: true, template: t });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.delete('/api/room-templates/:id', (req, res) => {
    try {
      if (String(req.params.id).startsWith('builtin:')) {
        return res.status(403).json({ ok: false, error: '内置模板不可删' });
      }
      const ok = roomTemplatesStore.delete(req.params.id);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
