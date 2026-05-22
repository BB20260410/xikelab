// Xike Lab — 多 Claude 会话管理后端
// 不用 pty（macOS arm64 binding 问题），用 claude stream-json API 模式
// 每条用户消息 = spawn 一次 claude --resume <sid> --input-format stream-json，pipe stdin/stdout

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn, spawnSync as _spawnSyncForBin } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, copyFileSync, appendFileSync, openSync, readSync, closeSync, chmodSync, renameSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { LoopGuard } from './src/safety/LoopGuard.js';
import { DangerousPatternDetector } from './src/safety/DangerousPatternDetector.js';
import { focusChainHeader, buildDoneSummaries } from './src/planner/FocusChain.js';
import { AgentStateMachine } from './src/state/AgentStateMachine.js';
import { CostTracker, estimateUsdFromUsage } from './src/cost/CostTracker.js';
import { MiniMaxAdapter } from './src/watcher/MiniMaxAdapter.js';
import { OllamaAdapter } from './src/watcher/OllamaAdapter.js';
import { ClaudeWatcherAdapter } from './src/watcher/ClaudeWatcherAdapter.js';
import { CodexWatcherAdapter } from './src/watcher/CodexWatcherAdapter.js';
import { loadWatcherConfig, saveWatcherConfig, maskedConfig } from './src/watcher/WatcherConfig.js';
import { WatcherDispatcher } from './src/watcher/WatcherDispatcher.js';
import { ChatRoomStore } from './src/room/ChatRoomStore.js';
import { DebateDispatcher } from './src/room/DebateDispatcher.js';
import { CollaborationDispatcher } from './src/room/CollaborationDispatcher.js';
import { metricsStore } from './src/metrics/MetricsStore.js';
import { listPricing } from './src/metrics/pricing.js';
import { roomTemplatesStore } from './src/templates/RoomTemplatesStore.js';
import { webhookStore, maskWebhookUrl } from './src/webhook/WebhookStore.js';
import { fireWebhooks, testWebhook } from './src/webhook/WebhookDispatcher.js';
// S18-2a：webhook routes 提取到独立 module
import { registerWebhookRoutes } from './src/server/routes/webhook.js';
// S18-2b：archive routes 提取
import { registerArchiveRoutes } from './src/server/routes/archive.js';
// S18-2c：mcp routes 提取（内部创建 McpClientManager）
import { registerMcpRoutes } from './src/server/routes/mcp.js';
// S18-2d：autopilot routes 提取
import { registerAutopilotRoutes } from './src/server/routes/autopilot.js';
// S18-2f：skills routes 提取
import { registerSkillsRoutes } from './src/server/routes/skills.js';
// S18-2g：knowledge routes 提取
import { registerKnowledgeRoutes } from './src/server/routes/knowledge.js';
// S18-2e1：room-templates routes 提取（rooms 子集，简单依赖）
import { registerRoomTemplatesRoutes } from './src/server/routes/roomTemplates.js';
// S18-2e2：rooms 5 个主 CRUD（list/create/get/delete/patch）— advanced endpoints 仍留 server.js
import { registerRoomsRoutes } from './src/server/routes/rooms.js';
// v0.81 真做：sessions 只读 endpoint 拆出
import { registerSessionsReadonlyRoutes } from './src/server/routes/sessions-readonly.js';
// B-005 v0.9：AI markdown 图片本地缓存
import { registerImgCacheRoutes } from './src/server/routes/img-cache.js';
// v1.0 Task 1.1：telemetry endpoint
import { registerTelemetryRoutes } from './src/server/routes/telemetry.js';
// v1.5 Task 3.1：license endpoint
import { registerLicenseRoutes } from './src/server/routes/license.js';
// v1.5 Task 3.3：Lemon Squeezy / Polar payment webhooks
import { registerPaymentWebhookRoutes } from './src/server/routes/payment-webhooks.js';
// v2.0 Task 4.1：SQLite 数据底座
import { registerStorageRoutes } from './src/server/routes/storage.js';
// v2.0 Task 4.2：向量索引
import { registerEmbeddingsRoutes } from './src/server/routes/embeddings.js';
// v2.0 Task 4.3：workspace 多空间隔离
import { registerWorkspaceRoutes } from './src/server/routes/workspaces.js';
// v2.0 final：商品化准备状态
import { registerCommercialSetupRoutes } from './src/server/routes/commercial-setup.js';
// v2.0 final + 1: Keychain 密码代理（panel 自动填密码到 Chrome，密码不进 LLM 对话）
import { registerAutoFillRoutes } from './src/server/routes/auto-fill.js';
// v2.0 final + 2: Lemon Squeezy API 集成（查 store / orders / 自动注册 webhook）
import { registerLemonSqueezyRoutes } from './src/server/routes/lemonsqueezy.js';
import { archiveStore } from './src/archive/ArchiveStore.js';
import { generateReport, defaultReportPath } from './src/report/RoomReporter.js';
import { mcpStore } from './src/mcp/McpStore.js';
import { skillStore } from './src/skills/SkillStore.js';
import { knowledgeStore } from './src/knowledge/KnowledgeStore.js';
import { breakers } from './src/safety/CircuitBreaker.js';
import { bulkheads } from './src/safety/Bulkhead.js';
import { rateLimiters } from './src/safety/RateLimiter.js';
import { autopilotStore } from './src/autopilot/AutopilotStore.js';
import { AutopilotController } from './src/autopilot/AutopilotController.js';
import { ArenaDispatcher } from './src/room/ArenaDispatcher.js';
import { SoloChatDispatcher } from './src/room/SoloChatDispatcher.js';
import { ClaudeSpawnAdapter } from './src/room/ClaudeSpawnAdapter.js';
import { CodexSpawnAdapter } from './src/room/CodexSpawnAdapter.js';
import { OllamaChatAdapter } from './src/room/OllamaChatAdapter.js';
// v0.52 新增 Gemini / OpenAI 兼容 + 自定义 adapter
import { GeminiSpawnAdapter, isGeminiCliAvailable } from './src/room/GeminiSpawnAdapter.js';
import { GeminiChatAdapter } from './src/room/GeminiChatAdapter.js';
import { OpenAICompatChatAdapter } from './src/room/OpenAICompatChatAdapter.js';
import { loadRoomAdaptersConfig, saveRoomAdaptersConfig, validateAndCleanConfig as cleanRoomAdaptersConfig, maskedConfig as maskRoomAdaptersConfig } from './src/room/RoomAdaptersConfig.js';
// v0.52 W1 通用 CLI Wrapper 雏形：plugin manifest registry + spawn 引擎
import { PluginRegistry } from './src/plugin/PluginRegistry.js';
import { PluginSpawnAdapter } from './src/plugin/PluginSpawnAdapter.js';
import { PluginHttpAdapter } from './src/plugin/PluginHttpAdapter.js';
import { MiniMaxChatAdapter } from './src/room/MiniMaxChatAdapter.js';
import { CCRSpawnAdapter } from './src/room/CCRSpawnAdapter.js';
// 路径沙箱（拆出便于 in-process 单测）
import { safeResolveFsPath } from './src/server/services/path-sandbox.js';
// v0.54 Sprint 10：删除 Ruflo 集成 import

const __dirname = dirname(fileURLToPath(import.meta.url));
// v0.51 X-05 fix + Z-02 fix: 用 spawnSync('which') 启动时 resolve 绝对路径
// spawn 不解析 shell alias，仅依赖 'claude' 会 ENOENT；提前 which 一次拿绝对路径
// v0.51 Z-06 fix: import 移到顶部，避免 mid-file import 风格不规范
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const r = _spawnSyncForBin('which', ['claude'], { encoding: 'utf-8', env: process.env });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  // npm 全局默认路径兜底（macOS / Linux 常见）
  const fallback = join(homedir(), '.npm-global', 'bin', 'claude');
  if (existsSync(fallback)) return fallback;
  return 'claude'; // 最后赌一把 PATH
}
const CLAUDE_BIN = resolveClaudeBin();

// 07 Continuum 状态目录：每个 cwd 对应 md5(cwd) 前 12 位的子目录
const CONTINUUM_STATE_ROOT = join(homedir(), '.claude', 'state');
function cwdHash(cwd) {
  let real = cwd;
  try { real = realpathSync(cwd); } catch {}
  return createHash('md5').update(real).digest('hex').slice(0, 12);
}
function continuumDir(cwd) {
  return join(CONTINUUM_STATE_ROOT, cwdHash(cwd));
}

// 持久化目录
const DATA_DIR = join(homedir(), '.claude-panel');
const DATA_FILE = join(DATA_DIR, 'data.json');
// v0.51 U-14 fix: mkdir 失败时友好提示再退出（之前直接抛 → server 启动失败但用户看不懂）
try {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error(`❌ 无法创建数据目录 ${DATA_DIR}：${e.message}`);
  console.error('   检查 ~ 目录写权限，或手动 mkdir 后重启');
  process.exit(1);
}
// v0.51 Z-07 fix: 清理 .tmp 残留（Y-05 原子写崩溃后残留的 tmp 文件）
try {
  for (const f of readdirSync(DATA_DIR)) {
    if (f.endsWith('.tmp')) {
      try { unlinkSync(join(DATA_DIR, f)); } catch {}
    }
  }
} catch {}

const app = express();
const server = createServer(app);
// v0.51 S-02 fix: WS payload 上限 1MB（默认 100MB 太大，PTY input / room chat 远小于此）
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });   // v0.52 1→8 MB

// v0.51 T-02 fix: 安全 slice — 防 emoji/中文 surrogate pair 切碎产生 lone surrogate
// 用户 name / cwd / displayName 等被 .slice(0, N) 时，N 可能落在 surrogate 中间
function safeSlice(s, n) {
  if (typeof s !== 'string' || s.length <= n) return s;
  let out = s.slice(0, n);
  // 砍尾部 lone high surrogate（0xD800-0xDBFF）
  const lastCode = out.charCodeAt(out.length - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) out = out.slice(0, -1);
  return out;
}

// v0.51 S-03 fix: 500 错误脱敏——内部异常记 console，客户端只看通用消息
// 仅在调试模式（env DEBUG=1）才把 e.message 透出
const DEBUG_ERRORS = process.env.PANEL_DEBUG === '1';
function send500(res, e, context = '') {
  console.error(`[500${context ? ' ' + context : ''}]`, e?.stack || e?.message || e);
  const payload = { error: DEBUG_ERRORS ? (e?.message || 'server error') : '内部错误（详情见 server 日志）' };
  res.status(500).json(payload);
}

// v0.51 T-13 fix: 隐藏 X-Powered-By 泄露技术栈
app.disable('x-powered-by');
app.use(express.json({
  limit: '10mb',
  // v1.5 Task 3.3 — webhook HMAC 验签需要 raw body
  verify: (req, _res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/webhooks/')) {
      req.rawBody = buf.toString('utf8');
    }
  },
}));
// v0.51 T-48 fix: body parser 错误统一返 JSON（默认是 Express HTML 错误页）
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'body too large (>10MB)' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  next(err);
});
// v0.51 T-12 fix: HTTP Origin 白名单（拒绝 cross-origin 请求）
// 注：浏览器对 application/json POST 走 preflight，panel 不响应 ACL 头也能挡；
// 这里再加 server 端检查作为深度防御
const PANEL_PORT = process.env.PORT || 51735;
// v0.51 Y-01 fix: 移除 'null' origin — sandboxed iframe / data: URL 也是 'null'，攻击面窄但存在
// Electron 实测 loadURL('http://localhost:51735') 时 Origin 是 http://localhost:51735，不需要 'null'
const ALLOWED_HTTP_ORIGINS = new Set([
  `http://localhost:${PANEL_PORT}`,
  `http://127.0.0.1:${PANEL_PORT}`,
  `http://[::1]:${PANEL_PORT}`,
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // 无 Origin 头（curl / Electron / 内部请求）放行；有 Origin 才校验
  if (origin && !ALLOWED_HTTP_ORIGINS.has(origin)) {
    console.warn('[http] origin rejected:', origin, 'on', req.method, req.path);
    return res.status(403).json({ error: 'forbidden: cross-origin not allowed' });
  }
  next();
});
// v0.51 S-01 fix: HTTP 安全 header（防 clickjacking / MIME sniff / referrer 泄露）
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');         // 不允许任何站点 iframe 嵌入 panel
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '0');           // 现代浏览器靠 CSP，老 XSS-Protection 已废弃
  // 简单 CSP：允许内联 + 几个 CDN（marked/DOMPurify/xterm）；禁 frame；禁 object
  res.setHeader('Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' data: blob:; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "font-src 'self' data:; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' ws: wss:; " +
    "frame-ancestors 'none'; " +
    "object-src 'none'; " +
    "base-uri 'self'"
  );
  next();
});
app.use(express.static(join(__dirname, 'public')));

const sessions = new Map();

// 持久化：保存 / 恢复
let saveTimer = null;
function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveData, 500);
}
function saveData() {
  try {
    const data = [...sessions.values()].map(s => {
      // v0.50 Q-07 fix: messages 截断 200 条 + starredIndices 同步映射，避免索引越界
      const KEEP = 200;
      const totalMsgs = (s.messages || []).length;
      const offset = Math.max(0, totalMsgs - KEEP);
      const messages = s.messages.slice(-KEEP);
      const starredIndices = Array.isArray(s.starredIndices)
        ? s.starredIndices.filter(i => i >= offset && i < totalMsgs).map(i => i - offset)
        : [];
      // v0.50 Q-07: runtime 也 cap 200，避免内存无限增长 + 二次 saveData 时索引漂移
      if (totalMsgs > KEEP) {
        s.messages = messages;
        s.starredIndices = starredIndices;
      }
      return {
      id: s.id, name: s.name, cwd: s.cwd,
      claudeSessionId: s.claudeSessionId,
      createdAt: s.createdAt,
      messages,
      handoffPrimed: s.handoffPrimed || false,
      parentSessionId: s.parentSessionId || null,
      chainDepth: s.chainDepth || 0,
      archived: s.archived || false,
      archivedAt: s.archivedAt || null,
      // v0.5 思维镜融合
      mainGoal: s.mainGoal || null,
      runState: s.runState || 'idle',
      guardLevel: s.guardLevel || 'standard',
      model: s.model || null,
      totalUSD: s.costTracker ? s.costTracker.totalUSD() : 0,
      dangerHistory: (s.dangerHistory || []).slice(-50),
      loopGuardHistory: (s.loopGuardHistory || []).slice(-50),
      // v0.36 真测 P1 fix: 补 watcher 字段持久化
      watcherEnabled: !!s.watcherEnabled,
      watcherProviderId: s.watcherProviderId || null,
      watcherHistory: (s.watcherHistory || []).slice(-50),
      // v0.47 hook 事件持久化（限长 100）
      hookEvents: (s.hookEvents || []).slice(-100),
      // v0.50 F5/Q-07: 收藏消息索引（已在上方按 offset 映射）
      starredIndices,
      };
    });
    // v0.51 Y-05 fix: 原子写（tmp + rename），防 panel 崩溃中写入截断丢全部 session
    // v0.51 T-16 fix: 0o600 权限（含 claudeSessionId / cwd / messages 等敏感数据）
    const tmp = DATA_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('save fail:', e.message);
  }
}
function loadData() {
  try {
    if (!existsSync(DATA_FILE)) return;
    let data = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
    // v0.51 Y-02 fix: 加载时 cap 到 MAX_SESSIONS（按 createdAt 倒序优先最新）
    // 避免 data.json 异常增长导致 load 后内存巨大
    if (Array.isArray(data) && data.length > 500) {
      console.warn(`[loadData] data.json 含 ${data.length} 个 session，超过 500 上限，仅加载最新 500`);
      data = [...data].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 500);
    }
    for (const s of data) {
      sessions.set(s.id, {
        id: s.id, name: s.name, cwd: s.cwd,
        claudeSessionId: s.claudeSessionId,
        createdAt: s.createdAt,
        child: null, pid: null,
        busy: false,
        messages: s.messages || [],
        clients: new Set(),
        handoffPrimed: s.handoffPrimed || false,
        parentSessionId: s.parentSessionId || null,
        chainDepth: s.chainDepth || 0,
        archived: s.archived || false,
        archivedAt: s.archivedAt || null,
        // v0.5 思维镜融合
        mainGoal: s.mainGoal || null,
        runState: s.runState || 'idle',
        guardLevel: s.guardLevel || 'standard',
        model: s.model || null,
        dangerHistory: s.dangerHistory || [],
        loopGuardHistory: s.loopGuardHistory || [],
        // v0.36 真测 P1 fix: load watcher 字段
        watcherEnabled: !!s.watcherEnabled,
        watcherProviderId: s.watcherProviderId || null,
        watcherHistory: s.watcherHistory || [],
        // v0.47 hook 事件 load
        hookEvents: Array.isArray(s.hookEvents) ? s.hookEvents : [],
        // v0.50 F5: 收藏 load
        starredIndices: Array.isArray(s.starredIndices) ? s.starredIndices : [],
      });
    }
    console.log(`📂 恢复 ${sessions.size} 个 session`);
  } catch (e) {
    // v0.51 B-01 fix: data.json 损坏时备份原文件（避免下次 saveData 原子写覆盖 → 用户 session 历史彻底丢）
    try {
      if (existsSync(DATA_FILE)) {
        const bak = DATA_FILE + '.corrupted-' + Date.now() + '.bak';
        copyFileSync(DATA_FILE, bak);
        console.error(`❌ data.json 损坏，已备份到 ${bak}：${e.message}`);
        console.error('   重启后将以空 session 列表运行，原数据保留在备份文件中');
      } else {
        console.error('load fail:', e.message);
      }
    } catch (bakErr) {
      console.error('load fail (备份也失败):', e.message, '/', bakErr.message);
    }
  }
}
loadData();

// ============ v0.26 tool_use Edit/Write/MultiEdit → markdown diff ============
function naiveDiff(oldStr, newStr) {
  const oldLines = String(oldStr || '').split('\n');
  const newLines = String(newStr || '').split('\n');
  // 朴素 diff：先全删旧 + 再全加新（不做 LCS，避免引入 diff lib 依赖）
  const out = [];
  for (const ln of oldLines) out.push('- ' + ln);
  for (const ln of newLines) out.push('+ ' + ln);
  return out.join('\n');
}
function formatEditDiff(input) {
  const path = input.file_path || '?';
  const diff = naiveDiff(input.old_string, input.new_string);
  return `🔧 **Edit** \`${path}\`\n\n\`\`\`diff\n${diff}\n\`\`\``;
}
function formatMultiEditDiff(input) {
  const path = input.file_path || '?';
  const blocks = (input.edits || []).slice(0, 10).map((ed, i) => {
    return `**Edit ${i + 1}/${input.edits.length}**\n\`\`\`diff\n${naiveDiff(ed.old_string, ed.new_string)}\n\`\`\``;
  });
  const more = input.edits.length > 10 ? `\n\n_（还有 ${input.edits.length - 10} 个 edit 省略）_` : '';
  return `🔧 **MultiEdit** \`${path}\` (${input.edits.length} 处)\n\n${blocks.join('\n\n')}${more}`;
}
function formatWritePreview(input) {
  const path = input.file_path || '?';
  const content = String(input.content || '');
  const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n…（截断 ' + (content.length - 2000) + ' 字符）' : content;
  // 用 diff fence 全 + 着色，凸显"新写入"
  const diffStyle = truncated.split('\n').map(l => '+ ' + l).join('\n');
  return `🔧 **Write** \`${path}\` (${content.length} 字符)\n\n\`\`\`diff\n${diffStyle}\n\`\`\``;
}

// ============ v0.5 思维镜融合：每个 session 配 5 个机制实例 ============
const sharedDetector = new DangerousPatternDetector(); // 无状态可共享

function ensureGuard(s) {
  if (!s.guard) s.guard = new LoopGuard();
  return s.guard;
}
// v0.27 安全历史：danger + loopGuard 触发记录
function recordDanger(session, entry) {
  if (!session.dangerHistory) session.dangerHistory = [];
  session.dangerHistory.push({ ts: new Date().toISOString(), ...entry });
  if (session.dangerHistory.length > 100) session.dangerHistory = session.dangerHistory.slice(-100);
}
function recordLoopGuard(session, reason) {
  if (!session.loopGuardHistory) session.loopGuardHistory = [];
  session.loopGuardHistory.push({ ts: new Date().toISOString(), ...reason });
  if (session.loopGuardHistory.length > 100) session.loopGuardHistory = session.loopGuardHistory.slice(-100);
}
function ensureStateMachine(s) {
  if (!s.stateMachine) s.stateMachine = new AgentStateMachine();
  return s.stateMachine;
}
function ensureCostTracker(s) {
  if (!s.costTracker) s.costTracker = new CostTracker();
  return s.costTracker;
}

// v0.51 R-17 fix: 集中 push messages + 立即 cap + 广播 cap 事件
// 让前端能同步调整 DOM data-msg-idx 偏移，避免 toggleStar 边界 race
const MESSAGES_CAP = 200;
function pushMessage(session, m) {
  session.messages.push(m);
  if (session.messages.length > MESSAGES_CAP) {
    const removed = session.messages.length - MESSAGES_CAP;
    session.messages = session.messages.slice(-MESSAGES_CAP);
    if (Array.isArray(session.starredIndices)) {
      session.starredIndices = session.starredIndices
        .filter(i => i >= removed).map(i => i - removed);
    }
    broadcastSession(session, { type: 'messages_capped', removed, newLength: session.messages.length });
  }
}

function broadcastSession(session, msg) {
  // v0.49 B-03 fix: 中断后丢弃残余 stdout（assistant message / tool_use / partial），
  // 状态类（busy / turn_end / state_change / cost_update）保留，让前端能正确同步。
  if (session._dropOutput && msg && typeof msg.type === 'string') {
    if (msg.type === 'message' || msg.type === 'partial_delta' || msg.type === 'partial_start' || msg.type === 'partial_stop') {
      return;
    }
  }
  for (const ws of session.clients) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch {}
    }
  }
}

