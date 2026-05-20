// ClaudeSpawnAdapter — spawn `claude --print` 一次性拿完整回答（聊天室成员）
// 用户的 Claude 20x plan 通过本地 CLI 走，零 API 增量
// v0.55 Sprint 12：自动注入 MCP server 配置（claude CLI 原生支持 --mcp-config）

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RoomAdapter } from './RoomAdapter.js';
// lazy import mcpStore 防循环依赖（mcp 模块不依赖 adapter）
import { mcpStore } from '../mcp/McpStore.js';

// v0.51 Z-05 fix: 与 Z-02 一致——spawn 不解析 shell alias，需 which resolve 绝对路径
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const r = spawnSync('which', ['claude'], { encoding: 'utf-8', env: process.env });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  const fb = join(homedir(), '.npm-global', 'bin', 'claude');
  return existsSync(fb) ? fb : 'claude';
}
const DEFAULT_CLAUDE_BIN = resolveClaudeBin();

export class ClaudeSpawnAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: 'claude',
      displayName: opts.displayName || '🟣 Claude',
      model: opts.model || null,
      timeout: opts.timeout || 1800000,  // v0.52 默认 30 分钟（用户可在 ⚙️ 拉到 2h）
    });
    this.bin = opts.bin || DEFAULT_CLAUDE_BIN;
    this.extraArgs = opts.extraArgs || ['--dangerously-skip-permissions'];
  }

  async _doChat(messages, opts = {}) {
    const prompt = this.flattenMessages(messages);
    const args = ['--print', ...this.extraArgs];
    const model = opts.model || this.model;
    if (model) args.push('--model', model);

    // v0.55 Sprint 12：注入启用的 stdio MCP servers
    // opts.disableMcp = true 时跳过（dispatcher 可临时关闭，比如总结这种不需要 tool 的 turn）
    let mcpConfigPath = null;
    try {
      if (!opts.disableMcp) {
        const enabled = mcpStore.list({ enabledOnly: true, mask: false }).filter((s) => s.type === 'stdio');
        if (enabled.length > 0) {
          const mcpServers = {};
          for (const s of enabled) {
            mcpServers[s.name] = { command: s.command, args: s.args || [], env: s.env || {} };
          }
          mcpConfigPath = join(tmpdir(), `claude-mcp-${randomUUID()}.json`);
          writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
          args.push('--mcp-config', mcpConfigPath);
        }
      }
    } catch (e) {
      // MCP 注入失败不要阻塞主流程；记下，跳过
      console.warn('[claude-mcp] inject failed:', e.message);
      mcpConfigPath = null;
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: opts.cwd || process.cwd(),
        // v0.49 N-45 fix: 透传 opts.env（CCRSpawnAdapter 用它传 CCR_PROVIDER_HINT）
        env: { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', ...(opts.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      // v0.45 P0-1: 闭包变量提前声明，避免 cleanup 在 timer/onAbort 赋值前被 spawn error 同步触发时 TDZ
      let timer = null;
      let onAbort = null;
      child.stdout.on('data', d => { stdout += d.toString(); opts.onProgress?.(d.toString()); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      // v0.51 W-09 fix: stdout/stderr 流 error 防御
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});

      const cleanup = () => {
        if (opts.abortSignal && onAbort) {
          opts.abortSignal.removeEventListener('abort', onAbort);
        }
        if (timer) { clearTimeout(timer); timer = null; }
        // v0.55 Sprint 12：删 mcp-config 临时文件
        if (mcpConfigPath) {
          try { unlinkSync(mcpConfigPath); } catch {}
          mcpConfigPath = null;
        }
      };
      const finishOk = (val) => { if (settled) return; settled = true; cleanup(); resolve(val); };
      const finishErr = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };

      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        // v0.51 ZZ-09 fix: SIGTERM 后 2s 再 SIGKILL 兜底（防 child 忽略 SIGTERM 变僵尸）
        setTimeout(() => { try { if (child && !child.killed) child.kill('SIGKILL'); } catch {} }, 2000);
        finishErr(new Error(`Claude 超时 ${this.timeout}ms`));
      }, this.timeout);

      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) {
          try { child.kill('SIGTERM'); } catch {}
          return finishErr(new Error('Claude 被中断'));
        }
        onAbort = () => { try { child.kill('SIGTERM'); } catch {} };
        opts.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', (e) => finishErr(new Error(`Claude spawn 失败: ${e.message}`)));

      child.stdin.on('error', e => {
        if (e.code === 'EPIPE') return;
        finishErr(new Error('Claude stdin 错误: ' + e.message));
      });

      child.on('exit', (code) => {
        // v0.51 ZZ-06 fix: abort 后 child SIGTERM 退出但 stdout 已部分输出，原逻辑会误判成功
        if (opts.abortSignal?.aborted) return finishErr(new Error('Claude 被中断'));
        if (code === 0 || (code === null && stdout)) {
          finishOk({
            reply: stdout.trim(),
            tokensIn: 0,
            tokensOut: 0,
            raw: { stdout, stderr, code },
          });
        } else {
          finishErr(new Error(`Claude exit code=${code} stderr=${stderr.slice(0, 300)}`));
        }
      });

      // v0.45 P2-1: 同 Codex，删外层冗余 try
      child.stdin.write(prompt, (err) => {
        if (err && err.code !== 'EPIPE') finishErr(new Error('Claude stdin write: ' + err.message));
        try { child.stdin.end(); } catch {}
      });
    });
  }
}
