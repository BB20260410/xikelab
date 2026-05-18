// MiniMaxAdapter — 调 MiniMax chat completion API（OpenAI 兼容协议）
//
// 国内账号默认 base URL: https://api.minimaxi.com/v1
// 海外账号: https://api.minimax.io/v1
//
// 推荐 model: MiniMax-Text-01 / abab6.5s-chat / abab6.5-chat（成本递增、质量递增）
// 默认 abab6.5s-chat：便宜 + 速度快 + 中文判断好

import { WatcherAdapter } from './WatcherAdapter.js';

const DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1';
const DEFAULT_MODEL = 'abab6.5s-chat';

export class MiniMaxAdapter extends WatcherAdapter {
  constructor(opts = {}) {
    super({
      apiKey: opts.apiKey,
      model: opts.model || DEFAULT_MODEL,
      baseUrl: opts.baseUrl || DEFAULT_BASE_URL,
      timeout: opts.timeout || 30000,
    });
  }

  get name() { return 'minimax'; }

  async judge(sessionState) {
    if (!this.apiKey) throw new Error('MiniMax API key 未配置');
    const prompt = this.buildJudgePrompt(sessionState);

    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: '你是严谨的代码任务监督者，只输出 JSON，不要任何前后解释。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, // 监督任务追求一致性
      max_tokens: 1024,
      response_format: { type: 'json_object' }, // MiniMax 支持 OpenAI 风格 JSON mode
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`MiniMax API ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || '';
      if (!content) throw new Error('MiniMax 响应空 content');
      return this.validateVerdict(content);
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`MiniMax API 超时 ${this.timeout}ms`);
      throw e;
    }
  }
}
