// GeminiSpawnAdapter — spawn `gemini` CLI（@google/gemini-cli）拿 Gemini 的回答
// 仿 ClaudeSpawnAdapter / CodexSpawnAdapter 风格
// stdin 喂 prompt → stdout 收 reply

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RoomAdapter } from './RoomAdapter.js';
// v0.52 fix: gemini-cli 0.42 在非 TTY 下不复用 OAuth token，必须真分配 PTY
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';

// 与 Z-02/Z-05 一致：spawn 不解析 shell alias，需 which resolve 绝对路径
function resolveGeminiBin() {
  if (process.env.GEMINI_BIN) return process.env.GEMINI_BIN;
  try {
    const r = spawnSync('which', ['gemini'], { encoding: 'utf-8', env: process.env });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  const fb = join(homedir(), '.npm-global', 'bin', 'gemini');
  return existsSync(fb) ? fb : 'gemini';
}
const DEFAULT_GEMINI_BIN = resolveGeminiBin();

/** 启动期探测 CLI 是否可用，供 buildRoomAdapters 决定是否注册 */
export function isGeminiCliAvailable() {
  try {
    if (process.env.GEMINI_BIN) return existsSync(process.env.GEMINI_BIN);
    const r = spawnSync('which', ['gemini'], { encoding: 'utf-8', env: process.env });
    if (r.status === 0 && r.stdout.trim()) return true;
  } catch {}
  return existsSync(join(homedir(), '.npm-global', 'bin', 'gemini'));
}

// 2026-05：Gemini 自动降级链——一个 model 配额满了自动试下一个
//   pro 能力最强但 free tier 仅 25 RPD/天 → flash 50 RPD/天 → flash-lite（次稳定后备）
//   顺序按"从高到低"；用户在 UI 指定 model 时把它放链首，其他作 fallback
export const GEMINI_FALLBACK_CHAIN = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

export function buildGeminiFallbackChain(preferred) {
  if (!preferred) return [...GEMINI_FALLBACK_CHAIN];
  const rest = GEMINI_FALLBACK_CHAIN.filter(m => m !== preferred);
  return [preferred, ...rest];
}

export class GeminiSpawnAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: 'gemini-cli',
      displayName: opts.displayName || '🔷 Gemini CLI',
      // 2026-05：默认链首 pro（能力强）；配额满时自动降级到 flash（更稳）
      //   旧版默认 flash 是因 gemini-cli 0.42 自身 default model 在 free quota 下 NotFound——
      //   现在通过 fallback chain 主动管理，pro/flash 都试，能力优先
      model: opts.model || 'gemini-2.5-pro',
      timeout: opts.timeout || 1800000,  // v0.52 默认 30 分钟
    });
    this.bin = opts.bin || DEFAULT_GEMINI_BIN;
  }

  /** 主入口：试 fallback chain 里每个 model，配额耗尽错误才往下试，其他错误直抛 */
  async _doChat(messages, opts = {}) {
    const prompt = this.flattenMessages(messages);
    const chain = buildGeminiFallbackChain(opts.model || this.model);
    let lastErr = null;
    for (let i = 0; i < chain.length; i++) {
      const m = chain[i];
      // 用户/协调器中途 abort 立即停
      if (opts.abortSignal?.aborted) throw new Error('Gemini CLI 被中断');
      try {
        const result = await this._doChatOnce(prompt, m, opts);
        if (i > 0) {
          // 通知 UI：本次实际用的是 fallback model
          opts.onProgress?.(`\n[Gemini 自动降级] ${chain[i - 1]} 配额耗尽 → 改用 ${m}\n`);
        }
        return { ...result, raw: { ...(result.raw || {}), modelUsed: m, fallbackFrom: i > 0 ? chain.slice(0, i) : null } };
      } catch (e) {
        lastErr = e;
        // 仅"配额耗尽 / ModelNotFound" 触发 fallback；OAuth/abort/timeout/其他错误直接抛
        if (e?.code !== 'GEMINI_QUOTA_EXHAUSTED') throw e;
        // 配额错误 → 继续 fallback chain 下一个
      }
    }
    // chain 全打光
    throw lastErr || new Error('Gemini CLI: fallback chain 全部失败');
  }

  /** 单次调用：单 model 一次 spawn；配额类错误抛 err.code='GEMINI_QUOTA_EXHAUSTED' 给外层判断 */
  async _doChatOnce(prompt, model, opts = {}) {
    // v0.52 fix: gemini CLI 0.42 在非 TTY 上下文（pipe stdin）下**不复用** ~/.gemini/oauth_creds.json，
    //   会重跑 OAuth 流（弹"Opening authentication page... [Y/n]"）→ 无 TTY 无人选 Y → cancel。
    // 解决：用 node-pty 真分配一个 PTY → gemini 觉得有 TTY → 走"已登录"路径。
    // 同时改用 `-p PROMPT` 参数（headless 模式）让 gemini 跑完即退，不要进交互 REPL。
    const args = ['-p', prompt];
    if (model) args.push('-m', model);

    return new Promise((resolve, reject) => {
      let ptyProcess;
      try {
        ptyProcess = pty.spawn(this.bin, args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: opts.cwd || process.cwd(),
          env: { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', TERM: 'xterm-256color', ...(opts.env || {}) },
        });
      } catch (e) {
        return reject(new Error(`Gemini CLI PTY 启动失败: ${e.message}（确认 \`gemini\` 已安装并在 PATH）`));
      }
      let stdout = '';
      let settled = false;
      let timer = null;
      let onAbort = null;
      // PTY 输出 stdout/stderr 混在一起；onData 一次性收
      ptyProcess.onData(d => {
        stdout += d;
        opts.onProgress?.(d);
        // 兜底：万一 OAuth 还是失败，立即 reject 不等 timeout
        if (/FatalCancellationError|Authentication cancelled|initOauthClient/.test(stdout)) {
          finishErr(new Error('Gemini CLI OAuth 失败。请在终端跑 `gemini -p hi` 确认登录有效，token 在 ~/.gemini/oauth_creds.json'));
          try { ptyProcess.kill('SIGTERM'); } catch {}
        }
      });

      const cleanup = () => {
        if (opts.abortSignal && onAbort) opts.abortSignal.removeEventListener('abort', onAbort);
        if (timer) { clearTimeout(timer); timer = null; }
      };
      const finishOk = (val) => { if (settled) return; settled = true; cleanup(); resolve(val); };
      const finishErr = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };
      const forceKillSoon = () => {
        const killTimer = setTimeout(() => {
          try { ptyProcess.kill('SIGKILL'); } catch {}
        }, 2000);
        try { killTimer.unref?.(); } catch {}
      };

      timer = setTimeout(() => {
        try { ptyProcess.kill('SIGTERM'); } catch {}
        forceKillSoon();
        finishErr(new Error(`Gemini CLI 超时 ${this.timeout}ms`));
      }, this.timeout);

      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) {
          try { ptyProcess.kill('SIGTERM'); } catch {}
          return finishErr(new Error('Gemini CLI 被中断'));
        }
        onAbort = () => {
          try { ptyProcess.kill('SIGTERM'); } catch {}
          forceKillSoon();
          finishErr(new Error('Gemini CLI 被中断'));
        };
        opts.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      ptyProcess.onExit(({ exitCode }) => {
        if (opts.abortSignal?.aborted) return finishErr(new Error('Gemini CLI 被中断'));
        // PTY 输出含 \r\n + ANSI + 控制字符 + warning。清理：
        let reply = stdout
          .replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')   // ANSI CSI
          .replace(/\x1B\][^\x07]*\x07/g, '')        // ANSI OSC
          .replace(/\r/g, '')                         // CR
          .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')   // 其他控制字符
          .replace(/^Ripgrep is not available\..*$/gm, '')
          .replace(/^Warning:.*$/gm, '')
          .trim();
        if (exitCode === 0 && reply) {
          finishOk({ reply, tokensIn: 0, tokensOut: 0, raw: { stdout, exitCode } });
        } else {
          // 2026-05：gemini-cli 0.42 把 Google API 配额耗尽（RESOURCE_EXHAUSTED）误分类成 ModelNotFoundError
          //   关键字命中 → 打 code='GEMINI_QUOTA_EXHAUSTED' 让外层 _doChat 触发 fallback
          if (/ModelNotFoundError|Requested entity was not found|RESOURCE_EXHAUSTED|quota|429/i.test(stdout)) {
            const err = new Error(`Gemini CLI 调用 ${model} 失败：配额耗尽（free tier 当天 RPD 用完）`);
            err.code = 'GEMINI_QUOTA_EXHAUSTED';
            err.model = model;
            finishErr(err);
          } else {
            finishErr(new Error(`Gemini CLI exit code=${exitCode} reply=${reply ? '有' : '空'} out=${stdout.slice(0, 300)}`));
          }
        }
      });
    });
  }
}