// v0.49 B-02 fix: 文件 API 路径沙箱
// 实现拆到 src/server/services/path-sandbox.js（in-process 单测友好）
// safeResolveFsPath 由文件顶部 import 进来

function sendMessageToClaude(session, userText) {
  // v0.51 ZZ-08 fix: 深度防御 — archived session 任何路径都不该 spawn（T-46 在端点层，这里在函数层）
  if (session.archived) return { ok: false, error: 'archived', message: '会话已归档' };
  if (session.busy) return {
    ok: false,
    error: 'busy',
    message: '上一条消息 claude 还在处理。等流式输出完成，或点 ⏸ 中断按钮（双击强制释放）后再发。',
  };

  // v0.51 S-23 fix: 中断后旧 child 可能未 exit，_dropOutput 还是 true；新 turn 必须重置
  // 否则新 child 的 stdout 会被 broadcastSession 错误拦截（B-03 fix 的副作用）
  session._dropOutput = false;
  session._lastInterrupted = false;
  // 如果旧 child 还活着（exit handler 还没跑完），先 force kill 避免两个 child 撞
  if (session.child && !session.child.killed) {
    try { session.child.kill('SIGKILL'); } catch {}
    session.child = null;
  }

  // ===== LoopGuard 前置卫兵 =====
  const guard = ensureGuard(session);
  const breakReason = guard.recordInstruction(userText);
  if (breakReason) {
    recordLoopGuard(session, breakReason);
    broadcastSession(session, { type: 'loop_guard_break', reason: breakReason });
    return { ok: false, error: 'loop_guard_break', reason: breakReason };
  }

  session.busy = true;

  const args = [
    '--print', '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',  // v0.13: 让 claude 输出 token-by-token stream_event
    '--dangerously-skip-permissions',
  ];
  if (session.claudeSessionId) {
    args.push('--resume', session.claudeSessionId);
  }

  const child = spawn(CLAUDE_BIN, args, {
    cwd: session.cwd,
    env: { ...process.env, TERM: 'xterm-256color', LANG: 'zh_CN.UTF-8' },
  });
  session.child = child;
  session.pid = child.pid;
  broadcastSession(session, { type: 'busy', busy: true });

  // 接力 session 首条消息：自动给 claude prepend HANDOFF 接手提示
  // 判定：claudeSessionId 还没落定（新生）+ messages 里有 role=system 的接力 banner
  let payloadText = userText;
  let primedThisTurn = false;
  if (!session.claudeSessionId && !session.handoffPrimed) {
    const hasHandoffBanner = session.messages.some(m => m.role === 'system' && m.content && m.content.startsWith('🔁'));
    if (hasHandoffBanner) {
      payloadText =
        '【接力上下文】你是从上个 Claude 会话接力过来的新 Claude。' +
        '请先 `cat ~/HANDOFF_LATEST.md` 读完事实快照（含 TaskList / Last activity / 项目状态文件 / Recent prompts 等），' +
        '理解上一会话做到哪了，然后接着回答用户下面的消息。不要先汇报"我读完了"，直接进入工作。\n\n' +
        '--- 用户消息 ---\n' +
        userText;
      primedThisTurn = true;
    }
  }

  // ===== Focus Chain 注入（每 5 个 user message 一次）=====
  if (session.mainGoal) {
    const userMsgCount = session.messages.filter(m => m.role === 'user').length + 1; // +1 for this turn
    const fc = focusChainHeader({
      mainGoal: session.mainGoal,
      doneSummaries: buildDoneSummaries(session.messages),
      userMsgCount,
      triggerInterval: 5,
    });
    if (fc) {
      payloadText = fc + payloadText;
      broadcastSession(session, { type: 'focus_chain_injected', step: userMsgCount });
    }
  }

  const userMsg = { role: 'user', content: userText, ts: new Date().toISOString() };
  pushMessage(session, userMsg);
  broadcastSession(session, { type: 'message', message: userMsg });
  debouncedSave();

  const sm = ensureStateMachine(session);
  const tracker = ensureCostTracker(session);

  // v0.13 流式：累积每个 content block 的 partial text，按 block_index 跟踪
  // 同一个 turn 内 message_start → 多个 content_block_start/delta/stop → message_delta → message_stop
  const partialBlocks = new Map(); // block_index → { type, text, toolName? }

  let stdoutBuf = '';
  // v0.51 S-13 fix: 单行无 \n 不能无限累积 buffer
  const STDOUT_BUF_MAX = 50 * 1024 * 1024; // 50MB 单行上限
  child.stdout.on('data', d => {
    stdoutBuf += d.toString();
    if (stdoutBuf.length > STDOUT_BUF_MAX) {
      console.warn(`[session ${session.id}] stdout 单行超 ${STDOUT_BUF_MAX} 字节，强制截断并 kill child`);
      stdoutBuf = '';
      try { child.kill('SIGTERM'); } catch {}
      return;
    }
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.session_id && !session.claudeSessionId) {
          session.claudeSessionId = obj.session_id;
        }

        // ===== v0.13 流式事件解析（来自 --include-partial-messages）=====
        if (obj.type === 'stream_event' && obj.event) {
          const ev = obj.event;
          if (ev.type === 'content_block_start') {
            const idx = ev.index;
            const cb = ev.content_block || {};
            partialBlocks.set(idx, {
              type: cb.type,
              text: cb.text || '',
              toolName: cb.name,
              toolInput: cb.input || {},
            });
            broadcastSession(session, {
              type: 'partial_start',
              blockIndex: idx,
              blockType: cb.type,
              toolName: cb.name,
              ts: new Date().toISOString(),
            });
          } else if (ev.type === 'content_block_delta') {
            const idx = ev.index;
            const delta = ev.delta || {};
            const slot = partialBlocks.get(idx);
            if (slot) {
              if (delta.type === 'text_delta' && delta.text) {
                slot.text += delta.text;
                broadcastSession(session, {
                  type: 'partial_delta',
                  blockIndex: idx,
                  blockType: 'text',
                  textDelta: delta.text,
                });
              } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                // tool input 累积（不主动广播每个字符，太碎）
                slot._inputJsonBuf = (slot._inputJsonBuf || '') + delta.partial_json;
              } else if (delta.type === 'thinking_delta' && delta.thinking) {
                slot.text += delta.thinking;
                broadcastSession(session, {
                  type: 'partial_delta',
                  blockIndex: idx,
                  blockType: 'thinking',
                  textDelta: delta.thinking,
                });
              }
            }
          } else if (ev.type === 'content_block_stop') {
            const idx = ev.index;
            const slot = partialBlocks.get(idx);
            broadcastSession(session, {
              type: 'partial_stop',
              blockIndex: idx,
              finalText: slot?.text || '',
            });
            // v0.51 X-03 fix: block 结束后释放 Map entry，避免长 turn 多 block 累积内存
            partialBlocks.delete(idx);
          }
          continue; // stream_event 不进后面的"完整 assistant message"处理
        }

        // ===== AgentStateMachine =====
        const transition = sm.ingest(obj);
        if (transition) {
          session.runState = transition.to;
          broadcastSession(session, { type: 'state_change', state: transition.to, from: transition.from, reason: transition.reason });
        }

        // ===== CostTracker（result 时 claude 给 usage）=====
        if (obj.type === 'result' && obj.usage) {
          const model = session.model || obj.modelUsage && Object.keys(obj.modelUsage)[0] || 'claude-opus-4-7';
          if (obj.modelUsage) {
            // 新版 claude --output-format stream-json result 给 modelUsage 分模型统计
            for (const [m, u] of Object.entries(obj.modelUsage)) {
              const usd = estimateUsdFromUsage(u, m);
              tracker.record(usd, (u.input_tokens || 0) + (u.output_tokens || 0), m);
            }
          } else {
            const usd = estimateUsdFromUsage(obj.usage, model);
            tracker.record(usd, (obj.usage.input_tokens || 0) + (obj.usage.output_tokens || 0), model);
          }
          // LoopGuard 成本激增检查
          const surgeBreak = guard.recordCost(tracker.windowUSD(5 * 60 * 1000));
          if (surgeBreak) {
            recordLoopGuard(session, surgeBreak);
            broadcastSession(session, { type: 'loop_guard_break', reason: surgeBreak });
            try { child.kill('SIGTERM'); } catch {}
            return;
          }
          broadcastSession(session, { type: 'cost_update', snapshot: tracker.snapshot() });
        }

        if (obj.type === 'assistant' && obj.message?.content) {
          // 记录 model
          if (obj.message.model && !obj.message.model.startsWith('<')) {
            session.model = obj.message.model;
          }
          const content = obj.message.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === 'text' && c.text) {
                const m = { role: 'assistant', content: c.text, ts: new Date().toISOString() };
                pushMessage(session, m);
                broadcastSession(session, { type: 'message', message: m });
                debouncedSave();
              } else if (c.type === 'tool_use') {
                // ===== DangerousPatternDetector 扫描 Bash =====
                if (c.name === 'Bash' && c.input?.command) {
                  const hits = sharedDetector.scan(c.input.command);
                  if (hits.length > 0) {
                    const worst = sharedDetector.worstSeverity(hits);
                    if (sharedDetector.shouldBlock(hits, session.guardLevel || 'standard')) {
                      // CRITICAL/HIGH：立刻 kill + 警告
                      try { child.kill('SIGTERM'); } catch {}
                      const dangerEntry = {
                        blocked: true,
                        severity: worst,
                        command: c.input.command.slice(0, 500),
                        hits: hits.map(h => ({ severity: h.rule.severity, category: h.rule.category, advice: h.rule.advice, snippet: h.snippet })),
                      };
                      recordDanger(session, dangerEntry);
                      broadcastSession(session, { type: 'danger_blocked', ...dangerEntry });
                      const dmsg = {
                        role: 'tool_use',
                        content: `🛑 危险命令被拦截（${worst}）：${c.input.command.slice(0, 200)}\n` +
                                 hits.map(h => `  • [${h.rule.severity}] ${h.rule.category}: ${h.rule.advice}`).join('\n'),
                        ts: new Date().toISOString(),
                      };
                      pushMessage(session, dmsg);
                      broadcastSession(session, { type: 'message', message: dmsg });
                      debouncedSave();
                      session.busy = false;
                      return;
                    } else {
                      // LOW：只警告不拦
                      const warnEntry = {
                        blocked: false,
                        severity: worst,
                        command: c.input.command.slice(0, 500),
                        hits: hits.map(h => ({ severity: h.rule.severity, category: h.rule.category, advice: h.rule.advice })),
                      };
                      recordDanger(session, warnEntry);
                      broadcastSession(session, { type: 'danger_warn', ...warnEntry });
                    }
                  }
                }
                // v0.26 Edit/Write/MultiEdit → markdown diff fence
                let toolContent = `🔧 ${c.name}: ${JSON.stringify(c.input).substring(0, 300)}`;
                try {
                  if (c.name === 'Edit' && c.input?.old_string != null && c.input?.new_string != null) {
                    toolContent = formatEditDiff(c.input);
                  } else if (c.name === 'MultiEdit' && Array.isArray(c.input?.edits)) {
                    toolContent = formatMultiEditDiff(c.input);
                  } else if (c.name === 'Write' && c.input?.file_path) {
                    toolContent = formatWritePreview(c.input);
                  }
                } catch { /* fallback 用原 JSON 截断 */ }
                const m = {
                  role: 'tool_use',
                  content: toolContent,
                  ts: new Date().toISOString()
                };
                pushMessage(session, m);
                broadcastSession(session, { type: 'message', message: m });
                debouncedSave();
              }
            }
          }
        }
      } catch {}
    }
  });

  child.stderr.on('data', d => {
    broadcastSession(session, { type: 'stderr', data: d.toString() });
  });
  // v0.51 W-08 fix: stdout/stderr 流 error 事件防御（pipe break / OS 错误时整个 panel 不崩）
  child.stdout.on('error', (e) => { console.warn(`[session ${session.id}] stdout error:`, e.message); });
  child.stderr.on('error', (e) => { console.warn(`[session ${session.id}] stderr error:`, e.message); });

  child.on('exit', async (code) => {
    session.busy = false;
    session.child = null;
    if (primedThisTurn) session.handoffPrimed = true;
    // v0.38 P0-B: 若是用户中断（SIGINT/reset-busy），exit code 可能仍是 0，但不应触发 watcher 判定
    const wasInterrupted = !!session._lastInterrupted;
    session._lastInterrupted = false; // 一次性标记，立即清
    // v0.49 B-03 fix: 清 dropOutput 之前先发完 turn_end，再恢复后续输出（其实 child 已退也没后续）
    const wasDroppingOutput = !!session._dropOutput;
    session._dropOutput = false;
    // v0.49 B-03 fix: 中断时 exit handler 是唯一的 busy=false 广播源，避免前端早早解锁却还在收 message
    if (wasInterrupted || wasDroppingOutput) {
      broadcastSession(session, { type: 'busy', busy: false, exitCode: code, interrupted: true });
      broadcastSession(session, { type: 'turn_end', exitCode: code, interrupted: true });
    } else {
      broadcastSession(session, { type: 'busy', busy: false, exitCode: code });
    }
    // v0.34 Watcher: turn 结束（exit code=0）触发 dispatcher；v0.38 跳过被中断的 turn
    if (code === 0 && !wasInterrupted && watcherDispatcher && session.watcherEnabled) {
      try {
        const r = await watcherDispatcher.onResultEvent(session, { is_error: false });
        // 自动模式 + verdict.continue + 安全过 → 自动把 next_action.prompt 发回 claude
        if (r?.autoExecute && r.prompt) {
          // v0.45 P2-5: 1s 后 session 可能已被删，重查一次再发
          // v0.51 ZZ-07 fix: 1s 内可能被 archived，跳过避免对归档 session 强 spawn
          setTimeout(() => {
            const live = sessions.get(session.id);
            if (live && !live.archived) sendMessageToClaude(live, r.prompt);
          }, 1000);
        }
      } catch (e) {
        console.warn('watcher dispatch error:', e.message);
      }
    }
  });

  child.on('error', (e) => {
    session.busy = false;
    session.child = null;
    broadcastSession(session, { type: 'error', error: e.message });
  });

  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: payloadText }] }
  }) + '\n';
  // v0.51 T-35 fix: stdin EPIPE 防御（child 立即死 / binary 不存在时 write 会抛）
  child.stdin.on('error', (e) => {
    if (e.code === 'EPIPE') return;
    console.warn(`[session ${session.id}] stdin error:`, e.message);
  });
  try { child.stdin.write(payload); } catch (e) {
    if (e.code !== 'EPIPE') console.warn(`[session ${session.id}] stdin write:`, e.message);
  }
  try { child.stdin.end(); } catch {}

  return { ok: true };
}

// ============ v0.32 Watcher 监视者接口（多 LLM 监督 Claude 任务）============
// v0.40 改为多 provider 池：每个 session 自己选 watcherProviderId
let watcherConfig = loadWatcherConfig();
let watcherAdapter = null;          // v0.39 兼容：默认 provider 单例（旧 /api/watcher/test 用）
let watcherDispatcher = null;
const watcherAdapterPool = new Map(); // providerId → WatcherAdapter

function rebuildAdapter() {
  watcherAdapterPool.clear();
  watcherAdapter = null;
  if (!watcherConfig.enabled) return;

  // 始终注册 Claude / Codex / Ollama 三个 0 增量 provider（CLI/本地）
  watcherAdapterPool.set('claude', new ClaudeWatcherAdapter({ bin: CLAUDE_BIN }));
  watcherAdapterPool.set('codex',  new CodexWatcherAdapter());
  watcherAdapterPool.set('ollama', new OllamaAdapter({
    apiKey: 'ollama',
    model: watcherConfig.model || 'gemma3:4b',
    baseUrl: watcherConfig.baseUrl || undefined,
  }));
  // MiniMax 需要 apiKey，配了才注册
  if (watcherConfig.apiKey && watcherConfig.provider === 'minimax') {
    watcherAdapterPool.set('minimax', new MiniMaxAdapter({
      apiKey: watcherConfig.apiKey,
      model: watcherConfig.model || undefined,
      baseUrl: watcherConfig.baseUrl || undefined,
    }));
  }

  // 默认 provider 单例（chat-header 👁️ 测试连通用 + 未明确 per-session 选择时的回退）
  const defaultId = watcherConfig.provider || 'ollama';
  watcherAdapter = watcherAdapterPool.get(defaultId) || watcherAdapterPool.get('ollama') || null;

  // v0.52: watcher 配置变化后同步刷新房间 adapter 池（applyRoomAdaptersConfig 内部处理"room-adapters.json 优先 / watcher 回退" 逻辑）
  // 启动时第一次调用时 roomAdapterPool 还没声明（TDZ），用 try 兜底
  try {
    if (typeof roomAdapterPool !== 'undefined' && roomAdapterPool) {
      applyRoomAdaptersConfig(roomAdapterPool);
    }
  } catch {
    // TDZ 期跳过——buildRoomAdapters 启动时会自己处理
  }
}
function rebuildDispatcher() {
  if (!watcherAdapter && watcherAdapterPool.size === 0) { watcherDispatcher = null; return; }
  // v0.43 P1 #11: 复用实例（保持 sessionState 连续），不再 new 一个新的
  if (watcherDispatcher) {
    watcherDispatcher.setAdapter(watcherAdapter);
    watcherDispatcher.setAdapterPool(watcherAdapterPool);
    watcherDispatcher.setConfig(watcherConfig);
    return;
  }
  watcherDispatcher = new WatcherDispatcher({
    adapter: watcherAdapter,
    adapterPool: watcherAdapterPool,
    config: watcherConfig,
    broadcastFn: (session, msg) => broadcastSession(session, msg),
    dangerDetector: sharedDetector,
    persistSession: () => saveData(),
  });
}
rebuildAdapter();
rebuildDispatcher();

app.get('/api/watcher/config', (req, res) => {
  res.json({ ok: true, config: maskedConfig(watcherConfig) });
});

// v0.40 watcher providers 列表（per-session 选 watcher 用）
app.get('/api/watcher/providers', (req, res) => {
  const providers = [];
  const labels = {
    claude:  '🟣 Claude（spawn CLI，零增量）',
    codex:   '🟢 GPT (Codex)（spawn CLI，零增量）',
    ollama:  '🔵 Ollama 本地（零成本，私有）',
    minimax: '🟡 MiniMax API（按 token 计费）',
  };
  for (const id of watcherAdapterPool.keys()) {
    providers.push({ id, displayName: labels[id] || id });
  }
  res.json({ ok: true, providers, defaultId: watcherConfig.provider || 'ollama' });
});

app.put('/api/watcher/config', (req, res) => {
  const incoming = req.body || {};
  // 如果 apiKey 是脱敏后的（含 ...），保留原值不覆盖
  if (typeof incoming.apiKey === 'string' && incoming.apiKey.includes('...')) {
    delete incoming.apiKey;
  }
  // v0.51 T-19 fix: 字段白名单 + 类型/长度校验（防误填或注入异常字段）
  const ALLOWED_PROVIDERS = new Set(['minimax', 'gemini', 'openai', 'ollama', 'custom']);
  const clean = {};
  if (typeof incoming.enabled === 'boolean') clean.enabled = incoming.enabled;
  if (typeof incoming.autoMode === 'boolean') clean.autoMode = incoming.autoMode;
  if (typeof incoming.perSessionDefault === 'boolean') clean.perSessionDefault = incoming.perSessionDefault;
  if (typeof incoming.provider === 'string' && ALLOWED_PROVIDERS.has(incoming.provider)) clean.provider = incoming.provider;
  if (typeof incoming.apiKey === 'string') {
    if (incoming.apiKey.length > 2048) return res.status(400).json({ error: 'apiKey 过长（>2048）' });
    clean.apiKey = incoming.apiKey;
  }
  if (typeof incoming.model === 'string') {
    if (incoming.model.length > 200) return res.status(400).json({ error: 'model 过长' });
    clean.model = incoming.model;
  }
  if (typeof incoming.baseUrl === 'string') {
    if (incoming.baseUrl.length > 500) return res.status(400).json({ error: 'baseUrl 过长' });
    // baseUrl 必须 http(s)://，避免 file:// / javascript:// 等异常协议
    if (incoming.baseUrl && !/^https?:\/\//i.test(incoming.baseUrl)) {
      return res.status(400).json({ error: 'baseUrl 必须 http(s)://' });
    }
    clean.baseUrl = incoming.baseUrl;
  }
  // 嵌套对象浅 merge 字段
  if (incoming.rateLimit && typeof incoming.rateLimit === 'object') {
    clean.rateLimit = { ...watcherConfig.rateLimit };
    if (Number.isFinite(incoming.rateLimit.perSessionPerHour)) clean.rateLimit.perSessionPerHour = Math.max(0, Math.min(1000, incoming.rateLimit.perSessionPerHour | 0));
    if (Number.isFinite(incoming.rateLimit.globalPerHour)) clean.rateLimit.globalPerHour = Math.max(0, Math.min(10000, incoming.rateLimit.globalPerHour | 0));
  }
  if (incoming.triggers && typeof incoming.triggers === 'object') {
    clean.triggers = { ...watcherConfig.triggers };
    if (Number.isFinite(incoming.triggers.minIntervalSec)) clean.triggers.minIntervalSec = Math.max(0, Math.min(3600, incoming.triggers.minIntervalSec | 0));
    if (Number.isFinite(incoming.triggers.requireIdleSec)) clean.triggers.requireIdleSec = Math.max(0, Math.min(3600, incoming.triggers.requireIdleSec | 0));
    if (typeof incoming.triggers.onlyOnResultSuccess === 'boolean') clean.triggers.onlyOnResultSuccess = incoming.triggers.onlyOnResultSuccess;
  }
  if (incoming.safety && typeof incoming.safety === 'object') {
    clean.safety = { ...watcherConfig.safety };
    if (typeof incoming.safety.dangerScanNextAction === 'boolean') clean.safety.dangerScanNextAction = incoming.safety.dangerScanNextAction;
    if (typeof incoming.safety.blockOnDrift === 'boolean') clean.safety.blockOnDrift = incoming.safety.blockOnDrift;
    if (Number.isFinite(incoming.safety.maxAutoPromptsPerSession)) clean.safety.maxAutoPromptsPerSession = Math.max(0, Math.min(1000, incoming.safety.maxAutoPromptsPerSession | 0));
  }
  watcherConfig = { ...watcherConfig, ...clean };
  const r = saveWatcherConfig(watcherConfig);
  if (!r.ok) return send500(res, new Error(r.error));
  rebuildAdapter();
  rebuildDispatcher();
  res.json({ ok: true, config: maskedConfig(watcherConfig), adapterActive: !!watcherAdapter });
});

