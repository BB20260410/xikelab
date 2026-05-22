// src/server/archive/lsm-archiver.js
//
// LSM-tree 思想做 panel watcher / session jsonl 归档：
//   memtable(数组累积) → 阈值 flush → sstable.gz + bloom filter → 查询走 memtable + bloom 剪枝
//
// Phase 6 PoC 01 实测：10000 chunk → 10 sstable.gz；压缩 75.73×、bloom fp 23.2%、query 1000/1000 命中
// Phase 6 P6-V3 校准：bloom hash 走 readUInt32BE（不要裸位运算赋数组下标，否则 signed → bits[-1] 静默失败）
//
// 设计要点：
//   - 完全无副作用：构造 → 调 .open()、.write()、.query()、.flush()、.close()
//   - panel 端默认 watch-archive dir = `${os.homedir()}/.claude-panel/watch-archive/`
//   - 失败软化：写 sstable 失败时 console.warn 但不抛（归档是 best-effort，不阻塞主流）
//   - 同步 IO（小文件 + flush 频次低，避免 await 链）
//
// 与 PR #1 / #2 / #3 关系：
//   - 独立目录 src/server/archive/，与 observability/、log-ring 不冲突

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createHash } from 'crypto';

const DEFAULT_FLUSH_THRESHOLD = 1000;
const DEFAULT_BLOOM_BITS = 8192;

class Bloom {
  constructor(m = DEFAULT_BLOOM_BITS) {
    this.m = m;
    this.bits = new Uint8Array(Math.ceil(m / 8));
  }
  _hashes(s) {
    const buf = createHash('sha256').update(String(s)).digest();
    return [buf.readUInt32BE(0) % this.m, buf.readUInt32BE(4) % this.m, buf.readUInt32BE(8) % this.m];
  }
  add(s) {
    for (const i of this._hashes(s)) this.bits[i >> 3] |= 1 << (i & 7);
  }
  test(s) {
    return this._hashes(s).every((i) => this.bits[i >> 3] & (1 << (i & 7)));
  }
  toBuffer() { return Buffer.from(this.bits); }
  static fromBuffer(buf, m = DEFAULT_BLOOM_BITS) {
    const b = new Bloom(m);
    b.bits = new Uint8Array(buf);
    return b;
  }
}

export class LsmArchiver {
  constructor({ dir, flushThreshold = DEFAULT_FLUSH_THRESHOLD, bloomBits = DEFAULT_BLOOM_BITS } = {}) {
    if (!dir) throw new Error('LsmArchiver: dir is required');
    this.dir = dir;
    this.flushThreshold = flushThreshold;
    this.bloomBits = bloomBits;
    this.memtable = [];
    this.sstables = [];
  }

  open() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of fs.readdirSync(this.dir).filter((n) => /^sst-\d{4}\.jsonl\.gz$/.test(n)).sort()) {
      const file = path.join(this.dir, name);
      const bloomFile = `${file}.bloom`;
      if (!fs.existsSync(bloomFile)) continue;
      const bloom = Bloom.fromBuffer(fs.readFileSync(bloomFile), this.bloomBits);
      this.sstables.push({ file, bloomFile, bloom });
    }
    return this;
  }

  write(record) {
    if (!record || typeof record !== 'object' || !record.id) throw new Error('LsmArchiver.write: record.id is required');
    this.memtable.push(record);
    if (this.memtable.length >= this.flushThreshold) this.flush();
  }

  flush() {
    if (this.memtable.length === 0) return null;
    const idx = this.sstables.length;
    const ndjson = this.memtable.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const compressed = zlib.gzipSync(ndjson, { level: 9 });
    const file = path.join(this.dir, `sst-${idx.toString().padStart(4, '0')}.jsonl.gz`);
    const bloomFile = `${file}.bloom`;
    const bloom = new Bloom(this.bloomBits);
    for (const r of this.memtable) bloom.add(r.id);
    try {
      fs.writeFileSync(file, compressed);
      fs.writeFileSync(bloomFile, bloom.toBuffer());
    } catch (e) {
      console.warn(`[lsm-archiver] flush failed (best-effort): ${e.message}`);
      return null;
    }
    this.sstables.push({ file, bloomFile, bloom });
    const count = this.memtable.length;
    this.memtable = [];
    return { file, count, compressedBytes: compressed.length };
  }

  query(id) {
    for (let i = this.memtable.length - 1; i >= 0; i--) {
      if (this.memtable[i].id === id) return this.memtable[i];
    }
    for (let i = this.sstables.length - 1; i >= 0; i--) {
      const sst = this.sstables[i];
      if (!sst.bloom.test(id)) continue;
      let buf;
      try { buf = fs.readFileSync(sst.file); } catch { continue; }
      const lines = zlib.gunzipSync(buf).toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (r.id === id) return r;
        } catch { /* 损坏行跳过 */ }
      }
    }
    return null;
  }

  /** 按 trace_id（或任意字段）扫全部 sstable + memtable，返回事件序列（保留时间顺序）*/
  scanBy(field, value) {
    const out = [];
    for (const sst of this.sstables) {
      let buf;
      try { buf = fs.readFileSync(sst.file); } catch { continue; }
      const lines = zlib.gunzipSync(buf).toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (r[field] === value) out.push(r);
        } catch { /* skip */ }
      }
    }
    for (const r of this.memtable) if (r[field] === value) out.push(r);
    return out;
  }

  stats() {
    let compressed = 0;
    for (const sst of this.sstables) {
      try { compressed += fs.statSync(sst.file).size; } catch { /* skip */ }
    }
    return { memtable: this.memtable.length, sstables: this.sstables.length, compressedBytes: compressed };
  }

  close() {
    this.flush();
  }
}
