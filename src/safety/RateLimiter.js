// v0.56 Sprint 15-R3 — RateLimiter（令牌桶限速）
//
// 参考：ruflo @claude-flow/shared/src/resilience/rate-limiter.ts
//
// 每个 key（adapter.id）独立令牌桶。容量 burst，按速率 perMinute 补 token。
// 用途：MiniMax / Gemini API 这种有 quota 的，客户端先压制避免 503。

const DEFAULT_OPTS = {
  perMinute: 60,    // 每分钟 60 次
  burst: 10,         // 突发上限
};

export class RateLimiter {
  constructor(key, opts = {}) {
    this.key = String(key || 'unknown');
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.tokens = this.opts.burst;
    this.lastRefill = Date.now();
    this.totalAllowed = 0;
    this.totalDenied = 0;
  }

  _refill() {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;
    const tokensPerMs = this.opts.perMinute / 60_000;
    const add = elapsedMs * tokensPerMs;
    this.tokens = Math.min(this.opts.burst, this.tokens + add);
    this.lastRefill = now;
  }

  /** 同步消费 1 token；返 true=放行 false=拒绝 */
  tryAcquire() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.totalAllowed++;
      return true;
    }
    this.totalDenied++;
    return false;
  }

  /** 异步等到有 token 可用（带超时） */
  async acquire(timeoutMs = 30_000) {
    if (this.tryAcquire()) return;
    const deadline = Date.now() + timeoutMs;
    // 每 200ms 重试
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (this.tryAcquire()) return;
    }
    const err = new Error(`[RateLimiter:${this.key}] 等 token 超时 ${timeoutMs}ms（每分钟 ${this.opts.perMinute} 次配额）`);
    err.code = 'RATE_LIMITED';
    throw err;
  }

  snapshot() {
    this._refill();
    return {
      key: this.key,
      tokens: Math.round(this.tokens * 10) / 10,
      burst: this.opts.burst,
      perMinute: this.opts.perMinute,
      totalAllowed: this.totalAllowed,
      totalDenied: this.totalDenied,
    };
  }
}

class RateLimiterRegistry {
  constructor() { this.map = new Map(); }
  get(key, opts) {
    if (!this.map.has(key)) this.map.set(key, new RateLimiter(key, opts));
    return this.map.get(key);
  }
  /** 用户在 ⚙️ 改了 adapter 的限速 → 替换 */
  set(key, opts) {
    this.map.set(key, new RateLimiter(key, opts));
  }
  all() { return Array.from(this.map.values()).map((r) => r.snapshot()); }
}

export const rateLimiters = new RateLimiterRegistry();