// 测试 adapter 连通性（dry-run）
app.post('/api/watcher/test', async (req, res) => {
  if (!watcherAdapter) return res.json({ ok: false, error: '监视者未启用或未配置 API key' });
  try {
    const verdict = await watcherAdapter.judge({
      id: 'test',
      name: '连通性测试',
      cwd: '/tmp',
      mainGoal: '测试 watcher 是否可达',
      messages: [
        { role: 'user', content: '请帮我写一个 hello world Python 脚本', ts: new Date().toISOString() },
        { role: 'assistant', content: '好的：\n```python\nprint("Hello, World!")\n```\n已完成。', ts: new Date().toISOString() },
      ],
      runState: 'completed',
    });
    res.json({ ok: true, verdict });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// v0.30 fix: 动态版本号端点（前端 brand-subtitle 显示用）
// v0.52: 优先级链 HANDOFF_NEW_CHAT.md → HANDOFF.md → package.json
app.get('/api/version', (req, res) => {
  let version = 'unknown';
  let appName = 'Xike Lab';
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
    version = pkg.version || version;
    appName = pkg.productName || pkg.name || appName;
  } catch {}
  // v0.52: 优先从 HANDOFF_NEW_CHAT.md 解析（每轮 Sprint 后维护的接力文档）
  for (const file of ['HANDOFF_NEW_CHAT.md', 'HANDOFF.md']) {
    try {
      const md = readFileSync(join(__dirname, file), 'utf-8');
      const m = md.match(/v(0\.\d+)\b/);
      if (m) { version = m[1]; break; }
    } catch {}
  }
  res.json({ ok: true, version, appName });
});

// 创建 session（I-01/B-01 修：加 cwd 路径合法性校验；v0.49 N-06: 字段长度限制；v0.51 R-13: 全局上限）
const MAX_NAME_LEN = 200;
const MAX_GOAL_LEN = 4000;
const MAX_CWD_LEN = 1024;
const MAX_SESSIONS = 500;          // 活跃 + 归档总上限
const MAX_ACTIVE_SESSIONS = 100;   // 活跃（未归档）上限
function checkSessionsCapacity(res) {
  if (sessions.size >= MAX_SESSIONS) {
    res.status(429).json({ error: `已达 session 总数上限（${MAX_SESSIONS}）。先归档或删除一些旧 session` });
    return false;
  }
  const activeCount = [...sessions.values()].filter(s => !s.archived).length;
  if (activeCount >= MAX_ACTIVE_SESSIONS) {
    res.status(429).json({ error: `已达活跃 session 上限（${MAX_ACTIVE_SESSIONS}）。先归档一些` });
    return false;
  }
  return true;
}
app.post('/api/sessions', (req, res) => {
  if (!checkSessionsCapacity(res)) return;
  const { name, cwd, mainGoal } = req.body || {};
  if (typeof name === 'string' && name.length > MAX_NAME_LEN) {
    return res.status(400).json({ error: `name 过长（>${MAX_NAME_LEN}）` });
  }
  if (typeof mainGoal === 'string' && mainGoal.length > MAX_GOAL_LEN) {
    return res.status(400).json({ error: `mainGoal 过长（>${MAX_GOAL_LEN}）` });
  }
  if (typeof cwd === 'string' && cwd.length > MAX_CWD_LEN) {
    return res.status(400).json({ error: `cwd 过长（>${MAX_CWD_LEN}）` });
  }
  let workingDir = cwd && cwd.trim() ? cwd.trim() : process.env.HOME;
  if (workingDir.startsWith('~')) workingDir = workingDir.replace(/^~/, process.env.HOME);

  // 必须是绝对路径
  if (!workingDir.startsWith('/')) {
    return res.status(400).json({ error: `cwd 必须是绝对路径或 ~ 开头：收到 "${workingDir}"` });
  }
  // 必须存在且是目录
  try {
    const st = statSync(workingDir);
    if (!st.isDirectory()) {
      return res.status(400).json({ error: `cwd 不是目录：${workingDir}` });
    }
  } catch {
    return res.status(400).json({ error: `cwd 不存在：${workingDir}` });
  }

  const id = randomUUID();
  const session = {
    id,
    name: name?.trim() || `Session ${sessions.size + 1}`,
    cwd: workingDir,
    claudeSessionId: null,
    createdAt: new Date().toISOString(),
    child: null,
    pid: null,
    busy: false,
    messages: [],
    clients: new Set(),
    usage: { inputTokens: 0, outputTokens: 0 },  // I-05
    // v0.5 思维镜融合
    mainGoal: (mainGoal && typeof mainGoal === 'string') ? mainGoal.trim() : null,
    runState: 'idle',
    guardLevel: 'standard',
    model: null,
  };
  sessions.set(id, session);
  debouncedSave();
  res.json({
    id, name: session.name, cwd: session.cwd,
    createdAt: session.createdAt, busy: false,
    messages: [], claudeSessionId: null,
    usage: session.usage,
  });
});

// 列 sessions（query: ?archived=1 只列归档；不传则只列活跃）
app.get('/api/sessions', (req, res) => {
  const wantArchived = req.query.archived === '1' || req.query.archived === 'true';
  const list = [...sessions.values()]
    .filter(s => !!s.archived === wantArchived)
    .map(s => ({
      id: s.id, name: s.name, cwd: s.cwd,
      pid: s.pid, createdAt: s.createdAt, busy: s.busy,
      msgCount: s.messages.length,
      claudeSessionId: s.claudeSessionId,
      archived: !!s.archived,
      archivedAt: s.archivedAt,
      chainDepth: s.chainDepth || 0,
      // v0.5
      mainGoal: s.mainGoal,
      runState: s.runState || 'idle',
      model: s.model,
      totalUSD: s.costTracker ? s.costTracker.totalUSD() : 0,
      watcherEnabled: !!s.watcherEnabled,
      // v0.51 R-14: 列表也返收藏数量，前端 state.sessions 缓存可同步 ★
      starredCount: Array.isArray(s.starredIndices) ? s.starredIndices.length : 0,
    }));
  res.json(list);
});

// PATCH session（目前支持 toggle archived）
app.patch('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (typeof req.body?.archived === 'boolean') {
    s.archived = req.body.archived;
    s.archivedAt = req.body.archived ? new Date().toISOString() : null;
    // v0.51 T-37 fix: 归档时停掉运行中的 child（资源不浪费 + UI 状态一致）
    if (req.body.archived && s.child && !s.child.killed) {
      try { s.child.kill('SIGTERM'); } catch {}
      s.child = null;
      s.busy = false;
      s.pid = null;
    }
  }
  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    if (req.body.name.length > MAX_NAME_LEN) return res.status(400).json({ error: `name 过长（>${MAX_NAME_LEN}）` });
    s.name = req.body.name.trim();
  }
  if (typeof req.body?.mainGoal === 'string') {
    if (req.body.mainGoal.length > MAX_GOAL_LEN) return res.status(400).json({ error: `mainGoal 过长（>${MAX_GOAL_LEN}）` });
    s.mainGoal = req.body.mainGoal.trim() || null;
  }
  if (typeof req.body?.guardLevel === 'string' && ['strict', 'standard', 'loose'].includes(req.body.guardLevel)) {
    s.guardLevel = req.body.guardLevel;
  }
  // v0.34 Watcher per-session toggle
  if (typeof req.body?.watcherEnabled === 'boolean') {
    s.watcherEnabled = req.body.watcherEnabled;
  }
  // v0.40 Watcher per-session provider 选择
  if (typeof req.body?.watcherProviderId === 'string') {
    // v0.51 Z-01 fix: 校验 providerId 在 pool 中或为空（清除）
    const pid = req.body.watcherProviderId.trim();
    if (pid && !watcherAdapterPool.has(pid)) {
      return res.status(400).json({ error: `watcherProviderId 不在 pool 中：${pid}` });
    }
    s.watcherProviderId = pid || null;
  }
  // v0.36 真测 P1 fix: PATCH 立即 save（不 debounce 避免 kill 时丢数据）
  saveData();
  res.json({ ok: true, archived: !!s.archived, name: s.name, mainGoal: s.mainGoal, guardLevel: s.guardLevel, watcherEnabled: !!s.watcherEnabled, watcherProviderId: s.watcherProviderId || null });
});

// 拿 session 详情（含历史）
app.get('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({
    id: s.id, name: s.name, cwd: s.cwd, pid: s.pid,
    createdAt: s.createdAt, busy: s.busy,
    messages: s.messages,
    claudeSessionId: s.claudeSessionId,
    // v0.31 真测 P2.3 fix: 加全字段返回
    mainGoal: s.mainGoal || null,
    runState: s.runState || 'idle',
    guardLevel: s.guardLevel || 'standard',
    model: s.model || null,
    totalUSD: s.costTracker ? s.costTracker.totalUSD() : 0,
    chainDepth: s.chainDepth || 0,
    parentSessionId: s.parentSessionId || null,
    archived: !!s.archived,
    archivedAt: s.archivedAt || null,
    handoffPrimed: !!s.handoffPrimed,
    watcherEnabled: !!s.watcherEnabled,
    watcherProviderId: s.watcherProviderId || null,
    watcherHistory: (s.watcherHistory || []).slice(-20),
    // v0.51 R-14 fix: 返回收藏索引，前端 appendMessage 才能正确显示 ★ 状态
    starredIndices: Array.isArray(s.starredIndices) ? s.starredIndices : [],
  });
});

// 发消息
// v0.49 N-16: 单条消息文本上限（防 spawn payload 失控）
const MAX_USER_MESSAGE_LEN = 2 * 1024 * 1024; // 2MB 文本，覆盖文件附入 + 长 prompt
app.post('/api/sessions/:id/messages', (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'empty text' });
  if (text.length > MAX_USER_MESSAGE_LEN) {
    return res.status(413).json({ error: `text 过长（>${MAX_USER_MESSAGE_LEN} 字符）` });
  }
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  // v0.51 T-46 fix: 归档 session 不允许发消息（避免 spawn child 浪费）
  if (s.archived) return res.status(409).json({ ok: false, error: 'archived', message: '会话已归档，先恢复（cmdk → 归档列表）再发消息' });
  const r = sendMessageToClaude(s, text.trim());
  // v0.31 真测 P2.2 fix: busy / loop_guard 不算 HTTP error，200 + ok=false 让前端能正常解析
  res.json(r);
});

// 关闭 session
app.delete('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.child) {
    try { s.child.kill('SIGTERM'); } catch {}
  }
  // v0.49 N-20 fix: 关掉所有连到这个 session 的 WS，清 watcher sessionState
  for (const ws of s.clients) {
    try { ws.close(); } catch {}
  }
  s.clients.clear();
  if (watcherDispatcher) {
    try { watcherDispatcher.resetSession(req.params.id); } catch {}
  }
  sessions.delete(req.params.id);
  debouncedSave();
  res.json({ ok: true });
});

// 列 cwd 下文件（文件浏览器用）— v0.49 B-02 fix: 路径沙箱
app.get('/api/files', (req, res) => {
  const reqPath = req.query.path || '~';
  const path = safeResolveFsPath(reqPath);
  if (!path) return res.status(403).json({ error: 'forbidden: 路径越权或敏感目录' });
  // v0.51 T-17 fix: 检查是否为目录，文件传入应 400 而非 500
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });
  } catch {
    return res.status(404).json({ error: 'not found' });
  }
  try {
    const items = readdirSync(path)
      .filter(n => !n.startsWith('.'))
      .map(name => {
        const full = join(path, name);
        try {
          const st = statSync(full);
          return { name, path: full, isDir: st.isDirectory(), size: st.size, mtime: st.mtime };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    res.json({ path, items });
  } catch (e) {
    send500(res, e);
  }
});

// 读文件预览 — v0.49 B-02/B-05 fix: 沙箱 + 真实前 1MB 截断
app.get('/api/file', (req, res) => {
  if (!req.query.path) return res.status(400).json({ error: 'no path' });
  const path = safeResolveFsPath(req.query.path);
  if (!path) return res.status(403).json({ error: 'forbidden: 路径越权或敏感目录' });
  try {
    const st = statSync(path);
    if (!st.isFile()) return res.status(400).json({ error: 'not a regular file' });
    // v0.51 ZZZ-01 fix: 先读前 4KB sniff binary（看 NUL byte），是 binary 则拒绝
    // 避免把 .png/.jpg/.pdf 当 utf-8 解码产生乱码 ufffd 替换字符
    const SNIFF_BYTES = Math.min(4096, st.size);
    if (SNIFF_BYTES > 0) {
      const sniffBuf = Buffer.alloc(SNIFF_BYTES);
      const fd0 = openSync(path, 'r');
      let sniffRead = 0;
      try { sniffRead = readSync(fd0, sniffBuf, 0, SNIFF_BYTES, 0); }
      finally { try { closeSync(fd0); } catch {} }
      for (let i = 0; i < sniffRead; i++) {
        if (sniffBuf[i] === 0) {
          return res.status(415).json({ error: 'binary file not supported (含 NUL byte)', size: st.size });
        }
      }
    }
    const MAX = 1024 * 1024;
    if (st.size > MAX) {
      const buf = Buffer.alloc(MAX);
      const fd = openSync(path, 'r');
      let bytesRead = 0;
      try { bytesRead = readSync(fd, buf, 0, MAX, 0); }
      finally { try { closeSync(fd); } catch {} }
      const content = buf.subarray(0, bytesRead).toString('utf-8');
      return res.json({ path, size: st.size, truncated: true, truncatedBytes: bytesRead, content });
    }
    const content = readFileSync(path, 'utf-8');
    res.json({ path, size: st.size, content });
  } catch (e) {
    send500(res, e);
  }
});

// v0.28 cost 时序（每分钟桶聚合）
// v0.81 真做：cost-series + safety-history 已迁到 src/server/routes/sessions-readonly.js
registerSessionsReadonlyRoutes(app, { sessions });
// B-005 v0.9：图片缓存代理
registerImgCacheRoutes(app);
// v1.0 Task 1.1：telemetry
registerTelemetryRoutes(app);
// v1.5 Task 3.1：license
registerLicenseRoutes(app);
// v1.5 Task 3.3：payment webhooks
registerPaymentWebhookRoutes(app);
// v2.0 Task 4.1：SQLite storage
registerStorageRoutes(app);
// v2.0 Task 4.2：embeddings / 向量索引
registerEmbeddingsRoutes(app);
// v2.0 Task 4.3：workspace 多空间
registerWorkspaceRoutes(app);
// v2.0 final：商品化准备状态
registerCommercialSetupRoutes(app);
// v2.0 final + 1: Keychain auto-fill
registerAutoFillRoutes(app);
// v2.0 final + 2: Lemon Squeezy API
registerLemonSqueezyRoutes(app);

// 中断 busy
// v0.47 阶段 3：Claude Code hook 事件接收端点（借鉴 disler/claude-code-hooks-multi-agent-observability）
// 12 种事件：PreToolUse / PostToolUse / Notification / UserPromptSubmit / SessionStart / SessionEnd
//          / Stop / SubagentStart / SubagentStop / PreCompact / PostCompact / SubagentResult
// 用户在 ~/.claude/settings.json 或项目级 .claude/settings.json 配 hooks 指向 POST /api/hooks/:event
// 详见 docs/HOOKS_USAGE.md
const VALID_HOOK_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'Notification', 'UserPromptSubmit',
  'SessionStart', 'SessionEnd', 'Stop', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'SubagentResult',
]);
const HOOK_MAX_PER_SESSION = 200;
const HOOK_MAX_GLOBAL = 2000;
const HOOK_MAX_PAYLOAD_BYTES = 50 * 1024; // v0.49 N-18: 单条 payload 上限 50KB（防 hooks 撑爆 data.json）
const globalHookEvents = []; // 跨 session 全局事件流（限长）

function trimHookPayload(body) {
  // 整体序列化估算大小；超限保留关键字段 + 截断标记
  let serialized;
  try { serialized = JSON.stringify(body); } catch { return { _error: 'circular' }; }
  if (serialized.length <= HOOK_MAX_PAYLOAD_BYTES) return body;
  // 超限：只保留 session_id / tool / cwd / event + 顶层基本字段，big 字段替换提示
  const keep = {};
  for (const k of Object.keys(body || {})) {
    const v = body[k];
    if (v == null || typeof v === 'boolean' || typeof v === 'number') { keep[k] = v; continue; }
    if (typeof v === 'string') {
      keep[k] = v.length > 2000 ? v.slice(0, 2000) + '…<截断>' : v;
      continue;
    }
    try {
      const s = JSON.stringify(v);
      keep[k] = s.length > 4000 ? `<对象已截断 ${s.length}B>` : v;
    } catch { keep[k] = '<不可序列化>'; }
  }
  keep._truncated = true;
  keep._originalBytes = serialized.length;
  return keep;
}

app.post('/api/hooks/:event', (req, res) => {
  const event = req.params.event;
  if (!VALID_HOOK_EVENTS.has(event)) return res.status(400).json({ error: 'unknown hook event: ' + event });
  const body = req.body || {};
  const sessionId = body.session_id || body.sessionId || null;
  // v0.51 T-22 fix: record 顶层字段长度封顶
  const record = {
    at: new Date().toISOString(),
    event,
    sessionId: typeof sessionId === 'string' ? safeSlice(sessionId, 100) : null,
    tool: typeof (body.tool_name || body.tool) === 'string' ? safeSlice(body.tool_name || body.tool, 200) : null,
    cwd: typeof body.cwd === 'string' ? safeSlice(body.cwd, 1024) : null,
    payload: trimHookPayload(body), // v0.49 N-18: 大 payload 截断
  };
  // session 级
  if (sessionId) {
    const s = sessions.get(sessionId);
    if (s) {
      if (!Array.isArray(s.hookEvents)) s.hookEvents = [];
      s.hookEvents.push(record);
      if (s.hookEvents.length > HOOK_MAX_PER_SESSION) {
        s.hookEvents = s.hookEvents.slice(-HOOK_MAX_PER_SESSION);
      }
      broadcastSession(s, { type: 'hook_event', record });
    }
  }
  // 全局环形
  globalHookEvents.push(record);
  if (globalHookEvents.length > HOOK_MAX_GLOBAL) globalHookEvents.shift();
  res.json({ ok: true });
});

// 暴露 docs/*.md 给前端展示（仅 GET 只读，文件名白名单）
const DOC_WHITELIST = new Set(['CCR_USAGE.md', 'HOOKS_USAGE.md']);
app.get('/api/docs/:name', (req, res) => {
  const name = req.params.name;
  if (!DOC_WHITELIST.has(name)) return res.status(404).json({ error: 'doc not found' });
  try {
    const content = readFileSync(join(__dirname, 'docs', name), 'utf-8');
    res.type('text/markdown').send(content);
  } catch (e) {
    // v0.51 T-32 fix: 不泄露 fs 错误细节
    console.error('[docs read]', e?.message || e);
    res.status(404).json({ error: 'doc not available' });
  }
});

// 列最近 hook 事件（全局或按 session 过滤）
app.get('/api/hooks', (req, res) => {
  const sid = req.query.sessionId;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  let events = globalHookEvents;
  if (sid) {
    const s = sessions.get(sid);
    events = s?.hookEvents || [];
  }
  res.json({ ok: true, count: events.length, events: events.slice(-limit) });
});

app.post('/api/sessions/:id/interrupt', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  // v0.38 P0-B: 标记此次退出是用户中断，exit handler 应跳过 watcher 判定
  s._lastInterrupted = true;
  // v0.51 A-02 fix: 中断后清 autoPromptCount，让用户重新触发 watcher autoMode 不被旧计数阻塞
  try { watcherDispatcher?.clearAutoPromptCount?.(req.params.id); } catch {}
  // v0.49 B-03 fix: 丢弃残余 stdout 消息，避免 child 退出前继续广播 assistant
  s._dropOutput = true;
  if (!s.child || s.child.killed) {
    // child 已经死了，直接清状态并广播
    s.busy = false;
    s._dropOutput = false;
    broadcastSession(s, { type: 'busy', busy: false });
    return res.json({ ok: true, alreadyDead: true });
  }
  try { s.child.kill('SIGINT'); } catch {}
  // 1s 内不退就 SIGTERM 兜底
  setTimeout(() => {
    if (s.child && !s.child.killed) {
      try { s.child.kill('SIGTERM'); } catch {}
    }
  }, 1000);
  // 立即广播 busy=false 让前端解锁 UI；stdout 残余 message 由 _dropOutput 拦截不会再推送
  s.busy = false;
  broadcastSession(s, { type: 'busy', busy: false, interrupted: true });
  res.json({ ok: true });
});

// v0.20 强制释放卡住的 busy 状态（child 已死但 busy 没复位的兜底）
app.post('/api/sessions/:id/reset-busy', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const wasChildAlive = s.child && !s.child.killed;
  // v0.38 P0-B: 强制释放也算用户干预，exit handler 跳 watcher
  s._lastInterrupted = true;
  // v0.51 A-02 fix: 同 interrupt — 清 autoPromptCount
  try { watcherDispatcher?.clearAutoPromptCount?.(req.params.id); } catch {}
  // v0.51 S-26 fix: 一并清 _dropOutput，避免下次发消息前 stdout 被错误 drop
  s._dropOutput = false;
  if (s.child) {
    try { s.child.kill('SIGKILL'); } catch {}
    s.child = null;
  }
  s.busy = false;
  s.pid = null;
  broadcastSession(s, { type: 'busy', busy: false, forced: true });
  res.json({ ok: true, hadChild: wasChildAlive });
});

