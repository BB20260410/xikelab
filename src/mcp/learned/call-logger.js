// call-logger — MCP tool call 历史 logger（W7 学自 MCP Inspector）
// 独立 helper，未接入 McpClientManager——等 sprint 级独立设计接入

import { appendFileSync, existsSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = join(homedir(), '.claude-panel');
const LOG_FILE = () => join(LOG_DIR, `mcp-calls-${new Date().toISOString().slice(0, 7)}.jsonl`);

function ensureDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * 记录一次 MCP tool call
 * @param {object} entry
 * @param {string} entry.serverId       MCP server id
 * @param {string} entry.toolName       tool 名
 * @param {object} entry.input          调用参数（敏感字段建议掩码再传入）
 * @param {object|string} [entry.output] 返回值（成功）
 * @param {string} [entry.error]         错误信息（失败）
 * @param {number} entry.durationMs     调用耗时
 * @param {string} [entry.roomId]       触发的房间
 * @param {string} [entry.speaker]      触发的 AI
 */
export function logMcpCall(entry) {
  ensureDir();
  const file = LOG_FILE();
  const created = !existsSync(file);

  const record = {
    at: new Date().toISOString(),
    serverId: entry.serverId || 'unknown',
    toolName: entry.toolName || 'unknown',
    durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : null,
    success: !entry.error,
    inputSize: entry.input ? JSON.stringify(entry.input).length : 0,
    outputSize: entry.output ? JSON.stringify(entry.output).length : 0,
    error: entry.error || null,
    roomId: entry.roomId || null,
    speaker: entry.speaker || null,
  };

  try {
    appendFileSync(file, JSON.stringify(record) + '\n');
    if (created) chmodSync(file, 0o600);
  } catch (e) {
    // 静默吞（不让 logger 异常影响主流程）；S26 经验：双轨可以加 toast
    if (process.env.PANEL_DEBUG) {
      console.warn('[mcp-call-logger] write failed:', e.message);
    }
  }
  return record;
}

/**
 * 读最近 N 条 call log（按月文件读，最近月份返回）
 * @param {number} limit
 */
export function recentMcpCalls(limit = 100) {
  try {
    const file = LOG_FILE();
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').trim().split('\n').slice(-limit);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * 用法（未来接入示例）：
 *   import { logMcpCall } from './learned/call-logger.js';
 *   const t0 = Date.now();
 *   try {
 *     const out = await mcpClient.callTool(toolName, input);
 *     logMcpCall({ serverId, toolName, input, output: out, durationMs: Date.now() - t0, roomId, speaker });
 *     return out;
 *   } catch (e) {
 *     logMcpCall({ serverId, toolName, input, error: e.message, durationMs: Date.now() - t0, roomId, speaker });
 *     throw e;
 *   }
 */
