// OllamaChatAdapter — 本地 Ollama 聊天室成员（顶位 MiniMax 直到 key 升级）
// 用 OpenAI 兼容 chat completion，零成本

import { RoomAdapter } from './RoomAdapter.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'gemma3:4b';

export class OllamaChatAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: opts.id || 'ollama',
      displayName: opts.displayName || '🔵 Ollama',
      model: opts.model || DEFAULT_MODEL,
      timeout: opts.timeout || 1200000,  // v0.52 默认 20 分钟
    });
    this.baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  }

  async _doChat(messages, opts = {}) {
    const url = `${this.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    // 直接转 OpenAI messages 数组（speaker 信息塞进 content 头）
    const oaiMessages = messages.map(m => ({
      role: m.role === 'system' ? 'system' : (m.role === 'user' ? 'user' : 'assistant'),
      content: m.speaker ? `[${m.speaker}] ${m.content}` : m.content,
    }));
    const body = {
      model: opts.model || this.model,
      messages: oaiMessages,
      temperature: 0.4,
      max_tokens: 8192,   // v0.52 1500→8192：本地 ollama 输出更长
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    // 串联外部 abortSignal（v0.43: 保留 handler 引用以 removeEventListener 防泄漏）
    let externalAbortHandler = null;
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        clearTimeout(timer);
        throw new Error('Ollama 被中断');
      }
      externalAbortHandler = () => controller.abort();
      opts.abortSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ollama' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Ollama ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      const reply = data?.choices?.[0]?.message?.content?.trim() || '';
      const usage = data?.usage || {};
      if (!reply) throw new Error('Ollama 响应空 reply');
      return {
        reply,
        tokensIn: usage.prompt_tokens || 0,
        tokensOut: usage.completion_tokens || 0,
        raw: data,
      };
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`Ollama 超时 ${this.timeout}ms`);
      throw e;
    } finally {
      if (externalAbortHandler && opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }
}
