// PluginSpawnAdapter — manifest 驱动的通用 spawn 引擎
// v0.52 W1 T3
//
// 把现有 ClaudeSpawnAdapter / CodexSpawnAdapter / GeminiSpawnAdapter 的通用部分抽出来：
//   - input.mode: stdin | argv | file
//   - output.mode: stream | file
//   - output.parser: raw | jsonl
//   - bin 由 PluginRegistry 探测后传入（resolvedBin）
//   - 超时 / abort / SIGKILL 兜底走现有模式
//
// 调用方：server.js POST /api/plugins/:id/exec → 找 entry → new PluginSpawnAdapter(entry) → execCommand()

import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

export class PluginSpawnAdapter {
  /** @param {object} entry PluginRegistry 返回的 { manifest, resolvedBin, ... } */
  constructor(entry) {
    if (!entry || !entry.manifest) throw new Error('PluginSpawnAdapter 需要 PluginRegistry entry');
    if (!entry.valid) throw new Error(`Plugin "${entry.manifest.id}" 不可用: ${entry.error || 'bin 探测失败'}`);
    this.manifest = entry.manifest;
    this.resolvedBin = entry.resolvedBin || entry.manifest.bin?.cmd;
    this.timeout = entry.manifest.sandbox?.timeoutMs || 240000;
  }

