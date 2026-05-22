// vitest: lsm-archiver 单测
//   - 基础 write → flush → query 命中
//   - bloom miss 直接剪枝（不解压不存在的 sstable）
//   - 持久化：open() 后能恢复旧 sstable
//   - scanBy 按 trace_id 抽取事件序列
//   - 损坏行（坏 JSON）查询不抛

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { LsmArchiver } from '../../src/server/archive/lsm-archiver.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('LsmArchiver', () => {
  it('write 不到阈值不 flush，query 走 memtable', () => {
    const arc = new LsmArchiver({ dir, flushThreshold: 10 }).open();
    for (let i = 0; i < 5; i++) arc.write({ id: `evt-${i}`, text: `t${i}` });
    expect(arc.stats().sstables).toBe(0);
    expect(arc.stats().memtable).toBe(5);
    expect(arc.query('evt-3')).toEqual({ id: 'evt-3', text: 't3' });
    expect(arc.query('not-exist')).toBeNull();
  });

  it('达阈值自动 flush，query 走 bloom + sstable', () => {
    const arc = new LsmArchiver({ dir, flushThreshold: 100 }).open();
    for (let i = 0; i < 250; i++) arc.write({ id: `evt-${i}`, text: 'lorem '.repeat(20) });
    expect(arc.stats().sstables).toBeGreaterThanOrEqual(2);
    expect(arc.query('evt-50')?.id).toBe('evt-50');
    expect(arc.query('evt-200')?.id).toBe('evt-200');
    expect(arc.query('not-exist')).toBeNull();
  });

  it('open() 后能恢复旧 sstable，跨进程查询命中', () => {
    const arc1 = new LsmArchiver({ dir, flushThreshold: 50 }).open();
    for (let i = 0; i < 120; i++) arc1.write({ id: `k-${i}`, text: `v${i}` });
    arc1.close();

    const arc2 = new LsmArchiver({ dir, flushThreshold: 50 }).open();
    expect(arc2.stats().sstables).toBeGreaterThan(0);
    expect(arc2.query('k-10')?.text).toBe('v10');
    expect(arc2.query('k-100')?.text).toBe('v100');
  });

  it('scanBy 按 trace_id 抽事件序列（跨 memtable + sstable）', () => {
    const arc = new LsmArchiver({ dir, flushThreshold: 50 }).open();
    for (let i = 0; i < 60; i++) arc.write({ id: `e-${i}`, trace_id: i < 30 ? 'tr-A' : 'tr-B', text: `m${i}` });
    expect(arc.stats().sstables).toBe(1);
    const a = arc.scanBy('trace_id', 'tr-A');
    const b = arc.scanBy('trace_id', 'tr-B');
    expect(a.length).toBe(30);
    expect(b.length).toBe(30);
    expect(a[0].text).toBe('m0');
    expect(b[b.length - 1].text).toBe('m59');
  });

  it('write 缺 id 抛错（fail-fast）', () => {
    const arc = new LsmArchiver({ dir }).open();
    expect(() => arc.write({ text: 'no-id' })).toThrow(/id is required/);
  });

  it('损坏 jsonl 行不让 query 崩', () => {
    const arc = new LsmArchiver({ dir, flushThreshold: 2 }).open();
    arc.write({ id: 'good-1', text: 'ok' });
    arc.write({ id: 'good-2', text: 'ok2' });
    // 上面 2 条 ≥ 阈值 2，已 flush
    expect(arc.stats().sstables).toBe(1);
    const sstFile = arc.sstables[0].file;
    const raw = zlib.gunzipSync(fs.readFileSync(sstFile)).toString('utf8');
    fs.writeFileSync(sstFile, zlib.gzipSync(raw + '{not json\n'));
    expect(() => arc.query('good-1')).not.toThrow();
    expect(arc.query('good-1')?.text).toBe('ok');
  });
});
