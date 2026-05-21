import { describe, it, expect } from 'vitest';
import { RoomAdapter } from '../../../src/room/RoomAdapter.js';

const a = new RoomAdapter({ id: 'test', displayName: 'T' });

describe('RoomAdapter._countTokens', () => {
  it('英文', () => {
    expect(a._countTokens([{ content: 'Hello world' }])).toBe(3);
  });
  it('中文', () => {
    expect(a._countTokens([{ content: '你好世界' }])).toBe(4);
  });
  it('多 message 累加', () => {
    expect(a._countTokens([
      { content: 'abcd' },
      { content: '你好' },
    ])).toBe(3); // 1 + 2
  });
});

describe('RoomAdapter._truncateMessages', () => {
  it('容量够 - 不裁', () => {
    const r = a._truncateMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
    ], 100000);
    expect(r.length).toBe(2);
  });
  it('容量小 - 留最新 + system', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      ...Array(20).fill(0).map(() => ({ role: 'user', content: '内容'.repeat(50) })),
    ];
    const r = a._truncateMessages(msgs, 5000);
    expect(r[0].role).toBe('system');
    expect(r.length).toBeLessThan(20);
  });
});

describe('RoomAdapter._buildFileContext', () => {
  it('无附件 - 原样', () => {
    expect(a._buildFileContext('hello', [])).toBe('hello');
  });
  it('有附件 - 拼上下文', () => {
    const r = a._buildFileContext('q', [{ name: 'a.md', content: 'doc', size: 1024 }]);
    expect(r).toContain('📎 a.md');
    expect(r).toContain('doc');
  });
});

describe('RoomAdapter._accumulateStream', () => {
  it('string array', () => {
    expect(a._accumulateStream(['a', 'b', 'c'])).toBe('abc');
  });
  it('object chunks', () => {
    expect(a._accumulateStream([{ text: 'a' }, { content: 'b' }])).toBe('ab');
  });
});
