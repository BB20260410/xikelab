import { requireOwnerToken } from '../auth/owner-token.js';
import { budgetPolicyStore as defaultBudgetPolicyStore, BudgetLimitExceededError } from '../../budget/BudgetPolicyStore.js';

function limitFromQuery(value, fallback = 500) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(1000, Math.trunc(n)));
}

function sendError(res, e) {
  if (e instanceof BudgetLimitExceededError) {
    return res.status(402).json({ ok: false, error: e.message, code: e.code, blocked: e.blocked });
  }
  const msg = e?.message || String(e);
  if (/required|invalid|must be|scope/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
  return res.status(500).json({ ok: false, error: msg });
}

export function registerBudgetRoutes(app, { budgetStore = defaultBudgetPolicyStore } = {}) {
  app.get('/api/budgets/policies', requireOwnerToken, async (req, res) => {
    try {
      const policies = budgetStore.listPolicies({
        scopeType: req.query.scopeType || undefined,
        scopeId: req.query.scopeId || undefined,
        metric: req.query.metric || undefined,
        activeOnly: req.query.activeOnly === '1' || req.query.activeOnly === 'true',
        limit: limitFromQuery(req.query.limit),
      });
      res.json({ ok: true, count: policies.length, policies });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/budgets/policies', requireOwnerToken, async (req, res) => {
    try {
      const policy = budgetStore.createPolicy(req.body || {});
      res.status(201).json({ ok: true, policy });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.patch('/api/budgets/policies/:id', requireOwnerToken, async (req, res) => {
    try {
      const policy = budgetStore.updatePolicy(req.params.id, req.body || {});
      if (!policy) return res.status(404).json({ ok: false, error: 'budget policy not found' });
      res.json({ ok: true, policy });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.delete('/api/budgets/policies/:id', requireOwnerToken, async (req, res) => {
    try {
      const ok = budgetStore.deletePolicy(req.params.id);
      if (!ok) return res.status(404).json({ ok: false, error: 'budget policy not found' });
      res.json({ ok: true });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/budgets/incidents', requireOwnerToken, async (req, res) => {
    try {
      const incidents = budgetStore.listIncidents({
        scopeType: req.query.scopeType || undefined,
        scopeId: req.query.scopeId || undefined,
        status: req.query.status || undefined,
        thresholdType: req.query.thresholdType || undefined,
        limit: limitFromQuery(req.query.limit),
      });
      res.json({ ok: true, count: incidents.length, incidents });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/budgets/incidents/:id/resolve', requireOwnerToken, async (req, res) => {
    try {
      const incident = budgetStore.resolveIncident(req.params.id);
      if (!incident) return res.status(404).json({ ok: false, error: 'budget incident not found' });
      res.json({ ok: true, incident });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/budgets/usage', requireOwnerToken, async (req, res) => {
    try {
      const usage = budgetStore.listUsage({
        scopeType: req.query.scopeType,
        scopeId: req.query.scopeId,
        metric: req.query.metric || 'usd',
        windowKind: req.query.windowKind || 'monthly',
        ts: req.query.ts,
      });
      res.json({ ok: true, usage });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/budgets/check', requireOwnerToken, async (req, res) => {
    try {
      const result = budgetStore.preflight(req.body || {});
      res.json(result);
    } catch (e) {
      sendError(res, e);
    }
  });
}
