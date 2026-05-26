import { describe, expect, it } from 'vitest';
import { registerMcpRoutes } from '../../../src/server/routes/mcp.js';
import { registerRoomAdaptersRoutes } from '../../../src/server/routes/roomAdapters.js';
import { registerWatcherRoutes } from '../../../src/server/routes/watcher.js';
import { registerWebhookRoutes } from '../../../src/server/routes/webhook.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (path, ...handlers) => {
      routes.push({ method, path, handlers });
    };
  }
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

function approvalGovernance(seen) {
  return {
    evaluatePermission(input) {
      seen.push(input);
      if (input.approvalId === 'approval-ok') {
        return {
          id: `permission-${seen.length}`,
          decision: 'allow',
          reason: 'approved permission resumed',
          action: input.action,
          risk: input.risk,
          target: input.target,
          approval: { id: 'approval-ok', status: 'approved' },
        };
      }
      return {
        id: `permission-${seen.length}`,
        decision: 'ask',
        reason: `${input.action} requires approval`,
        action: input.action,
        risk: input.risk,
        target: input.target,
        approval: { id: `approval-${seen.length}`, status: 'pending' },
      };
    },
  };
}

describe('permission governance route integration', () => {
  it('gates room adapter provider config writes before saving', () => {
    const seen = [];
    let saved = false;
    const { app, routes } = makeApp();
    registerRoomAdaptersRoutes(app, {
      getRoomAdaptersConfig: () => ({}),
      setRoomAdaptersConfig: () => {},
      cleanRoomAdaptersConfig: () => ({ ok: true, config: { openai: { apiKey: 'sk-test', baseUrl: 'https://api.example.com' } } }),
      maskRoomAdaptersConfig: (config) => config,
      saveRoomAdaptersConfig: () => { saved = true; return { ok: true }; },
      rebuildRoomAdapters: () => {},
      roomAdapterPool: new Map(),
      hasGeminiCli: false,
      permissionGovernance: approvalGovernance(seen),
      send500: () => {},
    });

    const route = routes.find((r) => r.method === 'put' && r.path === '/api/room-adapters');
    const res = makeRes();
    route.handlers[1]({ body: { approvalId: 'pending-approval' } }, res);

    expect(res.statusCode).toBe(202);
    expect(res.payload).toMatchObject({ ok: false, error: 'approval_required' });
    expect(seen[0]).toMatchObject({ action: 'provider.model_config.write', approvalId: 'pending-approval' });
    expect(saved).toBe(false);
  });

  it('gates watcher model/provider config writes and access before saving or testing', async () => {
    const seen = [];
    let saved = false;
    let tested = false;
    const { app, routes } = makeApp();
    registerWatcherRoutes(app, {
      getWatcherConfig: () => ({ provider: 'ollama', model: 'local' }),
      setWatcherConfig: () => {},
      getWatcherAdapter: () => ({ judge: () => { tested = true; return { ok: true }; } }),
      getWatcherAdapterPool: () => new Map(),
      saveWatcherConfig: () => { saved = true; return { ok: true }; },
      maskedConfig: (config) => config,
      rebuildAdapter: () => {},
      rebuildDispatcher: () => {},
      permissionGovernance: approvalGovernance(seen),
      send500: () => {},
    });

    const route = routes.find((r) => r.method === 'put' && r.path === '/api/watcher/config');
    const res = makeRes();
    route.handlers[1]({ body: { provider: 'openai', model: 'gpt-test', approvalId: 'pending-approval' } }, res);

    expect(res.statusCode).toBe(202);
    expect(seen[0]).toMatchObject({ action: 'provider.model_config.write', approvalIds: ['pending-approval'] });
    expect(saved).toBe(false);

    const testRoute = routes.find((r) => r.method === 'post' && r.path === '/api/watcher/test');
    const testRes = makeRes();
    await testRoute.handlers[1]({}, testRes);

    expect(testRes.statusCode).toBe(202);
    expect(seen[1]).toMatchObject({ action: 'provider.model_config.access' });
    expect(tested).toBe(false);
  });

  it('gates webhook outbound uploads before storing or testing', async () => {
    const seen = [];
    let created = false;
    let tested = false;
    const { app, routes } = makeApp();
    registerWebhookRoutes(app, {
      webhookStore: {
        create() { created = true; return { id: 'webhook-1', url: 'https://8.8.8.8/hook' }; },
        get() { return { id: 'webhook-1', url: 'https://8.8.8.8/hook' }; },
        bumpStats() {},
      },
      maskWebhookUrl: (url) => url,
      testWebhook: () => { tested = true; },
      permissionGovernance: approvalGovernance(seen),
    });

    const createRoute = routes.find((r) => r.method === 'post' && r.path === '/api/webhooks');
    const createRes = makeRes();
    await createRoute.handlers[1]({ body: { url: 'https://8.8.8.8/hook' } }, createRes);

    expect(createRes.statusCode).toBe(202);
    expect(seen[0]).toMatchObject({ action: 'network.upload', target: expect.objectContaining({ operation: 'create' }) });
    expect(created).toBe(false);

    const testRoute = routes.find((r) => r.method === 'post' && r.path === '/api/webhooks/:id/test');
    const testRes = makeRes();
    await testRoute.handlers[1]({ params: { id: 'webhook-1' } }, testRes);

    expect(testRes.statusCode).toBe(202);
    expect(seen[1]).toMatchObject({ action: 'network.upload', target: expect.objectContaining({ operation: 'test' }) });
    expect(tested).toBe(false);
  });

  it('allows webhook create retry with approval id and strips permission fields from storage', async () => {
    const seen = [];
    let storedBody = null;
    const { app, routes } = makeApp();
    registerWebhookRoutes(app, {
      webhookStore: {
        create(body) {
          storedBody = body;
          return { id: 'webhook-1', url: body.url };
        },
      },
      maskWebhookUrl: (url) => url,
      testWebhook: () => {},
      permissionGovernance: approvalGovernance(seen),
    });

    const createRoute = routes.find((r) => r.method === 'post' && r.path === '/api/webhooks');
    const createRes = makeRes();
    await createRoute.handlers[1]({ body: { url: 'https://8.8.8.8/hook', approvalId: 'approval-ok' } }, createRes);

    expect(createRes.statusCode).toBe(200);
    expect(createRes.payload).toMatchObject({ ok: true, webhook: { id: 'webhook-1' } });
    expect(seen[0]).toMatchObject({ action: 'network.upload', approvalId: 'approval-ok' });
    expect(storedBody).toEqual({ url: 'https://8.8.8.8/hook' });
  });

  it('gates MCP configuration and execution-like tool listing', async () => {
    const seen = [];
    let created = false;
    const { app, routes } = makeApp();
    registerMcpRoutes(app, {
      mcpStore: {
        list: () => [],
        create: () => { created = true; return { name: 'demo' }; },
      },
      permissionGovernance: approvalGovernance(seen),
    });

    const createRoute = routes.find((r) => r.method === 'post' && r.path === '/api/mcp/servers');
    const createRes = makeRes();
    createRoute.handlers[1]({ body: { name: 'demo', command: 'node', args: ['server.js'] } }, createRes);

    expect(createRes.statusCode).toBe(202);
    expect(seen[0]).toMatchObject({ action: 'skill.plugin.configure' });
    expect(created).toBe(false);

    const toolsRoute = routes.find((r) => r.method === 'get' && r.path === '/api/mcp/servers/:name/tools');
    const toolsRes = makeRes();
    await toolsRoute.handlers[1]({ params: { name: 'demo' } }, toolsRes);

    expect(toolsRes.statusCode).toBe(202);
    expect(seen[1]).toMatchObject({ action: 'skill.plugin.execute', target: expect.objectContaining({ operation: 'list_tools' }) });
  });

  it('allows MCP config retry with approval id and strips permission fields from storage', () => {
    const seen = [];
    let storedBody = null;
    const { app, routes } = makeApp();
    registerMcpRoutes(app, {
      mcpStore: {
        list: () => [],
        create: (body) => {
          storedBody = body;
          return { name: body.name };
        },
      },
      permissionGovernance: approvalGovernance(seen),
    });

    const createRoute = routes.find((r) => r.method === 'post' && r.path === '/api/mcp/servers');
    const createRes = makeRes();
    createRoute.handlers[1]({
      body: { name: 'demo', command: 'node', args: ['server.js'], approvalId: 'approval-ok' },
    }, createRes);

    expect(createRes.statusCode).toBe(200);
    expect(createRes.payload).toMatchObject({ ok: true, server: { name: 'demo' } });
    expect(seen[0]).toMatchObject({ action: 'skill.plugin.configure', approvalId: 'approval-ok' });
    expect(storedBody).toEqual({ name: 'demo', command: 'node', args: ['server.js'] });
  });

  it('gates MCP server delete before disconnecting and removing', () => {
    const seen = [];
    let deleted = false;
    const { app, routes } = makeApp();
    registerMcpRoutes(app, {
      mcpStore: { list: () => [], get: () => ({ name: 'demo' }), delete: () => { deleted = true; return true; } },
      permissionGovernance: approvalGovernance(seen),
    });

    const route = routes.find((r) => r.method === 'delete' && r.path === '/api/mcp/servers/:name');
    const res = makeRes();
    route.handlers[1]({ params: { name: 'demo' }, body: {} }, res);

    expect(res.statusCode).toBe(202);
    expect(seen[0]).toMatchObject({ action: 'skill.plugin.configure', target: expect.objectContaining({ operation: 'delete' }) });
    expect(deleted).toBe(false);
  });

  it('allows MCP server delete to resume with an approved approval id', async () => {
    const seen = [];
    let deleted = false;
    const { app, routes } = makeApp();
    registerMcpRoutes(app, {
      mcpStore: { list: () => [], get: () => ({ name: 'demo' }), delete: () => { deleted = true; return true; } },
      permissionGovernance: approvalGovernance(seen),
    });

    const route = routes.find((r) => r.method === 'delete' && r.path === '/api/mcp/servers/:name');
    const res = makeRes();
    await route.handlers[1]({ params: { name: 'demo' }, body: { approvalId: 'approval-ok' } }, res);

    expect(seen[0]).toMatchObject({ action: 'skill.plugin.configure', approvalId: 'approval-ok' });
    expect(deleted).toBe(true);
    expect(res.payload).toMatchObject({ ok: true });
  });

  it('gates MCP server test connection before spawning a child process', () => {
    const seen = [];
    const { app, routes } = makeApp();
    registerMcpRoutes(app, {
      mcpStore: { list: () => [] },
      permissionGovernance: approvalGovernance(seen),
    });

    const route = routes.find((r) => r.method === 'post' && r.path === '/api/mcp/servers/:name/test');
    const res = makeRes();
    route.handlers[1]({ params: { name: 'demo' }, body: {} }, res);

    expect(res.statusCode).toBe(202);
    expect(seen[0]).toMatchObject({ action: 'skill.plugin.execute', target: expect.objectContaining({ operation: 'test' }) });
  });
});
