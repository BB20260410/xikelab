// v0.54 Sprint 9 — Room Reporter：让 AI 浓缩房内所有 turn 内容生成报告
//
// 跟 ArchiveStore 的区别：
//   - ArchiveStore：原样导出 markdown（full-transcript.md 全文 + meta.json）
//   - RoomReporter：调 AI 跑 SUMMARY_PROMPT 浓缩成 5-10 节人类可读报告
//
// 流程：
//   1) 按 room.mode 选对应 SUMMARY_PROMPT 变体
//   2) 拼 room 的 conversation/rounds/tasks → 喂给 prompt
//   3) 调 adapter.chat（默认 claude） → 拿 reply（markdown 报告）
//   4) 可选：写盘到用户指定路径（沙箱）+ 返回内容

import { writeFileSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const MAX_CONTENT_PER_TURN = 32_000;   // 每条 turn 内容 cap，防超长 prompt
const MAX_TOTAL_CONTENT = 1_500_000;   // 整体 prompt 上限 1.5M 字符（≈ 750K tokens 中文 / 375-500K tokens 混合，安全装入 claude/gemini 1M context）
const PROMPT_OVERHEAD_RESERVE = 32_000; // system/user 模板、AGENTS/skill 元信息、输出空间预留
const DEFAULT_CONTEXT_RETRY_CONTENT = 120_000;
const MIN_CONTEXT_RETRY_CONTENT = 24_000;
const MAX_REPORT_CHUNKS = 18;
const MAX_CHUNK_SUMMARY_CHARS = 8_000;
const REPORT_TIMEOUT = 480_000;        // 报告生成超时 8min（大内容 AI 处理慢）

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

function safeFilename(s, maxLen = 80) {
  return String(s || '')
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, maxLen) || '未命名';
}

function isPathSafe(absPath) {
  const home = homedir();
  const allowed = [home, '/tmp', '/private/tmp', '/Volumes'];
  if (!allowed.some((root) => absPath === root || absPath.startsWith(root + '/'))) return false;
  const forbidden = ['/.ssh', '/.aws', '/.gnupg', '/.docker', '/.kube', '/Library/Keychains'];
  if (forbidden.some((seg) => absPath.includes(home + seg))) return false;
  return true;
}

const MODE_LABEL = { debate: '辩论', squad: '小组', arena: '对决', chat: '闲聊' };

/** 把 room 拍平成喂给 SUMMARY_PROMPT 的 markdown 段
 *  @param maxChars 整体字符上限，默认 MAX_TOTAL_CONTENT；可被 adapter.maxPromptChars 覆盖到更低值（如 codex 1M）
 */
function flattenRoomContent(room, maxChars = MAX_TOTAL_CONTENT) {
  const lines = [];
  let used = 0;
  function push(s) {
    if (used >= maxChars) return;
    const trimmed = s.length > MAX_CONTENT_PER_TURN
      ? s.slice(0, MAX_CONTENT_PER_TURN) + '\n…(单条截断)'
      : s;
    if (used + trimmed.length > maxChars) {
      lines.push(trimmed.slice(0, maxChars - used));
      used = maxChars;
    } else {
      lines.push(trimmed);
      used += trimmed.length;
    }
  }

  if (room.topic) {
    push(`## 任务 / topic\n${room.topic}\n`);
  }

  // chat: conversation
  if (room.mode === 'chat' && Array.isArray(room.conversation)) {
    push(`## 对话记录（${room.conversation.length} 条）\n`);
    for (const c of room.conversation) {
      if (c.thinking) continue;
      const who = c.from === 'user' ? '【用户】' : `【${c.displayName || c.from}】`;
      push(`### ${who} ${c.at || ''}\n${c.content || ''}\n`);
      if (used >= maxChars) break;
    }
  }

  // debate / arena: rounds[].turns[]
  if (Array.isArray(room.rounds) && room.rounds.length > 0) {
    push(`## 各轮发言（${room.rounds.length} 轮）\n`);
    for (const r of room.rounds) {
      push(`### Round: ${r.kind}\n`);
      for (const t of (r.turns || [])) {
        const tag = t.error ? '❌ ' : '';
        push(`#### ${tag}${t.displayName || t.speaker}${t.tokensOut ? ` (${t.tokensOut} tok)` : ''}\n${t.content || ''}\n`);
        if (used >= maxChars) break;
      }
      if (used >= maxChars) break;
    }
  }

  // squad: taskList
  if (Array.isArray(room.taskList) && room.taskList.length > 0) {
    push(`## 任务清单（${room.taskList.length} 个）\n`);
    for (const t of room.taskList) {
      push(`### ${t.id} ${t.title || ''}\n- status: ${t.status}\n- desc: ${(t.desc || '').replace(/\n/g, ' ')}\n`);
      if (t.escalateReason) push(`- 搁置原因: ${t.escalateReason}\n`);
      const lastGood = [...(t.attempts || [])].reverse().find((a) => !a.error);
      if (lastGood) push(`**Dev 最终交付**：\n${lastGood.content || ''}\n`);
      const lastReview = (t.reviews || [])[t.reviews.length - 1];
      if (lastReview) push(`**QA 最终 verdict**：${lastReview.verdict} — ${lastReview.reasoning || ''}\n`);
      if (used >= maxChars) break;
    }
  }

  // finalConsensus（如果有）
  if (room.finalConsensus) {
    push(`## 已有的最终共识（来自 Judge / PM 总结）\n${room.finalConsensus}\n`);
  }

  return { content: lines.join('\n'), truncated: used >= maxChars };
}

