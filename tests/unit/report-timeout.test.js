import { describe, it, expect } from 'vitest';
import { generateReport } from '../../src/report/RoomReporter.js';

function makeRoom() {
  return {
    id: 'r-report-timeout',
    name: '报告超时测试',
    mode: 'chat',
    createdAt: new Date().toISOString(),
    cwd: process.cwd(),
    members: [],
    conversation: [
      { from: 'user', content: '请总结这段对话', at: new Date().toISOString() },
      { from: 'assistant', displayName: 'AI', content: '这是一段需要总结的内容。', at: new Date().toISOString() },
    ],
  };
}

describe('RoomReporter timeout', () => {
  it('adapter 忽略 abort 时也会按报告硬超时返回错误', async () => {
    let signalSeen = null;
    const adapter = {
      id: 'stuck-adapter',
      async chat(_messages, opts) {
        signalSeen = opts.abortSignal;
        await new Promise(() => {});
      },
    };

    const started = Date.now();
    const res = await generateReport({ room: makeRoom(), adapter, timeoutMs: 20 });

    expect(Date.now() - started).toBeLessThan(500);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/报告生成超时 20ms/);
    expect(signalSeen?.aborted).toBe(true);
  });

  it('报告调用 adapter 时跳过 resilience 并禁用 MCP', async () => {
    let seenOpts = null;
    const adapter = {
      id: 'opts-adapter',
      async chat(_messages, opts) {
        seenOpts = opts;
        return {
          reply: '# 报告\n\n' + '有效内容。'.repeat(100),
          tokensIn: 1,
          tokensOut: 2,
        };
      },
    };

    const res = await generateReport({ room: makeRoom(), adapter, timeoutMs: 1000 });

    expect(res.ok).toBe(true);
    expect(seenOpts.skipResilience).toBe(true);
    expect(seenOpts.disableMcp).toBe(true);
  });
});
