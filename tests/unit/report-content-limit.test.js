// PR #18 后回归：RoomReporter 内容上限 1.5M 字符
// 验证：
//   1) 超大 room (10K turns × 200 字符 = 2M 字符) 不会让 generateReport 崩
//   2) truncated=true 正确报告
//   3) 喂给 adapter 的 prompt 字符数 ≤ MAX_TOTAL_CONTENT + prompt 模板（< 1.6M）
//   4) 正常大小 room (50 turns) truncated=false

import { describe, it, expect } from 'vitest';
import { generateReport } from '../../src/report/RoomReporter.js';

function makeRoom(turnCount, contentLen = 200) {
  const conversation = [];
  for (let i = 0; i < turnCount; i++) {
    conversation.push({
      from: i % 2 === 0 ? 'user' : 'claude',
      displayName: 'Claude',
      content: ('内容片段 ' + i + ' ').repeat(Math.ceil(contentLen / 12)).slice(0, contentLen),
      at: new Date().toISOString(),
    });
  }
  return {
    id: 'r-stress',
    name: '压力测试房',
    mode: 'chat',
    createdAt: new Date().toISOString(),
    members: [],
    conversation,
  };
}

function makeCapturingAdapter() {
  const captured = { promptLen: 0 };
  return {
    captured,
    adapter: {
      id: 'stub-capture',
      async chat(messages) {
        // 加总 system + user 内容长度
        captured.promptLen = (messages || []).reduce((s, m) => s + (m.content || '').length, 0);
        return {
          reply: '# 压力测试报告\n\n' + '正常长度回复内容。\n'.repeat(20),
          tokensIn: Math.floor(captured.promptLen / 2),
          tokensOut: 200,
        };
      },
    },
  };
}

describe('RoomReporter 内容上限 1.5M', () => {
  it('超大 room (2M 字符) generateReport 不崩 + truncated=true', async () => {
    const room = makeRoom(10_000, 200);  // 约 2M 字符
    const { adapter, captured } = makeCapturingAdapter();
    const res = await generateReport({ room, adapter });
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    expect(captured.promptLen).toBeGreaterThan(1_000_000);
    expect(captured.promptLen).toBeLessThan(1_600_000);  // 内容 cap 1.5M + 模板 ~3K + 一些 head
  }, 30_000);

  it('正常大小 room (50 turns) truncated=false', async () => {
    const room = makeRoom(50, 200);
    const { adapter } = makeCapturingAdapter();
    const res = await generateReport({ room, adapter });
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(false);
  });

  it('单条 turn 超长 (50K 字符) → 单条 cap 到 32K + 整体不溢出', async () => {
    const room = makeRoom(3, 50_000);
    const { adapter, captured } = makeCapturingAdapter();
    const res = await generateReport({ room, adapter });
    expect(res.ok).toBe(true);
    expect(captured.promptLen).toBeLessThan(200_000);  // 3 × 32K + 模板 < 200K
  });

  it('adapter 自报 maxPromptChars=1M (如 codex CLI) → 喂 codex 的内容被 cap 到 1M 内', async () => {
    const room = makeRoom(10_000, 200);  // 约 2M 字符
    const { adapter, captured } = makeCapturingAdapter();
    adapter.maxPromptChars = 1_000_000;  // 模拟 CodexSpawnAdapter
    const res = await generateReport({ room, adapter });
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    // promptLen = system + user(含 ~1M 内容 + 模板 ~3K) < 1,048,576（codex 硬上限）
    expect(captured.promptLen).toBeLessThan(1_048_576);
    expect(captured.promptLen).toBeGreaterThan(900_000);
  }, 30_000);

  it('adapter 自报 maxReportContentChars 时优先按报告上下文预算压缩', async () => {
    const room = makeRoom(10_000, 200);
    const { adapter, captured } = makeCapturingAdapter();
    adapter.maxPromptChars = 1_000_000;
    adapter.maxReportContentChars = 80_000;

    const res = await generateReport({ room, adapter });

    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.sourceContentLimit).toBe(80_000);
    expect(res.reportStrategy).toBe('map-reduce');
    expect(res.chunkCount).toBeGreaterThan(1);
    expect(captured.promptLen).toBeLessThan(120_000);
  }, 30_000);

  it('超出 adapter 报告预算时会先分块摘要再合并最终报告', async () => {
    const room = makeRoom(2_000, 200);
    const captured = { calls: 0, finalPrompt: '' };
    const adapter = {
      id: 'codex-like',
      maxPromptChars: 1_000_000,
      maxReportContentChars: 60_000,
      async chat(messages) {
        captured.calls += 1;
        const prompt = (messages || []).map(m => m.content || '').join('\n');
        if (prompt.includes('# 分块摘要任务')) {
          return {
            reply: `### 分块摘要 ${captured.calls}\n` + '关键事实、决定、风险、下一步。\n'.repeat(20),
            tokensIn: 10,
            tokensOut: 20,
          };
        }
        captured.finalPrompt = prompt;
        return {
          reply: '# 最终报告\n\n' + '基于分块摘要合并后的完整报告。\n'.repeat(100),
          tokensIn: 30,
          tokensOut: 40,
        };
      },
    };

    const res = await generateReport({ room, adapter });

    expect(res.ok).toBe(true);
    expect(res.reportStrategy).toBe('map-reduce');
    expect(res.chunkCount).toBeGreaterThan(1);
    expect(captured.calls).toBe(res.chunkCount + 1);
    expect(captured.finalPrompt).toContain('本报告由系统先对原始房间记录分块摘要');
    expect(res.tokensIn).toBe(10 * res.chunkCount + 30);
    expect(res.tokensOut).toBe(20 * res.chunkCount + 40);
  }, 30_000);

  it('Codex context-window 错误会自动缩小单次报告输入并重试', async () => {
    const room = makeRoom(10_000, 200);
    const captured = { calls: 0, promptLens: [] };
    const adapter = {
      id: 'codex-like',
      maxPromptChars: 1_000_000,
      contextRetryContentChars: 32_000,
      async chat(messages) {
        captured.calls += 1;
        const promptLen = (messages || []).reduce((s, m) => s + (m.content || '').length, 0);
        captured.promptLens.push(promptLen);
        if (captured.calls === 1) {
          const err = new Error("Codex ran out of room in the model's context window");
          err.code = 'CONTEXT_WINDOW_EXHAUSTED';
          throw err;
        }
        return {
          reply: '# 压缩重试报告\n\n' + '压缩后报告内容。'.repeat(100),
          tokensIn: Math.floor(promptLen / 2),
          tokensOut: 200,
        };
      },
    };

    const res = await generateReport({ room, adapter });

    expect(res.ok).toBe(true);
    expect(captured.calls).toBe(2);
    expect(captured.promptLens[1]).toBeLessThan(captured.promptLens[0]);
    expect(res.truncated).toBe(true);
    expect(res.retryReason).toBe('context-window-retry');
    expect(res.sourceContentLimit).toBe(32_000);
  }, 30_000);
});
