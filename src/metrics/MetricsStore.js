// v0.53 Sprint 3 — 指标存储层（append-only jsonl，按月切，内存 cache 加速近期查询）
//
// 写入：dispatcher 每完成一个 turn 调一次 record()，参数即 turn 摘要
// 查询：4 类视图
//   - query()       原始流，filter 后回放
//   - aggregate()   按时间桶（hour/day）聚合 token/cost
//   - byAdapter()   按 adapter 聚合 latency/tokens/cost/successRate
//   - overview()    汇总今日 + 全部计数（给总览块 A/B 用）

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, mkdirSync, renameSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { estimateCost } from './pricing.js';

const DIR = join(homedir(), '.claude-panel');
const MAX_BYTES_PER_FILE = 50 * 1024 * 1024;  // 50MB 后滚动
const MEM_CACHE_MAX = 2000;                    // 内存保留最近 2000 条
const QUERY_HARD_LIMIT = 50000;                // 单次查询读盘上限

function monthKey(ts) {
  return ts.slice(0, 7);  // "2026-05"
}

function fileFor(ts) {
  return join(DIR, `metrics-${monthKey(ts)}.jsonl`);
}

export class MetricsStore {
  constructor({ logger = null } = {}) {
    this.logger = logger;
    this.cache = [];     // 最近 N 条（含本月已读入的）
    this.cacheMonth = null;
    this.broadcast = null;  // 由 server 注入：(payload) => void
    this._ensureDir();
    this._warmCache();
  }

  _ensureDir() {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
    // S26 B1：早期版本 appendFileSync 未传 mode 时创建的 metrics-*.jsonl 默认 0o644
    // 启动期一次性 chmod 0o600 强制收敛（含 cost/token/model 财务敏感数据）
    try {
      const files = readdirSync(DIR).filter((f) => /^metrics-\d{4}-\d{2}\.jsonl(\.\d+)?$/.test(f));
      for (const f of files) {
        try { chmodSync(join(DIR, f), 0o600); } catch {}
      }
    } catch {}
  }

  _warmCache() {
    const month = monthKey(new Date().toISOString());
    const file = join(DIR, `metrics-${month}.jsonl`);
    if (!existsSync(file)) return;
    try {
      const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      const tail = lines.slice(-MEM_CACHE_MAX);
      this.cache = tail.map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      this.cacheMonth = month;
    } catch (e) {
      this.logger?.warn?.('[metrics] warm cache failed:', e.message);
    }
  }

  attachBroadcast(fn) {
    this.broadcast = typeof fn === 'function' ? fn : null;
  }

  /** dispatcher 调用入口 */
  record(turnSummary) {
    if (!turnSummary || typeof turnSummary !== 'object') return null;
    const ts = new Date().toISOString();
    const enriched = {
      ts,
      roomId: turnSummary.roomId || '',
      roomMode: turnSummary.roomMode || 'unknown',
      roomName: turnSummary.roomName || '',
      turn: turnSummary.turn || '',
      adapter: turnSummary.adapter || 'unknown',
      model: turnSummary.model || '',
      latencyMs: Math.max(0, Number(turnSummary.latencyMs) || 0),
      tokensIn: Math.max(0, Number(turnSummary.tokensIn) || 0),
      tokensOut: Math.max(0, Number(turnSummary.tokensOut) || 0),
      success: turnSummary.success !== false,
      errorKind: turnSummary.errorKind || null,
    };
    enriched.estCostUSD = estimateCost(enriched.adapter, enriched.model, enriched.tokensIn, enriched.tokensOut);

    // 落盘（同步 append，jsonl）
    try {
      const file = fileFor(ts);
      // 滚动：超过 50MB 改名为 .1，避免单文件无限增长
      if (existsSync(file) && statSync(file).size > MAX_BYTES_PER_FILE) {
        try { renameSync(file, file + '.' + Date.now()); } catch {}
      }
      appendFileSync(file, JSON.stringify(enriched) + '\n', { mode: 0o600 });
    } catch (e) {
      this.logger?.warn?.('[metrics] append failed:', e.message);
    }

