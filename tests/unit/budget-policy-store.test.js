import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetLimitExceededError, BudgetPolicyStore } from '../../src/budget/BudgetPolicyStore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

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
    store.recordMetric({
      ts: '2026-05-24T00:00:00.000Z',
      adapter: 'codex',
      estCostUSD: 0,
      tokensIn: 0,
      tokensOut: 0,
    });

    expect(() => store.preflight({
      ts: '2026-05-24T00:01:00.000Z',
      adapterId: 'codex',
      estimateCalls: 1,
    })).toThrow(BudgetLimitExceededError);
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
      adapter: 'codex',
      estCostUSD: 0.25,
      tokensIn: 100,
      tokensOut: 50,
    });

    expect(store.listUsage({ scopeType: 'project', scopeId: '/tmp/project', metric: 'usd', ts: '2026-05-24T00:00:00.000Z' }).amount).toBe(0.25);
    expect(store.listUsage({ scopeType: 'room', scopeId: 'room-1', metric: 'tokens', ts: '2026-05-24T00:00:00.000Z' }).amount).toBe(150);
    expect(store.listUsage({ scopeType: 'task', scopeId: 'T1', metric: 'calls', ts: '2026-05-24T00:00:00.000Z' }).amount).toBe(1);
  });
});
