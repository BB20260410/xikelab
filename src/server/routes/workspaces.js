// panel v2.0 Task 4.3 — workspace REST API（team-tier 才能创建额外 workspace）

export function registerWorkspaceRoutes(app) {
  app.get('/api/workspaces', async (req, res) => {
    try {
      const m = await import('../../workspace/WorkspaceManager.js');
      const lm = await import('../../license/LicenseManager.js');
      res.json({
        ok: true,
        active: m.getActive(),
        workspaces: m.listWorkspaces(),
        canCreate: lm.hasFeature('workspaces'),
        tier: lm.getCurrentTier(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/workspaces', async (req, res) => {
    try {
      const lm = await import('../../license/LicenseManager.js');
      if (!lm.hasFeature('workspaces')) {
        return res.status(402).json({
          error: '多 workspace 需要 Team license',
          tier: lm.getCurrentTier(),
          feature: 'workspaces',
          upgradeUrl: 'https://panel.app/pricing',
        });
      }
      const { name, description } = req.body || {};
      const m = await import('../../workspace/WorkspaceManager.js');
      const meta = m.createWorkspace(name, { description });
      res.json({ ok: true, workspace: meta });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.put('/api/workspaces/active', async (req, res) => {
    try {
      const { name } = req.body || {};
      const m = await import('../../workspace/WorkspaceManager.js');
      const active = m.setActive(name);
      res.json({ ok: true, active });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.delete('/api/workspaces/:name', async (req, res) => {
    try {
      const m = await import('../../workspace/WorkspaceManager.js');
      const r = m.deleteWorkspace(req.params.name);
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/workspaces/current', async (req, res) => {
    try {
      const m = await import('../../workspace/WorkspaceManager.js');
      res.json({
        ok: true,
        active: m.getActive(),
        dir: m.getWorkspaceDir(),
        dbPath: m.getDbPath(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
