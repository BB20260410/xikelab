// CodexSpawnAdapter — spawn `codex exec` 拿 GPT 的回答（聊天室成员）
// 用户 ChatGPT 5x plan 通过 codex CLI 走，零 API 增量
// codex exec stdin 喂 prompt，-o file 拿最终回答，避免解析 stdout 噪声

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { RoomAdapter } from './RoomAdapter.js';

// v0.51 Z-05 fix: spawn 不解析 shell alias，需 which resolve 绝对路径
function resolveCodexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  try {
    const r = spawnSync('which', ['codex'], { encoding: 'utf-8', env: process.env });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  const fb = join(homedir(), '.npm-global', 'bin', 'codex');
  return existsSync(fb) ? fb : 'codex';
}
const DEFAULT_CODEX_BIN = resolveCodexBin();

function isContextWindowText(text) {
  return /out of room in the model'?s context window|context window|context length|max(?:imum)? context|too many tokens|prompt is too long|input is too long/i.test(String(text || ''));
}

function codexExitError({ code, stdout, stderr }) {
  // codex banner + prompt echo 常常挤在 stderr 头部，UI 只需要短错误，完整 raw 仍放 raw 字段给调用方调试。
  const stderrTail = stderr.length > 1500 ? '...(头部省略)...' + stderr.slice(-1500) : stderr;
  const stdoutTail = stdout.length > 800 ? '...(头部省略)...' + stdout.slice(-800) : stdout;
  const err = new Error(`Codex exit code=${code} reply 空 stderr_tail=${stderrTail} stdout_tail=${stdoutTail}`);
  err.stdout = stdout;
  err.stderr = stderr;
  if (isContextWindowText(stderr) || isContextWindowText(stdout)) {
    err.code = 'CONTEXT_WINDOW_EXHAUSTED';
    err.message = 'Codex 上下文窗口不足：底层模型拒绝当前报告输入，请缩短输入或使用报告压缩重试';
  }
  return err;
}

export class CodexSpawnAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: 'codex',
      displayName: opts.displayName || '🟢 GPT',
      model: opts.model || null,
      timeout: opts.timeout || 1800000,  // v0.52 默认 30 分钟
    });
    this.bin = opts.bin || DEFAULT_CODEX_BIN;
    // codex CLI 0.128.0 的 turn/start 硬上限是 1,048,576 字符（stdin 整段）；
    // 扣掉 flattenMessages 分隔符 + system prompt + 模板 + 元信息，安全余量 ~48K。
    this.maxPromptChars = 1_000_000;
    // 报告不是普通聊天：Codex 还会加载 AGENTS / skills / 内置系统提示，1M 字符会超过真实模型上下文。
    // 单独给报告输入一个软预算，RoomReporter 可在 context-window 错误后继续压缩重试。
    this.maxReportContentChars = opts.maxReportContentChars || 120_000;
    this.contextRetryContentChars = opts.contextRetryContentChars || 32_000;
  }

  async _doChat(messages, opts = {}) {
    const prompt = this.flattenMessages(messages);
    const tmpDir = mkdtempSync(join(tmpdir(), 'codex-room-'));
    const outFile = join(tmpDir, 'last.txt');

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C', opts.cwd || process.cwd(),
      '-o', outFile,
    ];
    const model = opts.model || this.model;
    if (model) args.push('-m', model);
    args.push('-'); // 从 stdin 读 prompt

    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        env: { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' },
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
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        if (opts.abortSignal && onAbort) {
          opts.abortSignal.removeEventListener('abort', onAbort);
        }
        if (timer) { clearTimeout(timer); timer = null; }
      };
      const finishOk = (val) => { if (settled) return; settled = true; cleanup(); resolve(val); };
      const finishErr = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };
      const forceKillSoon = () => {
        const killTimer = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          } catch {}
        }, 2000);
        try { killTimer.unref?.(); } catch {}
      };

      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        // v0.51 ZZ-09 fix: SIGKILL 兜底
        forceKillSoon();
        finishErr(new Error(`Codex 超时 ${this.timeout}ms`));
      }, this.timeout);

      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) {
          try { child.kill('SIGTERM'); } catch {}
          return finishErr(new Error('Codex 被中断'));
        }
        onAbort = () => {
          try { child.kill('SIGTERM'); } catch {}
          forceKillSoon();
          finishErr(new Error('Codex 被中断'));
        };
        opts.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', e => finishErr(new Error(`Codex spawn 失败: ${e.message}`)));

      // P0 #4: stdin EPIPE 防御（CLI 立即 exit / 大 prompt 都可能触发）
      child.stdin.on('error', e => {
        if (e.code === 'EPIPE') return; // 进程先死，下面 exit handler 会处理 reject
        finishErr(new Error('Codex stdin 错误: ' + e.message));
      });

      child.on('exit', (code) => {
        // v0.51 ZZ-06 fix: abort 后 child SIGTERM 退出但 reply 已写入 outFile，原逻辑会误判成功
        if (opts.abortSignal?.aborted) return finishErr(new Error('Codex 被中断'));
        let reply = '';
        try { reply = readFileSync(outFile, 'utf-8').trim(); } catch {}
        if (!reply) {
          // 兜底：从 stdout 提取 "codex\n...\ntokens used" 段
          const m = stdout.match(/codex\n([\s\S]*?)\ntokens used/);
          if (m) reply = m[1].trim();
        }
        let tokensOut = 0;
        const tm = stdout.match(/tokens used\s*\n([\d,]+)/);
        if (tm) tokensOut = parseInt(tm[1].replace(/,/g, ''), 10) || 0;
        if (code === 0 && reply) {
          finishOk({ reply, tokensIn: 0, tokensOut, raw: { stdout, stderr, code } });
        } else {
          finishErr(codexExitError({ code, stdout, stderr }));
        }
      });

      // v0.45 P2-1: stdin.write 是 EventEmitter，回调里处理 EPIPE 即可，外层 try 是死代码
      child.stdin.write(prompt, (err) => {
        if (err && err.code !== 'EPIPE') finishErr(new Error('Codex stdin write: ' + err.message));
        try { child.stdin.end(); } catch {}
      });
    });
  }
}
