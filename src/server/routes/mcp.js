// Xike Lab — MCP routes (S18-2c)
// v0.55 Sprint 12 — MCP（Model Context Protocol）服务器配置 + 客户端管理
// 从 server.js 1759-1825 提取，行为完全一致
//
// 内部创建 McpClientManager（原 server.js 1759 的 const）

import { McpClientManager } from '../../mcp/McpClientManager.js';
import { hasFeature, getCurrentTier } from '../../license/LicenseManager.js';
// Round 4 P1：MCP server 配置 = 子进程 spawn 规格 → 写入 = 任意命令执行 RCE
// POST/PUT/DELETE/test 必须 owner-token 防本机其他 UID 进程植入恶意 mcp config
import { requireOwnerToken } from '../auth/owner-token.js';
import { permissionHttpBody, permissionHttpStatus } from '../../permissions/PermissionGovernance.js';

const FREE_MCP_LIMIT = 3;

export function registerMcpRoutes(app, deps) {
  const { mcpStore, permissionGovernance } = deps;
  const mcpClientManager = new McpClientManager({ store: mcpStore });

  function mcpTarget(operation, name, body = {}) {
    return {
      section: 'mcp',
      operation,
      serverName: name || body.name || null,
      command: body.command || null,
      argsCount: Array.isArray(body.args) ? body.args.length : 0,
      envKeys: body.env && typeof body.env === 'object' ? Object.keys(body.env).slice(0, 20) : [],
      hasEnv: !!(body.env && typeof body.env === 'object' && Object.keys(body.env).length),
    };
  }

  function requirePermission(res, input) {
    const permission = permissionGovernance?.evaluatePermission?.({
      actorType: 'owner',
      actorId: 'local-owner',
      cwd: process.cwd(),
      risk: 'high',
      ...input,
    });
    if (!permission || permission.decision === 'allow') return true;
    res.status(permissionHttpStatus(permission)).json(permissionHttpBody(permission));
    return false;
  }

  // Round 5 7M：MCP server 列表暴露 spawn 命令规格 + tools/resources/prompts 会拉起子进程 → 全部 owner-token
  app.get('/api/mcp/servers', requireOwnerToken, (req, res) => {
    try {
      res.json({ ok: true, servers: mcpStore.list(), status: mcpClientManager.status() });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/mcp/servers', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 16 * 1024) return res.status(413).json({ error: 'body 过大' });
      // v1.5 Task 3.2 — Free tier MCP limit 3
      if (!hasFeature('mcp-unlimited')) {
        const cur = mcpStore.list().length;
        if (cur >= FREE_MCP_LIMIT) {
          return res.status(402).json({
            error: `Free 层最多 ${FREE_MCP_LIMIT} 个 MCP server（当前 ${cur}）`,
            tier: getCurrentTier(),
            feature: 'mcp-unlimited',
            upgradeUrl: 'https://panel.app/pricing',
          });
        }
      }
      if (!requirePermission(res, {
        action: 'skill.plugin.configure',
        target: mcpTarget('create', body.name, body),
      })) return;
      const item = mcpStore.create(body);
      res.json({ ok: true, server: item });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.put('/api/mcp/servers/:name', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 16 * 1024) return res.status(413).json({ error: 'body 过大' });
      if (!requirePermission(res, {
        action: 'skill.plugin.configure',
        target: mcpTarget('update', req.params.name, body),
      })) return;
      // 配置变更后先断开旧连接，等下次 ensureConnected 重连
      try { await mcpClientManager.disconnect(req.params.name); } catch {}
      const item = mcpStore.update(req.params.name, body);
      if (!item) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true, server: item });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/mcp/servers/:name', requireOwnerToken, async (req, res) => {
    try {
      if (!requirePermission(res, {
        action: 'skill.plugin.configure',
        target: mcpTarget('delete', req.params.name),
      })) return;
      try { await mcpClientManager.disconnect(req.params.name); } catch {}
      const ok = mcpStore.delete(req.params.name);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 测试连接 + 列出 tools（一次调用 verify 连接 + capability）
  // test 会 spawn 子进程跑 mcp server，必须 owner-token
  app.post('/api/mcp/servers/:name/test', requireOwnerToken, async (req, res) => {
    try {
      if (!requirePermission(res, {
        action: 'skill.plugin.execute',
        target: mcpTarget('test', req.params.name),
      })) return;
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
  app.get('/api/mcp/servers/:name/tools', requireOwnerToken, async (req, res) => {
    try {
      if (!requirePermission(res, {
        action: 'skill.plugin.execute',
        target: mcpTarget('list_tools', req.params.name),
      })) return;
      const tools = await mcpClientManager.listTools(req.params.name);
      res.json({ ok: true, tools });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // B-013: 单独拉 resources（不强制重连，用 cache）
  app.get('/api/mcp/servers/:name/resources', requireOwnerToken, async (req, res) => {
    try {
      if (!requirePermission(res, {
        action: 'skill.plugin.execute',
        target: mcpTarget('list_resources', req.params.name),
      })) return;
      const resources = await mcpClientManager.listResources(req.params.name);
      res.json({ ok: true, resources: resources || [] });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // B-013: 单独拉 prompts
  app.get('/api/mcp/servers/:name/prompts', requireOwnerToken, async (req, res) => {
    try {
      if (!requirePermission(res, {
        action: 'skill.plugin.execute',
        target: mcpTarget('list_prompts', req.params.name),
      })) return;
      const prompts = await mcpClientManager.listPrompts(req.params.name);
      res.json({ ok: true, prompts: prompts || [] });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // v0.70.3-t3: MCP call 历史（学自 W7 MCP Inspector）
  app.get('/api/mcp/call-history', requireOwnerToken, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 100));
      const { recentMcpCalls } = await import('../../mcp/learned/call-logger.js');
      res.json({ ok: true, calls: recentMcpCalls(limit) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return { mcpClientManager };
}
