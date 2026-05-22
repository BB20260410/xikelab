// vitest: diff-viewer 单测
//   - 全等：ops 全 '='，added=removed=0
//   - 行级增删：识别新增 / 删除 + stats 正确
//   - diffEventStreams 默认抽 text
//   - renderUnified 输出符合预期前缀

import { describe, it, expect } from 'vitest';
import { diffText, diffEventStreams, renderUnified } from '../../src/server/archive/diff-viewer.js';

describe('diff-viewer', () => {
  it('全等文本 → 全 = ops', () => {
    const r = diffText('a\nb\nc', 'a\nb\nc');
    expect(r.stats.added).toBe(0);
    expect(r.stats.removed).toBe(0);
    expect(r.stats.same).toBe(3);
    expect(r.ops.every((o) => o.op === '=')).toBe(true);
  });

  it('单行替换 → 1 -, 1 +', () => {
    const r = diffText('a\nb\nc', 'a\nX\nc');
    expect(r.stats.added).toBe(1);
    expect(r.stats.removed).toBe(1);
    expect(r.stats.same).toBe(2);
  });

  it('右侧多行 → +', () => {
    const r = diffText('a\nb', 'a\nb\nc\nd');
    expect(r.stats.added).toBe(2);
    expect(r.stats.removed).toBe(0);
    expect(r.stats.same).toBe(2);
  });

  it('diffEventStreams 默认抽 text 字段', () => {
    const left = [{ id: 1, text: 'hi' }, { id: 2, text: 'world' }];
    const right = [{ id: 1, text: 'hi' }, { id: 2, text: 'WORLD' }];
    const r = diffEventStreams(left, right);
    expect(r.stats.added).toBe(1);
    expect(r.stats.removed).toBe(1);
    expect(r.stats.same).toBe(1);
  });

  it('renderUnified 前缀正确：=/+/-', () => {
    const r = diffText('keep\nold', 'keep\nnew');
    const u = renderUnified(r);
    expect(u.split('\n')[0]).toBe(' keep');
    expect(u).toContain('-old');
    expect(u).toContain('+new');
  });
});
