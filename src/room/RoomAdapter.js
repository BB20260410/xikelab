// RoomAdapter — 聊天室成员抽象基类
// 子类实现 _doChat(messages, opts)；外部调 chat() 自动套 CircuitBreaker + Bulkhead + RateLimiter
// messages: [{ role:'system'|'user'|'assistant', content, speaker? }]
// 注意：每个 adapter 自己负责把 messages 数组拍平成各自 CLI/API 能吃的格式
//
// v0.56 Sprint 15：chat() 是个壳，调用 _doChat 时套 3 个 resilience pattern

import { breakers } from '../safety/CircuitBreaker.js';
import { bulkheads } from '../safety/Bulkhead.js';
import { rateLimiters } from '../safety/RateLimiter.js';
import { budgetPolicyStore } from '../budget/BudgetPolicyStore.js';

export class RoomAdapter {
  constructor({ id, displayName, model, timeout = 180000 } = {}) {
    this.id = id;                   // 'claude' | 'codex' | 'minimax' | 'ollama'
    this.displayName = displayName; // '🟣 Claude' / '🟢 GPT' / '🟡 MiniMax' / '🔵 Ollama'
    this.model = model;
    this.timeout = timeout;
  }

  get providerName() { return this.id; }

  /**
   * 公开入口：套 CircuitBreaker（快速失败）+ Bulkhead（并发限制）+ RateLimiter（限速）
   * 子类不要 override 这个；override _doChat
   * v0.56：opts.skipResilience = true 时跳过（report 等内部任务可用）
   */
  async chat(messages, opts = {}) {
    if (!opts.skipBudget) {
      budgetPolicyStore.preflight({
        adapterId: this.id,
        projectId: opts.budgetContext?.projectId || opts.cwd || null,
        roomId: opts.budgetContext?.roomId || null,
        sessionId: opts.budgetContext?.sessionId || null,
        taskId: opts.budgetContext?.taskId || null,
        estimateTokens: this._countTokens(messages),
        estimateCalls: 1,
      });
    }
    if (opts.skipResilience) return this._doChat(messages, opts);
    const breaker = breakers.get(this.id);
    const bulkhead = bulkheads.get(this.id);
    const rl = rateLimiters.get(this.id);

    // 1) CircuitBreaker pre-check（OPEN 时直接抛）
    breaker.beforeCall();
    // 2) RateLimiter 排队等 token
    try { await rl.acquire(30_000); }
    catch (e) { breaker.onFailure(e); throw e; }
    // 3) Bulkhead 占并发槽
    let release;
    try { release = await bulkhead.acquire(); }
    catch (e) { breaker.onFailure(e); throw e; }

    try {
      const result = await this._doChat(messages, opts);
      breaker.onSuccess();
      return result;
    } catch (e) {
      // 2026-05：用户/协调器主动 abort 不算 adapter 失败——
      //   否则 debate 整轮被 Gemini 配额拖挂时，连带把 claude/codex 的"被中断"也计入
      //   断路器 failure，几轮后 5 次累计 → claude/codex 整体 OPEN 30s，用户看不懂
      const aborted = opts.abortSignal?.aborted
        || e?.name === 'AbortError'
        || /被中断|aborted|cancelled|canceled/i.test(e?.message || '');
      if (!aborted) breaker.onFailure(e);
      throw e;
    } finally {
      try { release(); } catch {}
    }
  }

  /** 子类实现这个；不要 override chat() */
  async _doChat(messages, _opts = {}) {
    throw new Error('RoomAdapter._doChat() must be implemented by subclass');
  }

  /** 拍平 messages 成单 prompt 字符串（spawn CLI 用） */
  flattenMessages(messages) {
    return messages.map(m => {
      const speaker = m.speaker || (m.role === 'user' ? '👤 用户' : m.role === 'system' ? '⚙️ 系统' : '🤖 ' + (m.role || 'assistant'));
      return `${speaker}:\n${m.content}`;
    }).join('\n\n---\n\n');
  }

  // ─── v0.9.x B-002：8 adapter 共用方法（学自 W3 LibreChat BaseClient）─────

  /** 估算单条 messages 数组的 token 数（粗算，中英分开）
   * 学自 W3 historyTrimmer.estimateTokens */
  _countTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    let total = 0;
    for (const m of messages) {
      const text = String(m?.content || '');
      const cjk = (text.match(/[一-鿿぀-ゟ゠-ヿ]/g) || []).length;
      const nonCjk = text.length - cjk;
      total += cjk + Math.ceil(nonCjk / 4);
    }
    return total;
  }

  /** 从 messages 末尾反向裁剪到 maxTokens 内（保留 system + 最新 user）
   * 学自 W3 LibreChat getMessagesWithinTokenLimit */
  _truncateMessages(messages, maxTokens = 100000) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    // 永远保留 system
    const systems = messages.filter(m => m.role === 'system');
    const others = messages.filter(m => m.role !== 'system');
    const systemTokens = this._countTokens(systems);
    let budget = maxTokens - systemTokens - 4096;  // 留 4K 给响应
    if (budget <= 0) return systems;
    const kept = [];
    for (let i = others.length - 1; i >= 0; i--) {
      const t = this._countTokens([others[i]]);
      if (budget - t <= 0) break;
      kept.unshift(others[i]);
      budget -= t;
    }
    return [...systems, ...kept];
  }

  /** 把 stream chunk 累积成完整 reply（用于 SSE / spawn streaming 收尾）
   * 子类 _doChat 内部可调用 */
  _accumulateStream(chunks) {
    if (!Array.isArray(chunks)) return String(chunks || '');
    return chunks.map(c => typeof c === 'string' ? c : (c?.text || c?.content || '')).join('');
  }

  /** 用户消息加文件附件上下文（学自 W3 LibreChat buildFileContext）
   * panel 当前主要是 topic 内嵌 [附件:xxx]，此方法是 future-ready */
  _buildFileContext(message, attachments = []) {
    if (!attachments.length) return message;
    const ctx = attachments.map(a =>
      `\n\n--- 📎 ${a.name || 'file'}${a.size ? ` (${(a.size / 1024).toFixed(1)}KB)` : ''} ---\n${a.content || ''}\n--- /附件 ---`
    ).join('');
    if (typeof message === 'string') return message + ctx;
    if (message?.content) return { ...message, content: message.content + ctx };
    return message;
  }
}
