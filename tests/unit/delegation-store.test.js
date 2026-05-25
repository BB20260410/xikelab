import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DelegationStore } from '../../src/delegation/DelegationStore.js';
import { close, getStats, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-delegation-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('DelegationStore', () => {
  it('creates, lists, marks created, and records stats', () => {
    const store = new DelegationStore({ logger: null });
    const delegation = store.create({
      sourceRoomId: 'room-1',
      sourceTaskId: 'task-1',
      targetMode: 'debate',
      title: 'Build follow-up room',
      instructions: 'Continue from source task',
      payload: { acceptanceCriteria: ['traceable'] },
    });

    expect(delegation).toMatchObject({
      sourceRoomId: 'room-1',
      sourceTaskId: 'task-1',
      status: 'queued',
      targetMode: 'debate',
    });
    expect(store.list({ sourceRoomId: 'room-1' })).toHaveLength(1);
    expect(getStats().counts.delegations).toBe(1);

    const done = store.markCreated(delegation.id, { targetRoomId: 'room-2' });
    expect(done).toMatchObject({ status: 'created', targetRoomId: 'room-2' });
  });

  it('cancels queued delegations but refuses already-created ones', () => {
    const store = new DelegationStore({ logger: null });
    const queued = store.create({
      sourceRoomId: 'room-1',
      title: 'Queued work',
      instructions: 'Do it later',
    });

    expect(store.cancel(queued.id, { reason: 'not needed' }).status).toBe('cancelled');

    const created = store.create({
      sourceRoomId: 'room-1',
      title: 'Created work',
      instructions: 'Do it now',
    });
    store.markCreated(created.id, { targetRoomId: 'room-2' });

    expect(() => store.cancel(created.id)).toThrow(/cannot be cancelled/);
  });
});
