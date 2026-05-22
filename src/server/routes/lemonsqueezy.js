// Xike Lab v2.0 — Lemon Squeezy REST API 集成 endpoint
// 让 panel UI 能查询 LS 状态 + 创建 checkout / webhook

import { requireOwnerToken } from '../auth/owner-token.js';

export function registerLemonSqueezyRoutes(app) {
  // Round 5 H#3：所有 LS GET 都消耗 LS API 配额；orders 还泄漏买家邮箱 → 全部 owner-token
  app.get('/api/lemonsqueezy/health', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../integrations/LemonSqueezyClient.js');
      const h = await m.healthCheck();
      res.json(h);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/lemonsqueezy/stores', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../integrations/LemonSqueezyClient.js');
      const r = await m.listStores();
      const stores = (r.data || []).map(s => ({
        id: s.id,
        name: s.attributes?.name,
        domain: s.attributes?.domain,
        url: s.attributes?.url,
        country: s.attributes?.country,
        plan: s.attributes?.plan,
      }));
      res.json({ ok: true, count: stores.length, stores });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/lemonsqueezy/products', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../integrations/LemonSqueezyClient.js');
      const { storeId } = req.query;
      const r = await m.listProducts({ storeId });
      const products = (r.data || []).map(p => ({
        id: p.id,
        name: p.attributes?.name,
        status: p.attributes?.status,
        price: p.attributes?.price,
        priceLabel: p.attributes?.from_price_formatted,
        slug: p.attributes?.slug,
        buyNowUrl: p.attributes?.buy_now_url,
      }));
      res.json({ ok: true, count: products.length, products });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/lemonsqueezy/orders', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../integrations/LemonSqueezyClient.js');
      const { storeId, limit = '50' } = req.query;
      const r = await m.listOrders({ storeId, limit: parseInt(limit, 10) });
      const orders = (r.data || []).map(o => ({
        id: o.id,
        identifier: o.attributes?.identifier,
        email: o.attributes?.user_email,
        status: o.attributes?.status,
        total: o.attributes?.total_formatted,
        createdAt: o.attributes?.created_at,
      }));
      res.json({ ok: true, count: orders.length, orders });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/lemonsqueezy/webhooks', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../integrations/LemonSqueezyClient.js');
      const r = await m.listWebhooks(req.query);
      const hooks = (r.data || []).map(h => ({
        id: h.id,
        url: h.attributes?.url,
        events: h.attributes?.events,
        testMode: h.attributes?.test_mode,
        lastSentAt: h.attributes?.last_sent_at,
        createdAt: h.attributes?.created_at,
      }));
      res.json({ ok: true, count: hooks.length, webhooks: hooks });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 自动注册 webhook（部署后调用一次即可）
  // 写 webhook secret 到 webhook-secrets.json，要 owner-token 鉴权
  app.post('/api/lemonsqueezy/webhook-auto-register', requireOwnerToken, async (req, res) => {
    try {
      const { storeId, url, secret } = req.body || {};
      if (!storeId || !url || !secret) {
        return res.status(400).json({ ok: false, error: 'storeId, url, secret required' });
      }
      const m = await import('../../integrations/LemonSqueezyClient.js');
      const r = await m.createWebhook({ storeId, url, secret });
      // 自动把 secret 存到 panel webhook-secrets.json
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      const secretsPath = path.join(os.homedir(), '.claude-panel', 'webhook-secrets.json');
      const secrets = fs.existsSync(secretsPath) ? JSON.parse(fs.readFileSync(secretsPath, 'utf8')) : {};
      secrets.lemon = secret;
      fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
      res.json({ ok: true, webhookId: r.data?.id, message: 'webhook 已注册 + secret 已存 panel' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
