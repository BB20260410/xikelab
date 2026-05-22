// v0.55 Sprint 12 — MCP server 配置持久化
//
// 文件：~/.claude-panel/mcp-servers.json
// 配置格式跟 Claude Desktop / Claude Code 兼容：
//
// {
//   "version": 1,
//   "servers": [
//     {
//       "name": "filesystem",                    // 唯一 key
//       "type": "stdio",                          // stdio | sse | http
//       "command": "npx",                         // stdio 必填
//       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/hxx/Desktop"],
//       "env": { "DEBUG": "*" },
//       "url": "",                                // sse/http 必填
//       "headers": {},                            // sse/http 可选
//       "enabled": true,
//       "createdAt": "..."
//     }
//   ]
// }

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DIR = join(homedir(), '.claude-panel');
const FILE = join(DIR, 'mcp-servers.json');

export const VALID_TYPES = ['stdio', 'sse', 'http'];

const MAX_SERVERS = 50;
const MAX_NAME = 64;
const MAX_COMMAND = 256;
const MAX_ARG = 1024;
const MAX_ARGS_COUNT = 30;
const MAX_ENV_COUNT = 30;
const MAX_ENV_VAL = 4096;
const MAX_URL = 2048;
const MAX_HEADERS_COUNT = 20;
const MAX_HEADER_VAL = 1024;

// 命令黑名单：防止用户配置危险命令把 panel 当 RCE 入口
// （MCP server 本来就是用户自配的，但加层防御）
const DENIED_COMMANDS = new Set(['rm', 'mv', 'dd', 'mkfs', 'sudo', ':(){', 'curl', 'wget']);

function sanitizeName(s) {
  if (typeof s !== 'string') return null;
  s = s.trim();
  if (!s) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(s)) return null;
  return s.slice(0, MAX_NAME);
}

