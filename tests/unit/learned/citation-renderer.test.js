import { describe, it, expect } from 'vitest';
import { renderCitations, renderBibliography } from '../../../src/knowledge/learned/citation-renderer.js';

const citations = [
  { index: 1, chunkId: 'c1', docId: 'd1', docTitle: '《设计模式》', sourceUrl: 'https://x.com/dp', textSnippet: '...' },
  { index: 2, chunkId: 'c2', docId: 'd2', docTitle: '《重构》', sourceUrl: null, textSnippet: '...' },
];

describe('renderCitations', () => {
  it('替换 [1] [2] 成 <sup><a>', () => {
    const r = renderCitations('方案 A 更合适 [1]，理由参考 [2]', citations);
    expect(r).toContain('href="#cite-1"');
    expect(r).toContain('href="#cite-2"');
    expect(r).toContain('data-cite-chunk-id="c1"');
  });
  it('无 citations 原样返回', () => {
    expect(renderCitations('hello [1]', [])).toBe('hello [1]');
  });
  it('保护 markdown 链接 [text](url) 不替换', () => {
    const r = renderCitations('see [link](http://x)', citations);
    expect(r).toBe('see [link](http://x)');
  });
  it('未知 [N] 不替换', () => {
    const r = renderCitations('用 [99] 不存在', citations);
    expect(r).toBe('用 [99] 不存在');
  });
});

describe('renderBibliography', () => {
  it('生成 ol 列表', () => {
    const r = renderBibliography(citations);
    expect(r).toContain('cite-1');
    expect(r).toContain('cite-2');
    expect(r).toContain('《设计模式》');
  });
  it('空 citations 返空', () => {
    expect(renderBibliography([])).toBe('');
  });
});
