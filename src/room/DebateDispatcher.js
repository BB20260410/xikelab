// DebateDispatcher — 编排多 AI debate 流程
//
// 基础三阶段（每个大轮内）：
// R1 独立提案：三 AI 并行各自给方案
//   - 大轮 1：互不见对方（初始独立提案）
//   - 大轮 ≥2：看上一大轮 R3 三方终稿 → 在此基础上再次独立提案（不是修订上一稿）
// R2 互评修订：每 AI 收到本大轮 R1 全部 → 评价 + 自己修订版
// R3 终稿表态：每 AI 看本大轮 R2 全部 → 最终立场，标"同意/分歧点"
//
// 整组 R1→R2→R3 重复 N 次（v0.52 方案 B，N 由 debateRounds 配置，默认 2，上限 10）
//
// R4 judge 总结：Claude 当主持 → 看全部 N 大轮记录，合成共识方案 + 分歧裁决
//
// 持久化时 kind 带后缀：`r1_propose@<n>` / `r2_critique@<n>` / `r3_final@<n>` / `r4_judge`
// 老房间 kind 无 @ 后缀，前端兼容渲染。

import { DEBATE_LIMITS, CONTENT_LIMITS } from './squad-limits.js';
import { metricsStore as defaultMetricsStore } from '../metrics/MetricsStore.js';
import { injectSkillsToMessages } from './skillInjector.js';

const ROLE_PROMPT = (memberDisplay, topic, others, macroRound, totalMacroRounds) => `# 你的角色：debate 参与者 ${memberDisplay}

## 🎯 OBJECTIVE
和 ${others.join(' / ')} 一起经过 ${totalMacroRounds} 大轮（每大轮含 R1 提案 / R2 互评修订 / R3 终稿表态）+ 最终主持总结，达成一致最优方案。当前在 **第 ${macroRound} 大轮**。

## 🛠 TOOLS GUIDANCE
- 用中文回答
- 观点要**具体可执行**（不要"考虑安全性"，要"加 X 校验防 Y 风险"）
- 第 1 大轮 R1 看不到对方方案；其他阶段会给你必要上下文

## 📥 任务
${topic}`;

const R2_INSTRUCTION = `## 🎯 OBJECTIVE（第 2 轮：互评修订）
1. **简短点评**对方两位的方案（赞同/补充/反对，每位 1-3 句）
2. **给出你的修订版方案**（吸收对方好点子 + 你坚持的部分）

## 📤 OUTPUT FORMAT（严格 markdown 两节）
### 我的点评
- 对 [对方名]：...
- 对 [对方名]：...

### 修订方案
（完整方案 markdown）

## ⛔ BOUNDARY
- 不要只点评不修订，**必须**给修订版
- 不要假装"我跟 X 完全一致"——找到差异并表态
- 不要进入第 3 轮（终稿）的内容`;

const R3_INSTRUCTION = `## 🎯 OBJECTIVE（第 3 轮：终稿表态）
看完所有第 2 轮发言，输出最终立场。

## 📤 OUTPUT FORMAT（markdown 三节）
### 1. 共识点
我同意大家的部分（列 3-5 条）

### 2. 分歧点
我仍坚持/反对的部分（列 0-3 条 + 理由）。如无分歧填"无"。

### 3. 我的最终方案
精炼版（markdown，可比 R2 修订版更紧凑）

## ⛔ BOUNDARY
- 不要重新评论对方（R2 已经评过了）
- 分歧点若你确实没分歧就写"无"，不要硬找
- 不要做 R4 主持人的合成工作`;

// v0.52 大轮 ≥2 时 R1 的 user prompt 改写：看上一大轮三方终稿 → 重新独立提案
const R1_RESUME_USER = (topic, macroRound, prevR3Context) => `## 当前是第 ${macroRound} 大轮 · 第 1 阶段：再次独立提案

### 上一大轮（第 ${macroRound - 1} 大轮）三方终稿
${prevR3Context}

### 任务
${topic}

## OBJECTIVE
看完上面的三方终稿后，**独立**再给一份你的最优方案（详细 markdown）。

## ⛔ BOUNDARY
- 不是去修订上一稿，是在吸收/反驳上一大轮共识与分歧后，给出本大轮你的提案
- 不要简单 +1 上一大轮某方，要明确表达你**这一大轮**的新立场（可以延续也可以转向）
- 不要进入第 2 阶段（互评）的内容，本步骤只独立表态`;

