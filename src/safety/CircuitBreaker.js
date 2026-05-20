// v0.56 Sprint 15-R1 — Circuit Breaker（断路器）
//
// 参考：ruflo @claude-flow/shared/src/resilience/circuit-breaker.ts（MIT）
//
// 三态：CLOSED（正常）→ 失败 N 次 → OPEN（拒绝）→ 等冷却 → HALF_OPEN → 成功 M 次 → CLOSED
//
// 用途：包装 RoomAdapter.chat()。某 adapter 网络挂时快速失败（不再等 30 min timeout）+
//      冷却后自动试探恢复。失败状态对同 adapter 的所有房可见（节省资源）。

export const STATE = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

const DEFAULT_OPTS = {
  failureThreshold: 5,        // 连续 N 次失败 → OPEN
  successThreshold: 2,        // HALF_OPEN 成功 M 次 → CLOSED
  cooldownMs: 30_000,          // OPEN 后多久能尝试 HALF_OPEN
  halfOpenMaxConcurrent: 1,   // HALF_OPEN 同时只放 1 个请求试探
};

/**
 * 给一个 key（通常是 adapter.id）维护一个断路器
 */
export class CircuitBreaker {
  constructor(key, opts = {}) {
    this.key = String(key || 'unknown');
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.state = STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.consecutiveSuccessesInHalfOpen = 0;
    this.openedAt = 0;
    this.lastError = null;
    this.halfOpenInflight = 0;
    this.listeners = new Set();
  }

  /** 决定是否允许调用通过；若不允许直接抛 */
  beforeCall() {
    const now = Date.now();
    if (this.state === STATE.OPEN) {
      if (now - this.openedAt >= this.opts.cooldownMs) {
        // 转 HALF_OPEN 试探
        this._setState(STATE.HALF_OPEN);
        this.halfOpenInflight = 0;
      } else {
        const wait = this.opts.cooldownMs - (now - this.openedAt);
        const err = new Error(`[CircuitBreaker:${this.key}] OPEN — 还有 ${Math.ceil(wait / 1000)}s 才能再试；上次错: ${this.lastError || 'n/a'}`);
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
    }
    if (this.state === STATE.HALF_OPEN && this.halfOpenInflight >= this.opts.halfOpenMaxConcurrent) {
      const err = new Error(`[CircuitBreaker:${this.key}] HALF_OPEN 试探中（${this.halfOpenInflight} in-flight），稍后重试`);
      err.code = 'CIRCUIT_HALF_OPEN_BUSY';
      throw err;
    }
    if (this.state === STATE.HALF_OPEN) this.halfOpenInflight++;
  }

  /** 调用成功后调 */
  onSuccess() {
    if (this.state === STATE.HALF_OPEN) {
      this.halfOpenInflight = Math.max(0, this.halfOpenInflight - 1);
      this.consecutiveSuccessesInHalfOpen++;
      if (this.consecutiveSuccessesInHalfOpen >= this.opts.successThreshold) {
        this._setState(STATE.CLOSED);
        this.consecutiveFailures = 0;
        this.consecutiveSuccessesInHalfOpen = 0;
        this.lastError = null;
      }
    } else if (this.state === STATE.CLOSED) {
      this.consecutiveFailures = 0;
    }
  }

  /** 调用失败后调 */
  onFailure(err) {
    this.lastError = err?.message || String(err || 'error');
    if (this.state === STATE.HALF_OPEN) {
      this.halfOpenInflight = Math.max(0, this.halfOpenInflight - 1);
      // HALF_OPEN 失败立即回 OPEN
      this._setState(STATE.OPEN);
      this.openedAt = Date.now();
      this.consecutiveSuccessesInHalfOpen = 0;
    } else if (this.state === STATE.CLOSED) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.opts.failureThreshold) {
        this._setState(STATE.OPEN);
        this.openedAt = Date.now();
      }
    }
  }

  /** 用户主动 reset（前端"立即恢复"按钮） */
  reset() {
    this._setState(STATE.CLOSED);
    this.consecutiveFailures = 0;
    this.consecutiveSuccessesInHalfOpen = 0;
    this.halfOpenInflight = 0;
    this.lastError = null;
  }

  snapshot() {
    return {
      key: this.key,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccessesInHalfOpen: this.consecutiveSuccessesInHalfOpen,
      openedAt: this.openedAt || null,
      cooldownRemaining: this.state === STATE.OPEN
        ? Math.max(0, this.opts.cooldownMs - (Date.now() - this.openedAt))
        : 0,
      lastError: this.lastError,
      halfOpenInflight: this.halfOpenInflight,
    };
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _setState(newState) {
    if (this.state === newState) return;
    const old = this.state;
    this.state = newState;
    for (const fn of this.listeners) {
      try { fn({ key: this.key, from: old, to: newState }); } catch {}
    }
  }
}

/** 进程级管理：每个 key 一个 breaker（懒加载） */
class CircuitBreakerRegistry {
  constructor() {
    this.map = new Map();
    this.broadcast = null;
  }
  attachBroadcast(fn) { this.broadcast = typeof fn === 'function' ? fn : null; }
  get(key, opts) {
    if (!this.map.has(key)) {
      const cb = new CircuitBreaker(key, opts);
      cb.on((evt) => {
        if (this.broadcast) try { this.broadcast({ type: 'circuit_state', ...evt }); } catch {}
      });
      this.map.set(key, cb);
    }
    return this.map.get(key);
  }
  all() {
    return Array.from(this.map.values()).map((cb) => cb.snapshot());
  }
  reset(key) {
    const cb = this.map.get(key);
    if (cb) { cb.reset(); return true; }
    return false;
  }
}

export const breakers = new CircuitBreakerRegistry();