// ============ v0.39 聊天室：多 AI debate 共识 ============
const roomStore = new ChatRoomStore();
const roomWsClients = new Map(); // roomId → Set<ws>

function broadcastRoom(roomId, msg) {
  // v0.45 P1-4: 整个函数套 try/catch，防 JSON.stringify 循环引用导致 dispatcher batch reject
  try {
    const set = roomWsClients.get(roomId);
    if (set) {
      const payload = JSON.stringify({ roomId, ts: Date.now(), ...msg });
      for (const ws of set) {
        if (ws.readyState === ws.OPEN) {
          try { ws.send(payload); } catch {}
        }
      }
    }
  } catch (e) {
    console.warn('broadcastRoom failed:', e?.message);
  }
  // v0.54 Sprint 4：webhook 触发（fire-and-forget，不阻塞 broadcast）
  try {
    const room = roomStore.get(roomId);
    fireWebhooks(roomId, msg, room).catch(() => {});
  } catch {}
  // v0.54 Sprint 4.5：自动归档（房 *_done 时按配置写盘）
  try {
    const cfg = archiveStore.getConfig();
    if (cfg.autoArchive && cfg.events.includes(msg.type)) {
      const room = roomStore.get(roomId);
      if (room) {
        // 异步执行（不阻塞 broadcast；ArchiveStore 同步写盘但量小）
        setImmediate(() => {
          try {
            const r = archiveStore.archiveRoom(room);
            if (!r.ok) console.warn('[archive] auto failed:', r.error);
          } catch (e) { console.warn('[archive] auto exc:', e.message); }
        });
      }
    }
  } catch {}
  // v0.56 Sprint 15-R4：Autopilot hook（仅当 enabled 且有匹配规则才动）
  try { autopilotController.onRoomEvent(roomId, msg); } catch {}
}

// v0.53 Sprint 3：panel 级 WS 通道（metrics / health / 全局事件）
const globalWsClients = new Set();
function broadcastGlobal(msg) {
  try {
    const payload = JSON.stringify({ ts: Date.now(), ...msg });
    for (const ws of globalWsClients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(payload); } catch {}
      }
    }
  } catch (e) {
    console.warn('broadcastGlobal failed:', e?.message);
  }
}
metricsStore.attachBroadcast(broadcastGlobal);
breakers.attachBroadcast(broadcastGlobal);

