import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutopilotScheduleStore } from '../../src/autopilot/AutopilotScheduleStore.js';
import { close, getStats, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-autopilot-schedules-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('AutopilotScheduleStore', () => {
  it('creates persistent schedules and enqueues due jobs once per scheduled timestamp', () => {
    const store = new AutopilotScheduleStore({ logger: null });
    const schedule = store.createSchedule({
      name: 'Check project state',
      action: 'notify',
      intervalMs: 60_000,
      nextRunAt: 1_000,
      roomId: 'room-1',
      payload: { message: 'wake up' },
    });

    expect(schedule).toMatchObject({
      name: 'Check project state',
      status: 'active',
      action: 'notify',
      roomId: 'room-1',
    });

    const jobs = store.enqueueDueSchedules({ now: 2_000 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      scheduleId: schedule.id,
      action: 'notify',
      roomId: 'room-1',
      status: 'queued',
    });

    expect(store.enqueueDueSchedules({ now: 2_000 })).toHaveLength(0);
    const updated = store.getSchedule(schedule.id);
    expect(updated.lastRunAt).toBe(2_000);
    expect(updated.nextRunAt).toBeGreaterThan(2_000);
    expect(getStats().counts.autopilot_schedules).toBe(1);
    expect(getStats().counts.autopilot_jobs).toBe(1);
  });

  it('claims jobs, records runs, and retries failed attempts before succeeding', () => {
    const store = new AutopilotScheduleStore({ logger: null });
    const job = store.enqueueJob({
      action: 'noop',
      runAfter: 1_000,
      maxAttempts: 2,
      retryBackoffMs: 5_000,
      payload: { step: 1 },
    });

    const first = store.claimNextJob({ workerId: 'worker-1', now: 1_000 });
    expect(first.job.id).toBe(job.id);
    expect(first.job.attempts).toBe(1);
    const failed = store.finishRun(first.run.id, {
      status: 'failed',
      error: 'transient',
      now: 2_000,
    });
    expect(failed.job.status).toBe('queued');
    expect(failed.job.runAfter).toBe(7_000);
    expect(failed.job.lastError).toBe('transient');

    const second = store.claimNextJob({ workerId: 'worker-1', now: 7_000 });
    const done = store.finishRun(second.run.id, {
      status: 'succeeded',
      result: { ok: true },
      now: 8_000,
    });

    expect(done.job.status).toBe('succeeded');
    expect(done.run.result).toEqual({ ok: true });
    expect(store.listRuns({ jobId: job.id })).toHaveLength(2);
  });

  it('deduplicates explicitly keyed jobs', () => {
    const store = new AutopilotScheduleStore({ logger: null });
    const first = store.enqueueJob({ action: 'notify', dedupeKey: 'same-work' });
    const second = store.enqueueJob({ action: 'notify', dedupeKey: 'same-work' });

    expect(second.id).toBe(first.id);
    expect(store.listJobs()).toHaveLength(1);
  });

  it('recovers stale running jobs so interrupted server runs do not stay stuck', () => {
    const store = new AutopilotScheduleStore({ logger: null });
    const job = store.enqueueJob({
      action: 'noop',
      runAfter: 1_000,
      maxAttempts: 2,
      retryBackoffMs: 5_000,
    });
    store.claimNextJob({ workerId: 'worker-dead', now: 1_000 });

    const recovered = store.recoverStaleRunningJobs({ now: 20_000, olderThanMs: 1_000 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      id: job.id,
      status: 'queued',
      lockedBy: null,
    });
    expect(store.listRuns({ jobId: job.id })[0]).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/Recovered stale/),
    });
  });
});
