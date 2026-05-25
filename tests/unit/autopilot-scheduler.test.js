import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutopilotScheduleStore } from '../../src/autopilot/AutopilotScheduleStore.js';
import { AutopilotScheduler } from '../../src/autopilot/AutopilotScheduler.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-autopilot-scheduler-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('AutopilotScheduler', () => {
  it('skips work while disabled unless forced', async () => {
    const store = new AutopilotScheduleStore({ logger: null });
    store.createSchedule({ name: 'Disabled tick', action: 'noop', nextRunAt: 1_000 });
    const scheduler = new AutopilotScheduler({
      store,
      isEnabled: () => false,
      handlers: { noop: async () => ({ ok: true }) },
      logger: null,
    });

    const skipped = await scheduler.tick({ now: 2_000 });
    expect(skipped.skipped).toBe('disabled');
    expect(store.listJobs()).toHaveLength(0);

    const forced = await scheduler.tick({ now: 2_000, force: true });
    expect(forced.enqueued).toHaveLength(1);
    expect(forced.executed[0].job.status).toBe('succeeded');
  });

  it('runs registered handlers and records failed jobs when no handler exists', async () => {
    const store = new AutopilotScheduleStore({ logger: null });
    store.enqueueJob({ action: 'notify', runAfter: 1_000, payload: { message: 'hello' } });
    store.enqueueJob({ action: 'missing', runAfter: 1_000, maxAttempts: 1 });

    const messages = [];
    const scheduler = new AutopilotScheduler({
      store,
      handlers: {
        notify: async (job) => {
          messages.push(job.payload.message);
          return { delivered: true };
        },
      },
      logger: null,
    });

    const first = await scheduler.runNextJob({ now: 1_000 });
    const second = await scheduler.runNextJob({ now: 1_000 });

    expect(messages).toEqual(['hello']);
    expect(first.job.status).toBe('succeeded');
    expect(second.job.status).toBe('failed');
    expect(second.run.error).toMatch(/No Autopilot handler/);
  });

  it('can defer a running job without marking it failed', async () => {
    const store = new AutopilotScheduleStore({ logger: null });
    const job = store.enqueueJob({ action: 'gate_wait', runAfter: 1_000, retryBackoffMs: 10_000 });
    const scheduler = new AutopilotScheduler({
      store,
      handlers: {
        gate_wait: async () => ({
          __defer: true,
          reason: 'approval_pending',
          runAfter: 5_000,
          result: { waiting: 'approval_pending' },
        }),
      },
      logger: null,
    });

    const result = await scheduler.runNextJob({ now: 1_000 });

    expect(result.job).toMatchObject({
      id: job.id,
      status: 'queued',
      runAfter: 5_000,
      lastError: 'approval_pending',
    });
    expect(result.run.status).toBe('succeeded');
    expect(result.run.result).toMatchObject({ deferred: true, waiting: 'approval_pending' });
  });
});
