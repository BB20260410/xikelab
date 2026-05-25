import { describe, it, expect } from 'vitest';
import { ReportJobStore } from '../../src/report/ReportJobStore.js';

describe('ReportJobStore', () => {
  it('tracks queued/running/done job state for polling fallback', () => {
    const store = new ReportJobStore({ ttlMs: 60_000, maxJobs: 10 });
    const created = store.create({ jobId: 'rpt-abc12345', roomId: 'room-1', adapterId: 'claude', model: 'sonnet' });
    expect(created.status).toBe('queued');
    expect(created.createdAtMs).toBeUndefined();

    const running = store.update('rpt-abc12345', { status: 'running', startedAt: '2026-05-24T00:00:00.000Z' });
    expect(running.status).toBe('running');

    const done = store.update('rpt-abc12345', {
      status: 'done',
      content: '# report',
      tokensIn: 1,
      tokensOut: 2,
      elapsedMs: 30,
    });
    expect(done.status).toBe('done');
    expect(done.finishedAt).toBeTruthy();
    expect(store.get('rpt-abc12345').content).toBe('# report');
  });

  it('cleans old jobs by ttl and maxJobs', () => {
    const store = new ReportJobStore({ ttlMs: 10, maxJobs: 2 });
    store.create({ jobId: 'rpt-old11111', roomId: 'room-old' });
    const old = store.jobs.get('rpt-old11111');
    old.createdAtMs = Date.now() - 100;
    store.cleanup(Date.now());
    expect(store.get('rpt-old11111')).toBeNull();

    store.create({ jobId: 'rpt-one11111', roomId: 'room-1' });
    store.create({ jobId: 'rpt-two22222', roomId: 'room-2' });
    store.create({ jobId: 'rpt-three333', roomId: 'room-3' });
    expect(store.jobs.size).toBe(2);
    expect(store.get('rpt-one11111')).toBeNull();
    expect(store.get('rpt-two22222')).toBeTruthy();
    expect(store.get('rpt-three333')).toBeTruthy();
  });
});
