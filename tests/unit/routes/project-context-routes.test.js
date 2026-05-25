import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerProjectContextRoutes } from '../../../src/server/routes/projectContext.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get']) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  }
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

let tmp;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('project context routes', () => {
  it('returns a summary by default and content only when requested', () => {
    tmp = mkdtempSync(join(tmpdir(), 'xikelab-project-context-route-'));
    writeFileSync(join(tmp, 'SKILL.md'), '# Skill\nProject-specific rule.\n');

    const { app, routes } = makeApp();
    registerProjectContextRoutes(app, { safeResolveFsPath: (p) => p });
    const route = routes.find((r) => r.path === '/api/project-context');

    const summaryRes = makeRes();
    route.handlers[1]({ query: { cwd: tmp } }, summaryRes);
    expect(summaryRes.statusCode).toBe(200);
    expect(summaryRes.payload.bundle.fileCount).toBe(1);
    expect(summaryRes.payload.bundle.files[0].content).toBeUndefined();

    const fullRes = makeRes();
    route.handlers[1]({ query: { cwd: tmp, includeContent: '1' } }, fullRes);
    expect(fullRes.payload.bundle.prompt).toContain('Project-specific rule');
  });

  it('blocks unsafe cwd returned by the sandbox resolver', () => {
    const { app, routes } = makeApp();
    registerProjectContextRoutes(app, { safeResolveFsPath: () => null });
    const route = routes.find((r) => r.path === '/api/project-context');
    const res = makeRes();
    route.handlers[1]({ query: { cwd: '/etc' } }, res);
    expect(res.statusCode).toBe(403);
  });
});