function finitePositive(n) {
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

function getInitialContentLimit(adapter) {
  const stdinHardLimit = finitePositive(adapter?.maxPromptChars);
  const promptSafeLimit = stdinHardLimit === Infinity
    ? Infinity
    : Math.max(MIN_CONTEXT_RETRY_CONTENT, stdinHardLimit - PROMPT_OVERHEAD_RESERVE);
  const reportSoftLimit = finitePositive(adapter?.maxReportContentChars);
  return Math.min(MAX_TOTAL_CONTENT, promptSafeLimit, reportSoftLimit);
}

function getRetryContentLimit(adapter, previousLimit) {
  const configured = finitePositive(adapter?.contextRetryContentChars);
  const target = configured === Infinity ? DEFAULT_CONTEXT_RETRY_CONTENT : configured;
  return Math.max(MIN_CONTEXT_RETRY_CONTENT, Math.min(target, Math.floor(previousLimit / 4)));
}

function isContextWindowError(e) {
  const haystack = `${e?.code || ''}\n${e?.message || ''}\n${e?.stderr || ''}\n${e?.stdout || ''}`;
  return /CONTEXT_WINDOW|out of room in the model'?s context window|context window|context length|max(?:imum)? context|too many tokens|prompt is too long|input is too long/i.test(haystack);
}

function trimAdapterError(e) {
  const raw = e?.message || String(e || '');
  if (isContextWindowError(e)) {
    return 'adapter.chat 失败: 模型上下文窗口不足，已自动压缩并重试后仍失败；请换用更大上下文 adapter，或先归档/拆分房间记录';
  }
  return 'adapter.chat 失败: ' + (raw.length > 1200 ? raw.slice(0, 1200) + '...(已截断)' : raw);
}

function buildReportMessages(room, contentLimit) {
  const { content: flatContent, truncated } = flattenRoomContent(room, contentLimit);
  if (!flatContent.trim()) return { error: '房间内无任何聊天内容可总结' };
  const prompt = summaryPrompt(room, flatContent);
  const projectContext = room?.projectContext?.prompt
    ? `\n\n${room.projectContext.prompt}`
    : '';
  const messages = [
    { role: 'system', content: `你是一名擅长把多 AI 协作记录浓缩成可读报告的专业编辑。中文输出，事实准确，结构清晰。${projectContext}` },
    { role: 'user', content: prompt },
  ];
  return { messages, truncated, sourceContentChars: flatContent.length, contentLimit };
}

function shouldUseChunkedReport(adapter, sourceContentChars, contentLimit) {
  return Number.isFinite(adapter?.maxReportContentChars)
    && Number.isFinite(contentLimit)
    && sourceContentChars > contentLimit;
}

function capText(s, maxChars) {
  const text = String(s || '').trim();
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n...(分块摘要截断)';
}

function splitReportChunks(text, chunkChars, maxChunks = MAX_REPORT_CHUNKS) {
  const chunks = [];
  const maxChunk = Math.max(MIN_CONTEXT_RETRY_CONTENT, Math.floor(chunkChars || MIN_CONTEXT_RETRY_CONTENT));
  let cursor = 0;

  while (cursor < text.length && chunks.length < maxChunks) {
    let end = Math.min(text.length, cursor + maxChunk);
    if (end < text.length) {
      const slice = text.slice(cursor, end);
      const minBreak = Math.floor(slice.length * 0.55);
      let breakAt = -1;
      for (const marker of ['\n### ', '\n## ', '\n\n']) {
        const idx = slice.lastIndexOf(marker);
        if (idx > minBreak) {
          breakAt = idx;
          break;
        }
      }
      if (breakAt > 0) end = cursor + breakAt;
    }
    if (end <= cursor) end = Math.min(text.length, cursor + maxChunk);
    const chunk = text.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);
    cursor = end;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  }

  return { chunks, omittedChars: Math.max(0, text.length - cursor) };
}

