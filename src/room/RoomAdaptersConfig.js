// RoomAdaptersConfig — 读写 ~/.claude-panel/room-adapters.json
// v0.52 房间 adapter 池独立配置：MiniMax / Gemini (native + openai-compat + cli) / 自定义 OpenAI 兼容条目
// 设计目标：用户可独立配 minimax + gemini + 多个 OpenAI 兼容自定义模型，互不影响 watcher 配置

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const CONFIG_DIR = join(homedir(), '.claude-panel');
const CONFIG_FILE = join(CONFIG_DIR, 'room-adapters.json');

const MAX_CUSTOMS = 10;
const MAX_API_KEY = 2048;
const MAX_BASE_URL = 500;
const MAX_MODEL = 200;
const MAX_DISPLAY_NAME = 80;

export const DEFAULT_CONFIG = {
  minimax: {
    enabled: false,
    apiKey: '',
    baseUrl: '',
    model: '',
    timeoutMs: 0,         // v0.52 0=用 adapter 默认（HTTP 1h）；>0 覆盖
    maxTokens: 0,         // v0.52 0=用 adapter 默认（32K）；>0 覆盖
  },
  gemini: {
    enabled: false,
    apiKey: '',
    model: '',
    baseUrl: '',
    timeoutMs: 0,
    maxTokens: 0,         // v0.52 0=用 adapter 默认（65K）
  },
  gemini_openai: {
    enabled: false,
    apiKey: '',
    baseUrl: '',
    model: '',
    timeoutMs: 0,
    maxTokens: 0,         // v0.52 0=用 adapter 默认（16K）
  },
  gemini_cli: {
    enabled: false,
    model: '',
    timeoutMs: 0,         // v0.52 0=用默认（spawn 2h）
  },
  // v0.52 spawn adapter（claude/codex/ccr）也支持覆盖默认 timeout
  spawn_overrides: {
    claudeTimeoutMs: 0,
    codexTimeoutMs: 0,
    ccrTimeoutMs: 0,
  },
  customs: [
    // [{ id, displayName, baseUrl, apiKey, model, timeoutMs? }]
  ],
};

export function loadRoomAdaptersConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
    const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    return mergeDeep(DEFAULT_CONFIG, data);
  } catch (e) {
    // 损坏时备份，避免下次原子写覆盖丢全部 adapter 配置（参考 B-01 模式）
    try {
      if (existsSync(CONFIG_FILE)) {
        const bak = CONFIG_FILE + '.corrupted-' + Date.now() + '.bak';
        copyFileSync(CONFIG_FILE, bak);
        console.error(`❌ room-adapters.json 损坏，已备份到 ${bak}：${e.message}`);
      }
    } catch {}
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

export function saveRoomAdaptersConfig(config) {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    try { chmodSync(CONFIG_DIR, 0o700); } catch {}
    // 原子写 + 0o600
    const tmp = CONFIG_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
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
    if (Array.isArray(source[k])) {
      out[k] = source[k];
    } else if (source[k] && typeof source[k] === 'object') {
      out[k] = mergeDeep(target[k] || {}, source[k]);
    } else {
      out[k] = source[k];
    }
  }
  return out;
}

/**
 * 收到前端 PUT 的 incoming 配置，做字段白名单 + 类型/长度校验，返回 clean 配置和错误。
 * 返回 { ok:true, config } 或 { ok:false, error, field }
 */
