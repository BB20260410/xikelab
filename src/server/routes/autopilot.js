// Claude Panel — Autopilot routes (S18-2d)
// v0.56 Sprint 15-R4 — Autopilot 控制 API
// 从 server.js 3733-3774 提取，行为完全一致

export function registerAutopilotRoutes(app, deps) {
  const { autopilotStore } = deps;

  app.get('/api/autopilot/config', (req, res) => {
    try { res.json({ ok: true, config: autopilotStore.getConfig() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/autopilot/toggle', (req, res) => {
    try {
      const { enabled } = req.body || {};
      autopilotStore.setEnabled(!!enabled);
      res.json({ ok: true, enabled: autopilotStore.isEnabled() });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.put('/api/autopilot/config', (req, res) => {
    try {
      const { maxHopsDefault } = req.body || {};
      if (maxHopsDefault !== undefined) autopilotStore.setMaxHops(maxHopsDefault);
      res.json({ ok: true, config: autopilotStore.getConfig() });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.post('/api/autopilot/rules', (req, res) => {
    try {
      const r = autopilotStore.upsertRule(req.body || {});
      res.json({ ok: true, rule: r });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/autopilot/rules/:id', (req, res) => {
    try {
      const ok = autopilotStore.deleteRule(req.params.id);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found or builtin (cannot delete; disable instead)' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/autopilot/log', (req, res) => {
    try {
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 100));
      res.json({ ok: true, logs: autopilotStore.recentLogs(limit) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}
