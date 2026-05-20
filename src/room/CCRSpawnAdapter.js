// CCRSpawnAdapter — spawn `ccr code --print` 走 claude-code-router 路由
// 用户的 Claude 20x plan + 多 provider 配置在 ~/.claude-code-router/config.json
// 优势：按场景（background/thinking/long-context）自动切到 Haiku/Sonnet/Opus，省 plan 配额
//
// 不强制依赖：仅当用户已 `npm install -g @musistudio/claude-code-router` 后能用
// 启动期 server.js 用 spawnSync('which', ['ccr']) 检测

import { ClaudeSpawnAdapter } from './ClaudeSpawnAdapter.js';

const DEFAULT_CCR_BIN = process.env.CCR_BIN || 'ccr';

export class CCRSpawnAdapter extends ClaudeSpawnAdapter {
  constructor(opts = {}) {
    super({
      ...opts,
      bin: opts.bin || DEFAULT_CCR_BIN,
      // ccr code 子命令 + 后续透传给 claude --print
      extraArgs: ['code', ...(opts.extraArgs || ['--dangerously-skip-permissions'])],
      displayName: opts.displayName || '🔄 Claude Router',
      timeout: opts.timeout || 1800000,  // v0.52 默认 30 分钟
    });
    this.id = 'ccr';
    this.providerHint = opts.providerHint; // 'background' | 'thinking' | 'long-context' 等
  }

  get name() { return 'ccr'; }

  async chat(messages, opts = {}) {
    // 注入 provider 提示（ccr 会根据它选 model）
    // 通过环境变量 CCR_PROVIDER_HINT 传，ccr 0.x+ 支持
    if (this.providerHint || opts.providerHint) {
      opts.env = { ...(opts.env || {}), CCR_PROVIDER_HINT: opts.providerHint || this.providerHint };
    }
    return super.chat(messages, opts);
  }
}
