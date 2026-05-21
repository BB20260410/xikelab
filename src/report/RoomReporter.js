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

import { writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const MAX_CONTENT_PER_TURN = 8000;     // 每条 turn 内容 cap，防超长 prompt
const MAX_TOTAL_CONTENT = 200_000;     // 整体 prompt 上限 200K 字符
const REPORT_TIMEOUT = 180_000;        // 报告生成超时 3min

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

/** 把 room 拍平成喂给 SUMMARY_PROMPT 的 markdown 段 */
function flattenRoomContent(room) {
  const lines = [];
  let used = 0;
  function push(s) {
    if (used >= MAX_TOTAL_CONTENT) return;
    const trimmed = s.length > MAX_CONTENT_PER_TURN
      ? s.slice(0, MAX_CONTENT_PER_TURN) + '\n…(单条截断)'
      : s;
    if (used + trimmed.length > MAX_TOTAL_CONTENT) {
      lines.push(trimmed.slice(0, MAX_TOTAL_CONTENT - used));
      used = MAX_TOTAL_CONTENT;
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
      if (used >= MAX_TOTAL_CONTENT) break;
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
        if (used >= MAX_TOTAL_CONTENT) break;
      }
      if (used >= MAX_TOTAL_CONTENT) break;
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
      if (used >= MAX_TOTAL_CONTENT) break;
    }
  }

  // finalConsensus（如果有）
  if (room.finalConsensus) {
    push(`## 已有的最终共识（来自 Judge / PM 总结）\n${room.finalConsensus}\n`);
  }

  return { content: lines.join('\n'), truncated: used >= MAX_TOTAL_CONTENT };
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
  const base = rootDir ? expandHome(rootDir) : join(homedir(), 'Documents', 'claude-panel-reports');
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
 * @returns {Promise<{ok, content, path?, tokensIn, tokensOut, elapsedMs, truncated, error?}>}
 */
export async function generateReport({ room, adapter, model, outputPath } = {}) {
  if (!room) return { ok: false, error: 'room required' };
  if (!adapter || typeof adapter.chat !== 'function') return { ok: false, error: 'adapter (with .chat) required' };

  const startedAt = Date.now();
  const { content: flatContent, truncated } = flattenRoomContent(room);
  if (!flatContent.trim()) {
    return { ok: false, error: '房间内无任何聊天内容可总结' };
  }

  const prompt = summaryPrompt(room, flatContent);
  const messages = [
    { role: 'system', content: `你是一名擅长把多 AI 协作记录浓缩成可读报告的专业编辑。中文输出，事实准确，结构清晰。` },
    { role: 'user', content: prompt },
  ];

  let result;
  try {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), REPORT_TIMEOUT);
    try {
      result = await adapter.chat(messages, {
        cwd: room.cwd || homedir(),
        abortSignal: abortController.signal,
        model: model || '',
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, error: 'adapter.chat 失败: ' + (e.message || String(e)), elapsedMs: Date.now() - startedAt };
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
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, reply, 'utf-8');
      savedPath = abs;
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
    assertionFailed,    // v0.70.2-t2: 给前端 toast 用
  };
}
