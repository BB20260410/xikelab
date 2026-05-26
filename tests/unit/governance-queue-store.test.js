import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GovernanceQueueStore, initialStateForKind } from '../../src/governance/GovernanceQueueStore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-gov-queue-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('GovernanceQueueStore', () => {
  it('derives queue items from blockers with per-kind initial state and dedupes', () => {
    const store = new GovernanceQueueStore();
    const blockers = [
      { kind: 'approval', id: 'a1', title: 'approve X', severity: 'warn' },
      { kind: 'budget', id: 'b1', title: 'budget hit', severity: 'error' },
      { kind: 'agent_run', id: 'r1', title: 'verify run', severity: 'info' },
    ];
    expect(store.syncFromBlockers(blockers)).toEqual({ upserted: 3 });
    store.syncFromBlockers(blockers); // 再次派生同样 blockers 不应重复
    const all = store.list();
    expect(all).toHaveLength(3);
    expect(all.find((x) => x.sourceKind === 'approval').queueState).toBe('pending_review');
    expect(all.find((x) => x.sourceKind === 'budget').queueState).toBe('pending_fix');
    expect(all.find((x) => x.sourceKind === 'agent_run').queueState).toBe('pending_verify');
  });

  it('transitions state by id and by source, and filters / groups by state', () => {
    const store = new GovernanceQueueStore();
    store.syncFromBlockers([{ kind: 'approval', id: 'a1', title: 'x', severity: 'warn' }]);
    const item = store.list()[0];
    expect(store.setState(item.id, 'done', 'handled')).toBe(true);
    expect(store.list({ state: 'done' })).toHaveLength(1);
    expect(store.list({ state: 'pending_review' })).toHaveLength(0);

    store.syncFromBlockers([{ kind: 'budget', id: 'b1', title: 'y', severity: 'error' }]);
    expect(store.setStateBySource('budget', 'b1', 'done')).toBe(true);
    expect(store.grouped().done).toHaveLength(2);
  });

  it('rejects invalid states and ignores blockers without kind/id', () => {
    const store = new GovernanceQueueStore();
    expect(() => store.setState('x', 'bogus')).toThrow();
    expect(store.syncFromBlockers([{ title: 'no kind' }, { kind: 'x' }])).toEqual({ upserted: 0 });
    expect(store.list()).toHaveLength(0);
  });

  it('initialStateForKind maps known kinds with a safe default', () => {
    expect(initialStateForKind('approval')).toBe('pending_review');
    expect(initialStateForKind('budget')).toBe('pending_fix');
    expect(initialStateForKind('autopilot')).toBe('pending_verify');
    expect(initialStateForKind('unknown')).toBe('pending_review');
  });
});
