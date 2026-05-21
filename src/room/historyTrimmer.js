// historyTrimmer — 把对话历史按 token 上限裁剪（保留最新 N 条 + 反向 pop 算法）
// W3 学自 LibreChat BaseClient.getMessagesWithinTokenLimit (api/app/clients/BaseClient.js:365)
//
// 设计思路：
//   1. 从最新消息开始反向 pop（最新最优先保留）
//   2. 每个 message 自带 tokenCount（如无则按字符/4 粗估）
//   3. instructions（system prompt）单独计算，永远保留
//   4. 返回的 context 已 reverse 回正序（旧→新）
//
// 这是一个**独立 helper**，目前不被调用——等 sprint 级独立设计后再接入
//   - DebateDispatcher / SoloChatDispatcher 等可在调用 adapter 前 trim
//   - 或在 forward endpoint 加 token-based trim 替代当前字符 cap
//
// 用法示例：
//   const { context, droppedCount, totalTokens } = trimHistoryByTokens({
//     messages: [{ role: 'user', content: '...', tokenCount: 12 }, ...],
//     maxContextTokens: 100_000,
//     systemPrompt: 'You are...',
//     reserveForResponse: 4096,
//   });

const RESERVED_RESPONSE_TOKENS = 4096;   // 给响应预留 token 数
const REPLY_PRIMER_TOKENS = 3;           // <|start|>assistant<|message|> 等 primer

/**
 * 估算文本 token 数（粗算：中文 1 char ≈ 1 token，英文 4 char ≈ 1 token）
 * 真正接入时建议用 tiktoken / @anthropic-ai/tokenizer 精确计算
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  // 中文字符（CJK Unified Ideographs）按 1:1 算
  const cjkCount = (text.match(/[一-鿿぀-ゟ゠-ヿ]/g) || []).length;
  const nonCjk = text.length - cjkCount;
  return cjkCount + Math.ceil(nonCjk / 4);
}

/**
 * 反向 pop 算法（学自 LibreChat）：从最新消息开始往老消息倒数，
 * 直到 token 上限。最旧的会被 drop。systemPrompt 永远保留。
 *
 * @param {object} opts
 * @param {Array<{role, content, tokenCount?}>} opts.messages   完整历史（旧→新）
 * @param {number} opts.maxContextTokens                        模型 context window 总 token
 * @param {string} [opts.systemPrompt]                          system prompt 文本
 * @param {number} [opts.reserveForResponse=4096]               预留给响应的 token
 * @returns {{ context, droppedCount, totalTokens, systemPromptTokens }}
 */
export function trimHistoryByTokens({
  messages = [],
  maxContextTokens,
  systemPrompt = '',
  reserveForResponse = RESERVED_RESPONSE_TOKENS,
}) {
  if (!maxContextTokens || maxContextTokens <= 0) {
    throw new Error('trimHistoryByTokens: maxContextTokens required (>0)');
  }
  if (!Array.isArray(messages)) {
    throw new Error('trimHistoryByTokens: messages must be array');
  }

  const systemPromptTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;
  const budget = maxContextTokens - systemPromptTokens - reserveForResponse - REPLY_PRIMER_TOKENS;
  if (budget <= 0) {
    // system prompt 已经撑爆 → 只保留 system，丢全部历史
    return { context: [], droppedCount: messages.length, totalTokens: systemPromptTokens, systemPromptTokens };
  }

  // 反向 pop（最新先入，最旧后入直到爆）
  const reversed = [...messages].reverse();
  const kept = [];
  let used = 0;
  let dropped = 0;
  for (const msg of reversed) {
    const tc = typeof msg.tokenCount === 'number'
      ? msg.tokenCount
      : estimateTokens(msg.content || '');
    if (used + tc <= budget) {
      kept.push({ ...msg, tokenCount: tc });
      used += tc;
    } else {
      dropped++;
    }
  }

  return {
    context: kept.reverse(),           // 回到正序（旧→新）
    droppedCount: dropped,
    totalTokens: systemPromptTokens + used + REPLY_PRIMER_TOKENS,
    systemPromptTokens,
  };
}

/**
 * 各 provider 的 maxContextTokens 默认值（保守估计，可在 RoomAdaptersConfig 覆盖）
 */
export const DEFAULT_MAX_CONTEXT = {
  claude: 200_000,           // Claude 3.5+
  codex: 128_000,            // GPT-5
  gemini: 1_000_000,         // Gemini 3.1 Pro
  'gemini-cli': 1_000_000,
  'gemini-openai': 1_000_000,
  minimax: 200_000,          // MiniMax-M2.7
  ollama: 32_000,            // 本地模型保守值
  ccr: 200_000,              // CCR 路由，按 Claude 估
};
