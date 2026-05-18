// Claude Panel — 多 Claude 会话管理后端
// 不用 pty（macOS arm64 binding 问题），用 claude stream-json API 模式
// 每条用户消息 = spawn 一次 claude --resume <sid> --input-format stream-json，pipe stdin/stdout

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, copyFileSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { LoopGuard } from './src/safety/LoopGuard.js';
import { DangerousPatternDetector } from './src/safety/DangerousPatternDetector.js';
import { focusChainHeader, buildDoneSummaries } from './src/planner/FocusChain.js';
import { AgentStateMachine } from './src/state/AgentStateMachine.js';
import { CostTracker, estimateUsdFromUsage } from './src/cost/CostTracker.js';
import { MiniMaxAdapter } from './src/watcher/MiniMaxAdapter.js';
import { OllamaAdapter } from './src/watcher/OllamaAdapter.js';
import { loadWatcherConfig, saveWatcherConfig, maskedConfig } from './src/watcher/WatcherConfig.js';
import { WatcherDispatcher } from './src/watcher/WatcherDispatcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/Users/hxx/.npm-global/bin/claude';

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
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json({ limit: '10mb' }));
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
    const data = [...sessions.values()].map(s => ({
      id: s.id, name: s.name, cwd: s.cwd,
      claudeSessionId: s.claudeSessionId,
      createdAt: s.createdAt,
      messages: s.messages.slice(-200), // 最近 200 条
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
      watcherHistory: (s.watcherHistory || []).slice(-50),
    }));
    writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('save fail:', e.message);
  }
}
function loadData() {
  try {
    if (!existsSync(DATA_FILE)) return;
    const data = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
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
        watcherHistory: s.watcherHistory || [],
      });
    }
    console.log(`📂 恢复 ${sessions.size} 个 session`);
  } catch (e) {
    console.error('load fail:', e.message);
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

function broadcastSession(session, msg) {
  for (const ws of session.clients) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch {}
    }
  }
}

