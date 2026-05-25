// CollaborationDispatcher — Squad 协作模式编排
//
// 流程：
// 1. PM 拆任务：用户给 topic → PM 角色输出 JSON taskList + 依赖图
// 2. 拓扑找 ready：无依赖 task 并行启动
// 3. Dev 实现：assignee dev 收到 task spec → 输出 deliverable
// 4. QA 审查：reviewer qa 拿 deliverable → JSON verdict
// 5. pass → done，触发后续依赖解锁；reject → 自动打回 dev 重做（iterations++）
// 6. iterations >= maxIterations → escalate（停下找 user）
// 7. 全部 done/escalated → 输出整体交付

import { randomUUID } from 'node:crypto';
import { TaskGraph } from './TaskGraph.js';
import { SQUAD_LIMITS, PROMPT_VERSIONS, CONTENT_LIMITS } from './squad-limits.js';
import { metricsStore as defaultMetricsStore } from '../metrics/MetricsStore.js';
import { buildRoomAgentContext, injectSkillsToMessages } from './skillInjector.js';
import { findRoleCard, formatRoleCardForPrompt } from './roleCards.js';
import { summarizeAgentRuntimeContext } from '../agents/AgentSkillRegistry.js';

const PM_PROMPT = (topic, members, room) => `# 你的角色：squad PM（项目经理）

## 🎯 OBJECTIVE
把用户任务拆成 3-8 个可独立交付的子任务，并指明依赖关系，让 dev/qa 能按依赖图并行/串行执行。

## 📥 INPUT
### 用户任务
${topic}

### 队员名单与角色卡
${members.map(m => {
  const card = findRoleCard(room, m);
  return `- ${m.displayName}（role=${m.role}${m.specialty ? '/' + m.specialty : ''}）adapterId=${m.adapterId}
  - reportTo: ${card.reportTo || 'user'}
  - responsibility: ${card.responsibility}
  - scope: ${(card.scope || []).join(', ')}`;
}).join('\n')}

## 📤 OUTPUT FORMAT
严格 JSON（不要 markdown 围栏，不要前后任何说明文字）：
{
  "tasks": [
    {
      "id": "T1",                          // 短 id，T1/T2/T3...
      "title": "...",                       // 一句话标题
      "desc": "...",                        // 2-5 句具体描述，**必须含验收标准**
      "assigneeId": "...",                  // dev 角色队员 adapterId
      "reviewerId": "...",                  // qa 角色队员 adapterId
      "dependencies": ["T_OTHER_ID", ...]   // 没依赖填 []
    }
  ]
}

## 🛠 TOOLS GUIDANCE
- 你**只**做拆任务，**不**实现任务
- assignee 必须从 dev 角色队员里挑；reviewer 必须从 qa 角色队员里挑
- 不要把 task 分给超出角色卡 scope 的成员；Dev 只做实现，QA 只做验证，PM 只做拆分和总结
- 不要把多个语义合并成一个 task（一个 task 一件清晰可验收的事）
- 依赖图必须是 DAG（无环），不能 A→B 又 B→A
- 描述里的"验收标准"会被 QA 直接用来判 pass/reject，必须**可观察、可验证**（"代码能跑通 + 输出包含 X 字符串"而非"代码质量好"）

## ⚡ 并行优先（v0.52 强化）
- **强烈优先拆出可并行（无依赖）的 task**——dev 池有多个成员，无依赖 task 会同时跑、效率高 N 倍
- 只有**真有先后关系**才声明 dependencies（B 必须读 A 的产出 / B 调用 A 的 API）
- ❌ 反例：T1 调研 → T2 验证 → T3 深度分析 → T4 整合（链式 = 串行 = 慢）
- ✅ 正例：T1/T2/T3 各调研一个独立方向（并行）→ T4 整合三方结论（T4 依赖 T1/T2/T3）
- 一个 topic 能拆 5 个独立 task + 1 个整合 task 时，**绝对不要**拆成 5 个链式 task
- 调研、验证、分析、对比这类工作 90% 都可拆并行——按"维度"切而不是按"流程"切

## ⛔ TASK BOUNDARY
- 不要替 dev 写实现细节，dev 自己设计
- 不要预判方案对错（那是 QA 的事）
- 不要写"研究 X 的可行性"这种含糊任务，要写"用 X 实现 Y，验收：测试 Z 通过"
- **不要限制 dev 的输出格式**——Dev 必须按固定模板输出 \`### 实现 / 方案\` + \`### 完成情况自查\` 两节 markdown。task.desc 的验收标准只能针对"实现段的内容"（如"代码能跑通"/"输出含 X 字符串"），**不能**写"不准用 markdown"/"不准带自查段"这种限制 dev 框架的要求，否则会卡死循环
- 输出只能是上述 JSON 对象一个，前后零文字`;

