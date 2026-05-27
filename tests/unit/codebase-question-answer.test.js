import { describe, expect, it } from 'vitest';
import { buildCodebaseQuestionAnswer } from '../../src/agents/CodebaseQuestionAnswer.js';

describe('CodebaseQuestionAnswer weak-evidence guard', () => {
  it('marks weakEvidence and returns no answer lines when no evidence matched', () => {
    const out = buildCodebaseQuestionAnswer({ query: 'where is X', results: [] });
    expect(out.ok).toBe(true);
    expect(out.weakEvidence).toBe(true);
    expect(out.answerLines).toEqual([]);
    expect(out.citations).toEqual([]);
    expect(out.limitations.some((l) => /insufficient/i.test(l))).toBe(true);
  });

  it('flags structural-evidence absence when only text/name matches exist', () => {
    const out = buildCodebaseQuestionAnswer({
      query: 'budget',
      resultCount: 1,
      results: [
        { path: 'src/x.js', line: 10, kind: 'text', reason: ['keyword:budget'], score: 5, citation: { evidence: [{ kind: 'text', line: 10, text: 'budget' }] } },
      ],
    });
    // 仅文本命中、无 reference/route/type 结构证据 → 弱证据
    expect(out.weakEvidence).toBe(true);
    expect(out.limitations.some((l) => /structural/i.test(l))).toBe(true);
    // answerLines 不超出 citation 范围
    expect(out.answerLines.length).toBeLessThanOrEqual(out.citations.length);
  });

  it('aggregates reference kinds into coverage.referenceKindCounts (P0-A summary, D1)', () => {
    const out = buildCodebaseQuestionAnswer({
      query: 'where is the room adapter budget callback',
      resultCount: 1,
      results: [
        {
          path: 'src/room/RoomAdapter.js', line: 20, kind: 'symbol', score: 140,
          reason: ['symbol:onBudget'],
          citation: {
            kind: 'symbol',
            evidence: [{ kind: 'symbol', line: 20, name: 'onBudget' }],
            graph: {
              references: [
                { kind: 'callback-registration', fromPath: 'src/room/RoomAdapter.js', toPath: 'src/budget/BudgetPolicyStore.js' },
                { kind: 'callback-registration', fromPath: 'src/room/RoomAdapter.js', toPath: 'src/x.js' },
                { kind: 'object-property-flow', fromPath: 'src/room/RoomAdapter.js', toPath: 'src/y.js' },
              ],
            },
          },
        },
      ],
    });
    expect(out.coverage.referenceKindCounts).toMatchObject({ 'callback-registration': 2, 'object-property-flow': 1 });
    // 有结构级引用证据 → 不应标弱证据
    expect(out.weakEvidence).toBe(false);
  });
});