// v0.56 Sprint 15-R4：Autopilot Controller（依赖 forwardRoom = self-call POST /api/rooms/forward）
const autopilotController = new AutopilotController({
  roomStore,
  forwardRoom: async ({ sourceRoomId, targetMode, autoStart, name, autopilotHops, claimedBy }) => {
    const PORT_LOCAL = process.env.PORT || 51735;
    const resp = await fetch(`http://127.0.0.1:${PORT_LOCAL}/api/rooms/forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceRoomId, targetMode, autoStart, name }),
    });
    const r = await resp.json();
    if (!resp.ok || !r.ok || !r.newRoomId) throw new Error(r.error || `HTTP ${resp.status}`);
    // 标记 autopilot 链路 + claim
    try { roomStore.update(r.newRoomId, { autopilotHops, claimedBy }); } catch {}
    return { newRoomId: r.newRoomId };
  },
  broadcastGlobal,
});
setInterval(() => { try { autopilotController._gc(); } catch {} }, 60_000);

// v0.47 阶段 2：检测 ccr (claude-code-router) 是否在 PATH（不强制依赖）
import { spawnSync as _spawnSyncCheck } from 'node:child_process';
function detectCCR() {
  try {
    const r = _spawnSyncCheck('which', ['ccr'], { encoding: 'utf-8' });
    return r.status === 0 && (r.stdout || '').trim().length > 0;
  } catch { return false; }
}
const HAS_CCR = detectCCR();
if (HAS_CCR) console.log('✅ 检测到 claude-code-router (ccr)，已加入 adapter 池');

// v0.52 房间 adapter 独立配置（minimax / gemini / 自定义）
let roomAdaptersConfig = loadRoomAdaptersConfig();
// 启动期探测 gemini CLI 是否可用（避免每次 spawn 都 which 一次）
const HAS_GEMINI_CLI = isGeminiCliAvailable();

// 内置 adapter 池（按 id 拿）
function buildRoomAdapters() {
  const map = new Map();
  // v0.52 内置 adapter 接受 spawn_overrides.timeoutMs（0=用 adapter 默认 2h）
  const ov = roomAdaptersConfig?.spawn_overrides || {};
  const tm = (v) => (Number.isFinite(v) && v > 0) ? v : undefined;
  map.set('claude', new ClaudeSpawnAdapter({ bin: CLAUDE_BIN, timeout: tm(ov.claudeTimeoutMs) }));
  map.set('codex', new CodexSpawnAdapter({ timeout: tm(ov.codexTimeoutMs) }));
  map.set('ollama', new OllamaChatAdapter({ id: 'ollama', displayName: '🔵 Ollama' }));
  // v0.47 CCR 可选：仅当 `which ccr` 命中才注册
  if (HAS_CCR) {
    map.set('ccr', new CCRSpawnAdapter({ timeout: tm(ov.ccrTimeoutMs) }));
  }
  applyRoomAdaptersConfig(map);
  return map;
}

/**
 * v0.52 按 room-adapters.json 注册 minimax / gemini / gemini-openai / gemini-cli / custom:*
 * 每个 adapter 支持 timeoutMs 覆盖（0=用 adapter 默认；>0 覆盖）
 * 同时兼容老配置：若 minimax 在 room-adapters.json 未启用但 watcher 配了 minimax key，仍回退注册
 */
function applyRoomAdaptersConfig(map) {
  // 先清理可变的 id（保留 4 个内置）
  for (const id of [...map.keys()]) {
    if (id === 'claude' || id === 'codex' || id === 'ollama' || id === 'ccr') continue;
    map.delete(id);
  }

  const tm = (v) => (Number.isFinite(v) && v > 0) ? v : undefined;
  // v0.52 maxTokens：用户填 0 时不传给 adapter，让 adapter 用自己默认；填正数则覆盖
  const mt = (v) => (Number.isFinite(v) && v >= 0) ? v : undefined;

  // MiniMax：优先用 room-adapters.json，回退 watcher
  const mm = roomAdaptersConfig.minimax;
  if (mm?.enabled && mm.apiKey) {
    map.set('minimax', new MiniMaxChatAdapter({
      apiKey: mm.apiKey,
      model: mm.model || undefined,
      baseUrl: mm.baseUrl || undefined,
      timeout: tm(mm.timeoutMs),
      maxTokens: mt(mm.maxTokens),
    }));
  } else if (watcherConfig?.apiKey && watcherConfig.provider === 'minimax') {
    map.set('minimax', new MiniMaxChatAdapter({
      apiKey: watcherConfig.apiKey,
      model: watcherConfig.model || undefined,
      baseUrl: watcherConfig.baseUrl,
    }));
  }

  // Gemini 原生 API
  const g = roomAdaptersConfig.gemini;
  if (g?.enabled && g.apiKey) {
    map.set('gemini', new GeminiChatAdapter({
      apiKey: g.apiKey,
      model: g.model || undefined,
      baseUrl: g.baseUrl || undefined,
      timeout: tm(g.timeoutMs),
      maxTokens: mt(g.maxTokens),
    }));
  }

  // Gemini OpenAI 兼容
  const go = roomAdaptersConfig.gemini_openai;
  if (go?.enabled && go.apiKey && go.baseUrl) {
    map.set('gemini-openai', new OpenAICompatChatAdapter({
      id: 'gemini-openai',
      displayName: '🔷 Gemini (OpenAI 兼容)',
      apiKey: go.apiKey,
      baseUrl: go.baseUrl,
      model: go.model || undefined,
      timeout: tm(go.timeoutMs),
      maxTokens: mt(go.maxTokens),
    }));
  }

  // Gemini CLI（仅 which gemini 命中且配置 enabled 才注册）
  const gc = roomAdaptersConfig.gemini_cli;
  if (gc?.enabled && HAS_GEMINI_CLI) {
    map.set('gemini-cli', new GeminiSpawnAdapter({ model: gc.model || undefined, timeout: tm(gc.timeoutMs) }));
  }

  // 自定义 OpenAI 兼容条目（id 形如 custom:xxx）
  for (const c of (roomAdaptersConfig.customs || [])) {
    if (!c || c.enabled === false) continue;
    if (!c.id || !c.baseUrl || !c.apiKey || !c.model) continue;
    const fullId = `custom:${c.id}`;
    map.set(fullId, new OpenAICompatChatAdapter({
      id: fullId,
      displayName: c.displayName || `🧩 ${c.id}`,
      apiKey: c.apiKey,
      baseUrl: c.baseUrl,
      model: c.model,
      timeout: tm(c.timeoutMs),
      maxTokens: mt(c.maxTokens),
    }));
  }
}

const roomAdapterPool = buildRoomAdapters();

/** v0.52 PUT /api/room-adapters 后原地重建 adapter 池（dispatcher 持有的 Map 引用不变） */
function rebuildRoomAdapters() {
  applyRoomAdaptersConfig(roomAdapterPool);
}
const debateDispatcher = new DebateDispatcher({
  store: roomStore,
  adapters: roomAdapterPool,
  broadcast: broadcastRoom,
});
const squadDispatcher = new CollaborationDispatcher({
  store: roomStore,
  adapters: roomAdapterPool,
  broadcast: broadcastRoom,
});
const arenaDispatcher = new ArenaDispatcher({
  store: roomStore,
  adapters: roomAdapterPool,
  broadcast: broadcastRoom,
});
const soloChatDispatcher = new SoloChatDispatcher({
  store: roomStore,
  adapters: roomAdapterPool,
  broadcast: broadcastRoom,
});

// ============ v0.53 Sprint 3 — Metrics API ============
// 通用解析 from/to/bucket，避免重复
function parseMetricsRange(req) {
  const { from, to, bucket } = req.query || {};
  const result = {};
  if (typeof from === 'string' && from.length > 0 && from.length < 64) {
    const d = new Date(from);
    if (!isNaN(d)) result.from = d.toISOString();
  }
  if (typeof to === 'string' && to.length > 0 && to.length < 64) {
    const d = new Date(to);
    if (!isNaN(d)) result.to = d.toISOString();
  }
  if (bucket === 'hour' || bucket === 'day') result.bucket = bucket;
  return result;
}

app.get('/api/metrics/overview', (req, res) => {
  try {
    const ov = metricsStore.overview({ roomStore });
    res.json({ ok: true, ...ov });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/metrics/timeseries', (req, res) => {
  try {
    const { from, to, bucket = 'hour' } = parseMetricsRange(req);
    res.json({ ok: true, ...metricsStore.aggregate({ from, to, bucket }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/metrics/by-adapter', (req, res) => {
  try {
    const { from, to } = parseMetricsRange(req);
    res.json({ ok: true, ...metricsStore.byAdapter({ from, to }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v0.55 Sprint 13-D：trace 时间线 — 拿某房的所有 turn
app.get('/api/metrics/by-room', (req, res) => {
  try {
    const roomId = String(req.query.roomId || '');
    if (!/^[0-9a-f-]{36}$/.test(roomId)) return res.status(400).json({ ok: false, error: 'roomId 格式错' });
    const { from, to } = parseMetricsRange(req);
    res.json({ ok: true, ...metricsStore.byRoom({ roomId, from, to }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/metrics/health', (req, res) => {
  try {
    const PANEL_DIR = join(homedir(), '.claude-panel');
    const fileSizeMB = (name) => {
      try { return Math.round((statSync(join(PANEL_DIR, name)).size / 1024 / 1024) * 100) / 100; }
      catch { return 0; }
    };
    let metricsMB = 0;
    try {
      const files = readdirSync(PANEL_DIR).filter((f) => /^metrics-\d{4}-\d{2}\.jsonl/.test(f));
      for (const f of files) metricsMB += statSync(join(PANEL_DIR, f)).size;
      metricsMB = Math.round((metricsMB / 1024 / 1024) * 100) / 100;
    } catch {}
    const mem = process.memoryUsage();
    const rssMB = Math.round((mem.rss / 1024 / 1024) * 100) / 100;
    const heapMB = Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100;
    // 收集所有 dispatcher 在跑的 spawn 子进程数（间接：活跃 abort 数）
    const activeRooms =
      (debateDispatcher.activeAborts?.size || 0) +
      (squadDispatcher.activeAborts?.size || 0) +
      (arenaDispatcher.activeAborts?.size || 0) +
      (soloChatDispatcher.activeAborts?.size || 0);
    const warnings = [];
    if (rssMB > 1024) warnings.push(`panel 内存占用偏高：${rssMB} MB`);
    if (fileSizeMB('data.json') > 200) warnings.push(`data.json > 200MB`);
    if (fileSizeMB('rooms.json') > 100) warnings.push(`rooms.json > 100MB`);
    if (metricsMB > 500) warnings.push(`metrics 文件总量 > 500MB`);
    res.json({
      ok: true,
      panel: { rssMB, heapMB, uptimeS: Math.round(process.uptime()), pid: process.pid },
      activeRooms,
      files: {
        dataJsonMB: fileSizeMB('data.json'),
        roomsJsonMB: fileSizeMB('rooms.json'),
        watcherJsonMB: fileSizeMB('watcher.json'),
        promptsJsonMB: fileSizeMB('prompts.json'),
        roomAdaptersJsonMB: fileSizeMB('room-adapters.json'),
        metricsMB,
      },
      warnings,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/metrics/pricing', (req, res) => {
  try {
    res.json({ ok: true, pricing: listPricing(), note: '估算可能与实际账单 ±20% 偏差' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v0.54 Sprint 4.5 — 归档配置 / 手动归档 / 列归档
// S18-2b：4 个 routes 提取到 src/server/routes/archive.js
registerArchiveRoutes(app, { archiveStore, safeResolveFsPath, roomStore });

// v0.55 Sprint 12 — MCP（Model Context Protocol）服务器配置 + 客户端管理
// S18-2c：6 个 routes + McpClientManager 实例化提取到 src/server/routes/mcp.js
const { mcpClientManager } = registerMcpRoutes(app, { mcpStore });

// v0.54 Sprint 9 + v0.55 Sprint 14 F1：改异步 job（修 Load failed —— Safari fetch >60s 超时报"Load failed"）
// body: { adapterId?, model?, outputPath?, autoPath?: boolean }
// 立即返 { ok, jobId, status:'queued' }，后台跑 generateReport，完成 broadcastGlobal report_done / report_error
app.post('/api/rooms/:id/report', (req, res) => {
  const r = roomStore.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'room not found' });
  const { adapterId = 'claude', model = '', outputPath: rawPath, autoPath } = req.body || {};
  const adapter = roomAdapterPool.get(adapterId);
  if (!adapter) return res.status(400).json({ error: `adapter ${adapterId} 未注册或未启用` });

  // outputPath：优先 body.outputPath；其次 autoPath=true 时用 archive rootPath 自动生成；否则不写盘
  let outputPath = null;
  if (typeof rawPath === 'string' && rawPath.trim()) {
    if (rawPath.length > 1024) return res.status(400).json({ error: 'outputPath 过长' });
    const safe = safeResolveFsPath(rawPath.trim());
    if (!safe) return res.status(403).json({ error: 'outputPath 越权或敏感目录' });
    outputPath = safe;
  } else if (autoPath === true) {
    const archiveCfg = archiveStore.getConfig();
    outputPath = defaultReportPath(r, archiveCfg.rootPath);
  }

  // 立返 jobId（202 Accepted），后台跑
  const jobId = 'rpt-' + randomUUID().slice(0, 12);
  res.status(202).json({ ok: true, jobId, status: 'queued' });

  // fire-and-forget
  (async () => {
    const startedAt = Date.now();
    try {
      const result = await generateReport({ room: r, adapter, model, outputPath });
      if (!result.ok) {
        broadcastGlobal({
          type: 'report_error',
          jobId,
          roomId: r.id,
          error: result.error,
          elapsedMs: result.elapsedMs || (Date.now() - startedAt),
        });
        return;
      }
      try {
        metricsStore.record({
          roomId: r.id, roomMode: 'report', roomName: r.name,
          turn: 'report:' + r.mode,
          adapter: adapter.id || adapterId, model: model || '',
          latencyMs: result.elapsedMs,
          tokensIn: result.tokensIn, tokensOut: result.tokensOut,
          success: true, errorKind: null,
        });
      } catch {}
      broadcastGlobal({
        type: 'report_done',
        jobId,
        roomId: r.id,
        content: result.content,
        path: result.path,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        elapsedMs: result.elapsedMs,
        truncated: result.truncated,
        assertionFailed: result.assertionFailed || [],   // v0.70.2-t2
      });
    } catch (e) {
      broadcastGlobal({
        type: 'report_error',
        jobId,
        roomId: r.id,
        error: e.message || String(e),
        elapsedMs: Date.now() - startedAt,
      });
    }
  })();
});

// v0.53 Sprint 3.5：清理老 metrics 文件
// query: olderThan=YYYY-MM（删该月份及之前的所有 metrics-*.jsonl）
app.delete('/api/metrics', (req, res) => {
  try {
    const cutoff = String(req.query.olderThan || '').trim();
    if (!/^\d{4}-\d{2}$/.test(cutoff)) {
      return res.status(400).json({ ok: false, error: 'olderThan 必须是 YYYY-MM 格式' });
    }
    const PANEL_DIR = join(homedir(), '.claude-panel');
    const deleted = [];
    try {
      const files = readdirSync(PANEL_DIR).filter((f) => /^metrics-\d{4}-\d{2}\.jsonl/.test(f));
      for (const f of files) {
        const m = f.match(/^metrics-(\d{4}-\d{2})\.jsonl/);
        if (m && m[1] <= cutoff) {
          try { unlinkSync(join(PANEL_DIR, f)); deleted.push(f); } catch {}
        }
      }
    } catch {}
    // 内存 cache 跨月时已自动清，这里防御性再清一次：当前月份小于等于 cutoff 才清
    const curMonth = new Date().toISOString().slice(0, 7);
    if (curMonth <= cutoff) metricsStore.clearCache();
    res.json({ ok: true, deleted, count: deleted.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v0.54 Sprint 4 — Webhooks API
// S18-2a：5 个 routes 提取到 src/server/routes/webhook.js
registerWebhookRoutes(app, { webhookStore, maskWebhookUrl, testWebhook });

// v0.53 Sprint 3 阶段 4：房间模板（builtin + user）
// S18-2e1：3 个 routes 提取（rooms 子集；主 rooms CRUD 因依赖过多继续留 server.js）
registerRoomTemplatesRoutes(app, { roomTemplatesStore });

// v0.53 Sprint 3 阶段 3：进程列表（pgrep -P → ps）+ PTY 终端 + 活跃 dispatcher 数
app.get('/api/health/processes', (req, res) => {
  try {
    const myPid = process.pid;
    let psRows = [];
    try {
      const r = _spawnSyncCheck('pgrep', ['-P', String(myPid)], { encoding: 'utf-8' });
      const childPids = (r.stdout || '').trim().split('\n').filter(Boolean);
      if (childPids.length > 0) {
        const ps = _spawnSyncCheck('ps', ['-p', childPids.join(','), '-o', 'pid=,rss=,etime=,command='], { encoding: 'utf-8' });
        const lines = (ps.stdout || '').trim().split('\n').filter(Boolean);
        psRows = lines.map((l) => {
          const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
          if (!m) return null;
          return {
            pid: parseInt(m[1], 10),
            rssMB: Math.round((parseInt(m[2], 10) / 1024) * 10) / 10,
            etime: m[3],
            command: (m[4] || '').slice(0, 200),
          };
        }).filter(Boolean);
      }
    } catch {
      // pgrep/ps 在某些环境不可用，silent fallback
    }
    const terms = [];
    for (const [id, t] of terminals) {
      terms.push({
        id,
        cwd: t.cwd,
        pid: t.term?.pid || null,
        clients: t.clients.size,
        shell: t.shell,
        createdAt: t.createdAt,
      });
    }
    res.json({
      ok: true,
      panelPid: myPid,
      activeDispatchers: {
        debate: debateDispatcher.activeAborts?.size || 0,
        squad: squadDispatcher.activeAborts?.size || 0,
        arena: arenaDispatcher.activeAborts?.size || 0,
        soloChat: soloChatDispatcher.activeAborts?.size || 0,
      },
      children: psRows,
      terminals: terms,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v0.52 房间 adapter 池配置（minimax / gemini / gemini-openai / gemini-cli / customs[]）
app.get('/api/room-adapters', (req, res) => {
  res.json({
    ok: true,
    config: maskRoomAdaptersConfig(roomAdaptersConfig),
    geminiCliAvailable: HAS_GEMINI_CLI,
  });
});

app.put('/api/room-adapters', async (req, res) => {
  const r = cleanRoomAdaptersConfig(req.body || {}, roomAdaptersConfig);
  if (!r.ok) return res.status(422).json({ error: r.error });
  // v1.5 Task 3.2 — Free tier adapter limit 3
  try {
    const lm = await import('./src/license/LicenseManager.js');
    if (!lm.hasFeature('adapters-unlimited')) {
      const enabledCount = Object.values(r.config || {}).filter(c => c && c.apiKey && c.apiKey.trim()).length;
      if (enabledCount > 3) {
        return res.status(402).json({
          error: `Free 层最多 3 个 adapter（当前 ${enabledCount}）`,
          tier: lm.getCurrentTier(),
          feature: 'adapters-unlimited',
          upgradeUrl: 'https://panel.app/pricing',
        });
      }
    }
  } catch {}
  const save = saveRoomAdaptersConfig(r.config);
  if (!save.ok) return send500(res, new Error(save.error));
  roomAdaptersConfig = r.config;
  rebuildRoomAdapters();
  res.json({
    ok: true,
    config: maskRoomAdaptersConfig(roomAdaptersConfig),
    geminiCliAvailable: HAS_GEMINI_CLI,
    activeProviders: [...roomAdapterPool.keys()],
  });
});

// 列出当前可在房成员里选的 adapter id + displayName（前端下拉用）
app.get('/api/room-adapters/providers', (req, res) => {
  const providers = [];
  for (const [id, adapter] of roomAdapterPool.entries()) {
    providers.push({ id, displayName: adapter.displayName || id });
  }
  res.json({ ok: true, providers });
});

// v0.52 W1：plugin registry（通用 CLI Wrapper 雏形，独立于 roomAdapterPool）
const pluginRegistry = new PluginRegistry();
{
  const loaded = pluginRegistry.load();
  console.log(`[PluginRegistry] 已加载 ${loaded.length} 个 plugin（${loaded.filter(p => p.valid).length} 可用）`);
  for (const p of loaded) {
    const tag = p.valid ? '✓' : '✗';
    console.log(`  ${tag} [${p.source}] ${p.id} → ${p.displayName}${p.error ? ' (' + p.error + ')' : ''}`);
  }
}

// GET /api/plugins — 列已加载 plugin manifest（摘要）
app.get('/api/plugins', (req, res) => {
  res.json({ ok: true, plugins: pluginRegistry.list() });
});

// GET /api/plugins/:id — 返完整 manifest JSON（含 bin/input/output/events/dashboard）
app.get('/api/plugins/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id)) return res.status(400).json({ error: 'plugin id 非法' });
  const entry = pluginRegistry.get(id);
  if (!entry) return res.status(404).json({ error: 'plugin 不存在' });
  res.json({
    ok: true,
    id: entry.manifest.id,
    source: entry.source,
    valid: entry.valid,
    error: entry.error,
    resolvedBin: entry.resolvedBin,
    manifest: entry.manifest,
  });
});

// POST /api/plugins/install — 装一份用户 manifest（body 直接是 manifest 对象）
app.post('/api/plugins/install', (req, res) => {
  const manifest = req.body;
  if (!manifest || typeof manifest !== 'object') return res.status(400).json({ error: 'manifest 必须是 JSON 对象' });
  // 大小上限
  try { if (JSON.stringify(manifest).length > 32 * 1024) return res.status(413).json({ error: 'manifest 过大（>32KB）' }); } catch {}
  const r = pluginRegistry.install(manifest);
  if (!r.ok) return res.status(422).json({ error: r.error });
  res.json({ ok: true, entry: { id: manifest.id, displayName: manifest.displayName, valid: r.entry?.valid, error: r.entry?.error } });
});

// DELETE /api/plugins/:id — 卸载用户 plugin（内置禁删）
app.delete('/api/plugins/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id)) return res.status(400).json({ error: 'plugin id 非法' });
  const r = pluginRegistry.uninstall(id);
  if (!r.ok) return res.status(r.error?.includes('内置') ? 403 : 404).json({ error: r.error });
  res.json({ ok: true });
});

// POST /api/plugins/reload — 重扫两个目录
app.post('/api/plugins/reload', (req, res) => {
  const loaded = pluginRegistry.reload();
  res.json({ ok: true, plugins: pluginRegistry.list(), count: loaded.length });
});

// POST /api/plugins/:id/exec — 跑一个 command
// body: { commandId, params, prompt, model, cwd, abortAfterMs? }
app.post('/api/plugins/:id/exec', async (req, res) => {
  const id = req.params.id;
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id)) return res.status(400).json({ error: 'plugin id 非法' });
  const entry = pluginRegistry.get(id);
  if (!entry) return res.status(404).json({ error: 'plugin 不存在' });
  if (!entry.valid) return res.status(424).json({ error: 'plugin 不可用: ' + (entry.error || 'bin 探测失败') });

  const { commandId, params = {}, prompt = '', model, cwd } = req.body || {};
  if (!commandId || typeof commandId !== 'string') return res.status(400).json({ error: 'commandId required' });
  // prompt 长度限制（防 10MB 撑爆）
  if (typeof prompt !== 'string' || prompt.length > 64 * 1024) return res.status(413).json({ error: 'prompt 过长（>64KB）或类型错' });
  // cwd 沙箱
  let safeCwd = undefined;
  if (typeof cwd === 'string' && cwd.trim()) {
    if (cwd.length > 1024) return res.status(400).json({ error: 'cwd 过长' });
    const safe = safeResolveFsPath(cwd.trim());
    if (!safe) return res.status(403).json({ error: 'cwd 越权或敏感目录' });
    safeCwd = safe;
  }

  // v0.53 Sprint 3.5：plugin exec 也 record metrics
  // v0.54 Sprint 4：按 manifest.type 分派 Spawn / Http adapter
  const startedAt = Date.now();
  try {
    const adapter = entry.manifest.type === 'http'
      ? new PluginHttpAdapter(entry)
      : new PluginSpawnAdapter(entry);
    const result = await adapter.execCommand(commandId, params, {
      prompt, model, cwd: safeCwd,
    });
    try {
      metricsStore.record({
        roomId: '', roomMode: 'plugin', roomName: entry.manifest.displayName || id,
        turn: `plugin:${id}.${commandId}`,
        adapter: id, model: model || '',
        latencyMs: Date.now() - startedAt,
        tokensIn: result.tokensIn || 0, tokensOut: result.tokensOut || 0,
        success: true, errorKind: null,
      });
    } catch {}
    res.json({ ok: true, reply: result.reply, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
  } catch (e) {
    try {
      metricsStore.record({
        roomId: '', roomMode: 'plugin', roomName: entry.manifest.displayName || id,
        turn: `plugin:${id}.${commandId}`,
        adapter: id, model: model || '',
        latencyMs: Date.now() - startedAt,
        tokensIn: 0, tokensOut: 0,
        success: false, errorKind: e?.name || 'error',
      });
    } catch {}
    res.status(500).json({ error: e.message || String(e) });
  }
});

// S18-2e2：rooms 5 个主 CRUD (list/create/get/delete/patch) 提取到 src/server/routes/rooms.js
const MAX_ROOMS = 500;   // v0.51 S-04 / v0.52 200→500（保留在 server.js 用作 const 注入到 rooms.js）
registerRoomsRoutes(app, {
  roomStore, safeResolveFsPath, safeSlice, roomAdapterPool,
  debateDispatcher, squadDispatcher, arenaDispatcher, soloChatDispatcher,
  roomWsClients, MAX_ROOMS,
});


// 启动 debate / squad（按 room.mode 调对应 dispatcher）
app.post('/api/rooms/:id/debate', async (req, res) => {
  const r = roomStore.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const topic = (req.body || {}).topic;
  if (!topic || typeof topic !== 'string') return res.status(400).json({ error: 'topic required' });
  // v0.51 S-11 fix: topic 长度上限（防 10MB topic 撑爆 prompt）
  // S17-extra: 上限提到 1MB（用户附件场景），dispatcher 内部仍会 cap 给单个 adapter 的 context window
  if (topic.length > 1048576) return res.status(413).json({ error: 'topic 过长（>1MB 字符）' });
  // v0.52 debate 模式接 debateRounds（body > room.debateRounds > 默认；dispatcher 内部会再 clip）
  const startOptions = {};
  if (req.body?.debateRounds !== undefined) {
    const n = Number(req.body.debateRounds);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 10) {
      return res.status(422).json({ error: 'debateRounds 必须是 1-10 的整数' });
    }
    startOptions.debateRounds = n;
  }
  res.json({ ok: true, started: true, mode: r.mode || 'debate' });
  const dispatcher = (r.mode === 'squad') ? squadDispatcher
                   : (r.mode === 'arena') ? arenaDispatcher
                   : debateDispatcher;
  dispatcher.start(req.params.id, topic, startOptions).catch(e => {
    console.warn(`${r.mode || 'debate'} failed:`, e.message);
    // v0.51 Z-03 fix: 不静默吞错，broadcast 给前端显示具体原因（之前用户看到"没人回复"是因为这里只 console.warn）
    try {
      broadcastRoom(req.params.id, {
        type: r.mode === 'squad' ? 'squad_error' : r.mode === 'arena' ? 'arena_error' : 'debate_error',
        error: e.message || 'unknown dispatcher error',
      });
      roomStore.setStatus(req.params.id, 'error');
    } catch {}
  });
});

// v0.42 用户中途注入提示给某个 task（squad 模式专用）
const INJECT_MAX_LEN = 32000;      // v0.52 极限 32000：长 prompt 也能塞
const INJECT_MAX_COUNT = 50;       // v0.52 20→50
app.post('/api/rooms/:id/tasks/:tid/inject', (req, res) => {
  const r = roomStore.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'room not found' });
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'content required' });
  if (content.length > INJECT_MAX_LEN) return res.status(413).json({ error: `content too long (max ${INJECT_MAX_LEN})` });
  const t = (r.taskList || []).find(x => x.id === req.params.tid);
  if (!t) return res.status(404).json({ error: 'task not found' });
  if (!Array.isArray(t.userInjections)) t.userInjections = [];
  if (t.userInjections.length >= INJECT_MAX_COUNT) return res.status(429).json({ error: `too many injections (max ${INJECT_MAX_COUNT})` });
  const inj = { at: new Date().toISOString(), content };
  t.userInjections.push(inj);
  roomStore.save();
  broadcastRoom(r.id, { type: 'task_injection_added', taskId: t.id, injection: inj });
  res.json({ ok: true, injection: inj });
});

// v0.70 W8 集成：squad task 多次 attempt 之间的 diff（学自 aider/Cline）
// GET /api/rooms/:id/tasks/:tid/diff?from=N&to=M  → unified diff + added/removed 行数
app.get('/api/rooms/:id/tasks/:tid/diff', async (req, res) => {
  try {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'room not found' });
    const t = (r.taskList || []).find(x => x.id === req.params.tid);
    if (!t) return res.status(404).json({ error: 'task not found' });
    const attempts = t.attempts || [];
    if (attempts.length < 2) return res.json({ ok: true, diff: null, reason: 'need ≥2 attempts' });
    const from = parseInt(req.query.from, 10);
    const to = parseInt(req.query.to, 10);
    const a = Number.isFinite(from) ? attempts[from] : attempts[attempts.length - 2];
    const b = Number.isFinite(to) ? attempts[to] : attempts[attempts.length - 1];
    if (!a || !b) return res.status(400).json({ error: 'invalid from/to' });
    const { diffAttempts } = await import('./src/room/learned/squad-diff-preview.js');
    const d = diffAttempts(a, b);
    res.json({ ok: true, diff: d, fromIdx: attempts.indexOf(a), toIdx: attempts.indexOf(b) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// v0.52 Sprint1-F：把当前房的 finalConsensus 作为 topic 转给新房
app.post('/api/rooms/forward', async (req, res) => {
  if (roomStore.list().length >= MAX_ROOMS) {
    return res.status(429).json({ error: `已达房间总数上限（${MAX_ROOMS}）。先删/归档一些旧房` });
  }
  const { sourceRoomId, targetMode, autoStart, name, seedScope } = req.body || {};
  if (!sourceRoomId) return res.status(400).json({ error: 'sourceRoomId required' });
  const src = roomStore.get(sourceRoomId);
  if (!src) return res.status(404).json({ error: 'source room not found' });
  const finalContent = src.finalConsensus;
  if (!finalContent) return res.status(400).json({ error: '源房尚无最终输出（finalConsensus 空）' });
  if (finalContent.length > 1048576) return res.status(413).json({ error: '源房输出过长（>1MB），无法 forward' });

  // v0.56 U10：seedScope='all' 时把完整 transcript 拼到 topic，让 squad/debate/arena 新房也能看到原讨论过程
  // chat 模式走自己的 conversation seed 路径（line 2556 处），不需要在这里拼 topic
  let topicContent = finalContent;
  if (seedScope === 'all' && targetMode !== 'chat') {
    const CAP = 950000;  // 95万字符 cap，给 finalConsensus 余 5万空间
    const parts = [];
    let used = 0;
    const push = (s) => {
      if (used >= CAP || !s) return;
      const t = String(s);
      if (used + t.length > CAP) { parts.push(t.slice(0, CAP - used)); used = CAP; }
      else { parts.push(t); used += t.length; }
    };
    if (src.topic) push(`## 📝 源房原始 topic\n${src.topic}\n\n`);
    if (Array.isArray(src.rounds) && src.rounds.length > 0) {
      push(`## 🗨 各轮发言（${src.rounds.length} 轮）\n\n`);
      for (const r of src.rounds) {
        push(`### ${r.kind}\n`);
        for (const t of (r.turns || [])) {
          push(`#### ${t.error ? '❌ ' : ''}${t.displayName || t.speaker}\n${t.content || ''}\n\n`);
          if (used >= CAP) break;
        }
        if (used >= CAP) break;
      }
    }
    if (Array.isArray(src.conversation) && src.conversation.length > 0) {
      push(`## 💬 对话历史（${src.conversation.length} 条）\n`);
      for (const c of src.conversation) {
        if (c.thinking) continue;
        const who = c.from === 'user' ? '【用户】' : `【${c.displayName || c.from}】`;
        push(`### ${who}\n${c.content || ''}\n\n`);
        if (used >= CAP) break;
      }
    }
    if (Array.isArray(src.taskList) && src.taskList.length > 0) {
      push(`## 📋 squad 任务清单（${src.taskList.length}）\n`);
      for (const t of src.taskList) {
        push(`### ${t.id} ${t.title || ''}（status=${t.status}）\n`);
        if (t.desc) push(`描述：${(t.desc || '').replace(/\n/g, ' ')}\n`);
        const lastGood = [...(t.attempts || [])].reverse().find((a) => !a.error);
        if (lastGood) push(`**Dev 最终交付**：\n${lastGood.content || ''}\n\n`);
        if (used >= CAP) break;
      }
    }
    const transcript = parts.join('');
    topicContent = `${transcript}${used >= CAP ? '\n\n…（transcript 已截断到 950KB）' : ''}\n\n---\n\n## 🎯 最终结论 / 共识\n\n${finalContent}`;
    if (topicContent.length > 1048576) {
      topicContent = topicContent.slice(0, 1048000) + '\n\n…（topic 已截断到 1MB 上限）';
    }

    // v0.70 W3 集成：token 估算 + 警告（学自 LibreChat historyTrimmer）
    // 不强行截断（用户选 'all' 是知情决定），仅记录估算 token 数到 broadcastGlobal warning
    try {
      const { estimateTokens, DEFAULT_MAX_CONTEXT } = await import('./src/room/historyTrimmer.js');
      const estTokens = estimateTokens(topicContent);
      // 取目标房任一成员最小 maxContext 作上限（保守）
      const memberMax = (defaultMembers || []).reduce((min, m) => {
        const cap = DEFAULT_MAX_CONTEXT[m.adapterId] || 100000;
        return Math.min(min, cap);
      }, Infinity);
      if (Number.isFinite(memberMax) && estTokens > memberMax * 0.7) {
        console.warn(`[forward] topicContent ~${estTokens} tokens > ${memberMax * 0.7} (70% of min member context). 可能爆 context。`);
      }
    } catch {}
  }

  // 防御：复用源房 cwd 时校一遍沙箱（万一沙箱白名单后来收紧）
  let forwardCwd = src.cwd;
  if (forwardCwd) {
    const safe = safeResolveFsPath(forwardCwd);
    if (!safe) forwardCwd = homedir();
    else forwardCwd = safe;
  } else {
    forwardCwd = homedir();
  }

  const allowedTargets = new Set(['debate', 'squad', 'arena', 'chat']);
  const tm = allowedTargets.has(targetMode) ? targetMode : 'squad';

  // 复用现有 createRoom 路径：构造一个内部 POST /api/rooms 风格的调用
  const safeName = (typeof name === 'string' && name.trim()) ? safeSlice(name.trim(), 200) : `（来自 ${src.name || '未命名'}）${tm}`;
  let defaultMembers;
  if (tm === 'squad') {
    defaultMembers = [
      { adapterId: 'claude', displayName: '🟣 Claude · PM',  role: 'pm',  enabled: true },
      { adapterId: 'claude', displayName: '🟣 Claude · Dev', role: 'dev', enabled: true },
      { adapterId: 'codex',  displayName: '🟢 GPT · Dev',     role: 'dev', enabled: true },
      { adapterId: 'codex',  displayName: '🟢 GPT · QA',      role: 'qa',  enabled: true },
    ];
  } else if (tm === 'arena') {
    defaultMembers = [
      { adapterId: 'claude', displayName: '🟣 Claude（含 Judge）', role: 'judge', enabled: true },
      { adapterId: 'codex',  displayName: '🟢 GPT', enabled: true },
      { adapterId: 'gemini-cli', displayName: '🔷 Gemini CLI', enabled: roomAdapterPool.has('gemini-cli') },
      { adapterId: 'minimax', displayName: '🟡 MiniMax', enabled: roomAdapterPool.has('minimax') },
    ].filter(m => roomAdapterPool.has(m.adapterId));
  } else if (tm === 'chat') {
    const partner = 'claude';
    defaultMembers = [{ adapterId: partner, displayName: '🟣 Claude', enabled: true }];
  } else { // debate
    defaultMembers = [
      { adapterId: 'claude', displayName: '🟣 Claude', enabled: true },
      { adapterId: 'codex',  displayName: '🟢 GPT',     enabled: true },
      { adapterId: 'ollama', displayName: '🔵 Ollama', enabled: true },
    ];
  }
  const newRoom = roomStore.create({ name: safeName, cwd: forwardCwd, members: defaultMembers, mode: tm });
  // 记录链路
  const updatePatch = {
    topic: topicContent,
    parentRoomId: sourceRoomId,
  };
  // v0.54 Sprint 5.5 + Sprint 11：forward 到 chat 房时 seed 完整对话历史 + 最终结论
  // 之前 bug：只 seed finalConsensus 一条 → AI 看不到原房 R1/R2/R3 的详细讨论
  // 现在：把整个 rounds[].turns / conversation / taskList 拍平 → 跟 finalConsensus 一起 seed
  if (tm === 'chat') {
    const TRANSCRIPT_CAP = 60000;     // 完整 transcript cap 60KB
    const FINAL_CAP = 20000;          // finalConsensus 单独 cap 20KB
    const modeLabel = ({ debate: '辩论', squad: '小组', arena: '对决', chat: '闲聊' })[src.mode] || src.mode;

    // 拍平源房完整聊天记录
    let transcriptParts = [];
    let used = 0;
    const push = (s) => {
      if (used >= TRANSCRIPT_CAP || !s) return;
      const trimmed = String(s);
      if (used + trimmed.length > TRANSCRIPT_CAP) {
        transcriptParts.push(trimmed.slice(0, TRANSCRIPT_CAP - used));
        used = TRANSCRIPT_CAP;
      } else {
        transcriptParts.push(trimmed);
        used += trimmed.length;
      }
    };
    if (src.topic) push(`## 原始任务 / topic\n${src.topic}\n\n`);
    if (src.mode === 'chat' && Array.isArray(src.conversation)) {
      push(`## 完整对话（${src.conversation.length} 条）\n`);
      for (const c of src.conversation) {
        if (c.thinking) continue;
        const who = c.from === 'user' ? '【用户】' : `【${c.displayName || c.from}】`;
        push(`### ${who}\n${c.content || ''}\n\n`);
        if (used >= TRANSCRIPT_CAP) break;
      }
    }
    if (Array.isArray(src.rounds) && src.rounds.length > 0) {
      push(`## 各轮发言（${src.rounds.length} 轮）\n`);
      for (const r of src.rounds) {
        push(`### ${r.kind}\n`);
        for (const t of (r.turns || [])) {
          const tag = t.error ? '❌ ' : '';
          push(`#### ${tag}${t.displayName || t.speaker}\n${t.content || ''}\n\n`);
          if (used >= TRANSCRIPT_CAP) break;
        }
        if (used >= TRANSCRIPT_CAP) break;
      }
    }
    if (Array.isArray(src.taskList) && src.taskList.length > 0) {
      push(`## squad 任务清单（${src.taskList.length} 个）\n`);
      for (const t of src.taskList) {
        push(`### ${t.id} ${t.title || ''}（status=${t.status}）\n`);
        if (t.desc) push(`描述：${(t.desc || '').replace(/\n/g, ' ')}\n`);
        const lastGood = [...(t.attempts || [])].reverse().find((a) => !a.error);
        if (lastGood) push(`**Dev 最终交付**：\n${lastGood.content || ''}\n\n`);
        if (used >= TRANSCRIPT_CAP) break;
      }
    }
    const transcript = transcriptParts.join('');
    const transcriptTruncated = used >= TRANSCRIPT_CAP;
    const finalCapped = finalContent.length > FINAL_CAP
      ? finalContent.slice(0, FINAL_CAP) + `\n\n…（最终结论已截断，原 ${finalContent.length} 字符）`
      : finalContent;

    // 把 transcript + finalConsensus 拼成一条 assistant 消息（AI 读到自己"刚说完这些"）
    const seedAssistant = `# 📌 源房《${src.name || '未命名'}》(${modeLabel}房) 完整记录

${transcript}${transcriptTruncated ? '\n\n…（完整 transcript 已截断到 60KB，剩余内容请参考源房）' : ''}

---

# 🎯 最终结论 / 共识

${finalCapped}`;

    const now = new Date().toISOString();
    updatePatch.conversation = [
      {
        at: now,
        from: 'user',
        content: `我刚在「${src.name || '未命名'}」（${modeLabel}房）跑完一轮完整讨论，下面是**完整聊天历史 + 最终结论**。请基于这些全部上下文和我继续讨论后续问题（不只是结论，过程中的细节也算数）。`,
      },
      {
        at: now,
        from: 'forward-context',     // 非 'user' → flatten 时算 assistant 角色
        displayName: `📌 源房《${src.name || '未命名'}》完整历史 + 结论`,
        content: seedAssistant,
        fromForward: true,
        sourceRoomId,
        sourceMode: src.mode,
        transcriptLen: transcript.length,
        transcriptTruncated,
      },
    ];
  }
  roomStore.update(newRoom.id, updatePatch);

  // 自动启动（chat 房没有自启动概念）
  let started = false;
  if (autoStart === true && tm !== 'chat') {
    const dispatcher = tm === 'squad' ? squadDispatcher
                     : tm === 'arena' ? arenaDispatcher
                     : debateDispatcher;
    dispatcher.start(newRoom.id, topicContent).catch(e => {
      console.warn(`forward auto-start ${tm} failed:`, e.message);
      try {
        broadcastRoom(newRoom.id, {
          type: tm === 'squad' ? 'squad_error' : tm === 'arena' ? 'arena_error' : 'debate_error',
          error: e.message || 'forward auto-start failed',
        });
        roomStore.setStatus(newRoom.id, 'error');
      } catch {}
    });
    started = true;
  }
  res.json({ ok: true, newRoomId: newRoom.id, started });
});

// v0.52 Sprint1-D：局部重试单个 turn（仅辩论房）
app.post('/api/rooms/:id/retry-turn', async (req, res) => {
  const r = roomStore.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'room not found' });
  if (r.mode !== 'debate' && r.mode !== 'arena') {
    return res.status(400).json({ error: `${r.mode} 房暂不支持局部重试` });
  }
  const { kind, speaker } = req.body || {};
  if (!kind || !speaker) return res.status(400).json({ error: 'kind + speaker required' });
  if (!/^(r[123])_(propose|critique|final)(?:@\d+)?$|^proposals$|^arena_judge$/.test(kind)) {
    return res.status(400).json({ error: 'kind 格式不合法' });
  }
  if (!/^[a-z][a-z0-9:_-]{0,79}$/i.test(speaker)) {
    return res.status(400).json({ error: 'speaker 格式不合法' });
  }
  try {
    const dispatcher = r.mode === 'arena' ? arenaDispatcher : debateDispatcher;
    if (typeof dispatcher.retryTurn !== 'function') {
      return res.status(501).json({ error: `${r.mode} 房 dispatcher 暂未实现 retryTurn` });
    }
    const result = await dispatcher.retryTurn(req.params.id, kind, speaker);
    res.json({ ok: true, turn: result.turn });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// v0.54 Sprint 6：squad 房单 task 重试（reset 该 task + 连带下游 + 触发 resume）
app.post('/api/rooms/:id/retry-task', (req, res) => {
  const r = roomStore.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'room not found' });
  if (r.mode !== 'squad') return res.status(400).json({ error: `${r.mode} 房不支持单 task 重试（squad 专用）` });
  if (r.status === 'running') return res.status(409).json({ error: '房间正在运行中，请先 ⏹ 暂停再重试 task' });
  const { taskId } = req.body || {};
  if (!taskId || typeof taskId !== 'string') return res.status(400).json({ error: 'taskId required' });
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(taskId)) return res.status(400).json({ error: 'taskId 格式不合法' });
  // 先返 ok，dispatcher 在后台跑（retryTask 内部 await this.start，是长任务）
  res.json({ ok: true });
  squadDispatcher.retryTask(req.params.id, taskId).catch((e) => {
    console.warn('squad retryTask failed:', e.message);
    try {
      broadcastRoom(req.params.id, { type: 'task_retry_error', taskId, error: e.message });
    } catch {}
  });
});

