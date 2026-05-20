// CodexWatcherAdapter — 用 GPT (codex CLI) 当监视者
import { WatcherAdapter } from './WatcherAdapter.js';
import { CodexSpawnAdapter } from '../room/CodexSpawnAdapter.js';

export class CodexWatcherAdapter extends WatcherAdapter {
  constructor(opts = {}) {
    super({ apiKey: 'codex-cli', model: opts.model, baseUrl: null, timeout: opts.timeout || 180000 });
    this.spawnAdapter = new CodexSpawnAdapter({ bin: opts.bin, timeout: this.timeout });
  }

  get name() { return 'codex'; }

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
