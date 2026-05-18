// OllamaAdapter — 本地 Ollama 监视者（零成本 + 任务不外传 + OpenAI 兼容协议）
//
// 前置：用户机器跑 `ollama serve`（端口 11434），并 `ollama pull <model>` 装过模型
// 推荐 model：gemma3:4b（快）/ qwen2.5:7b（中文好）/ llama3.2:3b（轻）
// JSON 输出能力：gemma3 / qwen2.5 / llama3.2 都支持 OpenAI 兼容协议 + JSON mode

import { WatcherAdapter } from './WatcherAdapter.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'gemma3:4b';

export class OllamaAdapter extends WatcherAdapter {
  constructor(opts = {}) {
    super({
      apiKey: opts.apiKey || 'ollama', // 本地不需要真 key 但接口要传非空
      model: opts.model || DEFAULT_MODEL,
      baseUrl: opts.baseUrl || DEFAULT_BASE_URL,
      timeout: opts.timeout || 60000, // 本地慢点没关系，60s
    });
  }

  get name() { return 'ollama'; }

  async judge(sessionState) {
    const prompt = this.buildJudgePrompt(sessionState);

    // OpenAI 兼容 chat completion endpoint
    const url = `${this.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: '你是严谨的代码任务监督者，只输出 JSON 不要 markdown 围栏。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
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
        throw new Error(`Ollama ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || '';
      if (!content) throw new Error('Ollama 响应空 content');
      return this.validateVerdict(content);
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`Ollama 超时 ${this.timeout}ms（模型 ${this.model} 可能太大）`);
      throw e;
    }
  }
}