// v0.52 续跑：从未完成阶段继续（保留已有 R1/R2/R3 / taskList 产出）
// 支持 debate / squad
app.post('/api/rooms/:id/resume', async (req, res) => {
  const r = roomStore.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'room not found' });
  if (r.status === 'running') return res.status(409).json({ error: '房间已在运行中' });
  const mode = r.mode || 'debate';
  if (mode === 'chat' || mode === 'arena') {
    return res.status(400).json({ error: `${mode} 房暂不支持续跑（chat 房用重发上一条；arena 房用 🔄 重启）` });
  }
  res.json({ ok: true, resumed: true });
  const dispatcher = mode === 'squad' ? squadDispatcher : debateDispatcher;
  dispatcher.resume(req.params.id).catch(e => {
    console.warn(`${mode} resume failed:`, e.message);
    try {
      broadcastRoom(req.params.id, {
        type: mode === 'squad' ? 'squad_error' : 'debate_error',
        error: e.message || 'resume failed',
      });
      roomStore.setStatus(req.params.id, 'error');
    } catch {}
  });
});

// 中断（三个 dispatcher 都尝试）
app.post('/api/rooms/:id/abort', (req, res) => {
  // v0.51 U-16 fix: room 不存在时返 404，避免 silent ok:true 误导
  const r = roomStore.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'room not found' });
  const ok1 = debateDispatcher.abort(req.params.id);
  const ok2 = squadDispatcher.abort(req.params.id);
  const ok3 = soloChatDispatcher.abort(req.params.id);
  const ok4 = arenaDispatcher.abort(req.params.id);
  res.json({ ok: true, aborted: ok1 || ok2 || ok3 || ok4 });
});

// v0.48 chat 模式：用户发一条消息触发一次 AI 回应
app.post('/api/rooms/:id/chat', async (req, res) => {
  const r = roomStore.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'room not found' });
  if (r.mode !== 'chat') return res.status(400).json({ error: 'room mode != chat' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 64000) return res.status(413).json({ error: '文本过长（>64000 字符）' });   // v0.52 极限 6 万字
  // v0.51 T-39 fix: 检查 dispatcher 是否正在处理上一条（前端可禁按钮，但兜底返 409）
  if (soloChatDispatcher.activeAborts?.has(req.params.id)) {
    return res.status(409).json({ error: '上一条消息还在处理中，先等回复或 abort' });
  }
  // 异步执行，HTTP 先返
  res.json({ ok: true, started: true });
  soloChatDispatcher.sendMessage(req.params.id, text).catch(e => {
    console.warn('chat sendMessage failed:', e.message);
  });
});

// ============ 方案 B 项目监控：扫 ~/Desktop/00_项目/ 下有 PROGRESS.md 的项目 ============

const PROJECTS_ROOT = join(homedir(), 'Desktop', '00_项目');

function detectStatusColor(statusContent) {
  if (!statusContent) return 'unknown';
  // STATUS.md 顶部一般有 ## 🟢 绿 / 🟡 黄 / 🔴 红 段头
  const m = statusContent.match(/##\s*(🟢|🟡|🔴)/);
  if (!m) return 'unknown';
  return { '🟢': 'green', '🟡': 'yellow', '🔴': 'red' }[m[1]];
}

function detectAscState(text) {
  if (!text) return null;
  const states = ['READY_FOR_SALE', 'IN_REVIEW', 'WAITING_FOR_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'REJECTED', 'METADATA_REJECTED', 'PREPARE_FOR_SUBMISSION'];
  for (const st of states) {
    if (text.includes(st)) return st;
  }
  return null;
}

function countCycles(progressContent) {
  if (!progressContent) return 0;
  // 找形如 cycle_42 / cycle_42, / cycle_42（…
  const matches = progressContent.match(/cycle_(\d+)/g);
  if (!matches || matches.length === 0) return 0;
  let maxN = 0;
  for (const m of matches) {
    const n = parseInt(m.replace('cycle_', ''), 10);
    if (n > maxN) maxN = n;
  }
  return maxN;
}

function countActiveBlocked(blockedContent) {
  if (!blockedContent) return 0;
  // 找 ### [Task #...] 头，且后面没有 ✅ 或 ~~ 表示已解除
  const lines = blockedContent.split('\n');
  let count = 0;
  for (const line of lines) {
    if (line.match(/^###\s*\[Task\s*#/)) {
      // 同行没 ✅、没 ~~
      if (!line.includes('✅') && !line.includes('~~')) count++;
    }
  }
  return count;
}

function scanProject(projDir) {
  const result = {
    name: projDir.split('/').pop(),
    path: projDir,
    hasProgress: false,
  };
  try {
    const st = statSync(projDir);
    if (!st.isDirectory()) return null;
  } catch { return null; }

  const progressPath = join(projDir, 'PROGRESS.md');
  if (!existsSync(progressPath)) return null;
  result.hasProgress = true;

  try {
    const progress = readFileSync(progressPath, 'utf-8');
    result.cycles = countCycles(progress);
  } catch {}

  const statusPath = join(projDir, 'STATUS.md');
  if (existsSync(statusPath)) {
    try {
      const status = readFileSync(statusPath, 'utf-8');
      result.statusColor = detectStatusColor(status);
      result.ascState = detectAscState(status);
      // 抓 STATUS.md 第一段第一行作 headline
      const headline = status.split('\n').find(l => l.trim() && !l.startsWith('#'));
      if (headline) result.headline = headline.replace(/^>?\s*/, '').slice(0, 120);
    } catch {}
  }

  const blockedPath = join(projDir, 'BLOCKED.md');
  if (existsSync(blockedPath)) {
    try {
      result.activeBlocked = countActiveBlocked(readFileSync(blockedPath, 'utf-8'));
    } catch {}
  }

  // 是否在跑（RUNNING_LOCK）
  result.running = existsSync(join(projDir, '.RUNNING_LOCK'));
  // 锁心跳新鲜度
  if (result.running) {
    const hb = join(projDir, '.RUNNING_LOCK', '.heartbeat');
    if (existsSync(hb)) {
      try {
        const last = parseInt(readFileSync(hb, 'utf-8').trim(), 10);
        const age = Math.floor(Date.now() / 1000) - last;
        result.lockAgeSec = age;
        result.lockStale = age > 6000; // 100min
      } catch {}
    }
  }

  // launchd plist 检测
  try {
    const lagents = join(homedir(), 'Library', 'LaunchAgents');
    if (existsSync(lagents)) {
      const plists = readdirSync(lagents).filter(f => f.endsWith('.plist'));
      const nameKey = result.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      result.launchdPlist = plists.find(p => p.toLowerCase().replace(/[^a-z0-9]/g, '').includes(nameKey.slice(0, 8))) || null;
    }
  } catch {}

  // 最近 commit
  try {
    const head = readFileSync(join(projDir, '.git', 'HEAD'), 'utf-8').trim();
    let refPath;
    if (head.startsWith('ref: ')) {
      refPath = join(projDir, '.git', head.slice(5).trim());
    }
    if (refPath && existsSync(refPath)) {
      const st2 = statSync(refPath);
      result.lastCommitAt = st2.mtime;
    }
  } catch {}

  return result;
}

// 端点：列所有方案 B 项目
app.get('/api/projects', (req, res) => {
  if (!existsSync(PROJECTS_ROOT)) return res.json({ ok: false, reason: 'no-projects-root', root: PROJECTS_ROOT, items: [] });
  try {
    const dirs = readdirSync(PROJECTS_ROOT)
      .filter(n => !n.startsWith('.'))
      .map(n => join(PROJECTS_ROOT, n));
    const items = dirs.map(scanProject).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ ok: true, root: PROJECTS_ROOT, items });
  } catch (e) {
    send500(res, e);
  }
});

// 端点：单项目详情（含 STATUS/BLOCKED/最近 PROGRESS）
// v0.49 N-19 fix: name 严格校验，禁 path traversal
app.get('/api/projects/:name', (req, res) => {
  const name = req.params.name;
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.length > 200) {
    return res.status(400).json({ error: 'invalid project name' });
  }
  const projDir = join(PROJECTS_ROOT, name);
  // 二次防御：解析后必须仍在 PROJECTS_ROOT 下
  let real;
  try { real = realpathSync(projDir); } catch { return res.status(404).json({ error: 'project not found' }); }
  let rootReal;
  try { rootReal = realpathSync(PROJECTS_ROOT); } catch { rootReal = PROJECTS_ROOT; }
  if (real !== rootReal && !real.startsWith(rootReal + '/')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const base = scanProject(projDir);
  if (!base) return res.status(404).json({ error: 'project not found or no PROGRESS.md' });
  const sections = {};
  for (const [key, fname] of [['status', 'STATUS.md'], ['blocked', 'BLOCKED.md'], ['plan', 'PLAN.md'], ['errorLog', 'ERROR_LOG.md']]) {
    const p = join(projDir, fname);
    if (existsSync(p)) {
      try {
        const txt = readFileSync(p, 'utf-8');
        sections[key] = txt.length > 30000 ? txt.slice(0, 30000) + '\n\n...(truncated)' : txt;
      } catch {}
    }
  }
  // PROGRESS.md 只取最后 60 行
  const prog = join(projDir, 'PROGRESS.md');
  if (existsSync(prog)) {
    try {
      const lines = readFileSync(prog, 'utf-8').split('\n');
      sections.progressTail = lines.slice(-60).join('\n');
    } catch {}
  }
  res.json({ ok: true, ...base, sections });
});

// ============ ctx 估算：从 claude transcript 反推当前上下文占用率 ============

// 找到 session 对应的 transcript jsonl（session_id.jsonl 在 ~/.claude/projects/<flat>/）
function findTranscript(sessionId) {
  if (!sessionId) return null;
  const projectsRoot = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsRoot)) return null;
  try {
    const dirs = readdirSync(projectsRoot).filter(d => {
      try { return statSync(join(projectsRoot, d)).isDirectory(); } catch { return false; }
    });
    for (const d of dirs) {
      const p = join(projectsRoot, d, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

// 根据 model 判定 max ctx tokens
function maxTokensForModel(model) {
  if (!model) return 200000;
  if (model.includes('opus')) return 1000000;        // opus 4.7 long context
  if (model.includes('sonnet-4')) return 1000000;    // sonnet 4.x 1M beta
  if (model.includes('haiku')) return 200000;        // haiku 默认 200k
  return 200000;
}

// 解析 transcript 最后一条 assistant.usage 估算 ctx
function estimateCtx(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { ok: false, reason: 'no-transcript' };
  }
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n');
    let lastUsage = null;
    let lastModel = null;
    let assistantCount = 0;
    // 反向找最后一条 assistant.usage（跳过 <synthetic> 这种内部桩）
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' && obj.message?.usage) {
          const m = obj.message.model || '';
          if (m.startsWith('<')) continue; // skip synthetic
          if (!lastUsage) {
            lastUsage = obj.message.usage;
            lastModel = m;
          }
          assistantCount++;
        }
      } catch {}
    }
    if (!lastUsage) return { ok: false, reason: 'no-usage' };
    const inputTokens = lastUsage.input_tokens || 0;
    const cacheRead = lastUsage.cache_read_input_tokens || 0;
    const cacheCreation = lastUsage.cache_creation_input_tokens || 0;
    const output = lastUsage.output_tokens || 0;
    // ctx = 这次 turn claude 看到的总输入（近似上下文已填充量）
    const ctxTotal = inputTokens + cacheRead + cacheCreation;
    const maxTokens = maxTokensForModel(lastModel);
    const pct = Math.min(100, (ctxTotal / maxTokens) * 100);
    return {
      ok: true,
      model: lastModel,
      inputTokens, cacheRead, cacheCreation, output,
      ctxTotal,
      maxTokens,
      pct: Math.round(pct * 10) / 10,
      assistantTurns: assistantCount,
    };
  } catch (e) {
    return { ok: false, reason: 'parse-fail', error: e.message };
  }
}

// 端点：返回该 session 的 ctx 估算
app.get('/api/sessions/:id/ctx', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (!s.claudeSessionId) {
    return res.json({ ok: false, reason: 'no-session-yet', pct: 0 });
  }
  const tp = findTranscript(s.claudeSessionId);
  const result = estimateCtx(tp);
  result.transcriptPath = tp;
  res.json(result);
});

// ============ 07 Continuum 集成：snapshot / meta / handoff ============

// 读该 session cwd 对应的事实快照
app.get('/api/sessions/:id/snapshot', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const dir = continuumDir(s.cwd);
  const snapPath = join(dir, 'snapshot.md');
  if (!existsSync(snapPath)) {
    return res.json({
      ok: false,
      reason: 'no-snapshot',
      hint: '07 Continuum hook 还没生成 snapshot。装 hook：cd ~/Desktop/00_项目/07_Continuum_会话接力工具 && ./install.sh',
      cwd: s.cwd,
      cwdHash: cwdHash(s.cwd),
    });
  }
  try {
    const content = readFileSync(snapPath, 'utf-8');
    const stat = statSync(snapPath);
    res.json({
      ok: true,
      cwd: s.cwd,
      cwdHash: cwdHash(s.cwd),
      bytes: stat.size,
      mtime: stat.mtime,
      content,
    });
  } catch (e) {
    send500(res, e);
  }
});

// 读 chain history 归档列表（用 ?file=<name> 取具体某次归档全文）
app.get('/api/sessions/:id/handoff-history', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const histDir = join(continuumDir(s.cwd), 'history');
  if (!existsSync(histDir)) return res.json({ ok: true, items: [], cwd: s.cwd });
  const fileQuery = req.query.file;
  if (fileQuery) {
    // 取具体一次归档的全文（防越权：只允许 snapshot_*.md 文件名）
    if (!/^snapshot_[\w_.-]+\.md$/.test(fileQuery)) return res.status(400).json({ error: 'bad filename' });
    const p = join(histDir, fileQuery);
    if (!existsSync(p)) return res.status(404).json({ error: 'archive not found' });
    try {
      const content = readFileSync(p, 'utf-8');
      const stat = statSync(p);
      return res.json({ ok: true, file: fileQuery, bytes: stat.size, mtime: stat.mtime, content });
    } catch (e) { return send500(res, e); }
  }
  // 默认：列表
  try {
    const items = readdirSync(histDir)
      .filter(n => n.endsWith('.md'))
      .map(name => {
        try {
          const st = statSync(join(histDir, name));
          // 从文件名抓 trigger（_PANEL.md / _MANUAL.md / _AUTO.md / 无后缀）
          let trigger = 'auto';
          if (name.includes('_PANEL.md')) trigger = 'panel';
          else if (name.includes('_MANUAL.md')) trigger = 'manual';
          return { name, bytes: st.size, mtime: st.mtime, trigger };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ ok: true, cwd: s.cwd, count: items.length, items });
  } catch (e) {
    send500(res, e);
  }
});

// 读 meta（chain_depth / handoff_count / project_mode / origin）
app.get('/api/sessions/:id/handoff-meta', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const metaPath = join(continuumDir(s.cwd), 'meta.json');
  if (!existsSync(metaPath)) {
    return res.json({ ok: false, reason: 'no-meta', cwd: s.cwd });
  }
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    res.json({ ok: true, cwd: s.cwd, meta });
  } catch (e) {
    send500(res, e);
  }
});

// 触发逻辑接力：归档当前 snapshot + 在 panel 内新建同 cwd 的 session
// 新 session 第一条消息预置 HANDOFF 内容，让新 claude 自动接手
app.post('/api/sessions/:id/handoff', (req, res) => {
  // v0.51 T-23 fix: handoff 也创建新 session，需走 capacity check
  if (!checkSessionsCapacity(res)) return;
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });

  const dir = continuumDir(s.cwd);
  const snapPath = join(dir, 'snapshot.md');
  if (!existsSync(snapPath)) {
    return res.status(409).json({
      ok: false,
      error: 'no-snapshot',
      hint: '07 Continuum 还没在这个 cwd 跑过 hook，无 snapshot 可接力',
    });
  }

  // 1) 归档当前 snapshot 到 history/
  let archiveName = null;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
    archiveName = `snapshot_${ts}_PANEL.md`;
    const histDir = join(dir, 'history');
    if (!existsSync(histDir)) mkdirSync(histDir, { recursive: true });
    copyFileSync(snapPath, join(histDir, archiveName));
  } catch (e) {
    console.error('archive snapshot fail:', e.message);
  }

  // 2) 读 snapshot 内容作为新 session 的种子消息 + 写 ~/HANDOFF_LATEST.md 与 07 对齐
  let snapContent = '';
  try { snapContent = readFileSync(snapPath, 'utf-8'); } catch {}
  try {
    writeFileSync(join(homedir(), 'HANDOFF_LATEST.md'), snapContent);
  } catch (e) {
    console.error('write HANDOFF_LATEST.md fail:', e.message);
  }

  // 3) 更新 meta：chain_depth + 1, handoff_count + 1
  const metaPath = join(dir, 'meta.json');
  let chainDepth = 1;
  try {
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf-8')) : {};
    meta.handoff_count = (meta.handoff_count || 0) + 1;
    meta.chain_depth = (meta.chain_depth || 0) + 1;
    meta.last_handoff_at = new Date().toISOString();
    meta.last_handoff_trigger = 'panel';
    chainDepth = meta.chain_depth;
    // v0.51 Y-06 fix: meta.json 原子写
    const tmp = metaPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(meta, null, 2));
    renameSync(tmp, metaPath);
  } catch (e) {
    console.error('update meta fail:', e.message);
  }

  // 4) 写 handoff_log.jsonl（与 07 兼容）
  try {
    const logPath = join(CONTINUUM_STATE_ROOT, 'handoff_log.jsonl');
    const entry = {
      ts: new Date().toISOString(),
      trigger: 'panel',
      ctx_pct: null,
      snapshot_bytes: snapContent.length,
      cwd: s.cwd,
      cwd_hash: cwdHash(s.cwd),
      session_id: s.claudeSessionId || 'panel-no-session',
      panel_session_id: s.id,
    };
    // S26 B1：handoff_log.jsonl 含 cwd_hash + session_id 等 PII，加 0o600 mode
    appendFileSync(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {}

  // 5) 在 panel 里建一个新 session（同 cwd，新名字，messages 区记一条"接力起点"）
  const newId = randomUUID();
  const handoffNote = `🔁 接力自 「${s.name}」（chain depth: ${chainDepth}）\n\n--- HANDOFF Snapshot ---\n\n${snapContent}`;
  const newSession = {
    id: newId,
    name: `${s.name} ▸ #${chainDepth}`,
    cwd: s.cwd,
    claudeSessionId: null,
    createdAt: new Date().toISOString(),
    child: null,
    pid: null,
    busy: false,
    messages: [{
      role: 'system',
      content: handoffNote,
      ts: new Date().toISOString(),
    }],
    clients: new Set(),
    usage: { inputTokens: 0, outputTokens: 0 },
    parentSessionId: s.id,
    chainDepth,
    // v0.31 fix: 补全字段，让 newSession 跟普通 session 字段一致
    mainGoal: s.mainGoal || null, // 继承父 session 主目标
    runState: 'idle',
    guardLevel: s.guardLevel || 'standard',
    model: null,
    dangerHistory: [],
    loopGuardHistory: [],
    archived: false,
    archivedAt: null,
    handoffPrimed: false,
  };
  sessions.set(newId, newSession);
  debouncedSave();

  res.json({
    ok: true,
    newSessionId: newId,
    chainDepth,
    archivedAs: archiveName,
    snapshotBytes: snapContent.length,
  });
});

