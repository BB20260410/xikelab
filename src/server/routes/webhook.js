// Xike Lab — Webhook routes (S18-2a)
// v0.54 Sprint 4 — 出站 webhook 推送 API
// 从 server.js 1959-2012 提取，行为完全一致
//
// 用法（在 server.js）：
//   import { registerWebhookRoutes } from './src/server/routes/webhook.js';
//   import { webhookStore, maskWebhookUrl } from './src/webhook/WebhookStore.js';
//   import { testWebhook } from './src/webhook/WebhookDispatcher.js';
//   registerWebhookRoutes(app, { webhookStore, maskWebhookUrl, testWebhook });
//
// Round 4 P1:
//   - 写端点（POST/PUT/DELETE/test）必须 owner-token 防本机其他 UID 进程注入恶意 URL
//   - URL 字段在 store 前过 assertPublicUrl（SSRF 防护，拒私网/loopback/非 http(s)/非默认端口）

import { requireOwnerToken } from '../auth/owner-token.js';
import { assertPublicUrl } from './img-cache.js';
import { permissionHttpBody, permissionHttpStatus } from '../../permissions/PermissionGovernance.js';

export function registerWebhookRoutes(app, deps) {
  const { webhookStore, maskWebhookUrl, testWebhook, permissionGovernance } = deps;

  app.get('/api/webhooks', (req, res) => {
    try {
      res.json({ ok: true, webhooks: webhookStore.list({ mask: true }) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/webhooks', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 16 * 1024) return res.status(413).json({ error: 'body 过大' });
      // SSRF 防护：拒私网/loopback/非 http(s)/非默认端口
      if (typeof body.url === 'string' && body.url.trim()) {
        try { await assertPublicUrl(body.url.trim()); }
        catch (e) { return res.status(400).json({ ok: false, error: `url blocked: ${e.message}` }); }
        const permission = permissionGovernance?.evaluatePermission?.({
          actorType: 'owner',
          actorId: 'local-owner',
          action: 'network.upload',
          cwd: process.cwd(),
          risk: 'high',
          target: { section: 'webhooks', operation: 'create', url: body.url.trim() },
        });
        if (permission && permission.decision !== 'allow') {
          return res.status(permissionHttpStatus(permission)).json(permissionHttpBody(permission));
        }
      }
      const w = webhookStore.create(body);
      res.json({ ok: true, webhook: { ...w, url: maskWebhookUrl(w.url) } });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.put('/api/webhooks/:id', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 16 * 1024) return res.status(413).json({ error: 'body 过大' });
      if (typeof body.url === 'string' && body.url.trim()) {
        try { await assertPublicUrl(body.url.trim()); }
        catch (e) { return res.status(400).json({ ok: false, error: `url blocked: ${e.message}` }); }
        const permission = permissionGovernance?.evaluatePermission?.({
          actorType: 'owner',
          actorId: 'local-owner',
          action: 'network.upload',
          cwd: process.cwd(),
          risk: 'high',
          target: { section: 'webhooks', operation: 'update', webhookId: req.params.id, url: body.url.trim() },
        });
        if (permission && permission.decision !== 'allow') {
          return res.status(permissionHttpStatus(permission)).json(permissionHttpBody(permission));
        }
      }
      const w = webhookStore.update(req.params.id, body);
      if (!w) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true, webhook: { ...w, url: maskWebhookUrl(w.url) } });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.delete('/api/webhooks/:id', requireOwnerToken, (req, res) => {
    try {
      const ok = webhookStore.delete(req.params.id);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/webhooks/:id/test', requireOwnerToken, async (req, res) => {
    try {
      const w = webhookStore.get(req.params.id);
      if (!w) return res.status(404).json({ ok: false, error: 'not found' });
      // test 触发实际出站 fetch — 再校验一遍 URL（防 store 里有历史脏数据）
      try { await assertPublicUrl(w.url); }
      catch (e) { return res.status(400).json({ ok: false, error: `url blocked: ${e.message}` }); }
      const permission = permissionGovernance?.evaluatePermission?.({
        actorType: 'owner',
        actorId: 'local-owner',
        action: 'network.upload',
        cwd: process.cwd(),
        risk: 'high',
        target: { section: 'webhooks', operation: 'test', webhookId: w.id, url: w.url },
      });
      if (permission && permission.decision !== 'allow') {
        return res.status(permissionHttpStatus(permission)).json(permissionHttpBody(permission));
      }
      await testWebhook(w);
      webhookStore.bumpStats(w.id, true);
      res.json({ ok: true });
    } catch (e) {
      try { webhookStore.bumpStats(req.params.id, false, e.message); } catch {}
      res.status(502).json({ ok: false, error: e.message });
    }
  });
}