function sendMessageToClaude(session, userText) {
  if (session.busy) return {
    ok: false,
    error: 'busy',
    message: '上一条消息 claude 还在处理。等流式输出完成，或点 ⏸ 中断按钮（双击强制释放）后再发。',
  };

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
  session.messages.push(userMsg);
  broadcastSession(session, { type: 'message', message: userMsg });
  debouncedSave();

  const sm = ensureStateMachine(session);
  const tracker = ensureCostTracker(session);

  // v0.13 流式：累积每个 content block 的 partial text，按 block_index 跟踪
  // 同一个 turn 内 message_start → 多个 content_block_start/delta/stop → message_delta → message_stop
  const partialBlocks = new Map(); // block_index → { type, text, toolName? }

  let stdoutBuf = '';
  child.stdout.on('data', d => {
    stdoutBuf += d.toString();
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
                session.messages.push(m);
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
                      session.messages.push(dmsg);
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
                } catch (e) { /* fallback 用原 JSON 截断 */ }
                const m = {
                  role: 'tool_use',
                  content: toolContent,
                  ts: new Date().toISOString()
                };
                session.messages.push(m);
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

  child.on('exit', async (code) => {
    session.busy = false;
    session.child = null;
    if (primedThisTurn) session.handoffPrimed = true;
    broadcastSession(session, { type: 'busy', busy: false, exitCode: code });
    // v0.34 Watcher: turn 结束（exit code=0）触发 dispatcher
    if (code === 0 && watcherDispatcher && session.watcherEnabled) {
      try {
        const r = await watcherDispatcher.onResultEvent(session, { is_error: false });
        // 自动模式 + verdict.continue + 安全过 → 自动把 next_action.prompt 发回 claude
        if (r?.autoExecute && r.prompt) {
          setTimeout(() => sendMessageToClaude(session, r.prompt), 1000);
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
  child.stdin.write(payload);
  child.stdin.end();

  return { ok: true };
}

// ============ v0.32 Watcher 监视者接口（多 LLM 监督 Claude 任务）============
let watcherAdapter = null;
let watcherConfig = loadWatcherConfig();

let watcherDispatcher = null;

function rebuildAdapter() {
  watcherAdapter = null;
  if (!watcherConfig.enabled) return;
  const provider = watcherConfig.provider;
  // ollama 本地不需要 apiKey
  if (provider === 'ollama') {
    watcherAdapter = new OllamaAdapter({
      apiKey: watcherConfig.apiKey || 'ollama',
      model: watcherConfig.model || undefined,
      baseUrl: watcherConfig.baseUrl || undefined,
    });
    return;
  }
  if (!watcherConfig.apiKey) return; // 其他 provider 都需要 key
  if (provider === 'minimax') {
    watcherAdapter = new MiniMaxAdapter({
      apiKey: watcherConfig.apiKey,
      model: watcherConfig.model || undefined,
      baseUrl: watcherConfig.baseUrl || undefined,
    });
  }
  // 未来：gemini / openai / custom
}
function rebuildDispatcher() {
  if (!watcherAdapter) { watcherDispatcher = null; return; }
  watcherDispatcher = new WatcherDispatcher({
    adapter: watcherAdapter,
    config: watcherConfig,
    broadcastFn: (session, msg) => broadcastSession(session, msg),
    dangerDetector: sharedDetector,
  });
}
rebuildAdapter();
rebuildDispatcher();

app.get('/api/watcher/config', (req, res) => {
  res.json({ ok: true, config: maskedConfig(watcherConfig) });
});

app.put('/api/watcher/config', (req, res) => {
  const incoming = req.body || {};
  // 如果 apiKey 是脱敏后的（含 ...），保留原值不覆盖
  if (typeof incoming.apiKey === 'string' && incoming.apiKey.includes('...')) {
    delete incoming.apiKey;
  }
  watcherConfig = { ...watcherConfig, ...incoming };
  const r = saveWatcherConfig(watcherConfig);
  if (!r.ok) return res.status(500).json({ error: r.error });
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
app.get('/api/version', (req, res) => {
  let version = 'unknown';
  let appName = 'Claude Panel';
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
    version = pkg.version || version;
    appName = pkg.productName || pkg.name || appName;
  } catch {}
  // 优先从 HANDOFF.md 顶部 "v0.X" 段解析当前业务版本（比 package.json 更新）
  try {
    const handoff = readFileSync(join(__dirname, 'HANDOFF.md'), 'utf-8');
    const m = handoff.match(/\*\*v(0\.\d+)\*\*/);
    if (m) version = m[1];
  } catch {}
  res.json({ ok: true, version, appName });
});

// 创建 session（I-01/B-01 修：加 cwd 路径合法性校验）
app.post('/api/sessions', (req, res) => {
  const { name, cwd, mainGoal } = req.body || {};
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
  } catch (e) {
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
  }
  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    s.name = req.body.name.trim();
  }
  if (typeof req.body?.mainGoal === 'string') {
    s.mainGoal = req.body.mainGoal.trim() || null;
  }
  if (typeof req.body?.guardLevel === 'string' && ['strict', 'standard', 'loose'].includes(req.body.guardLevel)) {
    s.guardLevel = req.body.guardLevel;
  }
  // v0.34 Watcher per-session toggle
  if (typeof req.body?.watcherEnabled === 'boolean') {
    s.watcherEnabled = req.body.watcherEnabled;
  }
  // v0.36 真测 P1 fix: PATCH 立即 save（不 debounce 避免 kill 时丢数据）
  saveData();
  res.json({ ok: true, archived: !!s.archived, name: s.name, mainGoal: s.mainGoal, guardLevel: s.guardLevel, watcherEnabled: !!s.watcherEnabled });
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
    watcherHistory: (s.watcherHistory || []).slice(-20),
  });
});

// 发消息
app.post('/api/sessions/:id/messages', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const text = req.body?.text;
  if (!text || !text.trim()) return res.status(400).json({ error: 'empty text' });
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
  sessions.delete(req.params.id);
  debouncedSave();
  res.json({ ok: true });
});

// 列 cwd 下文件（文件浏览器用）
app.get('/api/files', (req, res) => {
  let path = req.query.path || homedir();
  if (path.startsWith('~')) path = path.replace(/^~/, homedir());
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
    res.status(500).json({ error: e.message });
  }
});

// 读文件预览
app.get('/api/file', (req, res) => {
  let path = req.query.path;
  if (!path) return res.status(400).json({ error: 'no path' });
  if (path.startsWith('~')) path = path.replace(/^~/, homedir());
  try {
    const st = statSync(path);
    if (st.size > 1024 * 1024) {
      return res.json({ path, truncated: true, content: '(file > 1MB, truncated)' });
    }
    const content = readFileSync(path, 'utf-8');
    res.json({ path, size: st.size, content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v0.28 cost 时序（每分钟桶聚合）
app.get('/api/sessions/:id/cost-series', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const win = Math.max(5, Math.min(180, parseInt(req.query.windowMin || '30', 10)));
  const series = s.costTracker ? s.costTracker.seriesByMinute(win) : [];
  res.json({ ok: true, windowMin: win, series });
});

// v0.27 安全历史（DangerDetector + LoopGuard）
app.get('/api/sessions/:id/safety-history', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({
    ok: true,
    danger: s.dangerHistory || [],
    loopGuard: s.loopGuardHistory || [],
    stateHistory: s.stateMachine ? s.stateMachine.transitions : [],
    currentState: s.stateMachine ? s.stateMachine.current : (s.runState || 'idle'),
    guardSnapshot: s.guard ? s.guard.snapshot() : null,
  });
});

// 中断 busy
app.post('/api/sessions/:id/interrupt', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.child) {
    try { s.child.kill('SIGINT'); } catch {}
  }
  s.busy = false;
  broadcastSession(s, { type: 'busy', busy: false }); // v0.20 修：丢消息时让前端能同步
  res.json({ ok: true });
});

// v0.20 强制释放卡住的 busy 状态（child 已死但 busy 没复位的兜底）
app.post('/api/sessions/:id/reset-busy', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const wasChildAlive = s.child && !s.child.killed;
  if (s.child) {
    try { s.child.kill('SIGTERM'); } catch {}
    s.child = null;
  }
  s.busy = false;
  s.pid = null;
  broadcastSession(s, { type: 'busy', busy: false, forced: true });
  res.json({ ok: true, hadChild: wasChildAlive });
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
    res.status(500).json({ error: e.message });
  }
});

