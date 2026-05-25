import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { budgetPolicyStore } from '../../src/budget/BudgetPolicyStore.js';
import { AgentRunStore } from '../../src/agents/AgentRunStore.js';
import { RoomAdapter } from '../../src/room/RoomAdapter.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

class FakeAdapter extends RoomAdapter {
  constructor() {
    super({ id: 'fake-adapter', displayName: 'Fake' });
    this.calls = 0;
  }

  async _doChat() {
    this.calls += 1;
    return { reply: 'ok', tokensIn: 1, tokensOut: 1 };
  }
}

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-room-budget-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('RoomAdapter budget guard', () => {
  it('blocks adapter calls before resilience when adapter budget is exhausted', async () => {
    budgetPolicyStore.createPolicy({
      scopeType: 'adapter',
      scopeId: 'fake-adapter',
      metric: 'calls',
      windowKind: 'daily',
      amount: 1,
      hardStopEnabled: true,
    });
    budgetPolicyStore.recordMetric({
      adapter: 'fake-adapter',
      estCostUSD: 0,
      tokensIn: 1,
      tokensOut: 1,
    });

    const adapter = new FakeAdapter();
    await expect(adapter.chat([{ role: 'user', content: 'hello' }], {
      skipResilience: true,
      budgetContext: { adapterId: 'fake-adapter' },
    })).rejects.toMatchObject({ code: 'BUDGET_LIMIT_EXCEEDED' });
    expect(adapter.calls).toBe(0);
    const runs = new AgentRunStore({ logger: null }).list({ sourceType: 'adapter_chat' });
    expect(runs).toEqual([expect.objectContaining({
      status: 'deferred',
      deferReason: 'budget_blocked',
      adapterId: 'fake-adapter',
    })]);
  });

  it('blocks calls by agent profile budget before invoking the adapter', async () => {
    budgetPolicyStore.createPolicy({
      scopeType: 'agent_profile',
      scopeId: 'xike-verifier',
      metric: 'calls',
      windowKind: 'daily',
      amount: 1,
      hardStopEnabled: true,
    });
    budgetPolicyStore.recordMetric({
      agentProfileId: 'xike-verifier',
      adapter: 'fake-adapter',
      estCostUSD: 0,
      tokensIn: 1,
      tokensOut: 1,
    });

    const adapter = new FakeAdapter();
    await expect(adapter.chat([{ role: 'user', content: 'verify' }], {
      skipResilience: true,
      budgetContext: { adapterId: 'fake-adapter', agentProfileId: 'xike-verifier' },
    })).rejects.toMatchObject({ code: 'BUDGET_LIMIT_EXCEEDED' });
    expect(adapter.calls).toBe(0);
    const runs = new AgentRunStore({ logger: null }).list({ agentProfileId: 'xike-verifier' });
    expect(runs[0]).toMatchObject({
      status: 'deferred',
      deferReason: 'budget_blocked',
      agentProfileId: 'xike-verifier',
    });
  });

  it('marks adapter runs succeeded and exposes agentRunId on the adapter result', async () => {
    const adapter = new FakeAdapter();
    const result = await adapter.chat([{ role: 'user', content: 'hello' }], {
      skipResilience: true,
      budgetContext: { roomId: 'room-1', taskId: 'task-1', adapterId: 'fake-adapter' },
    });

    expect(result.agentRunId).toMatch(/^agent-run-/);
    const run = new AgentRunStore({ logger: null }).get(result.agentRunId);
    expect(run).toMatchObject({
      status: 'succeeded',
      roomId: 'room-1',
      taskId: 'task-1',
      adapterId: 'fake-adapter',
    });
  });
});
