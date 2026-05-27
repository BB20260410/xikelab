import { describe, expect, it } from 'vitest';
import { registerKnowledgeRoutes } from '../../../src/server/routes/knowledge.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'delete']) {
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

function findRoute(routes, method, path) {
  return routes.find((route) => route.method === method && route.path === path);
}

describe('knowledge evidence routes', () => {
  const knowledgeStore = { list: () => [] };

  it('does not register evidence endpoints when evidenceKnowledgeStore is absent', () => {
    const { app, routes } = makeApp();
    registerKnowledgeRoutes(app, { knowledgeStore });
    expect(findRoute(routes, 'get', '/api/knowledge/evidence/search')).toBeUndefined();
    expect(findRoute(routes, 'post', '/api/knowledge/evidence/reindex')).toBeUndefined();
    expect(findRoute(routes, 'get', '/api/knowledge/evidence/stats')).toBeUndefined();
    // 现有文档型路由仍在
    expect(findRoute(routes, 'get', '/api/knowledge')).toBeTruthy();
  });

  it('search endpoint forwards q/kind/limit and returns hits + indexed count', () => {
    const calls = [];
    const evidenceKnowledgeStore = {
      search(query, opts) { calls.push({ query, opts }); return [{ refKind: 'agent_message', refId: 'm1', snippet: '…hit…', score: -1.2 }]; },
      stats() { return { indexed: 7 }; },
    };
    const { app, routes } = makeApp();
    registerKnowledgeRoutes(app, { knowledgeStore, evidenceKnowledgeStore });

    const res = makeRes();
    findRoute(routes, 'get', '/api/knowledge/evidence/search')
      .handlers[1]({ query: { q: 'budget', kind: 'agent_message', limit: '5' } }, res);

    expect(calls[0].query).toBe('budget');
    expect(calls[0].opts).toEqual({ kind: 'agent_message', limit: 5 });
    expect(res.payload).toEqual({
      ok: true,
      hits: [{ refKind: 'agent_message', refId: 'm1', snippet: '…hit…', score: -1.2 }],
      indexed: 7,
    });
  });

  it('search endpoint tolerates missing query params', () => {
    const evidenceKnowledgeStore = {
      search(query, opts) { expect(query).toBe(''); expect(opts).toEqual({ kind: undefined, limit: undefined }); return []; },
      stats() { return { indexed: 0 }; },
    };
    const { app, routes } = makeApp();
    registerKnowledgeRoutes(app, { knowledgeStore, evidenceKnowledgeStore });

    const res = makeRes();
    findRoute(routes, 'get', '/api/knowledge/evidence/search').handlers[1]({ query: {} }, res);
    expect(res.payload).toEqual({ ok: true, hits: [], indexed: 0 });
  });

  it('reindex endpoint derives from stores and returns counts + total', () => {
    const captured = {};
    const evidenceKnowledgeStore = {
      indexFromStores(deps) { captured.deps = deps; return { indexed: 3, skipped: 2 }; },
      stats() { return { indexed: 9 }; },
    };
    const agentRunStore = { list: () => [] };
    const activityLog = { list: () => [] };
    const { app, routes } = makeApp();
    registerKnowledgeRoutes(app, { knowledgeStore, evidenceKnowledgeStore, agentRunStore, activityLog });

    const res = makeRes();
    findRoute(routes, 'post', '/api/knowledge/evidence/reindex')
      .handlers[1]({ body: { limit: 50 } }, res);

    expect(captured.deps.agentRunStore).toBe(agentRunStore);
    expect(captured.deps.activityLog).toBe(activityLog);
    expect(captured.deps.limit).toBe(50);
    expect(res.payload).toEqual({ ok: true, indexed: 3, skipped: 2, total: 9 });
  });

  it('stats endpoint returns indexed count', () => {
    const evidenceKnowledgeStore = { search: () => [], stats: () => ({ indexed: 12 }) };
    const { app, routes } = makeApp();
    registerKnowledgeRoutes(app, { knowledgeStore, evidenceKnowledgeStore });

    const res = makeRes();
    findRoute(routes, 'get', '/api/knowledge/evidence/stats').handlers[1]({ query: {} }, res);
    expect(res.payload).toEqual({ ok: true, indexed: 12 });
  });
});