    // 内存 cache（跨月时重置 cacheMonth）
    const month = monthKey(ts);
    if (this.cacheMonth && this.cacheMonth !== month) {
      this.cache = [];
      this.cacheMonth = month;
    } else if (!this.cacheMonth) {
      this.cacheMonth = month;
    }
    this.cache.push(enriched);
    if (this.cache.length > MEM_CACHE_MAX) this.cache.shift();

    // WS 推送一条增量
    if (this.broadcast) {
      try { this.broadcast({ type: 'metrics_update', delta: enriched }); } catch {}
    }
    return enriched;
  }

  /**
   * 读取窗口内所有 turn。
   * 注意：只读"现在 - 90 天"之内的数据，更老的归档不读（避免 cold path 拖慢）
   */
  query({ from, to, roomId, adapter } = {}) {
    const toTs = to ? new Date(to).toISOString() : new Date().toISOString();
    const fromTs = from ? new Date(from).toISOString() : new Date(Date.now() - 30 * 86400_000).toISOString();
    // 1) 全部命中内存 cache 时直接 filter
    const cacheCovers = this.cache.length > 0 && this.cache[0].ts <= fromTs;
    let rows = [];
    if (cacheCovers) {
      rows = this.cache;
    } else {
      // 2) 读对应月份文件
      rows = this._readRange(fromTs, toTs);
    }
    let result = rows.filter((r) => r.ts >= fromTs && r.ts <= toTs);
    if (roomId) result = result.filter((r) => r.roomId === roomId);
    if (adapter) result = result.filter((r) => r.adapter === adapter);
    if (result.length > QUERY_HARD_LIMIT) result = result.slice(-QUERY_HARD_LIMIT);
    return result;
  }

  _readRange(fromTs, toTs) {
    const fromMonth = monthKey(fromTs);
    const toMonth = monthKey(toTs);
    const all = [];
    let files;
    try {
      files = readdirSync(DIR).filter((f) => /^metrics-\d{4}-\d{2}\.jsonl$/.test(f));
    } catch {
      return [];
    }
    files.sort();
    for (const f of files) {
      const m = f.match(/^metrics-(\d{4}-\d{2})\.jsonl$/);
      if (!m) continue;
      const month = m[1];
      if (month < fromMonth || month > toMonth) continue;
      try {
        const lines = readFileSync(join(DIR, f), 'utf-8').split('\n').filter(Boolean);
        for (const l of lines) {
          try {
            const r = JSON.parse(l);
            if (r.ts >= fromTs && r.ts <= toTs) all.push(r);
          } catch {}
        }
      } catch {}
      if (all.length > QUERY_HARD_LIMIT * 2) break;  // 兜底
    }
    return all;
  }

  /** 按时间桶聚合 token / cost */
  aggregate({ from, to, bucket = 'hour' } = {}) {
    const rows = this.query({ from, to });
    const buckets = new Map();
    const bucketKey = (ts) => bucket === 'day' ? ts.slice(0, 10) : ts.slice(0, 13);
    for (const r of rows) {
      const k = bucketKey(r.ts);
      let b = buckets.get(k);
      if (!b) {
        b = { ts: k, tokensIn: 0, tokensOut: 0, costUSD: 0, turns: 0 };
        buckets.set(k, b);
      }
      b.tokensIn += r.tokensIn;
      b.tokensOut += r.tokensOut;
      b.costUSD += r.estCostUSD;
      b.turns += 1;
    }
    const series = Array.from(buckets.values()).sort((a, b) => a.ts.localeCompare(b.ts));
    // 成本 6 位小数防 floating 误差
    for (const b of series) b.costUSD = Math.round(b.costUSD * 1_000_000) / 1_000_000;
    return { bucket, from: from || null, to: to || null, series };
  }