// 在外部 Terminal 启动 claude（真·独立 GUI 窗口）
// v0.49 N-05 fix: AppleScript do script 注入加固——用 quoted form 构造 shell 命令避免双引号破外层字符串
function buildClaudeTerminalScript(cwd, resumeId) {
  // shell 单引号闭合转义
  const cwdSh = cwd.replace(/'/g, "'\\''");
  const resumeStr = resumeId && /^[A-Za-z0-9_\-]{1,64}$/.test(String(resumeId))
    ? ` --resume ${resumeId}` : '';
  const shellCmd = `cd '${cwdSh}' && claude --dangerously-skip-permissions${resumeStr}`;
  // AppleScript 字符串转义：反斜杠先于双引号
  const asEsc = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `tell application "Terminal"\n    activate\n    do script "${asEsc}"\nend tell`;
}
app.post('/api/sessions/:id/external', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  // cwd 来自 session 创建时校验过的真实目录，但稳妥起见拒绝含控制字符的
  if (/[\x00-\x1f]/.test(s.cwd)) return res.status(400).json({ error: 'cwd 含非法字符' });
  const script = buildClaudeTerminalScript(s.cwd, s.claudeSessionId);
  const proc = spawn('osascript', ['-e', script]);
  // v0.51 W-11 fix: spawn error / stdio error 防御
  proc.on('error', (e) => console.warn('osascript spawn fail:', e.message));
  proc.stdout?.on('error', () => {});
  proc.stderr?.on('error', () => {});
  proc.on('exit', code => {
    if (code !== 0) console.error('osascript exit', code);
  });
  res.json({ ok: true, cwd: s.cwd });
});

// v0.14: 在外部 Terminal 打开 + 自动跑 `claude /login`（OAuth 浏览器跳转流程）
// 不在 panel 内嵌 PTY（macOS arm64 node-pty 有坑），用 osascript 最稳
app.post('/api/login-claude', (req, res) => {
  const script = `tell application "Terminal"
    activate
    do script "echo '🔐 Claude Code 登录' && echo '完成后可关闭此窗口，回到 panel 继续' && echo '' && claude /login"
end tell`;
  const proc = spawn('osascript', ['-e', script]);
  // v0.51 W-11 fix: 同样防御
  proc.on('error', (e) => console.warn('login-claude osascript spawn fail:', e.message));
  proc.stdout?.on('error', () => {});
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });
  proc.stderr.on('error', () => {});
  proc.on('exit', code => {
    if (code !== 0 && stderr) console.error('login-claude osascript fail:', stderr);
  });
  res.json({ ok: true, message: '已在 Terminal 打开 claude /login，请完成 OAuth 后回来' });
});

// 同时 spawn 多个 Terminal 窗口（批量）— v0.49 N-05 fix: 同 external 端点的 AppleScript 加固
app.post('/api/spawn-batch', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 20) : [];
  const result = [];
  for (const id of ids) {
    // v0.51 U-15 fix: id 必须 string，避免 sessions.get(非 string) 异常 / 误命中
    if (typeof id !== 'string') continue;
    const s = sessions.get(id);
    if (!s) continue;
    if (/[\x00-\x1f]/.test(s.cwd)) continue;
    const script = buildClaudeTerminalScript(s.cwd, s.claudeSessionId);
    // v0.51 W-11 fix: 同样防 spawn error
    const p = spawn('osascript', ['-e', script]);
    p.on('error', (e) => console.warn('spawn-batch osascript fail:', e.message));
    p.stdout?.on('error', () => {});
    p.stderr?.on('error', () => {});
    result.push({ id, cwd: s.cwd });
  }
  res.json({ ok: true, spawned: result });
});

// 浏览目录 — v0.49 N-03 fix: 加沙箱（与 /api/files 同沙箱）
app.get('/api/browse', (req, res) => {
  const path = safeResolveFsPath(req.query.path || '~');
  if (!path) return res.status(403).json({ error: 'forbidden: 路径越权或敏感目录' });
  // v0.51 T-18 fix: 检查是否目录
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });
  } catch {
    return res.status(404).json({ error: 'not found' });
  }
  try {
    const items = readdirSync(path)
      .filter(n => !n.startsWith('.'))
      .map(name => {
        const full = join(path, name);
        try {
          const st = statSync(full);
          return { name, path: full, isDir: st.isDirectory() };
        } catch { return null; }
      })
      .filter(i => i && i.isDir)
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path, items });
  } catch (e) {
    send500(res, e);
  }
});

// ============ v0.50 全局搜索（F1）：跨 session 搜 messages ============
app.get('/api/search', (req, res) => {
  const q = req.query.q;
  if (!q || typeof q !== 'string' || !q.trim()) return res.status(400).json({ error: 'q required' });
  if (q.length > 200) return res.status(400).json({ error: 'q 过长（>200）' });
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
  const needle = q.toLowerCase();
  // v0.51 R-02 fix: per-session cap，避免第一个 session 命中过多导致其他 session 完全搜不到
  const perSessionCap = Math.max(3, Math.ceil(limit / 4));
  const hardCap = limit * 5; // 全局硬上限防内存爆
  const hits = [];
  outer: for (const s of sessions.values()) {
    if (s.archived && req.query.includeArchived !== '1') continue;
    const msgs = s.messages || [];
    let perSessionHits = 0;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const content = String(m.content || '');
      const idx = content.toLowerCase().indexOf(needle);
      if (idx >= 0) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(content.length, idx + needle.length + 60);
        hits.push({
          sessionId: s.id,
          sessionName: s.name,
          cwd: s.cwd,
          msgIndex: i,
          role: m.role,
          ts: m.ts,
          snippet: (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : ''),
          matchAt: idx,
        });
        perSessionHits++;
        if (perSessionHits >= perSessionCap) break;
        if (hits.length >= hardCap) break outer;
      }
    }
  }
  // 按 timestamp 倒序（最近的优先）+ 截到 limit
  hits.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const finalHits = hits.slice(0, limit);
  res.json({ ok: true, query: q, count: finalHits.length, total: hits.length, hits: finalHits });
});

// v0.54 Sprint 4 — CLI 一键起房：建房 + （可选）应用模板 + （可选）启动
// body: { mode, name?, members?, topic, templateId?, debateRounds?, qaStrictness?, startNow?, cwd? }
// 一次性完成：roomStore.create + PATCH 字段 + 启动 dispatcher
app.post('/api/rooms/quick', async (req, res) => {
  try {
    if (roomStore.list().length >= MAX_ROOMS) {
      return res.status(429).json({ error: `已达房间总数上限（${MAX_ROOMS}）` });
    }
    const body = req.body || {};
    const topic = String(body.topic || '').trim();
    if (!topic) return res.status(400).json({ error: 'topic required' });
    if (topic.length > 1048576) return res.status(400).json({ error: 'topic 过长（>1MB）' });

    // 1) 取模板（可选）
    let template = null;
    if (body.templateId) {
      template = roomTemplatesStore.get(String(body.templateId));
      if (!template) return res.status(404).json({ error: '模板不存在: ' + body.templateId });
    }

    // 2) mode：template > body > 默认 debate
    const mode = template?.mode || body.mode || 'debate';
    if (!['debate', 'squad', 'arena', 'chat'].includes(mode)) {
      return res.status(400).json({ error: 'mode 必须是 debate/squad/arena/chat' });
    }

    // 3) members：template > body > server 默认（POST /api/rooms 流程兜底）
    const members = template?.preset?.members || (Array.isArray(body.members) ? body.members : undefined);

    // 4) cwd 沙箱
    let safeCwd = homedir();
    if (body.cwd && typeof body.cwd === 'string' && body.cwd.trim()) {
      if (body.cwd.length > 1024) return res.status(400).json({ error: 'cwd 过长' });
      const safe = safeResolveFsPath(body.cwd.trim());
      if (!safe) return res.status(403).json({ error: 'cwd 越权或敏感目录' });
      try {
        const st = statSync(safe);
        if (!st.isDirectory()) return res.status(400).json({ error: 'cwd 不是目录' });
        safeCwd = safe;
      } catch { return res.status(400).json({ error: 'cwd 不存在' }); }
    }

    // 5) name
    const name = String(body.name || template?.name || ('快速 ' + mode + ' 房')).slice(0, 200);

    // 6) create room（复用 roomStore.create 而不是再走 POST /api/rooms，因为 quick 跳过默认 members fallback）
    let finalMembers = members;
    if (!finalMembers) {
      // 用 POST /api/rooms 一样的默认 fallback
      if (mode === 'squad') {
        finalMembers = [
          { adapterId: 'claude', displayName: '🟣 Claude · PM',  role: 'pm',  enabled: true },
          { adapterId: 'claude', displayName: '🟣 Claude · Dev', role: 'dev', enabled: true },
          { adapterId: 'codex',  displayName: '🟢 GPT · Dev',     role: 'dev', enabled: true },
          { adapterId: 'codex',  displayName: '🟢 GPT · QA',      role: 'qa',  enabled: true },
        ];
      } else if (mode === 'arena') {
        finalMembers = [
          { adapterId: 'claude', displayName: '🟣 Claude（提案 + Judge）', role: 'judge', enabled: true },
          { adapterId: 'codex',  displayName: '🟢 GPT', enabled: true },
        ];
      } else if (mode === 'chat') {
        finalMembers = [{ adapterId: 'codex', displayName: '🟢 GPT', enabled: true }];
      } else {
        finalMembers = [
          { adapterId: 'claude', displayName: '🟣 Claude', enabled: true },
          { adapterId: 'codex',  displayName: '🟢 GPT',     enabled: true },
        ];
      }
    }
    const room = roomStore.create({ name, cwd: safeCwd, members: finalMembers, mode });

    // 7) PATCH 模板/body 提供的额外字段
    const patch = {};
    const debateRounds = template?.preset?.debateRounds ?? body.debateRounds;
    if (mode === 'debate' && Number.isFinite(Number(debateRounds))) {
      const n = Math.max(1, Math.min(10, Math.trunc(Number(debateRounds))));
      patch.debateRounds = n;
    }
    const qaStrictness = template?.preset?.qaStrictness ?? body.qaStrictness;
    if (mode === 'squad' && ['loose', 'standard', 'strict'].includes(qaStrictness)) {
      patch.qaStrictness = qaStrictness;
    }
    if (Object.keys(patch).length > 0) roomStore.update(room.id, patch);

    // 8) 启动（可选）
    let started = false;
    if (body.startNow === true || body.startNow === 'true' || body.startNow === 1) {
      try {
        if (mode === 'debate') {
          debateDispatcher.start(room.id, topic, { debateRounds: patch.debateRounds }).catch(() => {});
          started = true;
        } else if (mode === 'squad') {
          squadDispatcher.start(room.id, topic).catch(() => {});
          started = true;
        } else if (mode === 'arena') {
          arenaDispatcher.start(room.id, topic).catch(() => {});
          started = true;
        } else if (mode === 'chat') {
          // chat 没有 start，只有 sendMessage
          roomStore.update(room.id, { topic });
          soloChatDispatcher.sendMessage(room.id, topic).catch(() => {});
          started = true;
        }
      } catch (e) {
        return res.json({ ok: true, room, started: false, startError: e.message });
      }
    } else if (topic) {
      // 不启动也保存 topic 到房（让 UI 看到）
      roomStore.update(room.id, { topic });
    }

    res.json({ ok: true, room: roomStore.get(room.id), started });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v0.53 Sprint 3.5：跨房搜索（搜 name/topic/finalConsensus/turn.content/conversation/task.attempts.content）
app.get('/api/rooms/search', (req, res) => {
  const q = req.query.q;
  if (!q || typeof q !== 'string' || !q.trim()) return res.status(400).json({ error: 'q required' });
  if (q.length > 200) return res.status(400).json({ error: 'q 过长（>200）' });
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
  const includeArchived = req.query.includeArchived === '1';
  const needle = q.toLowerCase();
  const perRoomCap = Math.max(3, Math.ceil(limit / 4));
  const hardCap = limit * 5;
  const hits = [];

  function pushHit(room, where, snippet, extra = {}) {
    const lc = String(snippet || '').toLowerCase();
    const idx = lc.indexOf(needle);
    if (idx < 0) return false;
    const s = String(snippet);
    const start = Math.max(0, idx - 60);
    const end = Math.min(s.length, idx + needle.length + 60);
    hits.push({
      roomId: room.id,
      roomName: room.name,
      mode: room.mode,
      where,
      snippet: (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : ''),
      updatedAt: room.updatedAt || room.createdAt,
      ...extra,
    });
    return true;
  }

  const allRooms = includeArchived
    ? [...roomStore.list(), ...roomStore.listArchived()]
    : roomStore.list();

  outer: for (const room of allRooms) {
    let perRoomHits = 0;
    // 1) name / topic / finalConsensus
    for (const field of ['name', 'topic', 'finalConsensus']) {
      if (pushHit(room, field, room[field])) perRoomHits++;
      if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
    }
    if (perRoomHits >= perRoomCap || hits.length >= hardCap) {
      if (hits.length >= hardCap) break outer;
      continue;
    }
    // 2) rounds[].turns[].content（debate / arena / squad）
    for (const r of (room.rounds || [])) {
      for (const t of (r.turns || [])) {
        if (pushHit(room, `turn:${r.kind}`, t.content, { speaker: t.speaker })) perRoomHits++;
        if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
      }
      if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
    }
    if (perRoomHits >= perRoomCap || hits.length >= hardCap) {
      if (hits.length >= hardCap) break outer;
      continue;
    }
    // 3) conversation[].content（chat）
    for (const c of (room.conversation || [])) {
      if (pushHit(room, `chat:${c.from}`, c.content)) perRoomHits++;
      if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
    }
    if (perRoomHits >= perRoomCap || hits.length >= hardCap) {
      if (hits.length >= hardCap) break outer;
      continue;
    }
    // 4) taskList[].title/desc + attempts[].content + reviews[].reasoning（squad）
    for (const task of (room.taskList || [])) {
      if (pushHit(room, `task:${task.id}.title`, task.title)) perRoomHits++;
      if (pushHit(room, `task:${task.id}.desc`, task.desc)) perRoomHits++;
      for (const at of (task.attempts || [])) {
        if (pushHit(room, `task:${task.id}.attempt`, at.content)) perRoomHits++;
        if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
      }
      if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
    }
    if (hits.length >= hardCap) break outer;
  }

  hits.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const finalHits = hits.slice(0, limit);
  res.json({ ok: true, query: q, count: finalHits.length, total: hits.length, hits: finalHits });
});

// ============ v0.50 导出 session 为 markdown（F2）============
app.get('/api/sessions/:id/export', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const lines = [];
  lines.push(`# ${s.name}`, '');
  lines.push(`- **cwd**: \`${s.cwd}\``);
  lines.push(`- **created**: ${s.createdAt}`);
  if (s.mainGoal) lines.push(`- **goal**: ${s.mainGoal}`);
  if (s.model) lines.push(`- **model**: ${s.model}`);
  lines.push(`- **messages**: ${s.messages.length}`);
  if (s.costTracker) lines.push(`- **total USD**: $${s.costTracker.totalUSD().toFixed(4)}`);
  lines.push('', '---', '');
  for (const m of s.messages) {
    const roleLabel = m.role === 'user' ? '👤 User' :
                      m.role === 'assistant' ? '🤖 Assistant' :
                      m.role === 'tool_use' ? '🔧 Tool' :
                      m.role === 'system' ? '⚙️ System' : m.role;
    const time = m.ts ? ` _(${new Date(m.ts).toLocaleString('zh-CN')})_` : '';
    lines.push(`## ${roleLabel}${time}`, '', String(m.content || ''), '');
  }
  const safeName = (s.name || 'session').replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').slice(0, 80);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  // v0.51 S-19 fix: RFC 5987 编码，让浏览器正确显示中文文件名（而非 URL 编码字串）
  const asciiFallback = safeName.replace(/[^\x20-\x7e]/g, '_');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiFallback}.md"; filename*=UTF-8''${encodeURIComponent(safeName)}.md`
  );
  res.send(lines.join('\n'));
});

// ============ v0.50 收藏消息（F5）============
app.post('/api/sessions/:id/star', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const idx = parseInt(req.body?.msgIndex, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= (s.messages || []).length) {
    return res.status(400).json({ error: 'invalid msgIndex' });
  }
  if (!Array.isArray(s.starredIndices)) s.starredIndices = [];
  const pos = s.starredIndices.indexOf(idx);
  if (pos >= 0) s.starredIndices.splice(pos, 1);
  else s.starredIndices.push(idx);
  s.starredIndices.sort((a, b) => a - b);
  debouncedSave();
  res.json({ ok: true, starredIndices: s.starredIndices });
});
app.get('/api/sessions/:id/stars', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const starred = (s.starredIndices || []).map(i => ({
    msgIndex: i,
    message: s.messages[i] || null,
  })).filter(x => x.message);
  res.json({ ok: true, count: starred.length, starred });
});

// ============ v0.50 Quick prompts 模板（F6）============
const PROMPTS_FILE = join(DATA_DIR, 'prompts.json');
function loadPrompts() {
  if (!existsSync(PROMPTS_FILE)) return [];
  try {
    const list = JSON.parse(readFileSync(PROMPTS_FILE, 'utf-8'));
    // v0.51 Y-04 fix: load 时 cap 200（与 POST cap 一致）
    if (Array.isArray(list) && list.length > 200) {
      console.warn(`[loadPrompts] prompts.json 含 ${list.length} 条，超过 200 上限，仅加载最新 200`);
      return [...list].slice(0, 200);  // unshift 顺序：head 是新的
    }
    return list;
  }
  catch (e) {
    // v0.51 U-09 fix: 损坏时备份原文件，避免下次 savePrompts 直接覆盖丢全部历史
    try {
      const bak = PROMPTS_FILE + '.corrupted-' + Date.now() + '.bak';
      copyFileSync(PROMPTS_FILE, bak);
      console.error(`[prompts.json] corrupted, backed up to ${bak}:`, e.message);
    } catch {}
    return [];
  }
}
function savePrompts(list) {
  try {
    // v0.51 Y-05 fix: 原子写
    const tmp = PROMPTS_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, PROMPTS_FILE);
    return true;
  } catch (e) { console.warn('save prompts:', e.message); return false; }
}
app.get('/api/prompts', (req, res) => res.json({ ok: true, prompts: loadPrompts() }));
app.post('/api/prompts', (req, res) => {
  const { name, content } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  if (name.length > 100) return res.status(400).json({ error: 'name 过长' });
  if (content.length > 50000) return res.status(400).json({ error: 'content 过长（>50KB）' });
  const list = loadPrompts();
  if (list.length >= 200) return res.status(429).json({ error: '已达 200 条上限' });
  const item = { id: randomUUID(), name: name.trim(), content, createdAt: new Date().toISOString() };
  list.unshift(item);
  savePrompts(list);
  res.json({ ok: true, prompt: item });
});
app.delete('/api/prompts/:id', (req, res) => {
  const list = loadPrompts();
  const idx = list.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  list.splice(idx, 1);
  savePrompts(list);
  res.json({ ok: true });
});

// ============ v0.50 Session forking（F7）============
app.post('/api/sessions/:id/fork', (req, res) => {
  // v0.51 R-13: fork 也走 sessions 上限检查
  if (!checkSessionsCapacity(res)) return;
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const fromIndex = parseInt(req.body?.fromIndex, 10);
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= (s.messages || []).length) {
    return res.status(400).json({ error: 'invalid fromIndex' });
  }
  // 复制 [0..fromIndex] 消息（含目标消息）
  const copiedMessages = s.messages.slice(0, fromIndex + 1).map(m => ({ ...m }));
  const newId = randomUUID();
  const newSession = {
    id: newId,
    name: `${s.name} (fork @${fromIndex})`,
    cwd: s.cwd,
    claudeSessionId: null, // 新 session 走 fresh claude（不继承原 claude session）
    createdAt: new Date().toISOString(),
    child: null, pid: null, busy: false,
    messages: copiedMessages,
    clients: new Set(),
    handoffPrimed: false,
    parentSessionId: s.id,
    chainDepth: (s.chainDepth || 0) + 1,
    archived: false,
    mainGoal: s.mainGoal || null,
    runState: 'idle',
    guardLevel: s.guardLevel || 'standard',
    model: s.model || null,
    starredIndices: (s.starredIndices || []).filter(i => i <= fromIndex),
  };
  sessions.set(newId, newSession);
  debouncedSave();
  res.json({ ok: true, newSessionId: newId, copiedCount: copiedMessages.length });
});

// ============ v0.54 Sprint 10：删除 Ruflo 集成 ============


// ============ v0.22 PTY 内嵌真终端 ============
const terminals = new Map(); // termId → { term, clients: Set, cwd, createdAt }

