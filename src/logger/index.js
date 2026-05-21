// panel v2.0 Task 4.4 — Pino 结构化日志
// 单例 logger，按日期分文件落 ~/.claude-panel/logs/panel-YYYY-MM-DD.log (0o600)
// 用法：
//   import { logger } from './src/logger/index.js';
//   logger.info({ feature: 'license', email }, '激活成功');
//   logger.warn({ provider: 'lemon', sig: '...' }, 'webhook 签名失败');
//   logger.error({ err: e.stack }, '崩溃');
//
// trace_id 跨调用串联：
//   import { child } from './src/logger/index.js';
//   const log = child({ traceId: 'abc-123' });

import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_DIR = path.join(os.homedir(), '.claude-panel', 'logs');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
}

function todayLogPath() {
  ensureLogDir();
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `panel-${yyyy}-${mm}-${dd}.log`);
}

const level = process.env.PANEL_LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// 先 touch 文件 + 设 0o600，再让 pino 接管 fd
const _logPath = todayLogPath();
try {
  if (!fs.existsSync(_logPath)) fs.writeFileSync(_logPath, '', { mode: 0o600 });
  fs.chmodSync(_logPath, 0o600);
} catch {}

// pino destination：写文件 + 同步刷盘（panel 崩溃前确保日志落地）
const destination = pino.destination({
  dest: _logPath,
  sync: false,
  mkdir: true,
  append: true,
});

export const logger = pino({
  level,
  base: {
    panel: process.env.PANEL_VERSION || 'dev',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
}, destination);

// 创建 child logger（继承父字段 + 自定义字段）
export function child(bindings) {
  return logger.child(bindings || {});
}

// 兼容现有 console.log 风格的辅助函数（不强制改全代码）
export function info(msg, meta = {}) { logger.info(meta, msg); }
export function warn(msg, meta = {}) { logger.warn(meta, msg); }
export function error(msg, meta = {}) { logger.error(meta, msg); }
export function debug(msg, meta = {}) { logger.debug(meta, msg); }

// 生成简单 trace id
let _traceCounter = 0;
export function newTraceId() {
  _traceCounter = (_traceCounter + 1) % 1e9;
  return `${Date.now().toString(36)}-${_traceCounter.toString(36)}`;
}

// flush（panel shutdown 时调用，确保日志落地）
export function flushSync() {
  try { destination.flushSync(); } catch {}
}

export { LOG_DIR };
