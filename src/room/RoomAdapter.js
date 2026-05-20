// RoomAdapter — 聊天室成员抽象基类
// 子类实现 _doChat(messages, opts)；外部调 chat() 自动套 CircuitBreaker + Bulkhead + RateLimiter
// messages: [{ role:'system'|'user'|'assistant', content, speaker? }]
// 注意：每个 adapter 自己负责把 messages 数组拍平成各自 CLI/API 能吃的格式
//
// v0.56 Sprint 15：chat() 是个壳，调用 _doChat 时套 3 个 resilience pattern

import { breakers } from '../safety/CircuitBreaker.js';
import { bulkheads } from '../safety/Bulkhead.js';
import { rateLimiters } from '../safety/RateLimiter.js';

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
      breaker.onFailure(e);
      throw e;
    } finally {
      try { release(); } catch {}
    }
  }

  /** 子类实现这个；不要 override chat() */
  async _doChat(messages, opts = {}) {
    throw new Error('RoomAdapter._doChat() must be implemented by subclass');
  }

  /** 拍平 messages 成单 prompt 字符串（spawn CLI 用） */
  flattenMessages(messages) {
    return messages.map(m => {
      const speaker = m.speaker || (m.role === 'user' ? '👤 用户' : m.role === 'system' ? '⚙️ 系统' : '🤖 ' + (m.role || 'assistant'));
      return `${speaker}:\n${m.content}`;
    }).join('\n\n---\n\n');
  }
}
