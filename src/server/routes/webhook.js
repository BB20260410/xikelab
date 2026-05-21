// Hangora — Webhook routes (S18-2a)
// v0.54 Sprint 4 — 出站 webhook 推送 API
// 从 server.js 1959-2012 提取，行为完全一致
//
// 用法（在 server.js）：
//   import { registerWebhookRoutes } from './src/server/routes/webhook.js';
//   import { webhookStore, maskWebhookUrl } from './src/webhook/WebhookStore.js';
//   import { testWebhook } from './src/webhook/WebhookDispatcher.js';
//   registerWebhookRoutes(app, { webhookStore, maskWebhookUrl, testWebhook });

export function registerWebhookRoutes(app, deps) {
  const { webhookStore, maskWebhookUrl, testWebhook } = deps;

  app.get('/api/webhooks', (req, res) => {
    try {
      res.json({ ok: true, webhooks: webhookStore.list({ mask: true }) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/webhooks', (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 16 * 1024) return res.status(413).json({ error: 'body 过大' });
      const w = webhookStore.create(body);
      res.json({ ok: true, webhook: { ...w, url: maskWebhookUrl(w.url) } });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.put('/api/webhooks/:id', (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 16 * 1024) return res.status(413).json({ error: 'body 过大' });
      const w = webhookStore.update(req.params.id, body);
      if (!w) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true, webhook: { ...w, url: maskWebhookUrl(w.url) } });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.delete('/api/webhooks/:id', (req, res) => {
    try {
      const ok = webhookStore.delete(req.params.id);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/webhooks/:id/test', async (req, res) => {
    try {
      const w = webhookStore.get(req.params.id);
      if (!w) return res.status(404).json({ ok: false, error: 'not found' });
      await testWebhook(w);
      webhookStore.bumpStats(w.id, true);
      res.json({ ok: true });
    } catch (e) {
      try { webhookStore.bumpStats(req.params.id, false, e.message); } catch {}
      res.status(502).json({ ok: false, error: e.message });
    }
  });
}
