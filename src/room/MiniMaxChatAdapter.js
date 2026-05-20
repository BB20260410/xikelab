// MiniMaxChatAdapter — MiniMax chat completion API 实现（聊天室成员版）
// 跟 src/watcher/MiniMaxAdapter.js 区分：那个只实现 judge() 给 watcher 用；
// 这个实现 chat() 给 Room dispatcher 用。

import { RoomAdapter } from './RoomAdapter.js';

const DEFAULT_BASE_URL = 'https://api.minimax.chat/v1';
const DEFAULT_MODEL = 'MiniMax-M2.7';   // v0.52 升到 2026 最新（原 M2）

export class MiniMaxChatAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: 'minimax',
      displayName: opts.displayName || '🟡 MiniMax',
      model: opts.model || DEFAULT_MODEL,
      timeout: opts.timeout || 1200000,  // v0.52 默认 20 分钟
    });
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    // v0.52 max_tokens：0 = 不传让服务端决定；正数 = 显式 cap。默认 32768 满足长 reply 需求
    this.maxTokens = typeof opts.maxTokens === 'number' ? opts.maxTokens : 32768;
  }

  async _doChat(messages, opts = {}) {
    if (!this.apiKey) throw new Error('MiniMax 缺少 apiKey');
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const oaiMessages = messages.map(m => ({
      role: m.role === 'system' ? 'system' : (m.role === 'user' ? 'user' : 'assistant'),
      content: m.speaker ? `[${m.speaker}] ${m.content}` : m.content,
    }));
    const body = {
      model: opts.model || this.model,
      messages: oaiMessages,
      temperature: 0.4,
    };
    if (this.maxTokens > 0) body.max_tokens = this.maxTokens;   // v0.52 0=不传，让服务端决定

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let externalAbortHandler = null;
    if (opts.abortSignal) {
      externalAbortHandler = () => controller.abort();
      opts.abortSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`MiniMax ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      const reply = data?.choices?.[0]?.message?.content?.trim() || '';
      const usage = data?.usage || {};
      if (!reply) throw new Error('MiniMax 响应空 reply（可能 plan 无 chat completion 权限）');
      return {
        reply,
        tokensIn: usage.prompt_tokens || 0,
        tokensOut: usage.completion_tokens || 0,
        raw: data,
      };
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`MiniMax 超时 ${this.timeout}ms`);
      throw e;
    } finally {
      if (externalAbortHandler && opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }
}
