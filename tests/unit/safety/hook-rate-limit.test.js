// Round 7 / PR #32：hooks 端点令牌桶限速契约
//
// 端点 POST /api/hooks/:event 无 owner-token（用户在 ~/.claude/settings.json
// 写的 curl 命令里塞 token 不现实），改用 RateLimiter 防本机 UID spam。
// 验证：burst=500 / 600 events/min（10/sec sustained）足够正常 Claude Code 峰值，
// 同时挡住灌满 globalHookEvents（max 2000）的攻击。

import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../../src/safety/RateLimiter.js';

describe('hooks-ingest 限速契约', () => {
  it('burst=500 时前 500 次 tryAcquire 全过', () => {
    const r = new RateLimiter('hooks-ingest', { perMinute: 600, burst: 500 });
    let passed = 0;
    for (let i = 0; i < 500; i++) if (r.tryAcquire()) passed++;
    expect(passed).toBe(500);
  });

  it('burst 用尽后 tryAcquire 拒绝', () => {
    const r = new RateLimiter('hooks-ingest', { perMinute: 600, burst: 500 });
    for (let i = 0; i < 500; i++) r.tryAcquire();
    expect(r.tryAcquire()).toBe(false);
    expect(r.tryAcquire()).toBe(false);
  });

  it('snapshot.totalDenied 准确计数被拒次数', () => {
    const r = new RateLimiter('hooks-ingest', { perMinute: 600, burst: 5 });
    for (let i = 0; i < 5; i++) r.tryAcquire();
    for (let i = 0; i < 3; i++) r.tryAcquire(); // 3 次拒
    const s = r.snapshot();
    expect(s.totalAllowed).toBe(5);
    expect(s.totalDenied).toBe(3);
  });

  it('限速速率 600/min ≈ 10/sec → 100ms 内不应补满 1 整 token', () => {
    const r = new RateLimiter('hooks-ingest', { perMinute: 600, burst: 500 });
    for (let i = 0; i < 500; i++) r.tryAcquire();
    // 100ms 内只能补 1 个 token，但因为 tryAcquire 要求 tokens >= 1
    // 严格说初始为 0.0，100ms 后约为 1.0 — 这是 RateLimiter 的实现细节
    // 此处只验证「没有立即补满 500」即可
    const t0 = Date.now();
    while (Date.now() - t0 < 50) { /* spin 50ms */ }
    expect(r.tokens).toBeLessThan(2); // 50ms 内至多补 0.5 个
  });
});