const R4_JUDGE_PROMPT = (topic, allTurns) => `# 你的角色：debate 主持人

## 🎯 OBJECTIVE
合成多方多大轮讨论的最终方案，做仲裁，给可执行清单。

## 📥 INPUT
### 原始任务
${topic}

### 全部大轮 R1/R2/R3 讨论记录
${allTurns}

## 📤 OUTPUT FORMAT（严格 markdown 4 节）
### 🎯 共识最优方案
（一份完整可执行的方案，融合三方共识 + 你判断的最优分歧选择）

### ✅ 三方共识点
- ...

### ⚖️ 分歧与裁决
- 分歧 X：A 说... B 说... → **采纳 A**，因为...
- （列出每个 R3 分歧 + 你的裁决理由）

### 📋 实施清单
1. ...
2. ...

## 🛠 TOOLS GUIDANCE
- 仲裁要给**具体理由**（"因为 A 方案在 Y 场景下更稳"，不要"A 更好"）
- 实施清单按时间/依赖顺序排
- 如果三方完全共识无分歧，"分歧与裁决"段写"三方共识无分歧"

## ⛔ BOUNDARY
- 不要重新提案（用三方已有的内容裁决）
- 不要 markdown 围栏，前后无任何说明文字`;

const AUTO_PAUSE_THRESHOLD = 5;  // v0.53 Sprint 3.5：连续 N 次 turn 失败自动暂停

export class DebateDispatcher {
  constructor({ store, adapters, broadcast, metrics }) {
    this.store = store;
    this.adapters = adapters; // Map<adapterId, RoomAdapter>
    this.broadcast = broadcast || (() => {});
    this.metrics = metrics || defaultMetricsStore;  // v0.53 Sprint 3
    this.activeAborts = new Map(); // roomId → AbortController
    this.activeRetries = new Set(); // v0.52 Sprint1-D 并发锁 "roomId:kind:speaker"
    this._fails = new Map();  // v0.53 Sprint 3.5：roomId → 连续失败计数
  }

  /** v0.53 Sprint 3.5：用户主动 abort 不计数 */
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

  /** v0.53: 内部统一上报指标，dispatcher 失败不影响主流程 */
  _recordMetric(room, kind, speaker, model, latencyMs, result, errorKind = null) {
    try {
      this.metrics?.record?.({
        roomId: room.id,
        roomMode: 'debate',
        roomName: room.name,
        projectId: room.cwd,
        turn: typeof kind === 'string' ? `${kind}:${speaker}` : String(kind),
        adapter: speaker,
        model: model || '',
        latencyMs,
        tokensIn: result?.tokensIn || 0,
        tokensOut: result?.tokensOut || 0,
        success: !errorKind,
        errorKind,
      });
    } catch {}
  }

  /** v0.52 续跑入口：保留 rounds + finalConsensus，仅从未完成阶段接着跑 */
  async resume(roomId) {
    const room = this.store.get(roomId);
    if (!room) throw new Error('room not found: ' + roomId);
    if (room.status === 'running') throw new Error('room is already running');
    if (!room.topic) throw new Error('该房尚未启动过，无法续跑');
    return this.start(roomId, room.topic, { resume: true, debateRounds: room.debateRounds });
  }

  /** 查某个 round 已完成成员；用于 resume 跳过 */
  _roundCompletion(roomId, kind, adapterList) {
    const r = this.store.get(roomId).rounds.find(x => x.kind === kind);
    if (!r) return { complete: false, missingAdapters: adapterList };
    const okSpeakers = new Set((r.turns || []).filter(t => !t.error).map(t => t.speaker));
    const missing = adapterList.filter(x => !okSpeakers.has(x.member.adapterId));
    return { complete: missing.length === 0, missingAdapters: missing };
  }