const DEV_PROMPT = (task, topic, previousReviews, roleCard) => {
  // v0.52 拿上一次的非 error 实现，给 dev 看自己写过啥（防止每次重写丢上下文）
  const lastAttempt = [...(task.attempts || [])].reverse().find(a => !a.error);
  const isRedo = previousReviews && previousReviews.length > 0;
  const lastReview = isRedo ? previousReviews[previousReviews.length - 1] : null;
  return `# 你的角色：squad Dev（实现者）

${formatRoleCardForPrompt(roleCard)}

## 🎯 OBJECTIVE
完成下面这一个具体子任务，输出可直接被 QA 按验收标准核对的交付物（代码 / 文件 / 方案）。

## 📥 INPUT
### 整体项目目标
${topic}

### 你负责的子任务
- ID: ${task.id}
- 标题: ${task.title}
- 描述（含验收标准）: ${task.desc}

${task.userInjections && task.userInjections.length > 0 ? `### ⚠️ 用户中途追加的关键指示（**最高优先级**，必须明确响应）
${task.userInjections.map((inj, i) => `${i + 1}. [${inj.at?.slice(11, 19) || ''}] ${inj.content}`).join('\n')}
` : ''}
${isRedo ? `### 🚨 你被打回 ${previousReviews.length} 次了，这次必须真改

#### 上一次（第 ${previousReviews.length} 次）QA 给的 issues（最重要，**逐条修复**）
${(lastReview.issues || []).map((it, i) => `${i + 1}. ${it}`).join('\n') || '（无 issues 字段）'}

#### 上一次（第 ${previousReviews.length} 次）QA 给的 suggestions
${(lastReview.suggestions || []).map((it, i) => `${i + 1}. ${it}`).join('\n') || '（无 suggestions 字段）'}

${previousReviews.length > 1 ? `#### 更早的 QA 反馈（仅供参考避免回头错）
${previousReviews.slice(0, -1).map((r, i) => `第 ${i + 1} 次 issues：${(r.issues || []).join(' / ')}`).join('\n')}
` : ''}
${lastAttempt ? `#### 你上一次的实现（不要从零重写，在此基础上**改**你被 reject 的具体点）
\`\`\`
${lastAttempt.content.slice(0, 12000)}${lastAttempt.content.length > 12000 ? '\n…（截断）' : ''}
\`\`\`
` : ''}
` : ''}
## 📤 OUTPUT FORMAT
中文 markdown，必须含 ${isRedo ? '3' : '2'} 节：

${isRedo ? `### 🔧 修复对照表（必填，逐条对照上次 issues 说明本次怎么改）
| # | 上次 issue | 本次怎么改 | 改在哪段 |
|---|---|---|---|
| 1 | … | … | … |

⚠️ 这一节如果跳过 / 内容空 / "已修复"这种敷衍措辞，QA 会直接 reject。

` : ''}### 实现 / 方案
（详细的代码 / 命令 / 设计；如果是写文件，给出文件路径 + 完整内容；如果是跑命令，给出实测输出）

### 完成情况自查
对照"描述（含验收标准）"逐条说明是否达成（不要泛泛说"已完成"，要点对点）。

## 🛠 TOOLS GUIDANCE
- 你**有文件系统 + shell 权限**（agent CLI 在容器/沙盒内运行）
- 优先**真的去做**（写文件 / 跑脚本 / 真测输出），而非纸上谈兵
- 如果有用户中途追加的指示，**先在自查段说明你怎么响应了**，再做实现
${isRedo ? `- ⚠️ 这是第 ${previousReviews.length + 1} 次提交，**不要重复犯之前的错**——上次 issue 没改，QA 这次会更严
- 如果你觉得某条 issue 不合理，在修复对照表的「本次怎么改」列明确写"我认为这条 issue 不成立，理由是 XXX"——不要默默忽略
` : '- 历次 reject 的 issues 必须逐条解决，不能跳过'}

## ⛔ TASK BOUNDARY
- 只做你负责的这一个 task，不要顺手做下个 task（即使依赖你完成）
- 严格遵守角色卡 scope，发现任务越权时在自查段说明并只处理自己负责的部分
- 不要自己判断 pass/reject（那是 QA 的事）
- 不要询问用户更多信息（这是非交互模式，没人回你）
- 输出**只输出 markdown 实现 + 自查**${isRedo ? '（+ 修复对照表）' : ''}，不要嵌套 JSON 或额外说明`;
};