function buildChunkSummaryMessages(room, chunk, index, total) {
  const modeLabel = MODE_LABEL[room.mode] || room.mode;
  const prompt = `# 分块摘要任务

你正在为一间「${modeLabel}房」生成最终报告的中间摘要。下面是完整聊天记录中的第 ${index + 1}/${total} 块。

请只基于本块内容输出中文 markdown 摘要，目标是供后续合并成最终报告。要求：
- 保留本块出现的关键事实、决策、分歧、未解决问题、可执行下一步
- 保留重要人名 / adapter 名 / 时间线 / 文件路径 / 报错信息
- 不要复述原文，不要输出寒暄或说明文字
- 控制在 1200-2000 字之间；信息密度优先

## 房间信息
- 房名：${room.name || '未命名'}
- 模式：${modeLabel}（${room.mode}）
- 房间 ID：${room.id || '-'}

## 本块原文
${chunk}`;

  return [
    { role: 'system', content: '你是多 AI 协作记录的分块摘要器。只抽取事实和决策，不发挥。' },
    { role: 'user', content: prompt },
  ];
}

function buildFinalFromChunkMessages(room, summaries, meta = {}) {
  const joined = summaries.map((s, i) => `## 分块摘要 ${i + 1}\n${s}`).join('\n\n');
  const omitted = meta.omittedChars > 0
    ? `\n\n## 截断说明\n由于报告输入预算限制，仍有约 ${meta.omittedChars} 字符未进入分块摘要。`
    : '';
  const content = `## 生成策略
本报告由系统先对原始房间记录分块摘要，再合并生成最终报告。请基于下面的分块摘要生成一份完整、自洽、面向用户的最终报告。

${joined}${omitted}`;

  const prompt = summaryPrompt(room, content);
  return [
    { role: 'system', content: `你是一名擅长把多 AI 协作记录浓缩成可读报告的专业编辑。中文输出，事实准确，结构清晰。` },
    { role: 'user', content: prompt },
  ];
}

async function runChunkedReport({ room, flatContent, flatTruncated, contentLimit, callAdapter }) {
  const { chunks, omittedChars } = splitReportChunks(flatContent, contentLimit);
  if (!chunks.length) throw new Error('报告分块失败：没有可总结内容');

  const summaries = [];
  let tokensIn = 0;
  let tokensOut = 0;
  for (let i = 0; i < chunks.length; i++) {
    const r = await callAdapter(buildChunkSummaryMessages(room, chunks[i], i, chunks.length));
    tokensIn += r?.tokensIn || 0;
    tokensOut += r?.tokensOut || 0;
    summaries.push(capText(r?.reply || '', MAX_CHUNK_SUMMARY_CHARS));
  }

  const final = await callAdapter(buildFinalFromChunkMessages(room, summaries, { omittedChars }));
  return {
    result: {
      ...final,
      tokensIn: tokensIn + (final?.tokensIn || 0),
      tokensOut: tokensOut + (final?.tokensOut || 0),
    },
    chunkCount: chunks.length,
    truncated: flatTruncated || omittedChars > 0,
    omittedChars,
    sourceContentChars: flatContent.length,
  };
}

