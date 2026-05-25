import { randomUUID } from 'node:crypto';
import { activityLog } from '../audit/ActivityLog.js';
import { getDb } from '../storage/SqliteStore.js';

const SCHEDULE_STATUSES = new Set(['active', 'paused', 'disabled']);
const SCHEDULE_KINDS = new Set(['interval', 'once']);
const JOB_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const RUN_STATUSES = new Set(['running', 'succeeded', 'failed', 'cancelled']);
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 120;
const MAX_ACTION_LENGTH = 80;
const MAX_ERROR_LENGTH = 2000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

function nowMs() {
  return Date.now();
}

function makeId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

function toNullableString(value, max = 512) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, max);
}

function toInt(value, fallback, min, max) {
  const n = Number(value);
  const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

function normalizeTs(value, fallback = nowMs()) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseJson(value, fallback = {}) {
  if (!value || typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function serializeJson(value) {
  const json = JSON.stringify(value && typeof value === 'object' ? value : {});
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload too large (max ${MAX_PAYLOAD_BYTES} bytes)`);
  }
  return json;
}

function sanitizeAction(value) {
  const action = String(value || 'notify').trim().slice(0, MAX_ACTION_LENGTH);
  if (!action) return 'notify';
  if (!/^[a-zA-Z0-9_.:-]+$/.test(action)) {
    throw new Error('action may only contain letters, numbers, dot, colon, underscore, or dash');
  }
  return action;
}

function sanitizeScheduleInput(input = {}, existing = null) {
  const at = nowMs();
  const scheduleKind = SCHEDULE_KINDS.has(input.scheduleKind) ? input.scheduleKind : (existing?.scheduleKind || 'interval');
  const intervalMs = scheduleKind === 'interval'
    ? toInt(input.intervalMs ?? existing?.intervalMs, existing?.intervalMs || DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS)
    : null;
  const fallbackNextRunAt = scheduleKind === 'interval' ? at + intervalMs : at;
  const nextRunAt = input.nextRunAt === null
    ? null
    : normalizeTs(input.nextRunAt ?? existing?.nextRunAt, fallbackNextRunAt);
  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, MAX_NAME_LENGTH);
  if (!name) throw new Error('schedule name required');
  const status = SCHEDULE_STATUSES.has(input.status) ? input.status : (existing?.status || 'active');
  return {
    id: toNullableString(input.id || existing?.id, 80) || makeId('aps'),
    name,
    status,
    scheduleKind,
    intervalMs,
    nextRunAt,
    lastRunAt: input.lastRunAt === null ? null : normalizeTs(input.lastRunAt ?? existing?.lastRunAt, existing?.lastRunAt || null),
    action: sanitizeAction(input.action ?? existing?.action),
    targetType: toNullableString(input.targetType ?? existing?.targetType, 80),
    targetId: toNullableString(input.targetId ?? existing?.targetId),
    roomId: toNullableString(input.roomId ?? existing?.roomId),
    sessionId: toNullableString(input.sessionId ?? existing?.sessionId),
    taskId: toNullableString(input.taskId ?? existing?.taskId),
    projectId: toNullableString(input.projectId ?? existing?.projectId),
    payload: input.payload !== undefined ? input.payload : (existing?.payload || {}),
    maxRetries: toInt(input.maxRetries ?? existing?.maxRetries, existing?.maxRetries ?? 2, 0, 20),
    retryBackoffMs: toInt(input.retryBackoffMs ?? existing?.retryBackoffMs, existing?.retryBackoffMs || 60_000, 1_000, 24 * 60 * 60 * 1000),
  };
}

function sanitizeJobInput(input = {}, schedule = null) {
  const at = nowMs();
  const maxRetries = input.maxRetries ?? schedule?.maxRetries ?? 2;
  return {
    id: toNullableString(input.id, 80) || makeId('apj'),
    scheduleId: toNullableString(input.scheduleId ?? schedule?.id, 80),
    status: JOB_STATUSES.has(input.status) ? input.status : 'queued',
    action: sanitizeAction(input.action ?? schedule?.action),
    targetType: toNullableString(input.targetType ?? schedule?.targetType, 80),
    targetId: toNullableString(input.targetId ?? schedule?.targetId),
    roomId: toNullableString(input.roomId ?? schedule?.roomId),
    sessionId: toNullableString(input.sessionId ?? schedule?.sessionId),
    taskId: toNullableString(input.taskId ?? schedule?.taskId),
    projectId: toNullableString(input.projectId ?? schedule?.projectId),
    priority: toInt(input.priority, 0, -1000, 1000),
    runAfter: normalizeTs(input.runAfter, at),
    attempts: toInt(input.attempts, 0, 0, 10_000),
    maxAttempts: toInt(input.maxAttempts, Math.max(1, Number(maxRetries) + 1), 1, 100),
    retryBackoffMs: toInt(input.retryBackoffMs ?? schedule?.retryBackoffMs, schedule?.retryBackoffMs || 60_000, 1_000, 24 * 60 * 60 * 1000),
    dedupeKey: toNullableString(input.dedupeKey, 512),
    payload: input.payload !== undefined ? input.payload : (schedule?.payload || {}),
  };
}

function rowToSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    scheduleKind: row.schedule_kind,
    intervalMs: row.interval_ms,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    roomId: row.room_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    projectId: row.project_id,
    payload: parseJson(row.payload),
    maxRetries: row.max_retries,
    retryBackoffMs: row.retry_backoff_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    status: row.status,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    roomId: row.room_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    projectId: row.project_id,
    priority: row.priority,
    runAfter: row.run_after,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    retryBackoffMs: row.retry_backoff_ms,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    dedupeKey: row.dedupe_key,
    payload: parseJson(row.payload),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    scheduleId: row.schedule_id,
    status: row.status,
    workerId: row.worker_id,
    attempt: row.attempt,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    result: parseJson(row.result),
    error: row.error,
  };
}

function nextScheduleRun(schedule, referenceTs) {
  if (schedule.scheduleKind === 'once') return null;
  const interval = toInt(schedule.intervalMs, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  let next = Number(schedule.nextRunAt) || referenceTs;
  do {
    next += interval;
  } while (next <= referenceTs);
  return next;
}

export class AutopilotScheduleStore {
  constructor({ logger = console } = {}) {
    this.logger = logger;
  }

  db() {
    return getDb();
  }

  createSchedule(input = {}) {
    const clean = sanitizeScheduleInput(input);
    const at = nowMs();
    this.db().prepare(`
      INSERT INTO autopilot_schedules(
        id, name, status, schedule_kind, interval_ms, next_run_at, last_run_at,
        action, target_type, target_id, room_id, session_id, task_id, project_id,
        payload, max_retries, retry_backoff_ms, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clean.id,
      clean.name,
      clean.status,
      clean.scheduleKind,
      clean.intervalMs,
      clean.nextRunAt,
      clean.lastRunAt,
      clean.action,
      clean.targetType,
      clean.targetId,
      clean.roomId,
      clean.sessionId,
      clean.taskId,
      clean.projectId,
      serializeJson(clean.payload),
      clean.maxRetries,
      clean.retryBackoffMs,
      at,
      at
    );
    const schedule = this.getSchedule(clean.id);
    activityLog.recordSafe({
      action: 'autopilot.schedule.created',
      actorType: 'system',
      roomId: schedule.roomId,
      sessionId: schedule.sessionId,
      taskId: schedule.taskId,
      entityType: 'autopilot_schedule',
      entityId: schedule.id,
      details: schedule,
    });
    return schedule;
  }

  getSchedule(id) {
    return rowToSchedule(this.db().prepare('SELECT * FROM autopilot_schedules WHERE id = ?').get(id));
  }

  listSchedules({ status, targetType, targetId, roomId, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (targetType) { where.push('target_type = ?'); args.push(targetType); }
    if (targetId) { where.push('target_id = ?'); args.push(targetId); }
    if (roomId) { where.push('room_id = ?'); args.push(roomId); }
    args.push(toInt(limit, 200, 1, 1000));
    return this.db().prepare(`
      SELECT * FROM autopilot_schedules
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...args).map(rowToSchedule);
  }

  updateSchedule(id, patch = {}) {
    const current = this.getSchedule(id);
    if (!current) throw new Error('schedule not found');
    const clean = sanitizeScheduleInput({ ...current, ...patch, id }, current);
    const at = nowMs();
    this.db().prepare(`
      UPDATE autopilot_schedules SET
        name = ?, status = ?, schedule_kind = ?, interval_ms = ?, next_run_at = ?, last_run_at = ?,
        action = ?, target_type = ?, target_id = ?, room_id = ?, session_id = ?, task_id = ?, project_id = ?,
        payload = ?, max_retries = ?, retry_backoff_ms = ?, updated_at = ?
      WHERE id = ?
    `).run(
      clean.name,
      clean.status,
      clean.scheduleKind,
      clean.intervalMs,
      clean.nextRunAt,
      clean.lastRunAt,
      clean.action,
      clean.targetType,
      clean.targetId,
      clean.roomId,
      clean.sessionId,
      clean.taskId,
      clean.projectId,
      serializeJson(clean.payload),
      clean.maxRetries,
      clean.retryBackoffMs,
      at,
      id
    );
    const schedule = this.getSchedule(id);
    activityLog.recordSafe({
      action: 'autopilot.schedule.updated',
      actorType: 'system',
      roomId: schedule.roomId,
      sessionId: schedule.sessionId,
      taskId: schedule.taskId,
      entityType: 'autopilot_schedule',
      entityId: schedule.id,
      details: schedule,
    });
    return schedule;
  }

  deleteSchedule(id) {
    const current = this.getSchedule(id);
    if (!current) return false;
    const changes = this.db().prepare('DELETE FROM autopilot_schedules WHERE id = ?').run(id).changes;
    if (changes) {
      activityLog.recordSafe({
        action: 'autopilot.schedule.deleted',
        actorType: 'system',
        roomId: current.roomId,
        sessionId: current.sessionId,
        taskId: current.taskId,
        entityType: 'autopilot_schedule',
        entityId: current.id,
        details: current,
      });
    }
    return changes > 0;
  }

  dueSchedules({ now = nowMs(), limit = 100 } = {}) {
    return this.db().prepare(`
      SELECT * FROM autopilot_schedules
      WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC
      LIMIT ?
    `).all(normalizeTs(now), toInt(limit, 100, 1, 1000)).map(rowToSchedule);
  }

  enqueueDueSchedules({ now = nowMs(), limit = 100 } = {}) {
    const dueAt = normalizeTs(now);
    const schedules = this.dueSchedules({ now: dueAt, limit });
    const jobs = [];
    const tx = this.db().transaction(() => {
      for (const schedule of schedules) {
        const scheduledFor = schedule.nextRunAt || dueAt;
        const dedupeKey = `schedule:${schedule.id}:${scheduledFor}`;
        const job = this.enqueueJob({
          scheduleId: schedule.id,
          action: schedule.action,
          targetType: schedule.targetType,
          targetId: schedule.targetId,
          roomId: schedule.roomId,
          sessionId: schedule.sessionId,
          taskId: schedule.taskId,
          projectId: schedule.projectId,
          runAfter: dueAt,
          maxAttempts: schedule.maxRetries + 1,
          retryBackoffMs: schedule.retryBackoffMs,
          dedupeKey,
          payload: {
            ...schedule.payload,
            scheduleId: schedule.id,
            scheduledFor,
          },
        }, { skipActivity: true });
        jobs.push(job);
        const nextRunAt = nextScheduleRun(schedule, dueAt);
        const nextStatus = schedule.scheduleKind === 'once' ? 'paused' : schedule.status;
        this.db().prepare(`
          UPDATE autopilot_schedules
          SET last_run_at = ?, next_run_at = ?, status = ?, updated_at = ?
          WHERE id = ?
        `).run(dueAt, nextRunAt, nextStatus, dueAt, schedule.id);
      }
    });
    tx();
    for (const job of jobs) {
      activityLog.recordSafe({
        action: 'autopilot.job.queued',
        actorType: 'system',
        roomId: job.roomId,
        sessionId: job.sessionId,
        taskId: job.taskId,
        entityType: 'autopilot_job',
        entityId: job.id,
        details: job,
      });
    }
    return jobs;
  }

  enqueueJob(input = {}, { skipActivity = false } = {}) {
    const schedule = input.scheduleId ? this.getSchedule(input.scheduleId) : null;
    const clean = sanitizeJobInput(input, schedule);
    const at = nowMs();
    try {
      this.db().prepare(`
        INSERT INTO autopilot_jobs(
          id, schedule_id, status, action, target_type, target_id, room_id, session_id, task_id, project_id,
          priority, run_after, attempts, max_attempts, retry_backoff_ms, dedupe_key, payload, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        clean.id,
        clean.scheduleId,
        clean.status,
        clean.action,
        clean.targetType,
        clean.targetId,
        clean.roomId,
        clean.sessionId,
        clean.taskId,
        clean.projectId,
        clean.priority,
        clean.runAfter,
        clean.attempts,
        clean.maxAttempts,
        clean.retryBackoffMs,
        clean.dedupeKey,
        serializeJson(clean.payload),
        at,
        at
      );
    } catch (e) {
      if (clean.dedupeKey && /UNIQUE constraint failed: autopilot_jobs\.dedupe_key/.test(e.message)) {
        return rowToJob(this.db().prepare('SELECT * FROM autopilot_jobs WHERE dedupe_key = ?').get(clean.dedupeKey));
      }
      throw e;
    }
    const job = this.getJob(clean.id);
    if (!skipActivity) {
      activityLog.recordSafe({
        action: 'autopilot.job.queued',
        actorType: 'system',
        roomId: job.roomId,
        sessionId: job.sessionId,
        taskId: job.taskId,
        entityType: 'autopilot_job',
        entityId: job.id,
        details: job,
      });
    }
    return job;
  }

  getJob(id) {
    return rowToJob(this.db().prepare('SELECT * FROM autopilot_jobs WHERE id = ?').get(id));
  }

  listJobs({ status, scheduleId, roomId, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (scheduleId) { where.push('schedule_id = ?'); args.push(scheduleId); }
    if (roomId) { where.push('room_id = ?'); args.push(roomId); }
    args.push(toInt(limit, 200, 1, 1000));
    return this.db().prepare(`
      SELECT * FROM autopilot_jobs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...args).map(rowToJob);
  }

  claimNextJob({ workerId = 'autopilot-local', now = nowMs() } = {}) {
    const claimedAt = normalizeTs(now);
    const tx = this.db().transaction(() => {
      const row = this.db().prepare(`
        SELECT * FROM autopilot_jobs
        WHERE status = 'queued' AND run_after <= ?
        ORDER BY priority DESC, run_after ASC, created_at ASC
        LIMIT 1
      `).get(claimedAt);
      if (!row) return null;
      const attempts = Number(row.attempts || 0) + 1;
      const updated = this.db().prepare(`
        UPDATE autopilot_jobs
        SET status = 'running', attempts = ?, locked_by = ?, locked_at = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(attempts, workerId, claimedAt, claimedAt, row.id);
      if (!updated.changes) return null;
      const runId = makeId('apr');
      this.db().prepare(`
        INSERT INTO autopilot_runs(id, job_id, schedule_id, status, worker_id, attempt, started_at, result)
        VALUES (?, ?, ?, 'running', ?, ?, ?, '{}')
      `).run(runId, row.id, row.schedule_id, workerId, attempts, claimedAt);
      return {
        job: this.getJob(row.id),
        run: this.getRun(runId),
      };
    });
    const claimed = tx();
    if (claimed) {
      activityLog.recordSafe({
        action: 'autopilot.job.claimed',
        actorType: 'system',
        roomId: claimed.job.roomId,
        sessionId: claimed.job.sessionId,
        taskId: claimed.job.taskId,
        entityType: 'autopilot_job',
        entityId: claimed.job.id,
        status: 'running',
        details: { job: claimed.job, run: claimed.run },
      });
    }
    return claimed;
  }

  getRun(id) {
    return rowToRun(this.db().prepare('SELECT * FROM autopilot_runs WHERE id = ?').get(id));
  }

  listRuns({ status, jobId, scheduleId, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (jobId) { where.push('job_id = ?'); args.push(jobId); }
    if (scheduleId) { where.push('schedule_id = ?'); args.push(scheduleId); }
    args.push(toInt(limit, 200, 1, 1000));
    return this.db().prepare(`
      SELECT * FROM autopilot_runs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY started_at DESC
      LIMIT ?
    `).all(...args).map(rowToRun);
  }

  finishRun(runId, { status = 'succeeded', result = {}, error = null, now = nowMs() } = {}) {
    if (!RUN_STATUSES.has(status) || status === 'running') throw new Error('finish status must be succeeded, failed, or cancelled');
    const run = this.getRun(runId);
    if (!run) throw new Error('run not found');
    const job = this.getJob(run.jobId);
    if (!job) throw new Error('job not found');
    const finishedAt = normalizeTs(now);
    const durationMs = Math.max(0, finishedAt - Number(run.startedAt || finishedAt));
    const errorText = error ? String(error).slice(0, MAX_ERROR_LENGTH) : null;
    const tx = this.db().transaction(() => {
      this.db().prepare(`
        UPDATE autopilot_runs
        SET status = ?, finished_at = ?, duration_ms = ?, result = ?, error = ?
        WHERE id = ?
      `).run(status, finishedAt, durationMs, serializeJson(result), errorText, runId);

      if (status === 'succeeded' || status === 'cancelled') {
        this.db().prepare(`
          UPDATE autopilot_jobs
          SET status = ?, locked_by = NULL, locked_at = NULL, last_error = ?, updated_at = ?, completed_at = ?
          WHERE id = ?
        `).run(status, errorText, finishedAt, finishedAt, job.id);
        return;
      }

      if (job.attempts < job.maxAttempts) {
        this.db().prepare(`
          UPDATE autopilot_jobs
          SET status = 'queued', run_after = ?, locked_by = NULL, locked_at = NULL, last_error = ?, updated_at = ?
          WHERE id = ?
        `).run(finishedAt + job.retryBackoffMs, errorText, finishedAt, job.id);
      } else {
        this.db().prepare(`
          UPDATE autopilot_jobs
          SET status = 'failed', locked_by = NULL, locked_at = NULL, last_error = ?, updated_at = ?, completed_at = ?
          WHERE id = ?
        `).run(errorText, finishedAt, finishedAt, job.id);
      }
    });
    tx();
    const updatedJob = this.getJob(job.id);
    const updatedRun = this.getRun(runId);
    activityLog.recordSafe({
      action: `autopilot.job.${updatedJob.status}`,
      actorType: 'system',
      roomId: updatedJob.roomId,
      sessionId: updatedJob.sessionId,
      taskId: updatedJob.taskId,
      entityType: 'autopilot_job',
      entityId: updatedJob.id,
      status: updatedJob.status,
      details: { job: updatedJob, run: updatedRun },
    });
    return { job: updatedJob, run: updatedRun };
  }

  deferRun(runId, { runAfter, result = {}, reason = 'deferred', now = nowMs() } = {}) {
    const run = this.getRun(runId);
    if (!run) throw new Error('run not found');
    const job = this.getJob(run.jobId);
    if (!job) throw new Error('job not found');
    const finishedAt = normalizeTs(now);
    const nextRunAt = normalizeTs(runAfter, finishedAt + job.retryBackoffMs);
    const durationMs = Math.max(0, finishedAt - Number(run.startedAt || finishedAt));
    const cleanReason = String(reason || 'deferred').slice(0, MAX_ERROR_LENGTH);
    const tx = this.db().transaction(() => {
      this.db().prepare(`
        UPDATE autopilot_runs
        SET status = 'succeeded', finished_at = ?, duration_ms = ?, result = ?, error = NULL
        WHERE id = ?
      `).run(finishedAt, durationMs, serializeJson({ ...result, deferred: true, reason: cleanReason, runAfter: nextRunAt }), runId);
      this.db().prepare(`
        UPDATE autopilot_jobs
        SET status = 'queued', run_after = ?, locked_by = NULL, locked_at = NULL, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(nextRunAt, cleanReason, finishedAt, job.id);
    });
    tx();
    const updatedJob = this.getJob(job.id);
    const updatedRun = this.getRun(runId);
    activityLog.recordSafe({
      action: 'autopilot.job.deferred',
      actorType: 'system',
      roomId: updatedJob.roomId,
      sessionId: updatedJob.sessionId,
      taskId: updatedJob.taskId,
      entityType: 'autopilot_job',
      entityId: updatedJob.id,
      status: updatedJob.status,
      details: { reason: cleanReason, job: updatedJob, run: updatedRun },
    });
    return { job: updatedJob, run: updatedRun };
  }

  cancelJob(id, { reason = 'cancelled', now = nowMs() } = {}) {
    const job = this.getJob(id);
    if (!job) throw new Error('job not found');
    if (!['queued', 'running'].includes(job.status)) return job;
    const ts = normalizeTs(now);
    const errorText = String(reason || 'cancelled').slice(0, MAX_ERROR_LENGTH);
    this.db().prepare(`
      UPDATE autopilot_jobs
      SET status = 'cancelled', locked_by = NULL, locked_at = NULL, last_error = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(errorText, ts, ts, id);
    const runningRuns = this.listRuns({ jobId: id, status: 'running', limit: 100 });
    for (const run of runningRuns) {
      this.db().prepare(`
        UPDATE autopilot_runs
        SET status = 'cancelled', finished_at = ?, duration_ms = ?, error = ?
        WHERE id = ?
      `).run(ts, Math.max(0, ts - Number(run.startedAt || ts)), errorText, run.id);
    }
    const updated = this.getJob(id);
    activityLog.recordSafe({
      action: 'autopilot.job.cancelled',
      actorType: 'system',
      roomId: updated.roomId,
      sessionId: updated.sessionId,
      taskId: updated.taskId,
      entityType: 'autopilot_job',
      entityId: updated.id,
      status: 'cancelled',
      details: { job: updated, reason: errorText },
    });
    return updated;
  }

  recoverStaleRunningJobs({ now = nowMs(), olderThanMs = 10 * 60 * 1000, limit = 100 } = {}) {
    const ts = normalizeTs(now);
    const cutoff = ts - toInt(olderThanMs, 10 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000);
    const rows = this.db().prepare(`
      SELECT * FROM autopilot_jobs
      WHERE status = 'running' AND locked_at IS NOT NULL AND locked_at <= ?
      ORDER BY locked_at ASC
      LIMIT ?
    `).all(cutoff, toInt(limit, 100, 1, 1000));
    const recovered = [];
    const tx = this.db().transaction(() => {
      for (const row of rows) {
        const nextStatus = row.attempts < row.max_attempts ? 'queued' : 'failed';
        const runAfter = nextStatus === 'queued' ? ts + Number(row.retry_backoff_ms || 60_000) : row.run_after;
        const message = `Recovered stale running Autopilot job locked by ${row.locked_by || 'unknown'}`;
        this.db().prepare(`
          UPDATE autopilot_jobs
          SET status = ?, run_after = ?, locked_by = NULL, locked_at = NULL, last_error = ?, updated_at = ?,
              completed_at = CASE WHEN ? = 'failed' THEN ? ELSE completed_at END
          WHERE id = ?
        `).run(nextStatus, runAfter, message, ts, nextStatus, ts, row.id);
        this.db().prepare(`
          UPDATE autopilot_runs
          SET status = 'failed', finished_at = ?, duration_ms = MAX(0, ? - started_at), error = ?
          WHERE job_id = ? AND status = 'running'
        `).run(ts, ts, message, row.id);
        recovered.push(this.getJob(row.id));
      }
    });
    tx();
    for (const job of recovered) {
      activityLog.recordSafe({
        action: 'autopilot.job.recovered',
        actorType: 'system',
        roomId: job.roomId,
        sessionId: job.sessionId,
        taskId: job.taskId,
        entityType: 'autopilot_job',
        entityId: job.id,
        status: job.status,
        details: { job },
      });
    }
    return recovered;
  }
}

export const autopilotScheduleStore = new AutopilotScheduleStore();
