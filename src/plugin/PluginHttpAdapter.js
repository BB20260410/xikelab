// PluginHttpAdapter — manifest 驱动的通用 HTTP 适配器
// v0.54 Sprint 4 W3-A
//
// 把 manifest.type === 'http' 的 plugin 跑成 REST 调用：
//   - manifest.http.method/url/headers/bodyTemplate 模板化
//   - 用户传 prompt + params 后展开 → fetch
//   - manifest.http.replyJsonPath 抽 reply 字符串
//
// 安全约束：URL 必须 https://（除 localhost / 127.0.0.1 允许 http）

const DEFAULT_TIMEOUT = 30000;
const MAX_RESPONSE = 1 * 1024 * 1024;   // 1MB
const MAX_BODY = 64 * 1024;             // 64KB outgoing

function isUrlAllowed(url) {
  if (typeof url !== 'string' || !url) return false;
  if (/^https:\/\//i.test(url)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(url)) return true;
  return false;
}

export class PluginHttpAdapter {
  constructor(entry) {
    if (!entry || !entry.manifest) throw new Error('PluginHttpAdapter 需要 PluginRegistry entry');
    if (entry.manifest.type !== 'http') throw new Error(`plugin "${entry.manifest.id}" 不是 http type`);
    if (!entry.manifest.http) throw new Error(`plugin "${entry.manifest.id}" 缺 http 配置`);
    this.manifest = entry.manifest;
    this.http = entry.manifest.http;
    this.timeout = Math.min(600000, Math.max(1000, this.http.timeoutMs || DEFAULT_TIMEOUT));
  }

  async execCommand(commandId, params = {}, opts = {}) {
    const cmd = (this.manifest.commands || []).find((c) => c.id === commandId);
    if (!cmd) throw new Error(`command "${commandId}" 不在 manifest 中`);

    const finalParams = this._validateParams(cmd, params);
    const prompt = String(opts.prompt || '');
    const ctx = { ...finalParams, prompt, model: opts.model || '' };

    const url = this._substitute(this.http.url, ctx);
    if (!isUrlAllowed(url)) {
      throw new Error(`url 协议受限（仅 https:// 或 http://localhost）：${url}`);
    }
    const method = (this.http.method || 'GET').toUpperCase();
    const headers = {};
    for (const [k, v] of Object.entries(this.http.headers || {})) {
      if (!/^[a-zA-Z0-9_-]+$/.test(k)) continue;
      const expanded = this._substitute(String(v), ctx);
      if (/[\r\n]/.test(expanded)) continue;  // 防 header injection
      headers[k] = expanded;
    }
    let body;
    if (['POST', 'PUT', 'PATCH'].includes(method) && this.http.bodyTemplate) {
      body = this._substitute(this.http.bodyTemplate, ctx);
      if (body.length > MAX_BODY) throw new Error(`body 过大 (${body.length} > ${MAX_BODY})`);
      if (!headers['Content-Type'] && !headers['content-type']) {
        // 默认 JSON
        headers['Content-Type'] = 'application/json';
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) { clearTimeout(timer); throw new Error('被中断'); }
      opts.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let resp;
    try {
      resp = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new Error(`${this.manifest.displayName} 超时 ${this.timeout}ms 或被中断`);
      throw new Error(`${this.manifest.displayName} 请求失败: ${e.message}`);
    }
    clearTimeout(timer);

    // 读响应（限大小）
    let raw = '';
    try {
      raw = await resp.text();
    } catch (e) {
      throw new Error(`${this.manifest.displayName} 响应读取失败: ${e.message}`);
    }
    if (raw.length > MAX_RESPONSE) raw = raw.slice(0, MAX_RESPONSE);

    if (!resp.ok) {
      throw new Error(`${this.manifest.displayName} HTTP ${resp.status}: ${raw.slice(0, 300)}`);
    }

    // 抽 reply
    let reply = raw;
    let tokensOut = 0;
    const replyPath = this.http.replyJsonPath;
    const tokensPath = this.http.tokensJsonPath;
    if (replyPath || tokensPath) {
      try {
        const obj = JSON.parse(raw);
        if (replyPath) {
          const v = this._getJsonPath(obj, replyPath);
          if (typeof v === 'string') reply = v;
          else if (v !== undefined) reply = JSON.stringify(v);
        }
        if (tokensPath) {
          const v = this._getJsonPath(obj, tokensPath);
          if (typeof v === 'number') tokensOut = v;
        }
      } catch {
        // JSON 解析失败保留 raw
      }
    }

    return { reply, tokensIn: 0, tokensOut, raw: { status: resp.status, headers: Object.fromEntries(resp.headers) } };
  }

  // 跟 SpawnAdapter 一致的小工具
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
      if (params[key] === undefined || params[key] === null) return '';
      return String(params[key]);
    });
  }

  _getJsonPath(obj, path) {
    let cur = obj;
    const parts = path.replace(/^\./, '').split(/\.|\[(\d+)\]/).filter(Boolean);
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[/^\d+$/.test(p) ? Number(p) : p];
    }
    return cur;
  }
}
