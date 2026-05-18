// CostTracker — 每个 session 持有一个，记录每个 turn 的成本 + 提供累计/速率查询
// 用法：record(usd, tokens) 在 stream-json result 拿到 usage 时调

// 粗略定价（USD per 1M tokens）—— 仅作展示估算，准确数据见 [禁假数据] memory
const PRICING_PER_M_TOKENS = {
  'claude-opus-4-7':    { input: 15.0,  cache_read: 1.50, cache_write: 18.75, output: 75.0 },
  'claude-sonnet-4-6':  { input: 3.0,   cache_read: 0.30, cache_write: 3.75,  output: 15.0 },
  'claude-sonnet-4-5':  { input: 3.0,   cache_read: 0.30, cache_write: 3.75,  output: 15.0 },
  'claude-haiku-4-5':   { input: 1.0,   cache_read: 0.10, cache_write: 1.25,  output: 5.0 },
  'default':            { input: 3.0,   cache_read: 0.30, cache_write: 3.75,  output: 15.0 },
};

export function estimateUsdFromUsage(usage, model) {
  if (!usage) return 0;
  const key = Object.keys(PRICING_PER_M_TOKENS).find(k => model && model.includes(k.replace('claude-', '').replace('-', ''))) ||
              (model && PRICING_PER_M_TOKENS[model]) ? model : 'default';
  const p = PRICING_PER_M_TOKENS[key] || PRICING_PER_M_TOKENS.default;
  const inputTok = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const outputTok = usage.output_tokens || 0;
  return (
    (inputTok * p.input + cacheRead * p.cache_read + cacheWrite * p.cache_write + outputTok * p.output) / 1_000_000
  );
}

export class CostTracker {
  constructor() {
    this.samples = [];  // { at, usd, tokens, model }
    this.totalUsdCached = 0;
  }

  record(usd, tokens = 0, model = null) {
    if (!usd || usd <= 0) return;
    const at = Date.now();
    this.samples.push({ at, usd, tokens, model });
    this.totalUsdCached += usd;
    // 限制内存：超过 1000 条丢前面
    if (this.samples.length > 1000) {
      const dropped = this.samples.splice(0, this.samples.length - 1000);
      // 不重新算 totalUsdCached（已经累计完成，丢弃 sample 只影响窗口查询）
    }
  }

  totalUSD() {
    return this.totalUsdCached;
  }

  // 最近 N 毫秒窗口 USD 总和
  windowUSD(ms) {
    const cutoff = Date.now() - ms;
    return this.samples.filter(s => s.at >= cutoff).reduce((s, x) => s + x.usd, 0);
  }

  // USD/min 速率（基于最近 5min）
  ratePerMinute() {
    const win5 = this.windowUSD(5 * 60 * 1000);
    return win5 / 5;
  }

  snapshot() {
    return {
      totalUSD: this.totalUsdCached,
      sampleCount: this.samples.length,
      last5MinUSD: this.windowUSD(5 * 60 * 1000),
      ratePerMinute: this.ratePerMinute(),
    };
  }

  // v0.28 按分钟桶聚合：返回最近 windowMin 分钟的 USD 时序（含空桶填 0）
  seriesByMinute(windowMin = 30) {
    const win = Math.max(5, Math.min(180, windowMin));
    const now = Date.now();
    const cutoff = now - win * 60 * 1000;
    const buckets = new Map();
    for (const s of this.samples) {
      if (s.at < cutoff) continue;
      const bucket = Math.floor(s.at / 60000);
      buckets.set(bucket, (buckets.get(bucket) || 0) + s.usd);
    }
    const startMin = Math.floor(cutoff / 60000);
    const endMin = Math.floor(now / 60000);
    const series = [];
    for (let m = startMin; m <= endMin; m++) {
      series.push({ minute: m, ts: m * 60 * 1000, usd: Math.round((buckets.get(m) || 0) * 10000) / 10000 });
    }
    return series;
  }
}