/** 按 room.mode 选 prompt 模板 */
function summaryPrompt(room, content) {
  const modeLabel = MODE_LABEL[room.mode] || room.mode;
  const memberList = (room.members || []).filter((m) => m.enabled !== false)
    .map((m) => m.displayName || m.adapterId).join(' / ');
  const common = `# 你的角色：${modeLabel}房记录总结员

## 🎯 OBJECTIVE
把下面这间「${modeLabel}房」从开始到现在的全部聊天记录浓缩成一份**人类可读的总结报告**。读者不会再回头看原始记录，所以报告必须**自洽完整**——含必要的上下文，不依赖原文。

## 📥 房间信息
- **房名**：${room.name || '未命名'}
- **模式**：${modeLabel}（${room.mode}）
- **创建时间**：${room.createdAt || '-'}
- **参与成员**：${memberList || '(无)'}

## 📦 全部聊天记录原文
${content}
`;

  // 各 mode 不同的输出格式要求
  if (room.mode === 'debate') {
    return common + `
## 📤 OUTPUT FORMAT（中文 markdown，严格 6 节）

### 1. 议题与背景
1-2 段说明这次辩论想解决什么问题、为什么需要多 AI 视角。

### 2. 各方核心立场
列出每个成员的最终立场（不是每一轮的复述，而是**最终的精炼版**）。每人 1 段。

### 3. 共识点
所有人都同意的部分（列 3-8 条要点）。

### 4. 关键分歧
仍有分歧的问题（列 0-5 条 + 各方观点 + 分歧本质）。

### 5. 最终结论 / 推荐方案
一份完整、可执行、自包含的方案（这是读者最需要的部分）。如果各方未达成统一，列出"分情况推荐"。

### 6. 元数据
- 共 N 大轮、M 个 turn
- 哪个 AI 改变过立场（如果有）
- 报告本身耗时（先留空，由系统填充）

## ⛔ BOUNDARY
- 不要复述每一轮（那是 transcript 的工作）
- 不要加你的主观判断（除非用户提出"评估各方观点"这种明确要求）
- 不要 markdown 围栏，前后无说明文字`;
  }

  if (room.mode === 'arena') {
    return common + `
## 📤 OUTPUT FORMAT（中文 markdown，严格 5 节）

### 1. 待解决问题
1 段说明这次对决要回答的具体问题。

### 2. 各方独立提案精炼
对每份匿名提案（A/B/C/D）给一段精炼，不复述全文。

### 3. 联网核对结果
Judge 用 WebSearch/WebFetch 真核实出来的事实点列表（哪条对、哪条错、哪条过期）。

### 4. 综合最优答案
基于核对后的事实，给一份完整自洽的最优答案（这是读者最关心的）。

### 5. 来源标注
关键结论的依据（来自哪份提案 / Judge 哪次 fetch）。

## ⛔ BOUNDARY
- 不要复述每份提案全文
- 事实点必须可核对，不要凭印象
- 不要 markdown 围栏，前后无说明文字`;
  }

  if (room.mode === 'squad') {
    return common + `
## 📤 OUTPUT FORMAT（中文 markdown，严格 6 节）

### 1. 项目目标
1 段说明这次协作想交付什么。

### 2. 任务拆分
PM 把任务拆成了哪 N 个子任务，依赖关系如何，列表展示。

### 3. 各任务成果
每个 task 一段：Dev 谁来做、迭代了几次、QA 几次打回、最终交付物是什么（精炼版，不复述全文）。

### 4. 整合后的完整交付
把所有 task 的成果整合成一份可直接用的完整方案（这是读者最关心的）。

### 5. 已搁置 / 待办
哪些 task 失败或需要人工介入，逐条列原因 + 建议下一步。

### 6. 协作复盘
- 平均迭代次数
- 主要 QA issue
- 哪些环节卡过

## ⛔ BOUNDARY
- 不要逐 attempt 复述（那是 transcript）
- 不要 markdown 围栏，前后无说明文字`;
  }

  // chat
  return common + `
## 📤 OUTPUT FORMAT（中文 markdown，严格 5 节）

### 1. 对话主题
1 段说明这次对话围绕什么主题、用户主要想达成什么。

### 2. 关键观点 / 信息点
按时间顺序列出对话中浮现的关键信息（每条 1-3 句，最多 15 条）。

### 3. 已达成的结论 / 决定
对话中明确确认的事项（列表）。如果没有，明确写"未达成结论"。

### 4. 未解决 / 留待之后的问题
对话中提出但未解决的问题（列表）。

### 5. 建议下一步
基于对话内容，给读者 2-5 条可执行的下一步建议。

## ⛔ BOUNDARY
- 不要复述每条消息（那是 transcript）
- 关键观点必须能在原文找到对应位置
- 不要 markdown 围栏，前后无说明文字`;
}