  /** 启动 debate：roomId + topic + { debateRounds, resume }（v0.52 N=大轮数） */
  async start(roomId, topic, options = {}) {
    const room = this.store.get(roomId);
    if (!room) throw new Error('room not found: ' + roomId);
    if (room.status === 'running') throw new Error('room is already running');
    const isResume = options.resume === true;

    // v0.52 N：参数 > room.debateRounds > 默认值，clip 到 [min, max]
    const reqRounds = Number(options?.debateRounds);
    const roomRounds = Number(room.debateRounds);
    let N = Number.isFinite(reqRounds) ? Math.trunc(reqRounds)
          : Number.isFinite(roomRounds) ? Math.trunc(roomRounds)
          : DEBATE_LIMITS.defaultMacroRounds;
    if (N < DEBATE_LIMITS.minMacroRounds) N = DEBATE_LIMITS.minMacroRounds;
    if (N > DEBATE_LIMITS.maxMacroRounds) N = DEBATE_LIMITS.maxMacroRounds;

    if (!isResume) {
      // 完整重置
      this.store.update(roomId, {
        topic,
        debateRounds: N,
        status: 'running',
        currentRound: 1,
        currentMacroRound: 1,
        rounds: [],
        finalConsensus: null,
        finalDegraded: false,
      });
    } else {
      // 续跑：保留 rounds + finalConsensus，仅恢复运行态
      this.store.update(roomId, { status: 'running' });
    }
    this.broadcast(roomId, { type: isResume ? 'debate_resume' : 'debate_start', topic, debateRounds: N });

    const enabledMembers = room.members.filter(m => m.enabled !== false);
    const adapters = enabledMembers
      .map(m => ({ member: m, adapter: this.adapters.get(m.adapterId) }))
      .filter(x => x.adapter);

    if (adapters.length < 2) {
      this.store.setStatus(roomId, 'error');
      this.broadcast(roomId, { type: 'debate_error', error: '至少需要 2 个启用的成员' });
      throw new Error('需要至少 2 个 adapter');
    }

    const aborter = new AbortController();
    this.activeAborts.set(roomId, aborter);

    try {
      // helper：resume 时跳过已完成 round；非 resume 永远跑全部
      const maybeRun = async (kind, buildMessages, n) => {
        if (isResume) {
          const { complete, missingAdapters } = this._roundCompletion(roomId, kind, adapters);
          if (complete) {
            this.broadcast(roomId, { type: 'round_skip', kind, macroRound: n, reason: 'already_complete' });
            return;
          }
          await this._runRound(roomId, kind, missingAdapters, buildMessages, aborter.signal, n);
        } else {
          await this._runRound(roomId, kind, adapters, buildMessages, aborter.signal, n);
        }
      };

      // ===== N 个大轮：每大轮跑 R1 → R2 → R3 =====
      for (let n = 1; n <= N; n++) {
        this.store.update(roomId, { currentMacroRound: n, currentRound: 1 });
        this.broadcast(roomId, { type: 'macro_round_start', macroRound: n, totalMacroRounds: N });

        const r1Kind = `r1_propose@${n}`;
        const r2Kind = `r2_critique@${n}`;
        const r3Kind = `r3_final@${n}`;

        // ----- R1：第 1 大轮独立提案；第 n≥2 大轮看上一大轮 R3 终稿后再独立提案 -----
        if (n === 1) {
          await maybeRun(r1Kind, (member, others) => [
            { role: 'system', content: ROLE_PROMPT(member.displayName, topic, others.map(o => o.displayName), n, N) },
            { role: 'user', content: `## 当前是第 1 大轮 · 第 1 阶段：独立提案\n请独立给出你认为的最优方案（详细 markdown）。你看不到其他人的，先各自表达。\n\n任务：${topic}` },
          ], n);
        } else {
          // 找上一大轮 R3 终稿（kind 必然带 @n-1 后缀）
          const prevR3Kind = `r3_final@${n - 1}`;
          const prevR3 = this.store.get(roomId).rounds.find(r => r.kind === prevR3Kind);
          const prevR3Context = prevR3
            ? prevR3.turns.map(t => `#### ${t.displayName} 的 R3 终稿\n${t.content}`).join('\n\n---\n\n')
            : '（上一大轮 R3 数据缺失）';
          await maybeRun(r1Kind, (member, others) => [
            { role: 'system', content: ROLE_PROMPT(member.displayName, topic, others.map(o => o.displayName), n, N) },
            { role: 'user', content: R1_RESUME_USER(topic, n, prevR3Context) },
          ], n);
        }

        this.store.update(roomId, { currentRound: 2 });

        // ----- R2 互评修订（看本大轮 R1 全部）-----
        const r1Round = this.store.get(roomId).rounds.find(r => r.kind === r1Kind);
        const r1Turns = r1Round ? r1Round.turns : [];
        await maybeRun(r2Kind, (member, others) => {
          const r1Context = r1Turns.map(t => `### ${t.displayName} 的 R1 提案\n${t.content}`).join('\n\n---\n\n');
          return [
            { role: 'system', content: ROLE_PROMPT(member.displayName, topic, others.map(o => o.displayName), n, N) },
            { role: 'user', content: `## 第 ${n} 大轮 · 第 1 阶段全部 R1 提案\n\n${r1Context}\n\n${R2_INSTRUCTION}` },
          ];
        }, n);

        this.store.update(roomId, { currentRound: 3 });

        // ----- R3 终稿表态（看本大轮 R2 全部）-----
        const r2Round = this.store.get(roomId).rounds.find(r => r.kind === r2Kind);
        const r2Turns = r2Round ? r2Round.turns : [];
        await maybeRun(r3Kind, (member, others) => {
          const r2Context = r2Turns.map(t => `### ${t.displayName} 的 R2 修订\n${t.content}`).join('\n\n---\n\n');
          return [
            { role: 'system', content: ROLE_PROMPT(member.displayName, topic, others.map(o => o.displayName), n, N) },
            { role: 'user', content: `## 第 ${n} 大轮 · 第 2 阶段全部 R2 修订\n\n${r2Context}\n\n${R3_INSTRUCTION}` },
          ];
        }, n);

        this.broadcast(roomId, { type: 'macro_round_done', macroRound: n, totalMacroRounds: N });
      }

      this.store.update(roomId, { currentRound: 4 });

      // ===== R4 judge 总结 =====
      // resume 时若已有 finalConsensus（且非降级），跳过 R4
      const existingFc = this.store.get(roomId).finalConsensus;
      const existingDegraded = this.store.get(roomId).finalDegraded;
      if (isResume && existingFc && !existingDegraded) {
        this.broadcast(roomId, { type: 'judge_skip', reason: 'already_done' });
        this.store.setStatus(roomId, 'done', { currentRound: -1, currentMacroRound: -1 });
        this.broadcast(roomId, { type: 'debate_done' });
        return;
      }
      const judgeMember = room.members.find(m => m.adapterId === 'claude' && m.enabled !== false) || adapters[0].member;
      const judge = this.adapters.get(judgeMember.adapterId) || adapters[0].adapter;
      const judgeModel = judgeMember.model;
      const allRounds = this.store.get(roomId).rounds.filter(r => r.kind !== 'r4_judge');
      const phaseTitle = (kind) => {
        const m = /^(r[123])_(propose|critique|final)@(\d+)$/.exec(kind);
        if (!m) return kind;
        const phaseLabel = { r1_propose: '独立提案', r2_critique: '互评修订', r3_final: '终稿表态' }[`${m[1]}_${m[2]}`] || kind;
        return `## 第 ${m[3]} 大轮 · ${m[1].toUpperCase()} ${phaseLabel}`;
      };
      const allTurnsText = allRounds.map(r => {
        return phaseTitle(r.kind) + '\n\n' + r.turns.map(t => `### ${t.displayName}\n${t.content}`).join('\n\n');
      }).join('\n\n===\n\n');

      this.broadcast(roomId, { type: 'judge_start', judge: judge.displayName });
      const judgeStartedAt = Date.now();
      try {
        const judgePrompt = R4_JUDGE_PROMPT(topic, allTurnsText);
        const judgeResult = await judge.chat(
          injectSkillsToMessages([
          { role: 'system', content: '你是中立主持人，负责合成最终方案。' },
          { role: 'user', content: judgePrompt },
        ], room),
          { cwd: room.cwd, abortSignal: aborter.signal, model: judgeModel, budgetContext: { projectId: room.cwd, roomId: room.id, adapterId: judge.id } },
        );
        this.store.appendTurn(roomId, 'r4_judge', {
          speaker: judge.id,
          displayName: judge.displayName + '（主持）',
          content: judgeResult.reply,
          tokensIn: judgeResult.tokensIn,
          tokensOut: judgeResult.tokensOut,
        });
        this._recordMetric(room, 'r4_judge', judge.id, judgeModel, Date.now() - judgeStartedAt, judgeResult);
        this._resetFailure(roomId);
        // v0.51 ZZZZ-05 fix: finalConsensus cap 防极长 reply 撑爆 rooms.json
        const MAX = CONTENT_LIMITS.maxReplyChars;  // v0.52 256KB
        const fc = (typeof judgeResult.reply === 'string' && judgeResult.reply.length > MAX)
          ? judgeResult.reply.slice(0, MAX) + `\n\n…（已截断，原 ${judgeResult.reply.length} 字符）`
          : judgeResult.reply;
        this.store.update(roomId, { finalConsensus: fc, finalDegraded: false });
        this.broadcast(roomId, { type: 'judge_done', content: judgeResult.reply });
      } catch (e) {
        this.store.appendTurn(roomId, 'r4_judge', {
          speaker: judge.id,
          displayName: judge.displayName + '（主持）',
          content: '[judge 失败] ' + e.message,
          error: true,
        });
        this._recordMetric(room, 'r4_judge', judge.id, judgeModel, Date.now() - judgeStartedAt, null, e?.name || 'error');
        this._bumpFailure(roomId, aborter.signal.aborted);
        // v0.44 P2 #18: 降级到最后一大轮 R3 终稿作为 finalConsensus，前端有 fallback 视图
        // v0.52 fix: 多大轮时取最后一大轮 R3，不再硬编码 rounds[2]
        const lastR3Kind = `r3_final@${N}`;
        const lastR3 = this.store.get(roomId).rounds.find(r => r.kind === lastR3Kind);
        const r3Turns = lastR3 ? lastR3.turns : [];
        const fallback = r3Turns.length > 0
          ? `> ⚠️ Judge 失败，下面是第 ${N} 大轮 R3 三方终稿合并（降级）\n\n` +
            r3Turns.map(t => `## ${t.displayName} 终稿\n\n${t.content}`).join('\n\n---\n\n')
          : `[judge 失败] ${e.message}（且 R3 无内容）`;
        this.store.update(roomId, { finalConsensus: fallback, finalDegraded: true });
        this.broadcast(roomId, { type: 'judge_error', error: e.message, fallback });
      }

      this.store.setStatus(roomId, 'done', { currentRound: -1, currentMacroRound: -1 });
      this.broadcast(roomId, { type: 'debate_done' });
    } catch (e) {
      const aborted = aborter.signal.aborted;
      this.store.setStatus(roomId, aborted ? 'paused' : 'error');
      this.broadcast(roomId, { type: aborted ? 'debate_paused' : 'debate_error', error: e.message });
      throw e;
    } finally {
      this.activeAborts.delete(roomId);
    }
  }