function sanitizeCommand(cmd) {
  if (typeof cmd !== 'string') return null;
  cmd = cmd.trim();
  if (!cmd) return null;
  if (cmd.length > MAX_COMMAND) return null;
  // 拒控制字符
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(cmd)) return null;
  // 拒 shell 元字符（防注入）—— stdio 用 spawn(command, args)，不走 shell 但参数里有元字符仍危险
  if (/[;&|`$(){}<>]/.test(cmd)) return null;
  // 不允许 command 字段含空格（spawn 第一参数应是 binary 而非整行命令）
  if (/\s/.test(cmd)) return null;
  // 黑名单基础命令（拿绝对路径或相对路径最后一段做 base 比对）
  const base = cmd.split('/').pop();
  if (DENIED_COMMANDS.has(base)) return null;
  return cmd;
}

function sanitizeArgs(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((a) => typeof a === 'string' && a.length <= MAX_ARG)
    .filter((a) => !/[\x00-\x08\x0b-\x1f\x7f]/.test(a))
    .slice(0, MAX_ARGS_COUNT);
}

function sanitizeEnv(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (n >= MAX_ENV_COUNT) break;
    if (typeof k !== 'string' || !/^[A-Z_][A-Z0-9_]{0,79}$/.test(k)) continue;
    if (typeof v !== 'string' || v.length > MAX_ENV_VAL) continue;
    if (/[\x00-\x08\x0b-\x1f]/.test(v)) continue;
    out[k] = v;
    n++;
  }
  return out;
}

function sanitizeUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  if (u.length > MAX_URL) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  if (/^http:\/\//i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(u)) return null;
  return u;
}

function sanitizeHeaders(h) {
  if (!h || typeof h !== 'object') return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(h)) {
    if (n >= MAX_HEADERS_COUNT) break;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(k)) continue;
    if (typeof v !== 'string' || v.length > MAX_HEADER_VAL) continue;
    if (/[\r\n]/.test(v)) continue;
    const lk = k.toLowerCase();
    if (['host', 'content-length'].includes(lk)) continue;
    out[k] = v;
    n++;
  }
  return out;
}

function sanitize(input) {
  if (!input || typeof input !== 'object') return null;
  const name = sanitizeName(input.name);
  if (!name) return null;
  const type = VALID_TYPES.includes(input.type) ? input.type : null;
  if (!type) return null;

  const out = { name, type, enabled: input.enabled !== false };

  if (type === 'stdio') {
    const cmd = sanitizeCommand(input.command);
    if (!cmd) return null;
    out.command = cmd;
    out.args = sanitizeArgs(input.args);
    out.env = sanitizeEnv(input.env);
  } else {
    // sse / http
    const url = sanitizeUrl(input.url);
    if (!url) return null;
    out.url = url;
    out.headers = sanitizeHeaders(input.headers);
  }

  return out;
}

export class McpStore {
  constructor() {
    this.servers = [];
    this._ensureDir();
    this._load();
  }

  _ensureDir() {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
  }

  _load() {
    if (!existsSync(FILE)) return;
    try {
      const raw = readFileSync(FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data?.servers)) {
        for (const s of data.servers) {
          const clean = sanitize(s);
          if (!clean) continue;
          this.servers.push({
            ...clean,
            createdAt: s.createdAt || new Date().toISOString(),
          });
          if (this.servers.length >= MAX_SERVERS) break;
        }
      }
    } catch (e) {
      console.warn('[mcp] load failed:', e.message);
    }
  }

  _save() {
    try {
      writeFileSync(FILE, JSON.stringify({ version: 1, servers: this.servers }, null, 2), { mode: 0o600 });
      try { chmodSync(FILE, 0o600); } catch {}
    } catch (e) {
      console.warn('[mcp] save failed:', e.message);
    }
  }

  list({ enabledOnly = false, mask = true } = {}) {
    let arr = this.servers;
    if (enabledOnly) arr = arr.filter((s) => s.enabled !== false);
    if (mask) {
      // 掩码 env 里看起来像 secret 的 value（key 含 KEY/TOKEN/SECRET/PASSWORD/PWD）
      arr = arr.map((s) => {
        const masked = { ...s };
        if (masked.env) {
          masked.env = Object.fromEntries(
            Object.entries(masked.env).map(([k, v]) => {
              if (/KEY|TOKEN|SECRET|PASSWORD|PWD|AUTH/i.test(k) && v.length > 8) {
                return [k, v.slice(0, 4) + '...' + v.slice(-4)];
              }
              return [k, v];
            })
          );
        }
        if (masked.headers) {
          masked.headers = Object.fromEntries(
            Object.entries(masked.headers).map(([k, v]) => {
              if (/key|token|secret|auth/i.test(k) && v.length > 8) {
                return [k, v.slice(0, 4) + '...' + v.slice(-4)];
              }
              return [k, v];
            })
          );
        }
        return masked;
      });
    }
    return arr;
  }

  get(name) {
    return this.servers.find((s) => s.name === name) || null;
  }

  create(input) {
    if (this.servers.length >= MAX_SERVERS) throw new Error(`MCP server 已达上限 ${MAX_SERVERS}`);
    const clean = sanitize(input);
    if (!clean) throw new Error('MCP server 配置不合法：name/type/command/url 任一不合规');
    if (this.servers.find((s) => s.name === clean.name)) throw new Error(`name "${clean.name}" 已存在`);
    const item = { ...clean, createdAt: new Date().toISOString() };
    this.servers.push(item);
    this._save();
    return item;
  }

  update(name, patch) {
    const i = this.servers.findIndex((s) => s.name === name);
    if (i < 0) return null;
    // 合并：patch 里没传的字段保留原值；name 不能改（如果要改 name 用 delete + create）
    const merged = { ...this.servers[i], ...patch, name };
    const clean = sanitize(merged);
    if (!clean) throw new Error('MCP server 配置不合法');
    this.servers[i] = { ...this.servers[i], ...clean };
    this._save();
    return this.servers[i];
  }

  delete(name) {
    const i = this.servers.findIndex((s) => s.name === name);
    if (i < 0) return false;
    this.servers.splice(i, 1);
    this._save();
    return true;
  }
}

export const mcpStore = new McpStore();