/** 默认输出文件名：<rootDir>/<roomName>-report-<YYYY-MM-DD-HHmmss>.md */
export function defaultReportPath(room, rootDir) {
  const base = rootDir ? expandHome(rootDir) : join(homedir(), 'Documents', 'xikelab-reports');
  const d = new Date();
  const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const filename = `${safeFilename(room.name || '未命名')}-report-${ts}.md`;
  return join(base, filename);
}

/**
 * 生成报告（核心入口）
 * @param {object} params
 * @param {object} params.room - 房间对象
 * @param {object} params.adapter - RoomAdapter 实例（有 .chat 方法）
 * @param {string?} params.model - 可选 model 名
 * @param {string?} params.outputPath - 可选写盘路径；不传则只返回 content
 * @param {number?} params.timeoutMs - 可选报告硬超时；测试可传小值
 * @returns {Promise<{ok, content, path?, tokensIn, tokensOut, elapsedMs, truncated, error?}>}
 */
export async function generateReport({ room, adapter, model, outputPath, timeoutMs = REPORT_TIMEOUT } = {}) {
  if (!room) return { ok: false, error: 'room required' };
  if (!adapter || typeof adapter.chat !== 'function') return { ok: false, error: 'adapter (with .chat) required' };

  const startedAt = Date.now();
  const fullContent = flattenRoomContent(room, MAX_TOTAL_CONTENT);
  if (!fullContent.content.trim()) {
    return { ok: false, error: '房间内无任何聊天内容可总结' };
  }
  // adapter.maxPromptChars 只表示传输/CLI stdin 硬上限；maxReportContentChars 才表示报告输入的上下文预算。
  let contentLimit = getInitialContentLimit(adapter);
  let built = buildReportMessages(room, contentLimit);
  if (built.error) return { ok: false, error: built.error };
  let { messages, truncated, sourceContentChars } = built;
  let retryReason = null;
  let reportStrategy = 'single';
  let chunkCount = 0;
  let omittedChars = 0;

  let result;
  try {
    const callAdapter = async (attemptMessages) => {
      const abortController = new AbortController();
      let timedOut = false;
      const reportTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REPORT_TIMEOUT;
      let timer = null;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          abortController.abort();
          reject(new Error(`报告生成超时 ${reportTimeout}ms，已中断 adapter`));
        }, reportTimeout);
      });
      try {
        return await Promise.race([
          adapter.chat(attemptMessages, {
            cwd: room.cwd || homedir(),
            abortSignal: abortController.signal,
            model: model || '',
            skipResilience: true,
            disableMcp: true,
            budgetContext: { projectId: room.cwd || homedir(), roomId: room.id || null, adapterId: adapter.id || null },
          }),
          timeoutPromise,
        ]);
      } catch (e) {
        if (timedOut) {
          e.code = e.code || 'REPORT_TIMEOUT';
          throw e;
        }
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      if (shouldUseChunkedReport(adapter, fullContent.content.length, contentLimit)) {
        const chunked = await runChunkedReport({
          room,
          flatContent: fullContent.content,
          flatTruncated: fullContent.truncated,
          contentLimit,
          callAdapter,
        });
        result = chunked.result;
        truncated = chunked.truncated;
        sourceContentChars = chunked.sourceContentChars;
        reportStrategy = 'map-reduce';
        retryReason = 'map-reduce';
        chunkCount = chunked.chunkCount;
        omittedChars = chunked.omittedChars;
      } else {
        result = await callAdapter(messages);
      }
    } catch (e) {
      if (!isContextWindowError(e)) throw e;
      const retryLimit = getRetryContentLimit(adapter, contentLimit);
      if (retryLimit >= contentLimit) throw e;
      retryReason = 'context-window-retry';
      contentLimit = retryLimit;
      if (shouldUseChunkedReport(adapter, fullContent.content.length, contentLimit)) {
        const chunked = await runChunkedReport({
          room,
          flatContent: fullContent.content,
          flatTruncated: true,
          contentLimit,
          callAdapter,
        });
        result = chunked.result;
        truncated = true;
        sourceContentChars = chunked.sourceContentChars;
        reportStrategy = 'map-reduce';
        chunkCount = chunked.chunkCount;
        omittedChars = chunked.omittedChars;
      } else {
        built = buildReportMessages(room, contentLimit);
        if (built.error) return { ok: false, error: built.error };
        messages = built.messages;
        truncated = true;
        sourceContentChars = built.sourceContentChars;
        result = await callAdapter(messages);
      }
    }
  } catch (e) {
    if (e?.code === 'REPORT_TIMEOUT') return { ok: false, error: e.message || String(e), elapsedMs: Date.now() - startedAt };
    return { ok: false, error: trimAdapterError(e), elapsedMs: Date.now() - startedAt, retryReason };
  }

  let reply = (result && typeof result.reply === 'string') ? result.reply : '';
  if (!reply.trim()) {
    return { ok: false, error: 'adapter 返回空 reply', elapsedMs: Date.now() - startedAt };
  }

  // v0.70 W11 集成：报告输出质量自动校验（学自 promptfoo assertion）
  // v0.70.2-t2 增强：失败项保存到 result.assertionFailed，让 server 广播给前端 toast
  let assertionFailed = [];
  try {
    const { runAssertions } = await import('../skills/learned/assertion.js');
    const { allPass, failed } = runAssertions(reply, [
      { type: 'min_length', value: 200 },                  // 报告太短大概率废
      { type: 'not_contains', value: 'I cannot' },         // 防 refusal（英文）
      { type: 'not_contains', value: '我不能为' },          // 防 refusal（中文）
    ]);
    if (!allPass) {
      assertionFailed = failed.map(f => ({ type: f.type, reason: f.reason }));
      // 不阻断，只在报告头部标 warning 让用户知道
      reply = `<!-- ⚠️ 报告质量校验 ${failed.length} 项未通过: ${failed.map(f => f.type).join(', ')} -->\n\n` + reply;
    }
  } catch {}

  // 报告头部加生成元信息
  const header = `<!-- ${room.name || '未命名'} 总结报告
generatedAt: ${new Date().toISOString()}
generatedBy: ${adapter.id || 'unknown-adapter'}${model ? ' / ' + model : ''}
roomMode: ${room.mode}
roomId: ${room.id}
contentTruncated: ${truncated}
sourceContentChars: ${sourceContentChars}
sourceContentLimit: ${contentLimit}
reportStrategy: ${reportStrategy}
chunkCount: ${chunkCount}
omittedChars: ${omittedChars}
retryReason: ${retryReason || ''}
-->

`;
  reply = header + reply;

  // 写盘（如果指定 outputPath）
  let savedPath = null;
  if (outputPath && typeof outputPath === 'string' && outputPath.trim()) {
    const abs = expandHome(outputPath.trim());
    if (!isPathSafe(abs)) {
      return { ok: false, error: `outputPath 越权或敏感目录: ${abs}`, content: reply, elapsedMs: Date.now() - startedAt };
    }
    try {
      // 防 EISDIR：用户传的是目录路径（如 ~/Desktop）时，把它当作 rootDir，
      // 用 defaultReportPath 拼出 <abs>/<roomName>-report-<ts>.md。
      // statSync 抛 ENOENT 当作"用户传的是不存在的文件路径"继续。
      let target = abs;
      try {
        if (statSync(abs).isDirectory()) {
          target = defaultReportPath(room, abs);
        }
      } catch { /* 路径不存在 → 当作文件路径继续 */ }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, reply, 'utf-8');
      savedPath = target;
    } catch (e) {
      return { ok: false, error: '写盘失败: ' + e.message, content: reply, elapsedMs: Date.now() - startedAt };
    }
  }

  return {
    ok: true,
    content: reply,
    path: savedPath,
    tokensIn: result.tokensIn || 0,
    tokensOut: result.tokensOut || 0,
    elapsedMs: Date.now() - startedAt,
    truncated,
    sourceContentChars,
    sourceContentLimit: contentLimit,
    reportStrategy,
    chunkCount,
    omittedChars,
    retryReason,
    assertionFailed,    // v0.70.2-t2: 给前端 toast 用
  };
}
