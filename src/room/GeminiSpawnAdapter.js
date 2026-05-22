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

export class GeminiSpawnAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: 'gemini-cli',
      displayName: opts.displayName || '🔷 Gemini CLI',
      model: opts.model || null,
      timeout: opts.timeout || 1800000,  // v0.52 默认 30 分钟
    });
    this.bin = opts.bin || DEFAULT_GEMINI_BIN;
  }

  async _doChat(messages, opts = {}) {
    const prompt = this.flattenMessages(messages);
    const model = opts.model || this.model;

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

      timer = setTimeout(() => {
        try { ptyProcess.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { ptyProcess.kill('SIGKILL'); } catch {} }, 2000);
        finishErr(new Error(`Gemini CLI 超时 ${this.timeout}ms`));
      }, this.timeout);

      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) {
          try { ptyProcess.kill('SIGTERM'); } catch {}
          return finishErr(new Error('Gemini CLI 被中断'));
        }
        onAbort = () => { try { ptyProcess.kill('SIGTERM'); } catch {} };
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
          finishErr(new Error(`Gemini CLI exit code=${exitCode} reply=${reply ? '有' : '空'} out=${stdout.slice(0, 300)}`));
        }
      });
    });
  }
}