const QA_STRICTNESS_BAND = {
  loose: `- 判定标准（loose 宽松模式）：
  * pass：任务描述的核心验收标准达成即可，允许小瑕疵（缺少 edge case、可读性弱、变量名一般）
  * reject：核心功能未达成、有明显 bug、跑不起来、安全风险、与需求严重不符
- 审查态度：以"能用 + 主路径正确"为准，不挑剔
- 适用场景：原型 / 一次性脚本 / 探索性任务`,
  standard: `- 判定标准（standard 标准模式）：
  * pass：任务描述的验收标准全部达成，无明显技术错误或遗漏
  * reject：有任何未达成的验收标准、明显 bug、遗漏、安全风险、与需求不符
- 审查态度：以挑剔但合理的眼光审查
- 适用场景：正常产线任务（默认）`,
  strict: `- 判定标准（strict 严格模式）：
  * pass：任务描述的验收标准 100% 达成 + 代码可读性好 + 错误处理完备 + 边界情况覆盖 + 风格统一
  * reject：任何 issue（含命名不一致 / 缺注释 / 未处理 None / 漏 edge case / 缺类型标注 / 性能隐患）
- 审查态度：严苛挑剔，宁严勿松（这是 review 循环的第一道关）；本轮没问题也要尝试找 1-2 个改进点列入 suggestions
- 适用场景：生产代码 / 安全敏感 / 关键模块`,
};

const QA_PROMPT = (task, devContent, topic, strictness, roleCard) => `# 你的角色：squad QA（审查员）

${formatRoleCardForPrompt(roleCard)}

## 🎯 OBJECTIVE
判定 dev 的交付物是否达成验收标准，输出 pass 或 reject + 具体 issues。

## 📥 INPUT
### 整体项目目标
${topic}

### 被审查的子任务
- ID: ${task.id}
- 标题: ${task.title}
- 描述（含验收标准）: ${task.desc}

### Dev 的交付物
${devContent}

## 📤 OUTPUT FORMAT
严格 JSON（不要 markdown 围栏）：
{
  "verdict": "pass" | "reject",
  "confidence": 0.0-1.0,
  "issues": ["具体问题 1", "具体问题 2", ...],
  "suggestions": ["具体改进建议 1", ...],
  "reasoning": "1-2 句中文总结，说明为何 pass / reject"
}

## 🎚 严格度档位 = ${strictness || 'standard'}
${QA_STRICTNESS_BAND[strictness] || QA_STRICTNESS_BAND.standard}

## 🛠 TOOLS GUIDANCE
- 你**有文件系统 + shell 权限**——如果 dev 声称写了文件 / 跑了命令，**真的去读 / 真的去跑**核对，不要只看 markdown 文字
- 优先**端到端验证**：dev 说脚本输出 X，你就 \`python xxx.py\` 跑一遍 diff 对比
- **issues 必须可定位 + 可修复**（v0.52 强化）：每条 issue 都要带"位置（文件:行号 / 段落标题 / 字段名）+ 问题 + 期望"。
  ✅ 示例："第 3 段「实现」第 2 行 \`def foo(x):\` 没处理 x=0 的边界，期望加 \`if x == 0: return\`"
  ❌ 反例："代码不严谨"/"建议优化错误处理"/"风格一般"——这种说了等于没说，dev 改不了
- 严格度档位决定挑刺力度，但**任何档位都不接受真错误**（跑不通、与需求不符）
- ⚠️ 如果这是第 N 次（N≥3）reject 同一 task，**复查上次 reject 的 issues 是否被本次 dev 真改过**：
  * 若 dev 在「修复对照表」明确说"已改 + 改在哪段" → 检查那段确实变了 → pass 该条
  * 若 dev 跳过对照表 / 用"已修复"敷衍 / 改的不是 issue 说的位置 → 在新 issues 里明确写"上次 issue X 没真改，请在 Y 位置真改"
- **dev 输出框架固定** = \`### 实现 / 方案\` + \`### 完成情况自查\` 两节 markdown，这是系统强制的，不算"多余 markdown"或"多余解释"；你审查时**只针对"实现 / 方案"段的内容**判 pass/reject。**完成情况自查段**只作为参考，不要单独判它好坏
- 若 task.desc 写了"不准用 markdown"或"不准带自查段"这类限制 dev 框架的要求，是 PM 拆任务时的错误，你**按内容判断**即可（实现段内容达成验收标准就 pass），不要硬挑这种格式 issue

## ⛔ TASK BOUNDARY
- 不要替 dev 重写实现（issues + suggestions 即可）
- 严格遵守角色卡 scope，只做验证、风险识别和可修复反馈
- 不要质疑 task 描述本身（那是 PM 的事）
- reasoning 必须中文，不要英文
- 只输出 JSON 对象，前后无任何文字（不要 \`\`\`json 围栏）`;