  /** 跑一个 command；params 是用户传的参数对象 */
  async execCommand(commandId, params = {}, opts = {}) {
    const cmd = (this.manifest.commands || []).find(c => c.id === commandId);
    if (!cmd) throw new Error(`command "${commandId}" 不在 manifest 中`);

    // 1. 校 + 替换 params 到 args
    const finalParams = this._validateParams(cmd, params);
    const argsRaw = (cmd.args || []).map(a => this._substitute(a, finalParams));

    // 2. 准备 input / output 模式
    const inMode = this.manifest.input?.mode || 'stdin';
    const outMode = this.manifest.output?.mode || 'stream';

    let tmpDir = null;
    let outFile = null;
    let stdinPrompt = '';
    const args = [...argsRaw];

    const prompt = String(opts.prompt || '');
    if (inMode === 'stdin') {
      stdinPrompt = prompt;
    } else if (inMode === 'argv') {
      args.push(prompt);
    } else if (inMode === 'file') {
      tmpDir = mkdtempSync(join(tmpdir(), `plugin-${this.manifest.id}-`));
      const inFile = join(tmpDir, 'in.txt');
      writeFileSync(inFile, prompt, 'utf-8');
      const flag = this.manifest.input?.filePathArg || '-f';
      args.push(flag, inFile);
    }

    // model arg：通用 modelArg 约定 — 若 opts.model 传了且 manifest.extra.modelArg 定义了，自动追加
    const modelArg = this.manifest.extra?.modelArg;
    const model = opts.model;
    if (modelArg && model) args.push(modelArg, model);

    if (outMode === 'file') {
      tmpDir = tmpDir || mkdtempSync(join(tmpdir(), `plugin-${this.manifest.id}-`));
      outFile = join(tmpDir, 'out.txt');
      const flag = this.manifest.output?.filePathArg || '-o';
      // 插入 -o file 到 args 前部（多数 CLI 接受位置无关，但稳妥起见放最前的非命令位置）
      // 简化：直接 push 末尾
      args.push(flag, outFile);
    }

    // 3. spawn
    const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : homedir();
    const envWhitelist = this.manifest.sandbox?.envWhitelist || ['LANG', 'LC_ALL', 'PATH', 'HOME', 'USER'];
    const env = {};
    for (const k of envWhitelist) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    // 强制 UTF-8
    if (!env.LANG) env.LANG = 'zh_CN.UTF-8';
    if (!env.LC_ALL) env.LC_ALL = 'zh_CN.UTF-8';
    if (opts.env && typeof opts.env === 'object') Object.assign(env, opts.env);

    return new Promise((resolve, reject) => {
      const child = spawn(this.resolvedBin, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer = null;
      let onAbort = null;

      child.stdout.on('data', d => { stdout += d.toString(); opts.onProgress?.(d.toString()); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});

      const cleanup = () => {
        if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
        if (opts.abortSignal && onAbort) opts.abortSignal.removeEventListener('abort', onAbort);
        if (timer) { clearTimeout(timer); timer = null; }
      };
      const finishOk = (val) => { if (settled) return; settled = true; cleanup(); resolve(val); };
      const finishErr = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };

      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { if (child && !child.killed) child.kill('SIGKILL'); } catch {} }, 2000);
        finishErr(new Error(`${this.manifest.displayName} 超时 ${this.timeout}ms`));
      }, this.timeout);

      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) {
          try { child.kill('SIGTERM'); } catch {}
          return finishErr(new Error(`${this.manifest.displayName} 被中断`));
        }
        onAbort = () => { try { child.kill('SIGTERM'); } catch {} };
        opts.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', e => finishErr(new Error(`${this.manifest.displayName} spawn 失败: ${e.message}`)));
      child.stdin.on('error', e => {
        if (e.code === 'EPIPE') return;
        finishErr(new Error(`${this.manifest.displayName} stdin 错误: ${e.message}`));
      });

      child.on('exit', (code) => {
        if (opts.abortSignal?.aborted) return finishErr(new Error(`${this.manifest.displayName} 被中断`));

        // 收输出
        let reply = '';
        try {
          if (outMode === 'file' && outFile) {
            reply = readFileSync(outFile, 'utf-8').trim();
          }
        } catch {}
        if (!reply) reply = stdout.trim();

        // 按 parser 抽取 reply 文本
        const parser = this.manifest.output?.parser || 'raw';
        if (parser === 'jsonl') {
          reply = this._parseJsonl(reply, this.manifest.output?.replyJsonPath);
        }

        // 提取 tokens
        let tokensOut = 0;
        const tokRegex = this.manifest.output?.tokensRegex;
        if (tokRegex) {
          try {
            const m = stdout.match(new RegExp(tokRegex, 'm'));
            if (m && m[1]) tokensOut = parseInt(String(m[1]).replace(/,/g, ''), 10) || 0;
          } catch {}
        }

        if ((code === 0 || (code === null && reply)) && reply) {
          finishOk({ reply, tokensIn: 0, tokensOut, raw: { stdout, stderr, code } });
        } else {
          finishErr(new Error(`${this.manifest.displayName} exit code=${code} reply=${reply ? '有' : '空'} stderr=${stderr.slice(0, 300)}`));
        }
      });

      // 写 stdin
      if (inMode === 'stdin' && stdinPrompt) {
        child.stdin.write(stdinPrompt, (err) => {
          if (err && err.code !== 'EPIPE') finishErr(new Error(`${this.manifest.displayName} stdin write: ${err.message}`));
          try { child.stdin.end(); } catch {}
        });
      } else {
        try { child.stdin.end(); } catch {}
      }
    });
  }

  // ===== helpers =====

  _validateParams(cmd, params) {
    const out = { ...params };
    for (const p of (cmd.params || [])) {
      const v = out[p.name];
      if (v === undefined || v === null || v === '') {
        if (p.required) throw new Error(`参数 ${p.name} 必填`);
        if (p.default !== undefined) out[p.name] = p.default;
        continue;
      }
      if (p.type === 'string') {
        const s = String(v);
        if (p.maxLen && s.length > p.maxLen) throw new Error(`参数 ${p.name} 过长 (>${p.maxLen})`);
        out[p.name] = s;
      } else if (p.type === 'number') {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`参数 ${p.name} 不是数字`);
        if (p.min !== undefined && n < p.min) throw new Error(`参数 ${p.name} 小于 ${p.min}`);
        if (p.max !== undefined && n > p.max) throw new Error(`参数 ${p.name} 大于 ${p.max}`);
        out[p.name] = n;
      } else if (p.type === 'boolean') {
        out[p.name] = v === true || v === 'true' || v === 1;
      } else if (p.type === 'enum') {
        if (!Array.isArray(p.enumValues) || !p.enumValues.includes(String(v))) {
          throw new Error(`参数 ${p.name} 不在枚举范围`);
        }
        out[p.name] = String(v);
      }
    }
    return out;
  }

  _substitute(template, params) {
    return String(template).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, key) => {
      if (params[key] === undefined) return m; // 未填则保留占位（如 {cwd} 必填会在 _validateParams 抛错）
      return String(params[key]);
    });
  }

  /** 解析 jsonl：每行一个 JSON，按 replyJsonPath 抽 text */
  _parseJsonl(text, jsonPath) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const parts = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const v = jsonPath ? this._getJsonPath(obj, jsonPath) : obj;
        if (typeof v === 'string') parts.push(v);
      } catch {}
    }
    return parts.join('').trim();
  }

  _getJsonPath(obj, path) {
    // 简化 jq：支持 ".a.b[0].c" 这种点+索引
    let cur = obj;
    const parts = path.replace(/^\./, '').split(/\.|\[(\d+)\]/).filter(Boolean);
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[/^\d+$/.test(p) ? Number(p) : p];
    }
    return cur;
  }
}