// v0.51 S-05 fix: PTY 终端总数上限（每个 PTY = 一个 shell 进程，资源消耗大）
const MAX_TERMINALS = 20;
app.post('/api/term', (req, res) => {
  if (terminals.size >= MAX_TERMINALS) {
    return res.status(429).json({ error: `已达终端总数上限（${MAX_TERMINALS}）。先关掉不用的终端` });
  }
  const { cwd, cols = 80, rows = 24, shell } = req.body || {};
  const termId = randomUUID();
  // v0.49 N-04 fix: cwd 走沙箱（仅 home 子树或 /tmp，禁敏感目录），非法回退到 home
  let workDir = homedir();
  if (cwd && typeof cwd === 'string' && cwd.trim()) {
    const safe = safeResolveFsPath(cwd.trim());
    if (safe) {
      try {
        const st = statSync(safe);
        if (st.isDirectory()) workDir = safe;
      } catch {}
    }
  }
  // shell 只允许常见 binary，防注入
  const ALLOWED_SHELLS = new Set(['/bin/zsh', '/bin/bash', '/bin/sh', '/usr/bin/zsh', '/usr/bin/bash']);
  const requestedShell = (typeof shell === 'string' && shell.trim()) ? shell.trim() : (process.env.SHELL || '/bin/zsh');
  const shellBin = ALLOWED_SHELLS.has(requestedShell) ? requestedShell : '/bin/zsh';
  try {
    const term = pty.spawn(shellBin, [], {
      name: 'xterm-256color',
      cols: Math.max(20, Math.min(500, cols | 0)),
      rows: Math.max(5, Math.min(200, rows | 0)),
      cwd: workDir,
      env: { ...process.env, TERM: 'xterm-256color', LANG: 'zh_CN.UTF-8' },
    });
    const clients = new Set();
    term.onData(d => {
      for (const ws of clients) {
        if (ws.readyState === 1) {
          try { ws.send(JSON.stringify({ type: 'data', data: d })); } catch {}
        }
      }
    });
    term.onExit(({ exitCode, signal }) => {
      for (const ws of clients) {
        if (ws.readyState === 1) {
          try { ws.send(JSON.stringify({ type: 'exit', exitCode, signal })); } catch {}
        }
      }
      terminals.delete(termId);
    });
    terminals.set(termId, { term, clients, cwd: workDir, shell: shellBin, createdAt: new Date().toISOString() });
    res.json({ ok: true, termId, cwd: workDir, shell: shellBin, pid: term.pid });
  } catch (e) {
    res.status(500).json({ error: 'pty spawn failed: ' + e.message });
  }
});

app.get('/api/term', (req, res) => {
  res.json([...terminals.entries()].map(([id, t]) => ({
    id, pid: t.term.pid, cwd: t.cwd, shell: t.shell, createdAt: t.createdAt,
  })));
});

app.delete('/api/term/:id', (req, res) => {
  const t = terminals.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  try { t.term.kill(); } catch {}
  // v0.51 V-05 fix: 主动 close 所有 ws clients，对齐 DELETE session 的清理（N-20）
  for (const ws of t.clients) {
    try { ws.close(); } catch {}
  }
  t.clients.clear();
  terminals.delete(req.params.id);
  res.json({ ok: true });
});

// 注：/api/* fallback 404 已移到所有 /api/* 路由之后（防止拦截新加端点）
// ============ v0.56 Sprint 15-R4：Autopilot 控制 API ============
// S18-2d：6 个 routes 提取到 src/server/routes/autopilot.js
registerAutopilotRoutes(app, { autopilotStore });

// ============ v0.56 Sprint 15：Resilience（CircuitBreaker / Bulkhead / RateLimiter）状态 ============
app.get('/api/safety/status', (req, res) => {
  try {
    // S21 P1：加 process.memoryUsage() 内存监控（前端可拉来画 RSS 趋势）
    const mu = process.memoryUsage();
    res.json({
      ok: true,
      breakers: breakers.all(),
      bulkheads: bulkheads.all(),
      rateLimiters: rateLimiters.all(),
      memory: {
        rss_mb: Math.round(mu.rss / 1024 / 1024),
        heapUsed_mb: Math.round(mu.heapUsed / 1024 / 1024),
        heapTotal_mb: Math.round(mu.heapTotal / 1024 / 1024),
        external_mb: Math.round(mu.external / 1024 / 1024),
        uptime_s: Math.round(process.uptime()),
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/safety/breakers/:key/reset', (req, res) => {
  try {
    const ok = breakers.reset(req.params.key);
    if (!ok) return res.status(404).json({ ok: false, error: 'breaker not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 配置某 adapter 的 rate limit
app.put('/api/safety/rate-limit/:key', (req, res) => {
  try {
    const { perMinute, burst } = req.body || {};
    const pm = Math.max(1, Math.min(10000, Number(perMinute) || 60));
    const b = Math.max(1, Math.min(1000, Number(burst) || 10));
    rateLimiters.set(req.params.key, { perMinute: pm, burst: b });
    res.json({ ok: true, snapshot: rateLimiters.get(req.params.key).snapshot() });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ============ v0.55 Sprint 13-B：知识库（KB）API ============
// S18-2g：7 个 routes 提取
registerKnowledgeRoutes(app, { knowledgeStore });

// ============ v0.55 Sprint 13-C：Skills 系统 ============
// S18-2f：6 个 routes 提取
registerSkillsRoutes(app, { skillStore });

// ============ v0.55 Sprint 13-A：OpenAI 兼容 API server ============
// 让外部 IDE / 客户端（VS Code Continue / Cursor / Cherry Studio / 任意 OpenAI SDK）把 panel 当 backend
// 端点不在 /api/* 下，避免被上面的 fallback 拦截。仅 127.0.0.1 监听（panel 默认）
//
// 支持：
//   GET  /v1/models           列出可用 model（每个 adapter + 其推荐 model）
//   POST /v1/chat/completions OpenAI 兼容（非 streaming，body 含 model + messages）
//
// model 命名约定：「<adapterId>:<modelName?>」
// 例：claude:sonnet-4-6 / codex:gpt-5 / gemini-cli / minimax:MiniMax-M2.7
// 也兼容直接 <adapterId> 不带 modelName（用 adapter 默认）

app.get('/v1/models', (req, res) => {
  try {
    const adapters = Array.from(roomAdapterPool.keys());
    // 每个 adapter 提供"基础" model id（用户也可以传 adapterId:任意 model 名）
    const ADAPTER_MODELS = {
      claude: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'sonnet', 'opus', 'haiku'],
      codex: ['gpt-5', 'gpt-5-mini', 'gpt-5-codex', 'o3', 'o3-mini'],
      'gemini-cli': ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
      gemini: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.1-flash-image-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
      'gemini-openai': [''],
      minimax: ['MiniMax-M2.7', 'MiniMax-M2.6', 'abab7-chat'],
      ollama: ['gemma3:4b', 'qwen2.5:7b', 'llama3.2:3b'],
      ccr: [''],
    };
    const data = [];
    for (const a of adapters) {
      const ms = ADAPTER_MODELS[a] || [''];
      for (const m of ms) {
        const id = m ? `${a}:${m}` : a;
        data.push({
          id,
          object: 'model',
          created: 0,
          owned_by: 'xikelab',
        });
      }
    }
    res.json({ object: 'list', data });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'panel_internal_error' } });
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.model || typeof body.model !== 'string') {
      return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages must be non-empty array', type: 'invalid_request_error' } });
    }
    const wantStream = body.stream === true;
    // 解 model
    const colonIdx = body.model.indexOf(':');
    const adapterId = colonIdx >= 0 ? body.model.slice(0, colonIdx) : body.model;
    const modelName = colonIdx >= 0 ? body.model.slice(colonIdx + 1) : '';
    const adapter = roomAdapterPool.get(adapterId);
    if (!adapter) {
      return res.status(404).json({ error: { message: `adapter "${adapterId}" not registered or disabled in panel`, type: 'invalid_request_error', param: 'model' } });
    }
    // 规范 messages：只保留 role/content
    const messages = body.messages
      .filter((m) => m && typeof m === 'object' && typeof m.role === 'string' && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
    if (messages.length === 0) {
      return res.status(400).json({ error: { message: 'no valid messages after filtering', type: 'invalid_request_error' } });
    }
    // body.max_tokens 等暂不传到 adapter（adapter 各自有默认）
    const startedAt = Date.now();
    const completionId = 'chatcmpl-panel-' + randomUUID().slice(0, 24);

    // v0.55 Sprint 14 F4：SSE streaming
    if (wantStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      // adapter.chat 不真原生 streaming（多数 spawn 是一次性返回），但有 onProgress 接 stdout chunk
      // 策略：onProgress 拿到的增量 → 转成 OpenAI delta；最后再发一次 finish_reason: stop
      let lastSent = '';
      const onProgress = (chunk) => {
        if (!chunk || typeof chunk !== 'string') return;
        // 注意 chunk 是 stdout 字节流，不是干净的"new content"——多数 adapter 累积传，每次 chunk 含所有已收文本前缀
        // 为正确生成 delta：跟 lastSent 比较增量
        // 但很多 spawn adapter 的 onProgress 传的是 *当前块*（chunk），不是累积。看 ClaudeSpawnAdapter 实现是 `child.stdout.on('data', d => { stdout += d.toString(); opts.onProgress?.(d.toString()); })` —— 传的是当前块
        send({
          id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        });
        lastSent += chunk;
      };
      // 心跳：每 15s 发空 comment 防中间代理 idle 关连接
      const heartbeat = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 15000);
      try {
        // 第一个 chunk 发个 role:'assistant' delta，符合 OpenAI 协议
        send({
          id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });
        const result = await adapter.chat(messages, { model: modelName, cwd: homedir(), onProgress });
        clearInterval(heartbeat);
        // 如果 adapter 整体 reply 比 onProgress 累积更长，补发剩余
        const fullReply = (result && result.reply) || '';
        if (fullReply.length > lastSent.length) {
          send({
            id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
            choices: [{ index: 0, delta: { content: fullReply.slice(lastSent.length) }, finish_reason: null }],
          });
        }
        // 结束信号
        send({
          id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: result.tokensIn || 0,
            completion_tokens: result.tokensOut || 0,
            total_tokens: (result.tokensIn || 0) + (result.tokensOut || 0),
          },
        });
        res.write('data: [DONE]\n\n');
        res.end();
        try {
          metricsStore.record({
            roomId: '', roomMode: 'openai-api-stream', roomName: `v1/chat:${adapterId}`,
            turn: 'v1-stream', adapter: adapterId, model: modelName,
            latencyMs: Date.now() - startedAt,
            tokensIn: result.tokensIn || 0, tokensOut: result.tokensOut || 0,
            success: true, errorKind: null,
          });
        } catch {}
      } catch (e) {
        clearInterval(heartbeat);
        try {
          send({ error: { message: `adapter error: ${e.message}`, type: 'upstream_error' } });
          res.end();
        } catch {}
      }
      return;
    }

    // ===== 非 streaming 路径 =====
    let result;
    try {
      result = await adapter.chat(messages, { model: modelName, cwd: homedir() });
    } catch (e) {
      return res.status(502).json({ error: { message: `adapter error: ${e.message}`, type: 'upstream_error' } });
    }
    try {
      metricsStore.record({
        roomId: '', roomMode: 'openai-api', roomName: `v1/chat:${adapterId}`,
        turn: 'v1-completion', adapter: adapterId, model: modelName,
        latencyMs: Date.now() - startedAt,
        tokensIn: result.tokensIn || 0, tokensOut: result.tokensOut || 0,
        success: true, errorKind: null,
      });
    } catch {}
    res.json({
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.reply || '' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: result.tokensIn || 0,
        completion_tokens: result.tokensOut || 0,
        total_tokens: (result.tokensIn || 0) + (result.tokensOut || 0),
      },
    });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'panel_internal_error' } });
  }
});

// v0.51 T-11 fix + v0.55 fix: /api/* 404 fallback（必须在所有 /api/* 路由之后）
app.use('/api', (req, res) => {
  res.status(404).json({ error: `unknown endpoint: ${req.method} ${req.path}` });
});

// /v1/* fallback 404 也返 OpenAI 格式
app.use('/v1', (req, res) => {
  res.status(404).json({ error: { message: `unknown endpoint: ${req.method} ${req.path}`, type: 'invalid_request_error' } });
});

// WS upgrade
// v0.49 N-02 fix: Origin 白名单防 CSRF（恶意网页伪造 WS upgrade 控制 PTY 终端）
const PORT_NUM = process.env.PORT || 51735;
const ALLOWED_WS_ORIGINS = new Set([
  `http://localhost:${PORT_NUM}`,
  `http://127.0.0.1:${PORT_NUM}`,
  `http://[::1]:${PORT_NUM}`,
]);
server.on('upgrade', (req, socket, head) => {
  // Origin 检查：Electron / 本机浏览器直连 panel 才放行；无 Origin（如 curl）也放行，因 CSRF 必须来自浏览器
  const origin = req.headers.origin;
  if (origin && !ALLOWED_WS_ORIGINS.has(origin)) {
    console.warn('[ws] origin rejected:', origin);
    socket.destroy();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  // v0.53 Sprint 3 panel 级全局 WS：/ws/global（接收 metrics_update / health_warning 等）
  if (url.pathname === '/ws/global') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      globalWsClients.add(ws);
      try { ws.send(JSON.stringify({ type: 'connected', channel: 'global' })); } catch {}
      ws.on('close', () => globalWsClients.delete(ws));
    });
    return;
  }
  // v0.39 聊天室 WS：/ws/room/:roomId
  const roomMatch = url.pathname.match(/^\/ws\/room\/([0-9a-f-]{36})$/);
  if (roomMatch) {
    const roomId = roomMatch[1];
    const room = roomStore.get(roomId);
    if (!room) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      let set = roomWsClients.get(roomId);
      if (!set) { set = new Set(); roomWsClients.set(roomId, set); }
      set.add(ws);
      ws.send(JSON.stringify({ type: 'connected', roomId, room }));
      ws.on('close', () => {
        const s = roomWsClients.get(roomId);
        if (s) { s.delete(ws); if (s.size === 0) roomWsClients.delete(roomId); }
      });
    });
    return;
  }
  // v0.22 PTY 终端 WS：/ws/term/:termId
  const termMatch = url.pathname.match(/^\/ws\/term\/([0-9a-f-]{36})$/);
  if (termMatch) {
    const termId = termMatch[1];
    const t = terminals.get(termId);
    if (!t) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      t.clients.add(ws);
      ws.send(JSON.stringify({ type: 'connected', termId, cwd: t.cwd }));
      ws.on('message', raw => {
        try {
          const obj = JSON.parse(raw.toString());
          if (obj.type === 'input' && typeof obj.data === 'string') {
            t.term.write(obj.data);
          } else if (obj.type === 'resize' && obj.cols && obj.rows) {
            t.term.resize(Math.max(20, Math.min(500, obj.cols | 0)), Math.max(5, Math.min(200, obj.rows | 0)));
          }
        } catch {}
      });
      ws.on('close', () => t.clients.delete(ws));
    });
    return;
  }
  // session chat WS：/ws/:sessionId
  const m = url.pathname.match(/^\/ws\/([0-9a-f-]{36})$/);
  if (!m) return socket.destroy();
  const id = m[1];
  const session = sessions.get(id);
  if (!session) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    session.clients.add(ws);
    ws.send(JSON.stringify({ type: 'connected', sessionId: id }));
    if (session.messages.length) {
      ws.send(JSON.stringify({ type: 'history', messages: session.messages }));
    }
    ws.on('close', () => session.clients.delete(ws));
  });
});

const PORT = process.env.PORT || 51735;
// v0.49 N-01 fix: 默认只听 127.0.0.1，避免 PTY/WS 暴露给 LAN。
// 显式 PANEL_HOST=0.0.0.0 才开放全网卡（Electron 本机访问不受影响）。
const HOST = process.env.PANEL_HOST || '127.0.0.1';
// v0.51 T-20 fix: listen 错误处理（端口被占用 / 权限不足等），明确日志告诉用户怎么办
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ 端口 ${PORT} 被占用。运行: lsof -iTCP:${PORT} -sTCP:LISTEN -t | xargs kill -KILL  释放后重启`);
  } else if (err.code === 'EACCES') {
    console.error(`❌ 端口 ${PORT} 权限不足（>1024 才可用 non-root 监听）`);
  } else {
    console.error('❌ server listen 错误:', err.message);
  }
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`🚀 Xike Lab @ http://${HOST}:${PORT}`);
  console.log(`   Using claude bin: ${CLAUDE_BIN}`);
  if (HOST !== '127.0.0.1') {
    console.log(`   ⚠️  监听 ${HOST}（非本地），PTY 终端将暴露给该接口，请确认网络安全`);
  }
  // v0.53 Sprint 3 阶段 3：启动后异步跑一次健康巡检
  setTimeout(() => runHealthSweep().catch(() => {}), 5000);
});

// v0.53 Sprint 3 阶段 3：周期性健康巡检（每 30 分钟一次，发现告警就 broadcastGlobal）
let _lastHealthWarnings = '';
async function runHealthSweep() {
  try {
    const PANEL_DIR = join(homedir(), '.claude-panel');
    const fileSizeMB = (name) => {
      try { return Math.round((statSync(join(PANEL_DIR, name)).size / 1024 / 1024) * 100) / 100; }
      catch { return 0; }
    };
    let metricsMB = 0;
    try {
      const files = readdirSync(PANEL_DIR).filter((f) => /^metrics-\d{4}-\d{2}\.jsonl/.test(f));
      for (const f of files) metricsMB += statSync(join(PANEL_DIR, f)).size;
      metricsMB = Math.round((metricsMB / 1024 / 1024) * 100) / 100;
    } catch {}
    const rssMB = Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100;
    const warnings = [];
    if (rssMB > 1024) warnings.push(`panel 内存占用偏高：${rssMB} MB`);
    if (fileSizeMB('data.json') > 200) warnings.push(`data.json > 200MB（当前 ${fileSizeMB('data.json')}MB）`);
    if (fileSizeMB('rooms.json') > 100) warnings.push(`rooms.json > 100MB（当前 ${fileSizeMB('rooms.json')}MB）`);
    if (metricsMB > 500) warnings.push(`metrics 文件总量 > 500MB（当前 ${metricsMB}MB）`);
    const sig = warnings.join('|');
    if (warnings.length > 0 && sig !== _lastHealthWarnings) {
      _lastHealthWarnings = sig;
      console.warn('[health] warnings:', warnings);
      try { broadcastGlobal({ type: 'health_warning', warnings, at: new Date().toISOString() }); } catch {}
    } else if (warnings.length === 0) {
      _lastHealthWarnings = '';
    }
  } catch (e) {
    console.warn('[health] sweep failed:', e.message);
  }
}
setInterval(() => { runHealthSweep().catch(() => {}); }, 30 * 60 * 1000);

function gracefulShutdown(signal) {
  console.log(`收到 ${signal}，force save data + 关 child...`);
  try { saveData(); } catch (e) { console.error('save fail:', e.message); }
  try { roomStore.flush(); } catch (e) { console.error('roomStore flush fail:', e.message); }
  // v0.51 A-01 fix: 显式 abort dispatchers，让 in-flight adapter.chat 优雅退出
  try {
    if (typeof debateDispatcher !== 'undefined' && debateDispatcher?.activeAborts) {
      for (const id of debateDispatcher.activeAborts.keys()) debateDispatcher.abort(id);
    }
    if (typeof squadDispatcher !== 'undefined' && squadDispatcher?.activeAborts) {
      for (const id of squadDispatcher.activeAborts.keys()) squadDispatcher.abort(id);
    }
    if (typeof arenaDispatcher !== 'undefined' && arenaDispatcher?.activeAborts) {
      for (const id of arenaDispatcher.activeAborts.keys()) arenaDispatcher.abort(id);   // v0.53 fix: 之前漏 arena
    }
    if (typeof soloChatDispatcher !== 'undefined' && soloChatDispatcher?.activeAborts) {
      for (const id of soloChatDispatcher.activeAborts.keys()) soloChatDispatcher.abort(id);
    }
  } catch {}
  for (const s of sessions.values()) {
    if (s.child) try { s.child.kill(); } catch {}
  }
  for (const [, t] of terminals) {
    try { t.term.kill(); } catch {}
  }
  // v0.55 Sprint 12: 断开所有 MCP 连接（fire-and-forget，已 exit）
  try { mcpClientManager.disconnectAll().catch(() => {}); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// v0.45 P0-2: 未捕获异常也强制落盘 + 退出
// v0.51 T-01 fix: uncaughtException 必须 exit
// Node 默认 unhandled exception 会 exit；注册 handler 后默认不 exit → 进程在不一致状态继续跑
// 正确做法：记日志 + 救命落盘 + exit(1)，让 Electron/launchctl/手动重启恢复
// v1.0 Task 1.1：异步引入 Sentry 兼容 ErrorReporter（用户填 DSN 才启用，默认关）
let _reporter = null;
import('./src/telemetry/ErrorReporter.js').then(m => { _reporter = m; }).catch(() => {});

process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e?.stack || e);
  try { _reporter?.captureException(e, { level: 'fatal', tags: { kind: 'uncaught' } }); } catch {}
  try { saveData(); } catch {}
  try { roomStore.flush(); } catch {}
  // S21 B6：100ms 不够 PTY 子进程清理；改 500ms + 提前发 SIGTERM 给子进程
  try { mcpClientManager.disconnectAll().catch(() => {}); } catch {}
  setTimeout(() => process.exit(1), 500);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  try { _reporter?.captureException(reason, { level: 'error', tags: { kind: 'unhandled-rejection' } }); } catch {}
  try { roomStore.flush(); } catch {}
  // unhandledRejection 在 Node 15+ 默认行为是 terminate，但很多 host 仍会容忍；
  // 这里只记日志不 exit，避免 promise 失败误杀整个 panel（可调）
});