  /** 单轮：并行调所有 adapter；buildMessages(member, others) → messages 数组
   *  v0.52 macroRound 一并广播，前端可按大轮分组渲染 */
  async _runRound(roomId, kind, adapterList, buildMessages, abortSignal, macroRound) {
    const room = this.store.get(roomId);
    this.broadcast(roomId, { type: 'round_start', kind, macroRound });

    const promises = adapterList.map(async ({ member, adapter }) => {
      const others = adapterList.filter(x => x.member.adapterId !== member.adapterId).map(x => x.member);
      const messages = buildMessages(member, others);
      this.broadcast(roomId, { type: 'turn_start', kind, macroRound, speaker: member.adapterId, displayName: member.displayName });
      // v0.52 心跳：spawn 走 onProgress（每收到 stdout 触发）；HTTP 不支持 streaming，dispatcher 自己每 20s 发一次 keep-alive
      let bytesSeen = 0;
      let lastProgressAt = Date.now();
      let realStdoutSeen = false;
      const onProgress = (chunk) => {
        bytesSeen += (chunk?.length || 0);
        realStdoutSeen = true;
        const now = Date.now();
        if (now - lastProgressAt < 500) return;
        lastProgressAt = now;
        this.broadcast(roomId, { type: 'turn_progress', kind, macroRound, speaker: member.adapterId, bytes: bytesSeen, at: new Date(now).toISOString() });
      };
      // HTTP 兜底：调用期间没有真 stdout 时每 20s 发一次"alive"心跳避免前端误判卡死
      const keepAliveTimer = setInterval(() => {
        if (realStdoutSeen) return;
        this.broadcast(roomId, { type: 'turn_progress', kind, macroRound, speaker: member.adapterId, bytes: 0, at: new Date().toISOString(), keepalive: true });
      }, 20000);
      const startedAt = Date.now();
      try {
        const result = await adapter.chat(injectSkillsToMessages(messages, room), {
          cwd: room.cwd,
          abortSignal,
          model: member.model,
          onProgress,
          budgetContext: { projectId: room.cwd, roomId: room.id, adapterId: member.adapterId },
        });
        clearInterval(keepAliveTimer);
        const turn = {
          speaker: member.adapterId,
          displayName: member.displayName,
          content: result.reply,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
        };
        this.store.appendTurn(roomId, kind, turn);
        this._recordMetric(room, `${kind}#mr${macroRound}`, member.adapterId, member.model, Date.now() - startedAt, result);
        this._resetFailure(roomId);
        this.broadcast(roomId, { type: 'turn_done', kind, macroRound, ...turn });
        return turn;
      } catch (e) {
        clearInterval(keepAliveTimer);
        const turn = {
          speaker: member.adapterId,
          displayName: member.displayName,
          content: '[发言失败] ' + e.message,
          error: true,
        };
        this.store.appendTurn(roomId, kind, turn);
        this._recordMetric(room, `${kind}#mr${macroRound}`, member.adapterId, member.model, Date.now() - startedAt, null, e?.name || 'error');
        this._bumpFailure(roomId, abortSignal?.aborted);
        this.broadcast(roomId, { type: 'turn_error', kind, macroRound, speaker: member.adapterId, error: e.message });
        return turn;
      }
    });

    await Promise.all(promises);
    this.broadcast(roomId, { type: 'round_done', kind, macroRound });

    // v0.70 W5+W6 集成（only log，不真改流程）
    try {
      const { detectConsensus } = await import('./learned/consensus-detector.js');
      const { DEBATE_STATE_MACHINE } = await import('./learned/dispatcher-state.js');
      const room = this.store.get(roomId);
      // v0.70.1 bug fix#2: round.kind 可能含 @ 后缀（如 r1_propose@1），match 时 startsWith
      // 此外没有 r3_final 仅 r3_finalize 但 dispatch 用 r3_final，map 时统一处理
      const baseKind = String(kind).split('@')[0];
      const round = (room?.rounds || []).find(r =>
        (r.kind === kind || String(r.kind).split('@')[0] === baseKind) &&
        (r.macroRound === macroRound || r.macroRound == null)
      );
      const stateMap = { r1_propose: 'r1_propose', r2_critique: 'r2_critique', r3_finalize: 'r3_finalize', r3_final: 'r3_finalize', judge: 'judge' };
      const stateName = stateMap[baseKind] || baseKind;
      const stateMeta = DEBATE_STATE_MACHINE.states[stateName];
      const turns = round?.turns || [];
      const detection = detectConsensus(turns);
      this.broadcast(roomId, {
        type: 'debate_state_meta',
        kind, macroRound,
        state: stateName,
        stateDesc: stateMeta?.desc,
        consensus: detection.consensus,
        consensusScore: detection.score,
        consensusEvidence: detection.evidence,
      });
    } catch (e) { console.warn('[debate_state_meta] failed:', e.message); }
  }

