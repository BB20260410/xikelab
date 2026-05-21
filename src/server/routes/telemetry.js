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

  // v1.1 Task 2.1: PostHog 配置 + 测试
  app.post('/api/analytics/config', async (req, res) => {
    try {
      const { host, key } = req.body || {};
      if (host && !host.startsWith('http')) {
        return res.status(400).json({ ok: false, error: 'host 必须以 http:// 或 https:// 开头' });
      }
      if (host && host.length > 500) return res.status(400).json({ ok: false, error: 'host 过长' });
      if (key && key.length > 200) return res.status(400).json({ ok: false, error: 'key 过长' });
      const m = await import('../../telemetry/ErrorReporter.js');
      const c = m.loadConfig();
      c.analyticsHost = (host || '').trim();
      c.analyticsKey = (key || '').trim();
      m.acceptTelemetry({ dsn: c.dsn });
      // 重写完整 config（acceptTelemetry 只接 dsn，手动写回 analytics fields）
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');
      writeFileSync(join(homedir(), '.claude-panel', 'telemetry.json'), JSON.stringify(c, null, 2), { mode: 0o600 });
      res.json({ ok: true, hasHost: !!c.analyticsHost, hasKey: !!c.analyticsKey });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/analytics/capture', async (req, res) => {
    try {
      const { event, properties } = req.body || {};
      if (!event) return res.status(400).json({ ok: false, error: 'event required' });
      const m = await import('../../telemetry/Analytics.js');
      m.capture(event, properties || {});
      res.json({ ok: true, enabled: m.isAnalyticsEnabled(), queued: true });
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
