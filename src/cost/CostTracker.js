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

function findPricingKey(model) {
  if (!model || typeof model !== 'string') return 'default';
  // 1) 精确命中
  if (PRICING_PER_M_TOKENS[model]) return model;
  // 2) 前缀匹配（"claude-opus-4-7-20251225" → "claude-opus-4-7"）
  const keys = Object.keys(PRICING_PER_M_TOKENS).filter(k => k !== 'default');
  const prefix = keys.find(k => model.startsWith(k));
  if (prefix) return prefix;
  // 3) 关键词回退（含 "opus"/"sonnet"/"haiku" 任一）
  const m = model.toLowerCase();
  if (m.includes('opus'))   return 'claude-opus-4-7';
  if (m.includes('sonnet')) return 'claude-sonnet-4-6';
  if (m.includes('haiku'))  return 'claude-haiku-4-5';
  return 'default';
}

// v0.51 Y-07 fix: 数值安全（拒 NaN / Infinity / 负数 / 异常大数，防 totalUSD 变 Infinity）
function safeTokenCount(v) {
  return Number.isFinite(v) && v >= 0 && v < 1e12 ? v : 0;
}
export function estimateUsdFromUsage(usage, model) {
  if (!usage) return 0;
  const key = findPricingKey(model);
  const p = PRICING_PER_M_TOKENS[key] || PRICING_PER_M_TOKENS.default;
  const inputTok = safeTokenCount(usage.input_tokens);
  const cacheRead = safeTokenCount(usage.cache_read_input_tokens);
  const cacheWrite = safeTokenCount(usage.cache_creation_input_tokens);
  const outputTok = safeTokenCount(usage.output_tokens);
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
    // v0.51 Y-08 fix: 拒 NaN / Infinity / 负数（防 totalUsdCached 变 Infinity）
    if (!Number.isFinite(usd) || usd <= 0) return;
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
