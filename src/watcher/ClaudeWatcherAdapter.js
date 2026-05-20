// ClaudeWatcherAdapter — 用 Claude 当监视者（spawn claude --print 拿 verdict JSON）
// 复用 ClaudeSpawnAdapter 的 spawn 逻辑 + WatcherAdapter 的 prompt + JSON 校验

import { WatcherAdapter } from './WatcherAdapter.js';
import { ClaudeSpawnAdapter } from '../room/ClaudeSpawnAdapter.js';

export class ClaudeWatcherAdapter extends WatcherAdapter {
  constructor(opts = {}) {
    super({ apiKey: 'claude-cli', model: opts.model, baseUrl: null, timeout: opts.timeout || 180000 });
    this.spawnAdapter = new ClaudeSpawnAdapter({ bin: opts.bin, extraArgs: opts.extraArgs, timeout: this.timeout });
  }

  get name() { return 'claude'; }

  async judge(sessionState) {
    const prompt = this.buildJudgePrompt(sessionState);
    const result = await this.spawnAdapter.chat(
      [
        { role: 'system', content: '你是严谨的代码任务监督者，只输出 JSON 不要 markdown 围栏，不要其他前后缀。' },
        { role: 'user', content: prompt },
      ],
      { cwd: sessionState.cwd, model: this.model },
    );
    return this.validateVerdict(result.reply);
  }
}
