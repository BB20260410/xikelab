import { describe, it, expect } from 'vitest';
import { estimateTokens, trimHistoryByTokens } from '../../../src/room/historyTrimmer.js';

describe('estimateTokens', () => {
  it('英文按 4:1', () => {
    expect(estimateTokens('Hello world')).toBe(3);  // 11 chars / 4 ≈ 3
  });
  it('中文按 1:1', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });
  it('混合中英', () => {
    expect(estimateTokens('Hello 你好')).toBe(4);  // 2 cjk + 6 non-cjk / 4 = 2+2
  });
  it('空字符串', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('trimHistoryByTokens', () => {
  it('容量够 - 全保留', () => {
    const r = trimHistoryByTokens({
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
      maxContextTokens: 10000,
    });
    expect(r.context.length).toBe(2);
    expect(r.droppedCount).toBe(0);
  });
  it('容量小 - 丢旧留新', () => {
    const r = trimHistoryByTokens({
      messages: Array(20).fill(0).map(() => ({ role: 'user', content: '内容'.repeat(50) })),
      maxContextTokens: 500,
    });
    expect(r.droppedCount).toBeGreaterThan(0);
    expect(r.context.length).toBeLessThan(20);
  });
  it('budget 0 - 全丢', () => {
    const r = trimHistoryByTokens({
      messages: [{ role: 'user', content: 'a' }],
      maxContextTokens: 4096,
      systemPrompt: 'x'.repeat(100000),
    });
    expect(r.context.length).toBe(0);
  });
});

describe('consensus-detector', () => {
  it('共识场景', async () => {
    const { detectConsensus } = await import('../../../src/room/learned/consensus-detector.js');
    const r = detectConsensus([
      { speaker: 'A', content: '我同意方案 X' },
      { speaker: 'B', content: '达成共识' },
    ]);
    expect(r.consensus).toBe(true);
  });
  it('分歧场景', async () => {
    const { detectConsensus } = await import('../../../src/room/learned/consensus-detector.js');
    const r = detectConsensus([
      { speaker: 'A', content: '我不同意' },
    ]);
    expect(r.consensus).toBe(false);
  });
});

describe('hybrid-merge RRF', () => {
  it('两路融合', async () => {
    const { mergeHybrid } = await import('../../../src/knowledge/learned/hybrid-merge.js');
    const r = mergeHybrid(
      [{ id: 'a', score: 5 }, { id: 'b', score: 3 }],
      [{ id: 'b', score: 0.9 }, { id: 'c', score: 0.5 }],
      { topN: 3 }
    );
    expect(r[0].id).toBe('b'); // b 出现在两个 list，rrf 最高
    expect(r.length).toBe(3);
  });
});

describe('assertion', () => {
  it('contains 通过', async () => {
    const { runAssertion } = await import('../../../src/skills/learned/assertion.js');
    expect(runAssertion('hello world', { type: 'contains', value: 'world' }).pass).toBe(true);
  });
  it('min_length 不通过', async () => {
    const { runAssertion } = await import('../../../src/skills/learned/assertion.js');
    expect(runAssertion('a', { type: 'min_length', value: 100 }).pass).toBe(false);
  });
  it('json_valid 通过', async () => {
    const { runAssertion } = await import('../../../src/skills/learned/assertion.js');
    expect(runAssertion('{"a":1}', { type: 'json_valid' }).pass).toBe(true);
  });
});

describe('squad-diff', () => {
  it('计算 added/removed', async () => {
    const { diff } = await import('../../../src/room/learned/squad-diff-preview.js');
    const d = diff('a\nb\nc', 'a\nX\nc');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });
});

describe('rule-dry-run', () => {
  it('event type 匹配规则', async () => {
    const { dryRun } = await import('../../../src/autopilot/learned/rule-dry-run.js');
    const r = dryRun([
      { id: '1', name: 'on done', eventTypes: ['room_done'], action: 'notify', enabled: true },
      { id: '2', name: 'on error', eventTypes: ['room_error'], action: 'notify', enabled: true },
    ], { type: 'room_done' });
    expect(r.matched.length).toBe(1);
    expect(r.skipped.length).toBe(1);
  });
});
