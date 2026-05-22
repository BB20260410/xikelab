// 用 panel 现成 vitest（package.json 已有 vitest@4.1.7）。
// 三个 Phase 6 PoC 场景全部回归。

import { describe, it, expect } from 'vitest';
import { LogRing } from '../../src/server/services/log-ring.js';

describe('LogRing', () => {
  it('drop-oldest：失配（producer 快于 consumer）丢最旧的，count 累计', async () => {
    const r = new LogRing(4, 'drop-oldest');
    for (let i = 0; i < 10; i++) await r.push(i);
    const drained = r.drain();
    expect(drained).toEqual([6, 7, 8, 9]);
    expect(r.stats().dropped).toBe(6);
  });

  it('block：失配场景 producer await 直到 consumer 腾位', async () => {
    const r = new LogRing(2, 'block');
    await r.push('a');
    await r.push('b');
    expect(r.stats().size).toBe(2);
    let pushed = false;
    const p = r.push('c').then(() => { pushed = true; });
    // 同 tick 推不进去（满）
    await new Promise(res => setImmediate(res));
    expect(pushed).toBe(false);
    expect(r.stats().waiters).toBe(1);
    // pop 后唤醒
    expect(r.pop()).toBe('a');
    await p;
    expect(pushed).toBe(true);
    expect(r.drain()).toEqual(['b', 'c']);
  });

  it('匹配场景：consumer 跟得上 producer 时零丢失零阻塞', async () => {
    const r = new LogRing(8, 'drop-oldest');
    for (let i = 0; i < 20; i++) {
      await r.push(i);
      expect(r.pop()).toBe(i);
    }
    expect(r.stats().dropped).toBe(0);
    expect(r.stats().size).toBe(0);
  });

  it('FIFO 序保持', async () => {
    const r = new LogRing(3, 'drop-oldest');
    await r.push(1); await r.push(2); await r.push(3);
    expect(r.drain()).toEqual([1, 2, 3]);
  });

  it('环回正确（tail / head wrap）', async () => {
    const r = new LogRing(3, 'drop-oldest');
    await r.push(1); await r.push(2); await r.push(3);
    r.pop(); r.pop();
    await r.push(4); await r.push(5);
    expect(r.drain()).toEqual([3, 4, 5]);
  });

  it('参数校验', () => {
    expect(() => new LogRing(0, 'drop-oldest')).toThrow(RangeError);
    expect(() => new LogRing(8, 'wat')).toThrow(TypeError);
    expect(() => new LogRing(1.5, 'block')).toThrow(RangeError);
  });

  it('drain 不破坏后续 push', async () => {
    const r = new LogRing(3, 'drop-oldest');
    await r.push('x'); await r.push('y');
    expect(r.drain()).toEqual(['x', 'y']);
    expect(r.stats().size).toBe(0);
    await r.push('z');
    expect(r.pop()).toBe('z');
  });
});
