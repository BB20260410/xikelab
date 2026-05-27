import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetLimitExceededError, BudgetPolicyStore } from '../../src/budget/BudgetPolicyStore.js';
import { close, initSqlite, listEvents } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-budget-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('BudgetPolicyStore', () => {
  it('records usage by scope and opens warning / hard-stop incidents once per window', () => {
    const store = new BudgetPolicyStore({ logger: null });
    const policy = store.createPolicy({
      scopeType: 'room',
      scopeId: 'room-1',
      metric: 'usd',
      windowKind: 'monthly',
      amount: 1,
      warnPercent: 0.8,
      hardStopEnabled: true,
    });

    store.recordMetric({
      ts: '2026-05-24T00:00:00.000Z',
      roomId: 'room-1',
      agentRunId: 'agent-run-budget-1',
      projectId: '/tmp/project',
      adapter: 'codex',
      estCostUSD: 0.81,
      tokensIn: 10,
      tokensOut: 20,
      success: true,
    });
    let incidents = store.listIncidents({ scopeType: 'room', scopeId: 'room-1', status: 'open' });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ policyId: policy.id, thresholdType: 'warning' });
    const warningActivity = listEvents({ kind: 'activity', entityType: 'budget_policy', entityId: policy.id })[0];
    expect(warningActivity.payload.details).toMatchObject({
      agentRunId: 'agent-run-budget-1',
      budgetIncidentId: incidents[0].id,
    });

    store.recordMetric({
      ts: '2026-05-24T00:01:00.000Z',
      roomId: 'room-1',
      adapter: 'codex',
      estCostUSD: 0.30,
      tokensIn: 1,
      tokensOut: 1,
    });
    incidents = store.listIncidents({ scopeType: 'room', scopeId: 'room-1', status: 'open' });
    expect(incidents.map((i) => i.thresholdType).sort()).toEqual(['hard_stop', 'warning']);

    store.recordMetric({
      ts: '2026-05-24T00:02:00.000Z',
      roomId: 'room-1',
      adapter: 'codex',
      estCostUSD: 0.10,
      tokensIn: 1,
      tokensOut: 1,
    });
    incidents = store.listIncidents({ scopeType: 'room', scopeId: 'room-1', status: 'open' });
    expect(incidents.filter((i) => i.thresholdType === 'hard_stop')).toHaveLength(1);
  });

  it('blocks adapter preflight when projected calls exceed hard-stop policy', () => {
    const store = new BudgetPolicyStore({ logger: null });
    store.createPolicy({
      scopeType: 'adapter',
      scopeId: 'codex',
      metric: 'calls',
      windowKind: 'daily',
      amount: 1,
      warnPercent: 0.5,
      hardStopEnabled: true,
    });
    expect(() => store.preflight({
      ts: '2026-05-24T00:01:00.000Z',
      adapterId: 'codex',
      agentRunId: 'agent-run-budget-preflight',
      estimateCalls: 2,
    })).toThrow(BudgetLimitExceededError);

    try {
      store.preflight({
        ts: '2026-05-24T00:01:00.000Z',
        adapterId: 'codex',
        agentRunId: 'agent-run-budget-preflight',
        estimateCalls: 2,
      });
    } catch (e) {
      expect(e.blocked[0].incident.activityId).toBeGreaterThan(0);
      const event = listEvents({ kind: 'activity', entityType: 'budget_policy', entityId: e.blocked[0].id })
        .find((item) => item.payload?.action === 'budget.hard_stop');
      expect(event.payload.details.agentRunId).toBe('agent-run-budget-preflight');
    }
  });

  it('allows the call that reaches the budget and blocks subsequent calls', () => {
    const store = new BudgetPolicyStore({ logger: null });
    store.createPolicy({
      scopeType: 'adapter',
      scopeId: 'claude',
      metric: 'calls',
      windowKind: 'daily',
      amount: 1,
      hardStopEnabled: true,
    });

    expect(store.preflight({
      ts: '2026-05-24T00:00:00.000Z',
      adapterId: 'claude',
      estimateCalls: 1,
    }).ok).toBe(true);

    store.recordMetric({
      ts: '2026-05-24T00:00:01.000Z',
      adapter: 'claude',
      tokensIn: 1,
      tokensOut: 1,
    });

    expect(() => store.preflight({
      ts: '2026-05-24T00:00:02.000Z',
      adapterId: 'claude',
      estimateCalls: 1,
    })).toThrow(BudgetLimitExceededError);
  });

  it('returns usage for independent project / room / task scopes', () => {
    const store = new BudgetPolicyStore({ logger: null });
    store.recordMetric({
      ts: '2026-05-24T00:00:00.000Z',
      projectId: '/tmp/project',
      roomId: 'room-1',
      taskId: 'T1',
      agentProfileId: 'xike-verifier',
      adapter: 'codex',
      estCostUSD: 0.25,
      tokensIn: 100,
      tokensOut: 50,
    });

    expect(store.listUsage({ scopeType: 'project', scopeId: '/tmp/project', metric: 'usd', ts: '2026-05-24T00:00:00.000Z' }).amount).toBe(0.25);
    expect(store.listUsage({ scopeType: 'room', scopeId: 'room-1', metric: 'tokens', ts: '2026-05-24T00:00:00.000Z' }).amount).toBe(150);
    expect(store.listUsage({ scopeType: 'task', scopeId: 'T1', metric: 'calls', ts: '2026-05-24T00:00:00.000Z' }).amount).toBe(1);
    expect(store.listUsage({ scopeType: 'agent_profile', scopeId: 'xike-verifier', metric: 'calls', ts: '2026-05-24T00:00:00.000Z' }).amount).toBe(1);
  });

  it('blocks profile-specific preflight when an agent profile call budget is exhausted', () => {
    const store = new BudgetPolicyStore({ logger: null });
    store.createPolicy({
      scopeType: 'agent_profile',
      scopeId: 'xike-shipper',
      metric: 'calls',
      windowKind: 'daily',
      amount: 1,
      hardStopEnabled: true,
    });
    store.recordMetric({
      ts: '2026-05-24T00:00:00.000Z',
      agentProfileId: 'xike-shipper',
      adapter: 'codex',
      tokensIn: 1,
      tokensOut: 1,
    });

    expect(() => store.preflight({
      ts: '2026-05-24T00:00:01.000Z',
      adapterId: 'codex',
      agentProfileId: 'xike-shipper',
      estimateCalls: 1,
    })).toThrow(BudgetLimitExceededError);
  });

  it('fires incidentResolveHook on resolveIncident and swallows hook errors (C2)', () => {
    const store = new BudgetPolicyStore({ logger: null });
    const policy = store.createPolicy({
      scopeType: 'room', scopeId: 'room-c2', metric: 'usd', windowKind: 'monthly',
      amount: 1, warnPercent: 0.8, hardStopEnabled: true,
    });
    store.recordMetric({ ts: '2026-05-24T00:00:00.000Z', roomId: 'room-c2', adapter: 'codex', estCostUSD: 0.9 });
    const open = store.listIncidents({ scopeType: 'room', scopeId: 'room-c2', status: 'open' });
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect(open[0].policyId).toBe(policy.id);

    const calls = [];
    store.setIncidentResolveHook((id, incident) => { calls.push({ id, incident }); });
    const resolved = store.resolveIncident(open[0].id);
    expect(resolved.status).toBe('resolved');
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe(open[0].id);
    expect(calls[0].incident.id).toBe(open[0].id);

    // 抛错的 hook 不应阻断解决；解决不存在的 incident 返回 null（不触发 hook）
    store.setIncidentResolveHook(() => { throw new Error('hook boom'); });
    store.recordMetric({ ts: '2026-05-24T00:01:00.000Z', roomId: 'room-c2', adapter: 'codex', estCostUSD: 0.5 });
    const open2 = store.listIncidents({ scopeType: 'room', scopeId: 'room-c2', status: 'open' });
    expect(() => store.resolveIncident(open2[0].id)).not.toThrow();

    store.setIncidentResolveHook(null);
    expect(store.resolveIncident('does-not-exist')).toBeNull();
  });
});
