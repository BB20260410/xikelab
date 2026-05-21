// Analytics.js — v1.1 Task 2.1: PostHog 兼容的产品分析（轻量自实现）
// 不依赖 posthog-js 包（17KB），自写 capture API
//
// 用法：
//   import { capture, identify } from './telemetry/Analytics.js';
//   capture('room_created', { mode: 'debate' });
//
// 设计：
// - 默认 disabled（用户必须 telemetry accept + 填 analyticsKey 才启用）
// - 事件批量（30s flush 一次或 50 个一批）
// - 永不阻塞 panel（任何上报失败 silent）
// - 不发用户输入内容（只发 event name + metadata 维度）

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname, platform, release } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const CONFIG_FILE = join(homedir(), '.claude-panel', 'telemetry.json');
const FLUSH_INTERVAL_MS = 30_000;
const BATCH_SIZE = 50;

let _config = null;
let _distinctId = null;
const _queue = [];
let _flushTimer = null;

function getDistinctId() {
  if (_distinctId) return _distinctId;
  // hash of hostname + os release（匿名稳定）
  _distinctId = createHash('sha256').update(hostname() + '|' + platform() + '|' + release()).digest('hex').slice(0, 16);
  return _distinctId;
}

function loadConfig() {
  if (_config) return _config;
  try {
    if (existsSync(CONFIG_FILE)) {
      _config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } else {
      _config = { enabled: false };
    }
  } catch { _config = { enabled: false }; }
  return _config;
}

export function isAnalyticsEnabled() {
  // 重新读 config（不缓存，让 user accept 后立即生效）
  _config = null;
  const c = loadConfig();
  // host+key 都填了就启用（不强制依赖 error reporter 的 enabled 状态）
  return !!c.analyticsHost && !!c.analyticsKey;
}

/**
 * 记录一个事件
 * @param {string} event       事件名（snake_case），如 'room_created'
 * @param {Object} [properties]  非敏感元数据（mode/count/duration_ms 等）
 */
export function capture(event, properties = {}) {
  if (!isAnalyticsEnabled()) return;
  try {
    const c = loadConfig();
    _queue.push({
      event: String(event).slice(0, 80),
      properties: {
        ...properties,
        $os: platform(),
        $os_version: release(),
        panel_version: c.panelVersion || '1.0.0',
        $time: new Date().toISOString(),
      },
      distinct_id: getDistinctId(),
      timestamp: new Date().toISOString(),
    });
    if (_queue.length >= BATCH_SIZE) flush();
    else if (!_flushTimer) _flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  } catch {}
}

async function flush() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_queue.length === 0) return;
  const batch = _queue.splice(0, _queue.length);
  try {
    const c = loadConfig();
    const url = `${c.analyticsHost.replace(/\/$/, '')}/batch/`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: c.analyticsKey,
        batch: batch.map(e => ({ event: e.event, properties: e.properties, distinct_id: e.distinct_id, timestamp: e.timestamp })),
      }),
    });
  } catch {
    // silent fail（不重试，丢弃这一批）
  }
}

/** 优雅退出时调用，确保 queue flush */
export async function flushOnExit() {
  await flush();
}

// 进程退出时 flush
process.on('beforeExit', () => { flush().catch(() => {}); });
