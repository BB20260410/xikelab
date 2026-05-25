import { describe, expect, it } from 'vitest';
import { registerBudgetRoutes } from '../../../src/server/routes/budgets.js';
import { BudgetLimitExceededError } from '../../../src/budget/BudgetPolicyStore.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) {
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

describe('budget routes', () => {
  it('creates and lists budget policies', async () => {
    const created = { id: 'budget-1', scopeType: 'room', scopeId: 'room-1', metric: 'usd' };
    const budgetStore = {
      createPolicy(input) { return { ...created, amount: input.amount }; },
      listPolicies() { return [created]; },
    };
    const { app, routes } = makeApp();
    registerBudgetRoutes(app, { budgetStore });

    const post = routes.find((r) => r.method === 'post' && r.path === '/api/budgets/policies');
    const postRes = makeRes();
    await post.handlers[1]({ body: { scopeType: 'room', scopeId: 'room-1', amount: 1 } }, postRes);
    expect(postRes.statusCode).toBe(201);
    expect(postRes.payload.policy.amount).toBe(1);

    const get = routes.find((r) => r.method === 'get' && r.path === '/api/budgets/policies');
    const getRes = makeRes();
    await get.handlers[1]({ query: {} }, getRes);
    expect(getRes.payload).toEqual({ ok: true, count: 1, policies: [created] });
  });

  it('returns 402 for hard-stop preflight blocks', async () => {
    const budgetStore = {
      preflight() {
        throw new BudgetLimitExceededError('预算已达上限', {
          blocked: [{ scopeType: 'adapter', scopeId: 'codex' }],
        });
      },
    };
    const { app, routes } = makeApp();
    registerBudgetRoutes(app, { budgetStore });

    const check = routes.find((r) => r.method === 'post' && r.path === '/api/budgets/check');
    const res = makeRes();
    await check.handlers[1]({ body: { adapterId: 'codex' } }, res);
    expect(res.statusCode).toBe(402);
    expect(res.payload.code).toBe('BUDGET_LIMIT_EXCEEDED');
  });

  it('resolves budget incidents', async () => {
    const incident = { id: 'incident-1', status: 'resolved' };
    const budgetStore = {
      resolveIncident() { return incident; },
    };
    const { app, routes } = makeApp();
    registerBudgetRoutes(app, { budgetStore });
    const route = routes.find((r) => r.method === 'post' && r.path === '/api/budgets/incidents/:id/resolve');
    const res = makeRes();
    await route.handlers[1]({ params: { id: 'incident-1' } }, res);
    expect(res.payload).toEqual({ ok: true, incident });
  });
});
