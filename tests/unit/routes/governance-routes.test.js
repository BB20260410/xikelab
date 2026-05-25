import { describe, expect, it } from 'vitest';
import { buildGovernanceSummary, registerGovernanceRoutes } from '../../../src/server/routes/governance.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get']) {
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

describe('governance routes', () => {
  it('builds a local governance summary across pending control queues', () => {
    const summary = buildGovernanceSummary({
      approvals: [
        { id: 'approval-1', type: 'dangerous_command', status: 'pending', payload: { command: 'rm -rf tmp' }, createdAt: 100 },
      ],
      budgetIncidents: [
        { id: 'incident-1', scopeType: 'room', scopeId: 'room-1', thresholdType: 'hard_stop', status: 'open', createdAt: 200 },
        { id: 'incident-2', scopeType: 'adapter', scopeId: 'codex', thresholdType: 'warning', status: 'open', createdAt: 150 },
      ],
      queuedDelegations: [
        { id: 'delegation-1', title: 'Review task', status: 'queued', createdAt: 300 },
      ],
      failedDelegations: [
        { id: 'delegation-2', title: 'Failed task', status: 'failed', updatedAt: 250 },
      ],
      queuedJobs: [
        { id: 'job-1', action: 'heartbeat', status: 'queued', createdAt: 350 },
      ],
      runningJobs: [
        { id: 'job-2', action: 'notify', status: 'running', updatedAt: 50 },
      ],
    });

    expect(summary.ok).toBe(true);
    expect(summary.counts).toMatchObject({
      pendingApprovals: 1,
      openBudgetIncidents: 2,
      queuedDelegations: 1,
      failedDelegations: 1,
      queuedAutopilotJobs: 1,
      runningAutopilotJobs: 1,
      hardBlockers: 2,
      attention: 4,
      totalOpen: 7,
    });
    expect(summary.blockers.map((b) => b.id).slice(0, 3)).toEqual(['job-1', 'delegation-1', 'delegation-2']);
    expect(summary.blockers.find((b) => b.id === 'approval-1')).toMatchObject({
      kind: 'approval',
      title: 'rm -rf tmp',
      severity: 'warn',
    });
  });

  it('exposes the summary through the owner-gated API route', async () => {
    const { app, routes } = makeApp();
    registerGovernanceRoutes(app, {
      approvalStore: {
        listApprovals(query) {
          expect(query.status).toBe('pending');
          return [{ id: 'approval-1', type: 'manual', status: 'pending', payload: { title: 'Confirm release' }, createdAt: 10 }];
        },
      },
      budgetStore: {
        listIncidents(query) {
          expect(query.status).toBe('open');
          return [{ id: 'incident-1', scopeType: 'project', scopeId: '/tmp/app', thresholdType: 'warning', status: 'open', createdAt: 20 }];
        },
      },
      delegationStore: {
        list(query) {
          if (query.status === 'queued') return [{ id: 'delegation-1', title: 'Split task', status: 'queued', createdAt: 30 }];
          if (query.status === 'failed') return [];
          return [];
        },
      },
      autopilotStore: {
        listJobs(query) {
          if (query.status === 'queued') return [{ id: 'job-1', action: 'heartbeat', status: 'queued', createdAt: 40 }];
          if (query.status === 'running') return [];
          return [];
        },
      },
    });

    const route = routes.find((r) => r.method === 'get' && r.path === '/api/governance/summary');
    const res = makeRes();
    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.counts).toMatchObject({
      pendingApprovals: 1,
      openBudgetIncidents: 1,
      queuedDelegations: 1,
      queuedAutopilotJobs: 1,
      totalOpen: 4,
    });
    expect(res.payload.blockers.map((b) => b.kind)).toEqual(['autopilot_job', 'delegation', 'budget', 'approval']);
  });
});
