// OpenAICompatChatAdapter — 通用 OpenAI Chat Completions 协议
// 用于：
//   - gemini-openai（Gemini 的 OpenAI 兼容端点 / 第三方代理）
//   - custom:<id>（用户自填 OpenRouter / Groq / DeepSeek / 本地 vLLM 等）

import { RoomAdapter } from './RoomAdapter.js';

export class OpenAICompatChatAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: opts.id || 'openai-compat',
      displayName: opts.displayName || '🟦 OpenAI 兼容',
      model: opts.model || '',
      timeout: opts.timeout || 1200000,  // v0.52 默认 20 分钟
    });
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    // 部分代理需要不同 path（默认 /chat/completions），保留扩展位
    this.chatPath = opts.chatPath || '/chat/completions';
    // 部分服务（如 Groq）支持但 max_tokens 字段名不同——这里走标准 OpenAI 字段
    this.temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.4;
    // v0.52 0=不传让服务端决定；正数=cap。默认 16384（覆盖多数 OpenAI 兼容服务上限）
    this.maxTokens = typeof opts.maxTokens === 'number' ? opts.maxTokens : 16384;
  }

  async _doChat(messages, opts = {}) {
    if (!this.apiKey) throw new Error(`${this.displayName} 缺少 apiKey`);
    if (!this.baseUrl) throw new Error(`${this.displayName} 缺少 baseUrl`);
    const model = opts.model || this.model;
    if (!model) throw new Error(`${this.displayName} 缺少 model`);
    const url = `${this.baseUrl.replace(/\/$/, '')}${this.chatPath}`;

    const oaiMessages = messages.map(m => ({
      role: m.role === 'system' ? 'system' : (m.role === 'assistant' ? 'assistant' : 'user'),
      content: m.speaker ? `[${m.speaker}] ${m.content}` : m.content,
    }));

    const body = {
      model,
      messages: oaiMessages,
      temperature: this.temperature,
    };
    if (this.maxTokens > 0) body.max_tokens = this.maxTokens;   // v0.52 0=不传

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
        throw new Error(`${this.displayName} ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      const reply = data?.choices?.[0]?.message?.content?.trim() || '';
      const usage = data?.usage || {};
      if (!reply) throw new Error(`${this.displayName} 响应空 reply`);
      return {
        reply,
        tokensIn: usage.prompt_tokens || 0,
        tokensOut: usage.completion_tokens || 0,
        raw: data,
      };
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`${this.displayName} 超时 ${this.timeout}ms`);
      throw e;
    } finally {
      if (externalAbortHandler && opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }
}
