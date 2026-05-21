// Task 1.1 v1.0: telemetry endpoint
// GET /api/telemetry/config  → 当前状态
// POST /api/telemetry/accept { dsn? }  → 同意 + 可选填 DSN
// POST /api/telemetry/decline  → 拒绝
// POST /api/telemetry/test  → 发一个测试 event 给 DSN 验证连通

export function registerTelemetryRoutes(app) {
  app.get('/api/telemetry/config', async (req, res) => {
    try {
      const m = await import('../../telemetry/ErrorReporter.js');
      const c = m.loadConfig();
      res.json({
        ok: true,
        enabled: c.enabled,
        hasDsn: !!c.dsn,
        // 不暴露完整 DSN（含 secret），只显示部分
        dsnPreview: c.dsn ? c.dsn.replace(/\/\/[^@]+@/, '//****@').slice(0, 100) : '',
        acceptedAt: c.acceptedAt,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/telemetry/accept', async (req, res) => {
    try {
      const dsn = String(req.body?.dsn || '').trim();
      if (dsn && !dsn.startsWith('https://')) {
        return res.status(400).json({ ok: false, error: 'DSN 必须以 https:// 开头' });
      }
      if (dsn.length > 500) {
        return res.status(400).json({ ok: false, error: 'DSN 过长（>500 chars）' });
      }
      const m = await import('../../telemetry/ErrorReporter.js');
      m.acceptTelemetry({ dsn });
      res.json({ ok: true, enabled: true, hasDsn: !!dsn });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/telemetry/decline', async (req, res) => {
    try {
      const m = await import('../../telemetry/ErrorReporter.js');
      m.declineTelemetry();
      res.json({ ok: true, enabled: false });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 测试发一个 fake error，看是否真到 Sentry
  app.post('/api/telemetry/test', async (req, res) => {
    try {
      const m = await import('../../telemetry/ErrorReporter.js');
      if (!m.isEnabled()) {
        return res.status(400).json({ ok: false, error: '未开启（先 accept 并填 DSN）' });
      }
      const result = await m.captureException(
        new Error('Panel telemetry test event @ ' + new Date().toISOString()),
        { level: 'info', tags: { kind: 'manual-test' } }
      );
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
