// Claude Panel — MCP routes (S18-2c)
// v0.55 Sprint 12 — MCP（Model Context Protocol）服务器配置 + 客户端管理
// 从 server.js 1759-1825 提取，行为完全一致
//
// 内部创建 McpClientManager（原 server.js 1759 的 const）

import { McpClientManager } from '../../mcp/McpClientManager.js';

export function registerMcpRoutes(app, deps) {
  const { mcpStore } = deps;
  const mcpClientManager = new McpClientManager({ store: mcpStore });

  app.get('/api/mcp/servers', (req, res) => {
    try {
      res.json({ ok: true, servers: mcpStore.list(), status: mcpClientManager.status() });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/mcp/servers', (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 16 * 1024) return res.status(413).json({ error: 'body 过大' });
      const item = mcpStore.create(body);
      res.json({ ok: true, server: item });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.put('/api/mcp/servers/:name', async (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 16 * 1024) return res.status(413).json({ error: 'body 过大' });
      // 配置变更后先断开旧连接，等下次 ensureConnected 重连
      try { await mcpClientManager.disconnect(req.params.name); } catch {}
      const item = mcpStore.update(req.params.name, body);
      if (!item) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true, server: item });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/mcp/servers/:name', async (req, res) => {
    try {
      try { await mcpClientManager.disconnect(req.params.name); } catch {}
      const ok = mcpStore.delete(req.params.name);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 测试连接 + 列出 tools（一次调用 verify 连接 + capability）
  app.post('/api/mcp/servers/:name/test', async (req, res) => {
    try {
      // 强制重连：先 disconnect 再 ensureConnected
      try { await mcpClientManager.disconnect(req.params.name); } catch {}
      const tools = await mcpClientManager.listTools(req.params.name);
      const resources = await mcpClientManager.listResources(req.params.name).catch(() => []);
      const prompts = await mcpClientManager.listPrompts(req.params.name).catch(() => []);
      res.json({
        ok: true,
        tools: (tools || []).map((t) => ({ name: t.name, description: t.description || '' })),
        toolsCount: tools.length,
        resourcesCount: resources.length,
        promptsCount: prompts.length,
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // 单独拉 tools（不强制重连，用 cache）
  app.get('/api/mcp/servers/:name/tools', async (req, res) => {
    try {
      const tools = await mcpClientManager.listTools(req.params.name);
      res.json({ ok: true, tools });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  return { mcpClientManager };
}
