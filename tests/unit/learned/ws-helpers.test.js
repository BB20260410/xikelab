import { describe, it, expect } from 'vitest';
import { backoffDelay, createWsDispatcher } from '../../../public/src/web/ws-helpers.js';

describe('backoffDelay', () => {
  it('1st attempt 800ms', () => expect(backoffDelay(1)).toBe(800));
  it('2nd 1600ms', () => expect(backoffDelay(2)).toBe(1600));
  it('cap at 8000ms', () => expect(backoffDelay(8)).toBe(8000));
  it('超过 max 返 null', () => expect(backoffDelay(9)).toBe(null));
  it('custom maxAttempts', () => expect(backoffDelay(3, { max: 2 })).toBe(null));
});

describe('createWsDispatcher', () => {
  it('type 命中调 handler', () => {
    let called = null;
    const d = createWsDispatcher({ foo: (m) => { called = m; } });
    d(JSON.stringify({ type: 'foo', v: 1 }));
    expect(called).toEqual({ type: 'foo', v: 1 });
  });
  it('未知 type 不抛', () => {
    const d = createWsDispatcher({ foo: () => {} });
    expect(() => d(JSON.stringify({ type: 'bar' }))).not.toThrow();
  });
  it('坏 JSON 静默吞', () => {
    const d = createWsDispatcher({});
    expect(() => d('{not json')).not.toThrow();
  });
});
