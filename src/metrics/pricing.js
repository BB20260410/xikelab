// v0.53 Sprint 3 — adapter/model 估算价表（USD per 1M tokens）
// 数字仅供参考，UI 会标"估算可能 ±20% 偏差"。用户可改这张表。
// 来源：各家 2026 Q1 公开定价（按官网捕获时刻）

// 结构：adapter id → { defaultIn, defaultOut, modelOverrides: { modelId: {in,out} } }
const TABLE = {
  claude: {
    defaultIn: 3.00,    // sonnet 4.6
    defaultOut: 15.00,
    modelOverrides: {
      'claude-opus-4-7': { in: 15.00, out: 75.00 },
      'claude-opus-4-6': { in: 15.00, out: 75.00 },
      'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
      'claude-haiku-4-5': { in: 1.00, out: 5.00 },
    },
  },
  codex: {
    // codex CLI 后端通常是 gpt-5 / gpt-5-mini，按 gpt-5 mid-tier 估
    defaultIn: 5.00,
    defaultOut: 15.00,
    modelOverrides: {
      'gpt-5': { in: 5.00, out: 15.00 },
      'gpt-5-mini': { in: 0.25, out: 2.00 },
      'gpt-5-nano': { in: 0.10, out: 0.40 },
    },
  },
  'gemini-cli': {
    defaultIn: 1.25,     // gemini-3-pro
    defaultOut: 10.00,
    modelOverrides: {
      'gemini-3-pro': { in: 1.25, out: 10.00 },
      'gemini-3-flash': { in: 0.075, out: 0.30 },
    },
  },
  gemini: {  // Google AI Studio 直连
    defaultIn: 1.25,
    defaultOut: 10.00,
    modelOverrides: {
      'gemini-3-pro': { in: 1.25, out: 10.00 },
      'gemini-3-flash': { in: 0.075, out: 0.30 },
    },
  },
  'gemini-openai': {  // OpenAI 兼容（OpenRouter 等）
    defaultIn: 1.25,
    defaultOut: 10.00,
  },
  minimax: {
    defaultIn: 0.20,
    defaultOut: 1.10,
  },
  ollama: {
    defaultIn: 0,    // 本地推理无成本
    defaultOut: 0,
  },
  ccr: {
    defaultIn: 3.00,  // 走 router，按 claude 中位估
    defaultOut: 15.00,
  },
};

// adapter id 形如 "custom:xxx" 时走默认 OpenAI 兼容估算
const CUSTOM_DEFAULT = { in: 2.00, out: 8.00 };

/**
 * 估算成本（USD）
 * @param {string} adapterId
 * @param {string?} model
 * @param {number} tokensIn
 * @param {number} tokensOut
 * @returns {number} 美元（精确到 6 位小数）
 */
export function estimateCost(adapterId, model, tokensIn = 0, tokensOut = 0) {
  if (!tokensIn && !tokensOut) return 0;
  let rate;
  if (adapterId && adapterId.startsWith('custom:')) {
    rate = CUSTOM_DEFAULT;
  } else {
    const entry = TABLE[adapterId];
    if (!entry) return 0;
    if (model && entry.modelOverrides && entry.modelOverrides[model]) {
      rate = entry.modelOverrides[model];
    } else {
      rate = { in: entry.defaultIn, out: entry.defaultOut };
    }
  }
  const cost = (tokensIn * rate.in + tokensOut * rate.out) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;  // 6 位小数
}

export function listPricing() {
  return JSON.parse(JSON.stringify(TABLE));
}
