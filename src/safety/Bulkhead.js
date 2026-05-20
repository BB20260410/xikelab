// v0.56 Sprint 15-R2 — Bulkhead（舱壁隔离）
//
// 参考：ruflo @claude-flow/shared/src/resilience/bulkhead.ts
//
// 限制每个 key（通常是 adapter.id）的最大并发调用数。超过则排队，队列满了直接拒。
// 用途：arena 房 5 个 AI 同时调一个 adapter 时，避免 spawn 5 个 claude 撑爆资源。

const DEFAULT_OPTS = {
  maxConcurrent: 3,    // 同时执行
  maxQueue: 20,         // 排队上限（防 OOM）
  queueTimeoutMs: 60_000,  // 排队超时（防永久卡）
};

export class Bulkhead {
  constructor(key, opts = {}) {
    this.key = String(key || 'unknown');
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.running = 0;
    this.queue = [];   // { resolve, reject, enqueuedAt, timer }
  }

  /**
   * 用 acquire/release 包装异步函数：
   * const release = await bulkhead.acquire(); try { ... } finally { release(); }
   */
  async acquire() {
    if (this.running < this.opts.maxConcurrent) {
      this.running++;
      return () => this._release();
    }
    if (this.queue.length >= this.opts.maxQueue) {
      const err = new Error(`[Bulkhead:${this.key}] 队列满（${this.queue.length}/${this.opts.maxQueue}），拒绝接受新调用`);
      err.code = 'BULKHEAD_FULL';
      throw err;
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, enqueuedAt: Date.now() };
      entry.timer = setTimeout(() => {
        // 排队超时
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        const err = new Error(`[Bulkhead:${this.key}] 排队 ${this.opts.queueTimeoutMs}ms 超时`);
        err.code = 'BULKHEAD_QUEUE_TIMEOUT';
        reject(err);
      }, this.opts.queueTimeoutMs);
      this.queue.push(entry);
    });
  }

  _release() {
    this.running = Math.max(0, this.running - 1);
    if (this.queue.length > 0 && this.running < this.opts.maxConcurrent) {
      const entry = this.queue.shift();
      if (entry.timer) clearTimeout(entry.timer);
      this.running++;
      entry.resolve(() => this._release());
    }
  }

  snapshot() {
    return {
      key: this.key,
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.opts.maxConcurrent,
      maxQueue: this.opts.maxQueue,
    };
  }
}

class BulkheadRegistry {
  constructor() { this.map = new Map(); }
  get(key, opts) {
    if (!this.map.has(key)) this.map.set(key, new Bulkhead(key, opts));
    return this.map.get(key);
  }
  all() { return Array.from(this.map.values()).map((b) => b.snapshot()); }
}

export const bulkheads = new BulkheadRegistry();