  /** 中断正在跑的 debate */
  abort(roomId) {
    const a = this.activeAborts.get(roomId);
    if (a) {
      a.abort();
      this.activeAborts.delete(roomId);
      this.store.setStatus(roomId, 'paused');
      this.broadcast(roomId, { type: 'debate_paused', reason: 'user_abort' });
      return true;
    }
    return false;
  }

  /** v0.52 Sprint1-D：局部重试单个 turn（仅当 turn 是 error 时可重试） */
  async retryTurn(roomId, kind, speakerAdapterId) {
    const room = this.store.get(roomId);
    if (!room) throw new Error('room not found');
    if (room.status === 'running') throw new Error('房间正在运行中，不能局部重试');

    const lockKey = `${roomId}:${kind}:${speakerAdapterId}`;
    if (this.activeRetries.has(lockKey)) throw new Error('该 turn 正在重试中，请等待');
    this.activeRetries.add(lockKey);

    const round = (room.rounds || []).find(r => r.kind === kind);
    if (!round) { this.activeRetries.delete(lockKey); throw new Error(`kind=${kind} 的 round 不存在`); }
    const turnIdx = (round.turns || []).findIndex(t => t.speaker === speakerAdapterId);
    if (turnIdx < 0) { this.activeRetries.delete(lockKey); throw new Error(`speaker=${speakerAdapterId} 在 ${kind} 没有 turn`); }
    const oldTurn = round.turns[turnIdx];
    if (!oldTurn.error) { this.activeRetries.delete(lockKey); throw new Error('该 turn 已成功，无需重试'); }

    const member = (room.members || []).find(m => m.adapterId === speakerAdapterId && m.enabled !== false);
    if (!member) throw new Error('该 adapter 已禁用或被移除');
    const adapter = this.adapters.get(speakerAdapterId);
    if (!adapter) throw new Error(`adapter ${speakerAdapterId} 未注册`);

    // 重建 messages：按 kind 推断阶段，从 store 拿上下文
    // kind 格式：r1_propose@<n> / r2_critique@<n> / r3_final@<n>（v0.52）；老房无 @<n>
    const m = /^(r[123])_(propose|critique|final)(?:@(\d+))?$/.exec(kind);
    if (!m) throw new Error(`kind 格式不识别：${kind}`);
    const phase = `${m[1]}_${m[2]}`;
    const macroN = m[3] ? Number(m[3]) : 1;
    const N = room.debateRounds || 1;

    // 拿 enabledAdapters 用于 others 名单
    const enabledMembers = room.members.filter(mm => mm.enabled !== false);
    const others = enabledMembers.filter(mm => mm.adapterId !== speakerAdapterId);
    const topic = room.topic || '';

    let messages;
    if (phase === 'r1_propose') {
      if (macroN === 1) {
        messages = [
          { role: 'system', content: ROLE_PROMPT(member.displayName, topic, others.map(o => o.displayName), macroN, N) },
          { role: 'user', content: `## 当前是第 1 大轮 · 第 1 阶段：独立提案\n请独立给出你认为的最优方案（详细 markdown）。你看不到其他人的，先各自表达。\n\n任务：${topic}` },
        ];
      } else {
        const prevR3 = room.rounds.find(r => r.kind === `r3_final@${macroN - 1}`);
        const prevR3Context = prevR3
          ? prevR3.turns.map(t => `#### ${t.displayName} 的 R3 终稿\n${t.content}`).join('\n\n---\n\n')
          : '（上一大轮 R3 数据缺失）';
        messages = [
          { role: 'system', content: ROLE_PROMPT(member.displayName, topic, others.map(o => o.displayName), macroN, N) },
          { role: 'user', content: R1_RESUME_USER(topic, macroN, prevR3Context) },
        ];
      }
    } else if (phase === 'r2_critique') {
      const r1Round = room.rounds.find(r => r.kind === `r1_propose@${macroN}` || r.kind === 'r1_propose');
      const r1Context = (r1Round?.turns || []).map(t => `### ${t.displayName} 的 R1 提案\n${t.content}`).join('\n\n---\n\n');
      messages = [
        { role: 'system', content: ROLE_PROMPT(member.displayName, topic, others.map(o => o.displayName), macroN, N) },
        { role: 'user', content: `## 第 ${macroN} 大轮 · 第 1 阶段全部 R1 提案\n\n${r1Context}\n\n${R2_INSTRUCTION}` },
      ];
    } else { // r3_final
      const r2Round = room.rounds.find(r => r.kind === `r2_critique@${macroN}` || r.kind === 'r2_critique');
      const r2Context = (r2Round?.turns || []).map(t => `### ${t.displayName} 的 R2 修订\n${t.content}`).join('\n\n---\n\n');
      messages = [
        { role: 'system', content: ROLE_PROMPT(member.displayName, topic, others.map(o => o.displayName), macroN, N) },
        { role: 'user', content: `## 第 ${macroN} 大轮 · 第 2 阶段全部 R2 修订\n\n${r2Context}\n\n${R3_INSTRUCTION}` },
      ];
    }

    this.broadcast(roomId, { type: 'turn_retry_start', kind, macroRound: macroN, speaker: speakerAdapterId, displayName: member.displayName });
    let bytesSeen = 0;
    let realStdoutSeen = false;
    const onProgress = (chunk) => {
      bytesSeen += (chunk?.length || 0);
      realStdoutSeen = true;
      this.broadcast(roomId, { type: 'turn_progress', kind, macroRound: macroN, speaker: speakerAdapterId, bytes: bytesSeen });
    };
    const keepAlive = setInterval(() => {
      if (!realStdoutSeen) this.broadcast(roomId, { type: 'turn_progress', kind, macroRound: macroN, speaker: speakerAdapterId, bytes: 0, keepalive: true });
    }, 20000);
    const retryStartedAt = Date.now();
    try {
      const result = await adapter.chat(injectSkillsToMessages(messages, room), {
        cwd: room.cwd,
        model: member.model,
        onProgress,
        budgetContext: { projectId: room.cwd, roomId: room.id, adapterId: speakerAdapterId },
      });
      clearInterval(keepAlive);
      const newTurn = {
        speaker: speakerAdapterId,
        displayName: member.displayName,
        content: result.reply,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        at: new Date().toISOString(),
        retriedAt: new Date().toISOString(),
      };
      round.turns[turnIdx] = newTurn;
      this.store.save();
      this._recordMetric(room, `${kind}#retry`, speakerAdapterId, member.model, Date.now() - retryStartedAt, result);
      this.broadcast(roomId, { type: 'turn_done', kind, macroRound: macroN, ...newTurn, retry: true });
      return { ok: true, turn: newTurn };
    } catch (e) {
      clearInterval(keepAlive);
      round.turns[turnIdx] = {
        ...oldTurn,
        content: `[重试仍失败] ${e.message}\n\n原错误：${oldTurn.content}`,
        retriedAt: new Date().toISOString(),
      };
      this.store.save();
      this._recordMetric(room, `${kind}#retry`, speakerAdapterId, member.model, Date.now() - retryStartedAt, null, e?.name || 'error');
      this.broadcast(roomId, { type: 'turn_error', kind, macroRound: macroN, speaker: speakerAdapterId, error: e.message, retry: true });
      throw e;
    } finally {
      this.activeRetries.delete(lockKey);
    }
  }
}