export function validateAndCleanConfig(incoming, currentConfig) {
  if (!incoming || typeof incoming !== 'object') {
    return { ok: false, error: 'config 必须是对象' };
  }
  const clean = JSON.parse(JSON.stringify(currentConfig || DEFAULT_CONFIG));

  const cleanFlat = (target, src, fields) => {
    if (!src || typeof src !== 'object') return null;
    if (typeof src.enabled === 'boolean') target.enabled = src.enabled;
    // v0.52 timeoutMs 通用字段（0 = 用默认；正整数 = 覆盖。上限 7200000ms = 2h）
    if (src.timeoutMs !== undefined) {
      const n = Number(src.timeoutMs);
      if (!Number.isFinite(n) || n < 0 || n > 7200000) return 'timeoutMs 必须 0~7200000ms（0=默认，最大 2 小时）';
      target.timeoutMs = Math.trunc(n);
    }
    // v0.52 maxTokens（输出上限）：0 = 不传让服务端决定；正整数 = 显式 cap。上限 200000（覆盖 Gemini 3.1 Pro 等大窗模型）
    if (src.maxTokens !== undefined) {
      const n = Number(src.maxTokens);
      if (!Number.isFinite(n) || n < 0 || n > 200000) return 'maxTokens 必须 0~200000（0=不传服务端默认）';
      target.maxTokens = Math.trunc(n);
    }
    for (const f of fields) {
      if (typeof src[f] === 'string') {
        const v = src[f];
        const limit = f === 'apiKey' ? MAX_API_KEY : f === 'baseUrl' ? MAX_BASE_URL : MAX_MODEL;
        if (v.length > limit) return `${f} 过长（>${limit}）`;
        if (f === 'baseUrl' && v && !/^https?:\/\//i.test(v)) return 'baseUrl 必须 http(s)://';
        // 脱敏占位（含 ...）保留原值不覆盖
        if (f === 'apiKey' && v.includes('...')) continue;
        target[f] = v;
      }
    }
    return null;
  };

  let err = cleanFlat(clean.minimax, incoming.minimax, ['apiKey', 'baseUrl', 'model']);
  if (err) return { ok: false, error: 'minimax.' + err };

  err = cleanFlat(clean.gemini, incoming.gemini, ['apiKey', 'baseUrl', 'model']);
  if (err) return { ok: false, error: 'gemini.' + err };

  err = cleanFlat(clean.gemini_openai, incoming.gemini_openai, ['apiKey', 'baseUrl', 'model']);
  if (err) return { ok: false, error: 'gemini_openai.' + err };

  if (incoming.gemini_cli && typeof incoming.gemini_cli === 'object') {
    if (typeof incoming.gemini_cli.enabled === 'boolean') clean.gemini_cli.enabled = incoming.gemini_cli.enabled;
    if (typeof incoming.gemini_cli.model === 'string') {
      if (incoming.gemini_cli.model.length > MAX_MODEL) return { ok: false, error: 'gemini_cli.model 过长' };
      clean.gemini_cli.model = incoming.gemini_cli.model;
    }
    if (incoming.gemini_cli.timeoutMs !== undefined) {
      const n = Number(incoming.gemini_cli.timeoutMs);
      if (!Number.isFinite(n) || n < 0 || n > 7200000) return { ok: false, error: 'gemini_cli.timeoutMs 必须 0~7200000ms' };
      clean.gemini_cli.timeoutMs = Math.trunc(n);
    }
  }

  // v0.52 spawn 内置 adapter（claude/codex/ccr）timeout 覆盖
  if (incoming.spawn_overrides && typeof incoming.spawn_overrides === 'object') {
    for (const k of ['claudeTimeoutMs', 'codexTimeoutMs', 'ccrTimeoutMs']) {
      if (incoming.spawn_overrides[k] !== undefined) {
        const n = Number(incoming.spawn_overrides[k]);
        if (!Number.isFinite(n) || n < 0 || n > 7200000) return { ok: false, error: `spawn_overrides.${k} 必须 0~7200000ms` };
        clean.spawn_overrides = clean.spawn_overrides || { claudeTimeoutMs: 0, codexTimeoutMs: 0, ccrTimeoutMs: 0 };
        clean.spawn_overrides[k] = Math.trunc(n);
      }
    }
  }

  if (Array.isArray(incoming.customs)) {
    if (incoming.customs.length > MAX_CUSTOMS) {
      return { ok: false, error: `自定义条目超出上限 ${MAX_CUSTOMS}` };
    }
    const customs = [];
    const seenIds = new Set();
    for (const [i, c] of incoming.customs.entries()) {
      if (!c || typeof c !== 'object') return { ok: false, error: `customs[${i}] 不是对象` };
      let id = typeof c.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(c.id) ? c.id : randomUUID().slice(0, 8);
      // 同步保留原 id（前端编辑时）
      if (seenIds.has(id)) return { ok: false, error: `customs[${i}].id 重复` };
      seenIds.add(id);
      const displayName = typeof c.displayName === 'string' ? c.displayName : '';
      if (displayName.length > MAX_DISPLAY_NAME) return { ok: false, error: `customs[${i}].displayName 过长` };
      const baseUrl = typeof c.baseUrl === 'string' ? c.baseUrl : '';
      if (baseUrl.length > MAX_BASE_URL) return { ok: false, error: `customs[${i}].baseUrl 过长` };
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return { ok: false, error: `customs[${i}].baseUrl 必须 http(s)://` };
      const apiKey = typeof c.apiKey === 'string' ? c.apiKey : '';
      if (apiKey.length > MAX_API_KEY) return { ok: false, error: `customs[${i}].apiKey 过长` };
      const model = typeof c.model === 'string' ? c.model : '';
      if (model.length > MAX_MODEL) return { ok: false, error: `customs[${i}].model 过长` };
      const enabled = c.enabled !== false;
      let timeoutMs = 0;
      if (c.timeoutMs !== undefined) {
        const n = Number(c.timeoutMs);
        if (!Number.isFinite(n) || n < 0 || n > 7200000) return { ok: false, error: `customs[${i}].timeoutMs 必须 0~7200000ms` };
        timeoutMs = Math.trunc(n);
      }
      let maxTokens = 0;
      if (c.maxTokens !== undefined) {
        const n = Number(c.maxTokens);
        if (!Number.isFinite(n) || n < 0 || n > 200000) return { ok: false, error: `customs[${i}].maxTokens 必须 0~200000` };
        maxTokens = Math.trunc(n);
      }
      // 脱敏占位保留原 apiKey
      const prev = (currentConfig?.customs || []).find(x => x.id === id);
      const finalKey = (apiKey.includes('...') && prev) ? prev.apiKey : apiKey;
      customs.push({ id, displayName: displayName || `自定义 ${id}`, baseUrl, apiKey: finalKey, model, enabled, timeoutMs, maxTokens });
    }
    clean.customs = customs;
  }

  return { ok: true, config: clean };
}

/** 返回脱敏后端可发给前端的版本（apiKey 显示 4...4） */
export function maskedConfig(config) {
  const mask = (s) => {
    if (!s) return '';
    if (s.length <= 8) return '***';
    return s.slice(0, 4) + '...' + s.slice(-4);
  };
  const c = JSON.parse(JSON.stringify(config));
  if (c.minimax?.apiKey) c.minimax.apiKey = mask(c.minimax.apiKey);
  if (c.gemini?.apiKey) c.gemini.apiKey = mask(c.gemini.apiKey);
  if (c.gemini_openai?.apiKey) c.gemini_openai.apiKey = mask(c.gemini_openai.apiKey);
  if (Array.isArray(c.customs)) {
    c.customs = c.customs.map(x => ({ ...x, apiKey: mask(x.apiKey) }));
  }
  return c;
}