const FINAL_SUMMARY_PROMPT = (topic, tasks) => {
  // v0.54 Sprint 6：检测全部 escalated 场景，给可执行的诊断输出而不是空话
  const doneCnt = tasks.filter(t => t.status === 'done').length;
  const escCnt = tasks.filter(t => t.status === 'escalated').length;
  const allEscalated = doneCnt === 0 && escCnt > 0;
  // 全失败模式：换不同的 prompt
  if (allEscalated) {
    return `# 你的角色：squad PM（失败诊断）

## ⚠️ 关键背景
这次协作**所有 ${escCnt} 个子任务全部失败**，没有任何 task 产出有效交付物。

## 📥 INPUT
### 整体项目目标
${topic}

### 各任务失败原因
${tasks.map(t => `- **${t.id} ${t.title}**：${t.escalateReason || '原因未记录'}`).join('\n')}

## 📤 OUTPUT FORMAT
中文 markdown，**严格按 4 节**：

### 1. 失败诊断
分析这次失败的根因（按概率排序，最多 3 条）。注意区分：
- **adapter 网络/凭证问题**（如 "fetch failed" / "GaxiosError" / "401" / "rate limited"）→ 不是模型能力问题
- **任务设计问题**（如拆得太碎、依赖图错、prompt 太模糊）→ PM 阶段的锅
- **模型能力不足**（如 task 难度超出 dev 模型能力）

### 2. 立即可做的修复动作（用户）
列 1-5 条**具体可执行**的建议，每条按"问题 → 修复办法"格式。例：
- "MiniMax fetch failed → 检查 \`~/.claude-panel/room-adapters.json\` 的 MiniMax baseUrl + apiKey 是否过期"
- "Gemini cloudcode-pa 报错 → 跑 \`gemini\` 命令重新登录"
- "全 task 串行依赖 → 重启房后在 topic 里加 '请尽量拆并行 task'"

### 3. 用户应该考虑的下一步
- 不重启房：单点修复哪个 task（说明哪几个最值得手动重试）
- 重启房 + 切换 adapter：建议改用哪几个 adapter（claude / codex / 不依赖网络的 ollama 等）
- 跳过 squad，直接进对决房 / 闲聊房手动追问

### 4. 已采集到的部分内容（如果有）
即使 task 失败，dev 可能跑过几次 attempt，列出**有价值的中间输出片段**（每条 < 200 字），如无写"无"。

## ⛔ BOUNDARY
- 不要假装总结成果（没成果不要硬编）
- 不要责怪某个 adapter / model，重点是给用户**可执行的下一步**
- 不要 markdown 围栏，前后无说明文字`;
  }

  // 正常路径：至少 1 个 task 成功
  return `# 你的角色：squad PM（结项总结）

## 🎯 OBJECTIVE
把所有子任务的最终交付物合成一份完整可执行的整体方案。

## 📥 INPUT
### 整体项目目标
${topic}

### 全部子任务及其最终交付（pass review 的版本）
${tasks.map(t => {
  // v0.52 fix: 跳过 error attempts，避免把 "[dev 失败] 超时" 这种错误消息当成 deliverable 喂给 PM
  const lastGood = [...t.attempts].reverse().find(a => !a.error);
  const statusLabel = t.status === 'done' ? '✅ 完成'
                    : t.status === 'escalated' ? `⚠️ 已搁置（${t.escalateReason || '原因未记录'}）`
                    : `⚠️ 未完成（status=${t.status}）`;
  const body = (t.status === 'done' && lastGood)
    ? lastGood.content
    : (t.status === 'escalated' || !lastGood)
      ? '【本任务未产出有效交付物，整合时请忽略此 task 的具体内容，仅说明它已搁置】'
      : (lastGood?.content || '(空)');
  return `### ${t.id} ${t.title}
状态：${statusLabel}
${body}
`;
}).join('\n\n---\n\n')}

## 📤 OUTPUT FORMAT
中文 markdown，必须含 4 节：

### 1. 总览
1 段说明这次协作做了什么、谁做了什么。

### 2. 整合后的完整方案 / 代码 / 答案
把所有 task 的成果拼起来，去重 + 补全 + 顺序合理，让读者拿这一段就能直接用。

### 3. 协作回顾
- 哪些 task 被 QA 打回过几次
- 主要发现什么 issue
- 是否触发过用户中途插话注入

### 4. 待办 / 已搁置
哪些 task 因为失败被搁置需要用户介入，逐条列出。如无写"无"。

## 🛠 TOOLS GUIDANCE
- 整合时要**消重**：若 T1 和 T2 都写了某代码片段，只保留更完整的那个
- 整合时要**顺序**：依赖关系决定执行顺序（init → impl → test → deploy）
- 注意保留 dev 真测的实际输出（如 stdout、文件路径），别只保留代码不保留运行证据

## ⛔ TASK BOUNDARY
- 不要再 review 任务（QA 已经审过了）
- 不要自己提出新需求（用户没要的不要加）
- 输出只能是上述 4 节 markdown，前后无说明`;
};

