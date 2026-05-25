import { autopilotScheduleStore } from './AutopilotScheduleStore.js';
import { activityLog } from '../audit/ActivityLog.js';

const DEFAULT_TICK_MS = 30_000;

export class AutopilotScheduler {
  constructor({
    store = autopilotScheduleStore,
    handlers = {},
    workerId = `autopilot-${process.pid}`,
    tickMs = DEFAULT_TICK_MS,
    isEnabled = () => true,
    logger = console,
  } = {}) {
    this.store = store;
    this.handlers = handlers;
    this.workerId = workerId;
    this.tickMs = Math.max(1000, Math.trunc(Number(tickMs) || DEFAULT_TICK_MS));
    this.isEnabled = isEnabled;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.logger?.warn?.('[autopilot-scheduler] tick failed:', e.message));
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick({ now = Date.now(), limit = 5, force = false } = {}) {
    if (this.running) {
      return { ok: true, skipped: 'already_running', enqueued: [], executed: [] };
    }
    if (!force && !this.isEnabled()) {
      return { ok: true, skipped: 'disabled', enqueued: [], executed: [] };
    }

    this.running = true;
    try {
      const recovered = this.store.recoverStaleRunningJobs?.({ now }) || [];
      const enqueued = this.store.enqueueDueSchedules({ now, limit });
      const executed = [];
      for (let i = 0; i < Math.max(1, Math.min(50, Number(limit) || 5)); i += 1) {
        const item = await this.runNextJob({ now: Date.now() });
        if (!item) break;
        executed.push(item);
      }
      return { ok: true, recovered, enqueued, executed };
    } finally {
      this.running = false;
    }
  }

  async runNextJob({ now = Date.now() } = {}) {
    const claimed = this.store.claimNextJob({ workerId: this.workerId, now });
    if (!claimed) return null;

    const { job, run } = claimed;
    const handler = this.handlers[job.action];
    if (!handler) {
      return this.store.finishRun(run.id, {
        status: 'failed',
        error: `No Autopilot handler registered for action: ${job.action}`,
      });
    }

    try {
      const result = await handler(job, { run, scheduler: this });
      if (result?.__defer) {
        return this.store.deferRun(run.id, {
          runAfter: result.runAfter,
          reason: result.reason,
          result: result.result || result,
        });
      }
      return this.store.finishRun(run.id, {
        status: 'succeeded',
        result: result && typeof result === 'object' ? result : { value: result },
      });
    } catch (e) {
      activityLog.recordSafe({
        action: 'autopilot.scheduler.handler_error',
        actorType: 'system',
        roomId: job.roomId,
        sessionId: job.sessionId,
        taskId: job.taskId,
        entityType: 'autopilot_job',
        entityId: job.id,
        status: 'failed',
        details: {
          jobId: job.id,
          runId: run.id,
          action: job.action,
          error: e?.message || String(e),
        },
      });
      return this.store.finishRun(run.id, {
        status: 'failed',
        error: e?.message || String(e),
      });
    }
  }
}
