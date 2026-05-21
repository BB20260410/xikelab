// ErrorReporter — 轻量 Sentry 兼容 client（Task 1.1）
// 无 npm 依赖；用 fetch 直连 Sentry Store API
//
// 设计原则（商品化）：
// 1. 默认 disabled — 用户必须在 telemetry.json 显式填 DSN 才启用
// 2. 隐私优先 — 不上报 user content / API key / file path 绝对路径（自动 mask 到 ~）
// 3. 限流 — 同一错误指纹 5 分钟内只上报 1 次
// 4. 永不阻塞 panel — 任何异常都 silent catch
// 5. Opt-out 简单 — 删 DSN 字段即关

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostname } from 'node:os';

const CONFIG_DIR = join(homedir(), '.claude-panel');
const CONFIG_FILE = join(CONFIG_DIR, 'telemetry.json');
const RATE_LIMIT_MS = 5 * 60 * 1000;  // 同指纹 5 分钟内只上报 1 次

let _config = null;
const _recentFingerprints = new Map();   // fingerprint → lastSentMs

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/** 读取 telemetry.json（懒加载）*/
export function loadConfig() {
  if (_config) return _config;
  try {
    if (!existsSync(CONFIG_FILE)) {
      _config = { enabled: false, dsn: '', acceptedAt: null };
      return _config;
    }
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    _config = JSON.parse(raw);
    return _config;
  } catch (e) {
    _config = { enabled: false, dsn: '', acceptedAt: null };
    return _config;
  }
}

/** 用户确认遥测同意（首次 onboarding 触发）*/
export function acceptTelemetry({ dsn = '' } = {}) {
  ensureConfigDir();
  _config = { enabled: true, dsn: String(dsn).trim(), acceptedAt: new Date().toISOString() };
  writeFileSync(CONFIG_FILE, JSON.stringify(_config, null, 2), { mode: 0o600 });
  try { chmodSync(CONFIG_FILE, 0o600); } catch {}
}

export function declineTelemetry() {
  ensureConfigDir();
  _config = { enabled: false, dsn: '', acceptedAt: new Date().toISOString() };
  writeFileSync(CONFIG_FILE, JSON.stringify(_config, null, 2), { mode: 0o600 });
}

export function isEnabled() {
  const c = loadConfig();
  return c.enabled && !!c.dsn;
}

/** 解析 Sentry DSN -> { projectId, publicKey, host } */
function parseDsn(dsn) {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.slice(1);
    const publicKey = u.username;
    return { projectId, publicKey, host: u.host, protocol: u.protocol };
  } catch {
    return null;
  }
}

/** 隐私 sanitize — 自动 mask 敏感字段 */
function sanitize(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\/Users\/[^/]+/g, '~')                                // home path
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED-OPENAI-KEY]')      // openai key
    .replace(/(api[_-]?key|token|secret|password)["\s:=]+[^"',}\s]+/gi, '$1=[REDACTED]')
    .slice(0, 8000);                                                 // 截断长 stacktrace
}

function fingerprint(err) {
  const msg = typeof err === 'string' ? err : (err?.message || String(err));
  const stack = err?.stack || '';
  // 取 message + stack 前 2 行作指纹
  const stackKey = stack.split('\n').slice(0, 2).join('|');
  return `${msg}|${stackKey}`.slice(0, 200);
}

/**
 * 捕获并上报一个错误
 * @param {Error|string} err
 * @param {Object} [opts]  { tags, extra, level='error' }
 */
export async function captureException(err, opts = {}) {
  try {
    if (!isEnabled()) return { skipped: 'disabled' };
    const fp = fingerprint(err);
    const last = _recentFingerprints.get(fp);
    if (last && Date.now() - last < RATE_LIMIT_MS) {
      return { skipped: 'rate-limited', fingerprint: fp };
    }
    _recentFingerprints.set(fp, Date.now());

    const dsn = loadConfig().dsn;
    const parsed = parseDsn(dsn);
    if (!parsed) return { skipped: 'bad-dsn' };

    const event = {
      event_id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      timestamp: Math.floor(Date.now() / 1000),
      platform: 'node',
      level: opts.level || 'error',
      logger: 'claude-panel',
      server_name: 'panel-' + hostname().slice(0, 8),
      release: 'panel@v0.9',
      tags: { component: 'panel-server', ...(opts.tags || {}) },
      extra: opts.extra || {},
      exception: {
        values: [{
          type: err?.name || 'Error',
          value: sanitize(err?.message || String(err)),
          stacktrace: { frames: parseStackFrames(err?.stack) },
        }],
      },
    };

    const url = `${parsed.protocol}//${parsed.host}/api/${parsed.projectId}/store/`;
    const auth = `Sentry sentry_version=7,sentry_client=panel/1.0,sentry_key=${parsed.publicKey}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sentry-Auth': auth },
        body: JSON.stringify(event),
        signal: ac.signal,
      });
      return { sent: resp.ok, status: resp.status, fingerprint: fp };
    } finally { clearTimeout(timer); }
  } catch (e) {
    // 上报本身不能崩 panel
    return { error: e.message };
  }
}

function parseStackFrames(stack) {
  if (!stack) return [];
  return stack.split('\n').slice(1, 11).map(line => {
    const m = line.match(/at\s+(?:(.+?)\s+)?\(?(.+?):(\d+):(\d+)\)?/);
    if (!m) return { function: sanitize(line) };
    return {
      function: m[1] || '<anonymous>',
      filename: sanitize(m[2]),
      lineno: parseInt(m[3], 10),
      colno: parseInt(m[4], 10),
    };
  });
}