const AUTO_PAUSE_THRESHOLD = 5;  // v0.53 Sprint 3.5

export class CollaborationDispatcher {
  constructor({ store, adapters, broadcast, metrics }) {
    this.store = store;
    this.adapters = adapters; // Map<adapterId, RoomAdapter>
    this.broadcast = broadcast || (() => {});
    this.metrics = metrics || defaultMetricsStore;  // v0.53 Sprint 3
    this.activeAborts = new Map(); // roomId → AbortController
    this._fails = new Map();  // v0.53 Sprint 3.5：roomId → 连续失败计数
  }

  _bumpFailure(roomId, isUserAbort) {
    if (isUserAbort) return;
    const n = (this._fails.get(roomId) || 0) + 1;
    this._fails.set(roomId, n);
    if (n >= AUTO_PAUSE_THRESHOLD) {
      this._fails.delete(roomId);
      const a = this.activeAborts.get(roomId);
      if (a) { try { a.abort(); } catch {} this.activeAborts.delete(roomId); }
      try { this.store.setStatus(roomId, 'auto_paused'); } catch {}
      try { this.broadcast(roomId, { type: 'room_auto_paused', reason: `连续 ${AUTO_PAUSE_THRESHOLD} 次 turn 失败/超时` }); } catch {}
    }
  }
  _resetFailure(roomId) { this._fails.delete(roomId); }

  /** v0.54 Sprint 6：重试单个 escalated task（reset 该 task + 连带 reset 被牵连下游 + 触发 resume）*/
  async retryTask(roomId, taskId) {
    const room = this.store.get(roomId);
    if (!room) throw new Error('room not found');
    if (room.mode !== 'squad') throw new Error('仅 squad 房支持 retryTask');
    if (room.status === 'running') throw new Error('房间正在运行中，不能局部重试 task');

    const taskList = room.taskList || [];
    const task = taskList.find((t) => t.id === taskId);
    if (!task) throw new Error(`task ${taskId} 不存在`);
    if (task.status !== 'escalated') throw new Error(`task 状态 ${task.status} 不需重试（仅 escalated 可）`);

    // 并发锁
    if (!this._taskRetries) this._taskRetries = new Set();
    const lockKey = `${roomId}:task:${taskId}`;
    if (this._taskRetries.has(lockKey)) throw new Error('该 task 正在重试中');
    this._taskRetries.add(lockKey);

    try {
      // reset 该 task
      task.status = 'pending';
      task.iterations = 0;
      task.attempts = [];
      task.reviews = [];
      delete task.escalateReason;

      // 同时 reset 被牵连的下游（escalateReason 含 'blocked' 或 'blocked_by_escalated_dep'）
      let cascadedCount = 0;
      for (const t of taskList) {
        if (t.id === taskId) continue;
        if (t.status === 'escalated' && /blocked/i.test(t.escalateReason || '')) {
          t.status = 'pending';
          t.iterations = 0;
          t.attempts = [];
          t.reviews = [];
          delete t.escalateReason;
          cascadedCount++;
        }
      }
      this.store.update(roomId, { taskList });
      this.broadcast(roomId, { type: 'task_retry_start', taskId, cascadedCount });

      // 触发 resume（dispatcher 自己接着跑）
      await this.start(roomId, room.topic, { resume: true });
    } finally {
      this._taskRetries.delete(lockKey);
    }
  }

  abort(roomId) {
    const a = this.activeAborts.get(roomId);
    if (a) {
      a.abort();
      this.activeAborts.delete(roomId);
      this.store.setStatus(roomId, 'paused');
      this.broadcast(roomId, { type: 'squad_paused', reason: 'user_abort' });
      return true;
    }
    return false;
  }

  /** v0.52 Sprint1-C：续跑——保留 taskList + finalConsensus，从未完成 task 继续 */
  async resume(roomId) {
    const room = this.store.get(roomId);
    if (!room) throw new Error('room not found: ' + roomId);
    if (room.status === 'running') throw new Error('room already running');
    if (!room.topic) throw new Error('该房尚未启动过，无法续跑');
    return this.start(roomId, room.topic, { resume: true });
  }

