import { describe, expect, it } from 'vitest';
import { registerCodebaseIndexRoutes } from '../../../src/server/routes/codebaseIndex.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) {
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

describe('codebase index routes', () => {
  it('registers owner-gated rebuild, status, and query endpoints', () => {
    const status = { ok: true, cwd: '/safe/project', scannedFileCount: 2 };
    const map = { ok: true, cwd: '/safe/project', focusFiles: [] };
    const queryResult = {
      ok: true,
      cwd: '/safe/project',
      query: 'budget',
      results: [{ path: 'src/room/RoomAdapter.js', line: 10, score: 50, reason: ['symbol'], parser: 'acorn' }],
    };
    const questionResult = {
      ...queryResult,
      question: 'budget',
      answer: {
        mode: 'local-codebase-question',
        answer: 'Most relevant local evidence points to src/room/RoomAdapter.js:10.',
      },
    };
    const store = {
      rebuild(cwd, options) {
        expect(cwd).toBe('/safe/project');
        expect(options).toMatchObject({ query: 'budget', focusLimit: 8 });
        return { status, map };
      },
      status(cwd) {
        expect(cwd).toBe('/safe/project');
        return status;
      },
      query(cwd, options) {
        expect(cwd).toBe('/safe/project');
        expect(options).toMatchObject({ query: 'budget', maxResults: 5, focusLimit: 8, useSnapshot: true });
        return queryResult;
      },
      question(cwd, options) {
        expect(cwd).toBe('/safe/project');
        expect(options).toMatchObject({ question: 'budget', maxResults: 5, focusLimit: 8, useSnapshot: true });
        return questionResult;
      },
    };
    const { app, routes } = makeApp();
    registerCodebaseIndexRoutes(app, {
      codebaseIndexStore: store,
      safeResolveFsPath: () => '/safe/project',
    });

    const rebuildRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/codebase-index/rebuild')
      .handlers[1]({ body: { cwd: '/unsafe', query: 'budget', focusLimit: 8 }, query: {} }, rebuildRes);
    expect(rebuildRes.payload).toEqual({ ok: true, status, map });

    const statusRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/codebase-index/status')
      .handlers[1]({ query: { cwd: '/unsafe' }, body: {} }, statusRes);
    expect(statusRes.payload).toEqual({ ok: true, status });

    const queryRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/codebase-index/query')
      .handlers[1]({ body: { cwd: '/unsafe', query: 'budget', maxResults: 5, focusLimit: 8, useSnapshot: true }, query: {} }, queryRes);
    expect(queryRes.payload).toBe(queryResult);

    const questionRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/codebase-index/question')
      .handlers[1]({ body: { cwd: '/unsafe', question: 'budget', maxResults: 5, focusLimit: 8, useSnapshot: true }, query: {} }, questionRes);
    expect(questionRes.payload).toBe(questionResult);
  });

  it('uses process cwd when cwd is not explicitly supplied', () => {
    const original = process.cwd();
    const status = { ok: true, cwd: original, scannedFileCount: 0 };
    const store = {
      status(cwd) {
        expect(cwd).toBe(original);
        return status;
      },
    };
    const { app, routes } = makeApp();
    registerCodebaseIndexRoutes(app, {
      codebaseIndexStore: store,
      safeResolveFsPath: () => {
        throw new Error('safeResolveFsPath should not be called for implicit cwd');
      },
    });

    const res = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/codebase-index/status')
      .handlers[1]({ query: {}, body: {} }, res);
    expect(res.payload).toEqual({ ok: true, status });
  });
});
