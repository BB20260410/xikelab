// PR #17 回归：RoomReporter writeFile 防 EISDIR
// 2026-05-23 事故：UI 填 outputPath="/Users/hxx/Desktop"（目录）→
//   writeFileSync(abs) 把目录当文件 open → throw EISDIR → 报告生成失败。
// 修复：写盘前 statSync.isDirectory()，是目录就用 defaultReportPath 拼成 <abs>/<roomName>-report-<ts>.md。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateReport, defaultReportPath } from '../../src/report/RoomReporter.js';

// stub adapter，返回固定 reply 够通过 min_length=200 断言
function makeAdapter() {
  return {
    id: 'stub',
    async chat() {
      return {
        reply: '# 测试报告\n\n' + '这是一段够长的测试内容，用于通过 assertion min_length=200 限制。\n'.repeat(10),
        tokensIn: 1,
        tokensOut: 1,
      };
    },
  };
}

function makeRoom(name = '测试房', mode = 'chat') {
  return {
    id: 'r-eisdir-test',
    name,
    mode,
    createdAt: new Date().toISOString(),
    members: [],
    conversation: [
      { from: 'user', content: '你好', at: new Date().toISOString() },
      { from: 'claude', displayName: 'Claude', content: '在的', at: new Date().toISOString() },
    ],
  };
}

describe('RoomReporter EISDIR 防御', () => {
  // 用户 homedir 下临时目录，避开 isPathSafe 的 /tmp 已经允许、但 mac /tmp -> /private/tmp 解析后超出白名单的细节
  let baseDir;
  beforeEach(() => {
    baseDir = mkdtempSync(join(homedir(), '.panel-reporter-test-'));
  });
  afterEach(() => {
    try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
  });

  it('outputPath 为目录时，应自动拼上 <roomName>-report-<ts>.md 而不是 EISDIR', async () => {
    const room = makeRoom('我的辩论');
    const res = await generateReport({
      room,
      adapter: makeAdapter(),
      outputPath: baseDir,    // 故意传目录路径，复现 EISDIR 场景
    });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.path).toBeTruthy();
    expect(res.path.startsWith(baseDir + '/')).toBe(true);
    expect(res.path).toMatch(/我的辩论-report-\d{4}-\d{2}-\d{2}-\d{6}\.md$/);
    expect(existsSync(res.path)).toBe(true);
    const written = readFileSync(res.path, 'utf-8');
    expect(written).toContain('测试报告');
  });

  it('outputPath 为不存在的文件路径时，递归建父目录后写文件', async () => {
    const room = makeRoom('测试');
    const target = join(baseDir, 'sub', 'deep', 'my-report.md');
    const res = await generateReport({
      room,
      adapter: makeAdapter(),
      outputPath: target,
    });
    expect(res.ok).toBe(true);
    expect(res.path).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it('outputPath 越权时返回错误而非写盘', async () => {
    const room = makeRoom('测试');
    const res = await generateReport({
      room,
      adapter: makeAdapter(),
      outputPath: '/etc/passwd',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/越权|敏感/);
    expect(res.content).toBeTruthy();  // 仍然返回报告内容，只是没落盘
  });

  it('outputPath 未提供时只返回 content，不写盘（path 为 null）', async () => {
    const room = makeRoom('测试');
    const res = await generateReport({ room, adapter: makeAdapter() });
    expect(res.ok).toBe(true);
    expect(res.path).toBeNull();
    expect(res.content).toContain('测试报告');
  });

  it('defaultReportPath(room, rootDir) 拼出来的文件名与房名一致 + 含时间戳', () => {
    const p = defaultReportPath({ name: 'Hello World' }, baseDir);
    expect(p.startsWith(baseDir + '/')).toBe(true);
    expect(p).toMatch(/Hello World-report-\d{4}-\d{2}-\d{2}-\d{6}\.md$/);
  });
});