  async start(roomId, topic, options = {}) {
    const room = this.store.get(roomId);
    if (!room) throw new Error('room not found: ' + roomId);
    if (room.status === 'running') throw new Error('room already running');
    const isResume = options.resume === true;

    const members = (room.members || []).filter(m => m.enabled !== false);
    const pms  = members.filter(m => m.role === 'pm');
    const devs = members.filter(m => m.role === 'dev');
    const qas  = members.filter(m => m.role === 'qa');
    if (pms.length === 0 || devs.length === 0 || qas.length === 0) {
      this.broadcast(roomId, { type: 'squad_error', error: 'squad 模式需要至少 1 PM + 1 Dev + 1 QA' });
      throw new Error('需要 1 PM + 1 Dev + 1 QA');
    }

    if (!isResume) {
      this.store.update(roomId, {
        topic, status: 'running', currentRound: 1,
        rounds: [], taskList: [], finalConsensus: null,
        conversation: [],
      });
    } else {
      // 续跑：保留 taskList / finalConsensus 等历史
      this.store.update(roomId, { status: 'running' });
      // 把 in_progress / in_review 状态重置为 pending（中断时它们没完成）
      const room2 = this.store.get(roomId);
      const taskList = (room2.taskList || []).map(t => {
        if (t.status === 'in_progress' || t.status === 'in_review') {
          // attempt 留着供 dev 看上次写过啥；status 回 pending 重启 dev 循环
          return { ...t, status: 'pending' };
        }
        return t;
      });
      this.store.update(roomId, { taskList });
    }
    this.broadcast(roomId, { type: isResume ? 'squad_resume' : 'squad_start', topic });

    const aborter = new AbortController();
    this.activeAborts.set(roomId, aborter);

    try {
      let taskList;
      if (isResume && Array.isArray(room.taskList) && room.taskList.length > 0) {
        // 续跑：复用现有 taskList
        taskList = this.store.get(roomId).taskList;   // 上面 update 后的 taskList
        this.broadcast(roomId, { type: 'plan_resume', taskCount: taskList.length });
      } else {
        // === Step 1: PM 拆任务 ===
        this.broadcast(roomId, { type: 'pm_planning', pm: pms[0].displayName });
        const planRaw = await this._callAdapter(pms[0], [
          { role: 'system', content: '你是严谨的 PM，只输出 JSON 不要 markdown 围栏。' },
          { role: 'user', content: PM_PROMPT(topic, members, room) },
        ], room.cwd, aborter.signal, { room, turnKind: 'pm_plan' });
        const plan = this._parsePlanJson(planRaw);
        if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
          throw new Error('PM 输出的任务清单解析失败 / 为空');
        }

        // 准备 taskList：补 status/iterations/attempts/reviews 字段
        taskList = plan.tasks.slice(0, SQUAD_LIMITS.maxTasks).map(t => ({
          id: t.id || ('T_' + randomUUID().slice(0, 6)),
          title: String(t.title || '').slice(0, 200),
          desc: String(t.desc || '').slice(0, 2000),
          assigneeId: String(t.assigneeId || (devs[0]?.adapterId)),
          reviewerId: String(t.reviewerId || (qas[0]?.adapterId)),
          dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
          status: 'pending',
          iterations: 0,
          maxIterations: SQUAD_LIMITS.defaultMaxIterations,
          attempts: [],
          reviews: [],
          userInjections: [],
        }));

        // 校验依赖图（无环）
        const graph = new TaskGraph(taskList);
        const cycleCheck = graph.detectCycle();
        if (!cycleCheck.ok) {
          for (let i = 0; i < taskList.length; i++) {
            taskList[i].dependencies = i === 0 ? [] : [taskList[i - 1].id];
          }
          this.broadcast(roomId, { type: 'plan_cycle_fixed', cycle: cycleCheck.cycle });
        }

        this.store.update(roomId, { taskList });
        this.broadcast(roomId, { type: 'plan_done', taskList });
      }

      // === Step 2-6: 反复找 ready task 并行执行 + QA review 循环 ===
      const liveGraph = new TaskGraph(taskList);
      const maxParallelBatches = SQUAD_LIMITS.maxParallelBatches;
      let batch = 0;

      while (!liveGraph.allDoneOrTerminal() && batch < maxParallelBatches) {
        if (aborter.signal.aborted) break;
        const ready = liveGraph.readyTasks();
        if (ready.length === 0) {
          // 没 ready 但又没全 done → 死锁（被 escalated 的 task 阻塞后续）
          for (const t of liveGraph.toArray()) {
            if (t.status === 'pending') {
              t.status = 'escalated';
              t.escalateReason = '上游依赖任务失败';
              this.broadcast(roomId, { type: 'task_escalated', taskId: t.id, reason: 'blocked_by_escalated_dep' });
            }
          }
          break;
        }

        this.broadcast(roomId, { type: 'batch_start', batch: batch + 1, taskIds: ready.map(t => t.id) });

        // 并行做这一批 ready tasks
        await Promise.all(ready.map(t => this._runOneTaskUntilTerminal(roomId, t, topic, members, aborter.signal)));

        // 同步状态到 store（attempts/reviews 已经在 _runOneTaskUntilTerminal 里 push）
        this.store.update(roomId, { taskList });
        batch++;
      }

      // === Step 7: PM 合成最终交付 ===
      const allTasks = liveGraph.toArray();
      const doneOrEsc = allTasks.filter(t => t.status === 'done' || t.status === 'escalated');
      this.broadcast(roomId, { type: 'final_summary_start' });
      let finalContent = '';
      try {
        finalContent = await this._callAdapter(pms[0], [
          { role: 'system', content: '你是 PM，正在总结这次 squad 协作的交付物。' },
          { role: 'user', content: FINAL_SUMMARY_PROMPT(topic, doneOrEsc) },
        ], room.cwd, aborter.signal, { room, turnKind: 'pm_final_summary' });
      } catch (e) {
        finalContent = '[最终总结失败] ' + e.message;
      }
      this.store.update(roomId, { finalConsensus: finalContent });
      this.broadcast(roomId, { type: 'final_summary_done', content: finalContent });

      this.store.setStatus(roomId, 'done', { currentRound: -1 });
      this.broadcast(roomId, { type: 'squad_done' });
    } catch (e) {
      const aborted = aborter.signal.aborted;
      this.store.setStatus(roomId, aborted ? 'paused' : 'error');
      this.broadcast(roomId, { type: aborted ? 'squad_paused' : 'squad_error', error: e.message });
      throw e;
    } finally {
      this.activeAborts.delete(roomId);
    }
  }

  /** 跑一个 task 直到 done / escalated（含 Dev-QA 循环） */
  async _runOneTaskUntilTerminal(roomId, task, topic, members, abortSignal) {
    const dev = members.find(m => m.adapterId === task.assigneeId);
    const qa = members.find(m => m.adapterId === task.reviewerId);
    if (!dev || !qa) {
      task.status = 'escalated';
      task.escalateReason = 'Dev 或 QA 成员缺失（房间配置问题）';
      this.broadcast(roomId, { type: 'task_escalated', taskId: task.id, reason: 'assignee_or_reviewer_missing' });
      return;
    }

    while (task.iterations < task.maxIterations) {
      if (abortSignal.aborted) return;
      // v0.43 P0 #7: 每轮重拉 room，让 cwd / qaStrictness / userInjections 中途变更生效
      const room = this.store.get(roomId);
      if (!room) return;

      task.iterations++;
      task.status = 'in_progress';
      this.broadcast(roomId, { type: 'task_dev_start', taskId: task.id, iteration: task.iterations, dev: dev.displayName });

      // Dev 实现
      let devContent = '';
      try {
        devContent = await this._callAdapter(dev, [
          { role: 'system', content: '你是 squad 的 dev，输出 markdown。' },
          { role: 'user', content: DEV_PROMPT(task, topic, task.reviews, findRoleCard(room, dev)) },
        ], room.cwd, abortSignal, { room, taskId: task.id, turnKind: `dev:${task.id}#i${task.iterations}` });
      } catch (e) {
        devContent = '[dev 失败] ' + e.message;
        task.attempts.push({ at: new Date().toISOString(), by: dev.adapterId, content: devContent, error: true });
        task.status = 'escalated';
        task.escalateReason = `Dev (${dev.displayName}) 调用失败：${e.message}`;
        this.broadcast(roomId, { type: 'task_escalated', taskId: task.id, reason: 'dev_failed: ' + e.message });
        return;
      }
      task.attempts.push({ at: new Date().toISOString(), by: dev.adapterId, content: devContent, promptVersion: PROMPT_VERSIONS.squad_dev });
      this.broadcast(roomId, { type: 'task_dev_done', taskId: task.id, iteration: task.iterations, by: dev.displayName, content: devContent });

      task.status = 'in_review';
      this.broadcast(roomId, { type: 'task_qa_start', taskId: task.id, iteration: task.iterations, qa: qa.displayName });

      // QA 审查
      let review;
      try {
        const strictness = room.qaStrictness || 'standard';
        const qaRaw = await this._callAdapter(qa, [
          { role: 'system', content: '你是 squad 的 QA，只输出 JSON 不要 markdown 围栏。' },
          { role: 'user', content: QA_PROMPT(task, devContent, topic, strictness, findRoleCard(room, qa)) },
        ], room.cwd, abortSignal, { room, taskId: task.id, turnKind: `qa:${task.id}#i${task.iterations}` });
        review = this._parseQaJson(qaRaw);
      } catch (e) {
        review = { verdict: 'reject', confidence: 0.5, issues: ['QA 调用失败: ' + e.message], suggestions: [], reasoning: 'QA 失败' };
      }
      review.at = new Date().toISOString();
      review.by = qa.adapterId;
      review.promptVersion = PROMPT_VERSIONS.squad_qa;
      task.reviews.push(review);
      this.broadcast(roomId, { type: 'task_qa_done', taskId: task.id, iteration: task.iterations, by: qa.displayName, review });

      if (review.verdict === 'pass') {
        task.status = 'done';
        this.broadcast(roomId, { type: 'task_done', taskId: task.id, iterations: task.iterations });
        return;
      }
      // reject → 进入下一次迭代
    }
    // 超过 maxIterations
    task.status = 'escalated';
    task.escalateReason = `QA 反复打回，达到最大迭代次数 ${task.maxIterations}`;
    this.broadcast(roomId, { type: 'task_escalated', taskId: task.id, reason: 'max_iterations_reached', iterations: task.iterations });
  }

  async _callAdapter(member, messages, cwd, abortSignal, ctx = {}) {
    const adapter = this.adapters.get(member.adapterId);
    if (!adapter) throw new Error('adapter not registered: ' + member.adapterId);
    const startedAt = Date.now();
    let result, err;
    // v0.55 Sprint 14 F2：注入房 skills
    const objective = ctx?.objective
      || ctx?.task?.desc
      || ctx?.room?.topic
      || messages.map((m) => m?.content || '').join('\n').slice(0, 8000);
    const agentContext = ctx?.room ? buildRoomAgentContext(ctx.room, { member, objective }) : null;
    const agentMetrics = summarizeAgentRuntimeContext(agentContext);
    const finalMessages = ctx?.room
      ? injectSkillsToMessages(messages, ctx.room, { agentContext })
      : messages;
    try {
      result = await adapter.chat(finalMessages, {
        cwd,
        abortSignal,
        model: member.model,
        budgetContext: {
          projectId: ctx?.room?.cwd || cwd,
          roomId: ctx?.room?.id || null,
          adapterId: member.adapterId,
          taskId: ctx?.taskId || null,
          agentProfileId: agentMetrics.agentProfileId,
        },
      });
    } catch (e) {
      err = e;
    }
    // v0.53 Sprint 3：埋点 metrics（room 可选；缺时跳过 record）
    if (ctx && ctx.room) {
      try {
        this.metrics?.record?.({
          roomId: ctx.room.id,
          roomMode: 'squad',
          roomName: ctx.room.name,
          projectId: ctx.room.cwd,
          taskId: ctx.taskId || '',
          turn: ctx.turnKind || 'unknown',
          adapter: member.adapterId,
          model: member.model || '',
          latencyMs: Date.now() - startedAt,
          tokensIn: result?.tokensIn || 0,
          tokensOut: result?.tokensOut || 0,
          success: !err,
          errorKind: err ? (err.name || 'error') : null,
          agentRunId: result?.agentRunId || err?.agentRunId || '',
          ...agentMetrics,
        });
      } catch {}
      // v0.53 Sprint 3.5：自动暂停计数
      if (err) this._bumpFailure(ctx.room.id, abortSignal?.aborted);
      else this._resetFailure(ctx.room.id);
    }
    if (err) throw err;
    // v0.51 ZZZZ-04 fix: dispatcher 出口 cap reply 防极长 AI 输出撑爆 task.attempts / rooms.json
    const reply = result.reply;
    const MAX = CONTENT_LIMITS.maxReplyChars;  // v0.52 256KB
    if (typeof reply === 'string' && reply.length > MAX) {
      return reply.slice(0, MAX) + `\n\n…（已截断，原 ${reply.length} 字符）`;
    }
    return reply;
  }

  _parsePlanJson(raw) {
    try {
      // v0.44 P2 #17 DoS 防御：超过 200KB 截断
      // v0.45 P2-4: 截断时若结尾 } 被切，仍能用 lastIndexOf('}') 找完整大括号包围段
      let s = String(raw);
      if (s.length > SQUAD_LIMITS.maxRawJsonLength) s = s.slice(0, SQUAD_LIMITS.maxRawJsonLength);
      const cleaned = s.replace(/^```(json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start < 0 || end < 0 || end <= start) return null;
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch { return null; }
  }

  _parseQaJson(raw) {
    const obj = this._parsePlanJson(raw) || {};
    const validVerdict = ['pass', 'reject'];
    if (!validVerdict.includes(obj.verdict)) {
      // 容错：从文本里找 "pass"/"reject"
      const m = String(raw).toLowerCase().match(/\b(pass|reject)\b/);
      obj.verdict = m ? m[1] : 'reject';
    }
    if (typeof obj.confidence !== 'number') obj.confidence = 0.5;
    obj.issues = Array.isArray(obj.issues) ? obj.issues : [];
    obj.suggestions = Array.isArray(obj.suggestions) ? obj.suggestions : [];
    obj.reasoning = String(obj.reasoning || '');
    return obj;
  }
}
