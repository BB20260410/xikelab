const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_JOBS = 50;

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

export class ReportJobStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxJobs = DEFAULT_MAX_JOBS } = {}) {
    this.ttlMs = ttlMs;
    this.maxJobs = maxJobs;
    this.jobs = new Map();
  }

  create({ jobId, roomId, adapterId, model, outputPath } = {}) {
    if (!jobId) throw new Error('jobId required');
    const now = Date.now();
    this.cleanup(now);
    const job = {
      jobId,
      roomId,
      adapterId,
      model: model || '',
      outputPath: outputPath || null,
      status: 'queued',
      createdAt: nowIso(now),
      createdAtMs: now,
    };
    this.jobs.set(jobId, job);
    this.cleanup(now);
    return this.publicJob(job);
  }

  update(jobId, patch = {}) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    Object.assign(job, patch);
    if ((job.status === 'done' || job.status === 'error') && !job.finishedAt) {
      job.finishedAt = nowIso();
    }
    return this.publicJob(job);
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    return job ? this.publicJob(job) : null;
  }

  publicJob(job) {
    if (!job) return null;
    const out = { ...job };
    delete out.createdAtMs;
    return out;
  }

  cleanup(now = Date.now()) {
    for (const [jobId, job] of this.jobs.entries()) {
      if (now - (job.createdAtMs || 0) > this.ttlMs) this.jobs.delete(jobId);
    }
    if (this.jobs.size <= this.maxJobs) return;
    const sorted = [...this.jobs.values()].sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
    for (const job of sorted.slice(0, this.jobs.size - this.maxJobs)) {
      this.jobs.delete(job.jobId);
    }
  }
}
