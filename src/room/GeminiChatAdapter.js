// GeminiChatAdapter — Google AI Studio 原生 API（generativelanguage.googleapis.com v1beta）
// 与 OpenAI 兼容协议不同：用 contents[].parts[] 格式 + systemInstruction

import { RoomAdapter } from './RoomAdapter.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
// 2026-05：Google 尚未发布 gemini-3.x；gemini-2.5-flash 是 free quota 下唯一稳定可用的 model（gemini-2.5-pro / 1.5-* / 2.0-flash-exp 在 CLI 0.42 + free tier 下都报 ModelNotFoundError）
const DEFAULT_MODEL = 'gemini-2.5-flash';

export class GeminiChatAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: 'gemini',
      displayName: opts.displayName || '🔷 Gemini',
      model: opts.model || DEFAULT_MODEL,
      timeout: opts.timeout || 1200000,  // v0.52 默认 20 分钟
    });
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    // v0.52 Gemini 3.1 Pro 支持 65536 输出 tokens（Flash 8192）
    this.maxTokens = typeof opts.maxTokens === 'number' ? opts.maxTokens : 65536;
  }

  async _doChat(messages, opts = {}) {
    if (!this.apiKey) throw new Error('Gemini 缺少 apiKey');
    const model = opts.model || this.model || DEFAULT_MODEL;
    // 在 baseUrl 上拼模型路径
    const url = `${this.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    // 把 OpenAI 风格的 messages 转成 Gemini contents 结构
    // - system 提示合并到 systemInstruction
    // - user/assistant 映射为 user/model 角色
    const systemParts = [];
    const contents = [];
    for (const m of messages) {
      const text = m.speaker ? `[${m.speaker}] ${m.content}` : m.content;
      if (m.role === 'system') {
        systemParts.push(text);
      } else {
        const role = m.role === 'assistant' ? 'model' : 'user';
        contents.push({ role, parts: [{ text }] });
      }
    }
    if (contents.length === 0) {
      // Gemini 至少要有一条 user content
      contents.push({ role: 'user', parts: [{ text: '继续' }] });
    }

    const body = {
      contents,
      generationConfig: {
        temperature: 0.4,
        ...(this.maxTokens > 0 ? { maxOutputTokens: this.maxTokens } : {}),
      },
    };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    }

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Gemini ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      // 提取 reply：candidates[0].content.parts[*].text 拼起来
      const candidate = data?.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const reply = parts.map(p => p?.text || '').join('').trim();
      if (!reply) {
        const finish = candidate?.finishReason || 'unknown';
        throw new Error(`Gemini 响应空 reply（finishReason=${finish}，可能 safety 拦截）`);
      }
      const usage = data?.usageMetadata || {};
      return {
        reply,
        tokensIn: usage.promptTokenCount || 0,
        tokensOut: usage.candidatesTokenCount || 0,
        raw: data,
      };
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`Gemini 超时 ${this.timeout}ms`);
      throw e;
    } finally {
      if (externalAbortHandler && opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }
}
