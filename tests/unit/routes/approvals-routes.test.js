import { describe, expect, it } from 'vitest';
import { registerApprovalRoutes } from '../../../src/server/routes/approvals.js';

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
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

describe('approval routes', () => {
  it('lists pending approvals and approves one', async () => {
    const pending = { id: 'approval-1', type: 'dangerous_command', status: 'pending' };
    const approved = { ...pending, status: 'approved', decisionBy: 'owner' };
    const approvalStore = {
      listApprovals() { return [pending]; },
      approve() { return approved; },
    };
    const { app, routes } = makeApp();
    registerApprovalRoutes(app, { approvalStore });

    const list = routes.find((r) => r.method === 'get' && r.path === '/api/approvals');
    const listRes = makeRes();
    await list.handlers[1]({ query: { status: 'pending' } }, listRes);
    expect(listRes.payload).toEqual({ ok: true, count: 1, approvals: [pending] });

    const approve = routes.find((r) => r.method === 'post' && r.path === '/api/approvals/:id/approve');
    const approveRes = makeRes();
    await approve.handlers[1]({ params: { id: 'approval-1' }, body: { decisionBy: 'owner' } }, approveRes);
    expect(approveRes.payload).toEqual({ ok: true, approval: approved });
  });

  it('creates manual approvals through the queue API', async () => {
    const created = { id: 'approval-2', type: 'manual', status: 'pending' };
    const approvalStore = {
      createApproval() { return created; },
    };
    const { app, routes } = makeApp();
    registerApprovalRoutes(app, { approvalStore });
    const route = routes.find((r) => r.method === 'post' && r.path === '/api/approvals');
    const res = makeRes();
    await route.handlers[1]({ body: { type: 'manual', payload: { note: 'check' } } }, res);
    expect(res.statusCode).toBe(201);
    expect(res.payload).toEqual({ ok: true, approval: created });
  });
});