// 端点：单项目详情（含 STATUS/BLOCKED/最近 PROGRESS）
app.get('/api/projects/:name', (req, res) => {
  const projDir = join(PROJECTS_ROOT, req.params.name);
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
    res.status(500).json({ error: e.message });
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
    } catch (e) { return res.status(500).json({ error: e.message }); }
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

// 触发逻辑接力：归档当前 snapshot + 在 panel 内新建同 cwd 的 session
// 新 session 第一条消息预置 HANDOFF 内容，让新 claude 自动接手
app.post('/api/sessions/:id/handoff', (req, res) => {
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
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
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
    appendFileSync(logPath, JSON.stringify(entry) + '\n');
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
app.post('/api/sessions/:id/external', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const cwd = s.cwd.replace(/'/g, "'\\''");
  const script = `tell application "Terminal"
    activate
    do script "cd '${cwd}' && claude --dangerously-skip-permissions${s.claudeSessionId ? ` --resume ${s.claudeSessionId}` : ''}"
end tell`;
  const proc = spawn('osascript', ['-e', script]);
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
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });
  proc.on('exit', code => {
    if (code !== 0 && stderr) console.error('login-claude osascript fail:', stderr);
  });
  res.json({ ok: true, message: '已在 Terminal 打开 claude /login，请完成 OAuth 后回来' });
});

// 同时 spawn 多个 Terminal 窗口（批量）
app.post('/api/spawn-batch', (req, res) => {
  const ids = req.body?.ids || [];
  const result = [];
  for (const id of ids) {
    const s = sessions.get(id);
    if (!s) continue;
    const cwd = s.cwd.replace(/'/g, "'\\''");
    const script = `tell application "Terminal"
      activate
      do script "cd '${cwd}' && claude --dangerously-skip-permissions${s.claudeSessionId ? ` --resume ${s.claudeSessionId}` : ''}"
    end tell`;
    spawn('osascript', ['-e', script]);
    result.push({ id, cwd: s.cwd });
  }
  res.json({ ok: true, spawned: result });
});

// 浏览目录
app.get('/api/browse', (req, res) => {
  let path = req.query.path || process.env.HOME;
  if (path.startsWith('~')) path = path.replace(/^~/, process.env.HOME);
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
    res.status(500).json({ error: e.message });
  }
});

// ============ v0.22 PTY 内嵌真终端 ============
const terminals = new Map(); // termId → { term, clients: Set, cwd, createdAt }

app.post('/api/term', (req, res) => {
  const { cwd, cols = 80, rows = 24, shell } = req.body || {};
  const termId = randomUUID();
  let workDir = (cwd && typeof cwd === 'string' && cwd.trim()) ? cwd.trim() : homedir();
  if (workDir.startsWith('~')) workDir = workDir.replace(/^~/, homedir());
  try {
    const st = statSync(workDir);
    if (!st.isDirectory()) workDir = homedir();
  } catch { workDir = homedir(); }
  const shellBin = shell || process.env.SHELL || '/bin/zsh';
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
  terminals.delete(req.params.id);
  res.json({ ok: true });
});

// WS upgrade
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
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

const PORT = process.env.PORT || 5173;
server.listen(PORT, () => {
  console.log(`🚀 Claude Panel @ http://localhost:${PORT}`);
  console.log(`   Using claude bin: ${CLAUDE_BIN}`);
});

function gracefulShutdown(signal) {
  console.log(`收到 ${signal}，force save data + 关 child...`);
  try { saveData(); } catch (e) { console.error('save fail:', e.message); }
  for (const s of sessions.values()) {
    if (s.child) try { s.child.kill(); } catch {}
  }
  for (const [, t] of terminals) {
    try { t.term.kill(); } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