  /** v0.55 Sprint 13-D：按 roomId 拿全部 turn（给 trace 时间线视图用） */
  byRoom({ roomId, from, to, limit = 500 } = {}) {
    if (!roomId) return { roomId: null, turns: [] };
    const rows = this.query({ from, to, roomId, limit }).slice(0, limit);
    return {
      roomId,
      turns: rows.map((r) => ({
        ts: r.ts,
        turn: r.turn,
        adapter: r.adapter,
        model: r.model,
        latencyMs: r.latencyMs,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        estCostUSD: r.estCostUSD,
        success: r.success,
        errorKind: r.errorKind,
      })),
    };
  }

  /** 按 adapter 横向对比 */
  byAdapter({ from, to } = {}) {
    const rows = this.query({ from, to });
    const map = new Map();
    for (const r of rows) {
      let a = map.get(r.adapter);
      if (!a) {
        a = { id: r.adapter, count: 0, success: 0, totalLatencyMs: 0, totalTokensIn: 0, totalTokensOut: 0, totalCostUSD: 0 };
        map.set(r.adapter, a);
      }
      a.count += 1;
      if (r.success) a.success += 1;
      a.totalLatencyMs += r.latencyMs;
      a.totalTokensIn += r.tokensIn;
      a.totalTokensOut += r.tokensOut;
      a.totalCostUSD += r.estCostUSD;
    }
    const adapters = Array.from(map.values()).map((a) => ({
      id: a.id,
      count: a.count,
      successRate: a.count ? Math.round((a.success / a.count) * 1000) / 1000 : 0,
      avgLatencyMs: a.count ? Math.round(a.totalLatencyMs / a.count) : 0,
      totalTokens: a.totalTokensIn + a.totalTokensOut,
      totalTokensIn: a.totalTokensIn,
      totalTokensOut: a.totalTokensOut,
      totalCostUSD: Math.round(a.totalCostUSD * 1_000_000) / 1_000_000,
    }));
    adapters.sort((a, b) => b.totalTokens - a.totalTokens);
    return { from: from || null, to: to || null, adapters };
  }

  /** 总览：今日数字 + 各房状态计数（房状态由调用方传入 roomStore） */
  overview({ roomStore } = {}) {
    const todayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString();
    const today = this.query({ from: todayStart });
    let tokensIn = 0, tokensOut = 0, costUSD = 0;
    const adapterSet = new Set();
    for (const r of today) {
      tokensIn += r.tokensIn;
      tokensOut += r.tokensOut;
      costUSD += r.estCostUSD;
      adapterSet.add(r.adapter);
    }
    const status = { running: 0, paused: 0, idle: 0, error: 0, done: 0, auto_paused: 0, other: 0 };
    const recent = [];
    if (roomStore && typeof roomStore.list === 'function') {
      const rooms = roomStore.list();   // list() 已默认过滤 archived
      for (const r of rooms) {
        const st = r.status || 'idle';
        if (status[st] !== undefined) status[st] += 1;
        else status.other += 1;
        if (st === 'running' || st === 'paused' || st === 'auto_paused') {
          recent.push({
            id: r.id, name: r.name, mode: r.mode, status: st,
            updatedAt: r.updatedAt || r.createdAt,
          });
        }
      }
      recent.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }
    return {
      today: {
        tokensIn, tokensOut,
        costUSD: Math.round(costUSD * 1_000_000) / 1_000_000,
        turns: today.length,
        activeAdapters: Array.from(adapterSet),
      },
      rooms: status,
      activeRooms: recent.slice(0, 8),
    };
  }

  /** 测试 / 维护用：清空内存缓存（不删盘） */
  clearCache() {
    this.cache = [];
    this.cacheMonth = null;
  }
}

export const metricsStore = new MetricsStore({ logger: console });
