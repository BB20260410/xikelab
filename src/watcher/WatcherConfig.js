// WatcherConfig — 读写 ~/.claude-panel/watcher.json
// 默认全部关闭，用户在 Settings tab 启用 + 填 API key

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.claude-panel');
const CONFIG_FILE = join(CONFIG_DIR, 'watcher.json');

export const DEFAULT_CONFIG = {
  enabled: false,                    // 全局开关（默认关）
  autoMode: false,                   // 自动模式（默认半自动，需要用户审核）
  provider: 'minimax',               // minimax | gemini | openai | ollama | custom
  apiKey: '',                        // 用户填
  model: '',                         // 留空走 adapter 默认
  baseUrl: '',                       // 留空走 adapter 默认
  rateLimit: {
    perSessionPerHour: 10,           // 每 session 每小时最多 judge 次数
    globalPerHour: 60,               // 全局每小时上限
  },
  triggers: {
    minIntervalSec: 60,              // 同 session 两次 judge 最小间隔
    requireIdleSec: 30,              // result 后多少秒无用户输入才触发
    onlyOnResultSuccess: true,       // 只在 turn 真正成功结束后触发
  },
  safety: {
    dangerScanNextAction: true,      // 自动 prompt 经过 DangerDetector
    blockOnDrift: true,              // drift_detected=true 时暂停自动模式
    maxAutoPromptsPerSession: 20,    // 防失控：单 session 自动 prompt 总上限
  },
  // 默认每 session 的开关（per-session 也可独立调）
  perSessionDefault: false,
};

export function loadWatcherConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, _firstTime: true };
    }
    const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    // 深合并默认值（向后兼容新加字段）
    return mergeDeep(DEFAULT_CONFIG, data);
  } catch (e) {
    console.warn('watcher.json 读取失败:', e.message, '→ 用默认');
    return { ...DEFAULT_CONFIG, _error: e.message };
  }
}

export function saveWatcherConfig(config) {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    // sanitize：禁止保存 _xxx 临时字段
    const clean = { ...config };
    for (const k of Object.keys(clean)) if (k.startsWith('_')) delete clean[k];
    // v0.51 Y-05 fix: 原子写
    const tmp = CONFIG_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, CONFIG_FILE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function mergeDeep(target, source) {
  const out = { ...target };
  for (const k of Object.keys(source || {})) {
    if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
      out[k] = mergeDeep(target[k] || {}, source[k]);
    } else {
      out[k] = source[k];
    }
  }
  return out;
}

// 返回脱敏版本（API key 只显示前 4 + 后 4 字符）给前端
export function maskedConfig(config) {
  const c = { ...config };
  if (c.apiKey && c.apiKey.length > 8) {
    c.apiKey = c.apiKey.slice(0, 4) + '...' + c.apiKey.slice(-4);
  } else if (c.apiKey) {
    c.apiKey = '***';
  }
  return c;
}
