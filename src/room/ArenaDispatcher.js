// ArenaDispatcher — 多组对决模式
// 流程：N 个 AI 并行各自给方案（互不相通）→ Claude CLI judge 拿全部提案 + 联网核对 → 输出最优意见
//
// 关键差异 vs DebateDispatcher：
// - 只有 1 大轮（无 R2/R3 互评）
// - judge 必须走 Claude/Codex/Gemini CLI（有 WebSearch/WebFetch 工具）才能联网核对
// - 喂 judge 时匿名化（A/B/C/D 替代 model 名）避免偏心
//
// v0.52 Sprint1-A

import { CONTENT_LIMITS } from './squad-limits.js';
import { metricsStore as defaultMetricsStore } from '../metrics/MetricsStore.js';
import { injectSkillsToMessages } from './skillInjector.js';

const PROPOSAL_PROMPT = (topic, anonId) => `# 你的角色：Arena 提案者（编号 ${anonId}）

## 🎯 OBJECTIVE
针对下面这个任务，**独立**给出你认为的最优方案。不要解释你是谁、不要提"作为 AI 助手"。

## 📥 任务
${topic}

## 📤 OUTPUT FORMAT
中文 markdown。结构清楚分段。

## 🛠 TOOLS GUIDANCE
- 给**具体可执行**的方案，不要泛泛而谈
- 数据 / 链接 / 引用尽量给来源
- 如果你不确定某个事实，明确标 "[待核实]"——后面 judge 会联网核对

## ⛔ BOUNDARY
- 不要 markdown 围栏，不要前后任何说明文字`;

const JUDGE_PROMPT = (topic, anonymizedProposals, proposalCount) => `# 你的角色：联网事实核对员 + 最优方案合成员

## 🎯 OBJECTIVE
${proposalCount} 个 AI 独立给了 ${proposalCount} 份方案（已匿名化为 A/B/C/D 等）。你的工作：
1. 提取每份提案的"可核对事实点"（数据 / 链接 / 引用 / 时效声明）
2. 用 **WebSearch** 和 **WebFetch** 工具核实关键事实点
3. 找事实错误 / 信息冲突 / 已过时声明
4. 综合产出统一的最优意见

## 🛠 你能用的工具
- **WebSearch(query)**：搜索关键事实
- **WebFetch(url)**：抓取具体页面核对数据
- **真的去调用这些工具**——你的核心价值在于联网核实，不要纸上谈兵

## 📥 INPUT
### 原始任务
${topic}

### ${proposalCount} 份匿名提案
${anonymizedProposals}

## 📤 OUTPUT FORMAT（严格 markdown 4 节）

### 一、各方案事实核对表
| 方案 | 关键声明 | 联网核实结果 | 结论 |
|------|---------|-------------|------|
| A | "X 库每周下载 100w" | 查 npm trends：实际 87w | ⚠️ 偏高但接近 |
| B | "iOS 17 默认开启 X" | 查 Apple 文档：iOS 18 才默认 | ❌ 时效错 |
| ... | ... | ... | ✅/❌/⚠️ |

### 二、各方案优劣对比
- **A 提案**：优点 / 缺点（基于核对结果）
- **B 提案**：...
（每方案 2-4 句）

### 三、综合最优意见
（一份完整可执行方案，融合核实过的最优点）

### 四、来源标注
- 结论 1 ← 来自 A 已联网核实
- 结论 2 ← 来自 B+C 一致 + 我 WebFetch 验证
- 结论 3 ← 我用 WebSearch 补充的事实

## ⛔ BOUNDARY
- 不要 markdown 围栏，不要前后说明文字
- 必须**真的调用 WebSearch / WebFetch**——空说"我搜索过"算无效
- 不要识别哪份提案是哪个 model 写的，按 A/B/C/D 编号判断`;

const AUTO_PAUSE_THRESHOLD = 5;  // v0.53 Sprint 3.5

export class ArenaDispatcher {
  constructor({ store, adapters, broadcast, metrics }) {
    this.store = store;
    this.adapters = adapters;
    this.broadcast = broadcast || (() => {});
    this.metrics = metrics || defaultMetricsStore;  // v0.53 Sprint 3
    this.activeAborts = new Map();
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

  _recordMetric(room, turnKind, speaker, model, latencyMs, result, errorKind = null) {
    try {
      this.metrics?.record?.({
        roomId: room.id,
        roomMode: 'arena',
        roomName: room.name,
        turn: turnKind,
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

  async start(roomId, topic, _options = {}) {
    const room = this.store.get(roomId);
    if (!room) throw new Error('room not found: ' + roomId);
    if (room.status === 'running') throw new Error('room is already running');

    this.store.update(roomId, {
      topic,
      status: 'running',
      currentRound: 1,
      rounds: [],
      finalConsensus: null,
      finalDegraded: false,
    });
    this.broadcast(roomId, { type: 'arena_start', topic });

    // v0.52 Sprint1-A：所有 enabled 成员都参与提案（包括 judge 也提案，避免人手不够）
    // judge 角色仅决定 Phase 2 谁来联网核对
    const enabledMembers = room.members.filter(m => m.enabled !== false);
    const judgeCandidate = room.members.find(m => m.role === 'judge' && m.enabled !== false);
    const proposers = enabledMembers
      .map(m => ({ member: m, adapter: this.adapters.get(m.adapterId) }))
      .filter(x => x.adapter);

    if (proposers.length < 2) {
      this.store.setStatus(roomId, 'error');
      this.broadcast(roomId, { type: 'arena_error', error: '至少需要 2 个启用的成员' });
      throw new Error('需要至少 2 个 proposer');
    }

    const aborter = new AbortController();
    this.activeAborts.set(roomId, aborter);

    try {
      // ===== Phase 1：N 个 AI 并行独立提案 =====
      this.broadcast(roomId, { type: 'round_start', kind: 'proposals', macroRound: 1 });
      const anonLetters = ['A', 'B', 'C', 'D', 'E', 'F'];
      const proposalPromises = proposers.map(async ({ member, adapter }, idx) => {
        const anonId = anonLetters[idx] || `P${idx + 1}`;
        this.broadcast(roomId, {
          type: 'turn_start',
          kind: 'proposals',
          macroRound: 1,
          speaker: member.adapterId,
          displayName: member.displayName,
          anonId,
        });
        let bytesSeen = 0;
        let realStdoutSeen = false;
        const onProgress = (chunk) => {
          bytesSeen += (chunk?.length || 0);
          realStdoutSeen = true;
          this.broadcast(roomId, { type: 'turn_progress', kind: 'proposals', macroRound: 1, speaker: member.adapterId, bytes: bytesSeen });
        };
        const keepAlive = setInterval(() => {
          if (!realStdoutSeen) this.broadcast(roomId, { type: 'turn_progress', kind: 'proposals', macroRound: 1, speaker: member.adapterId, bytes: 0, keepalive: true });
        }, 20000);
        const startedAt = Date.now();
        try {
          const result = await adapter.chat(injectSkillsToMessages([
            { role: 'system', content: PROPOSAL_PROMPT(topic, anonId) },
            { role: 'user', content: `任务：${topic}\n\n请直接给方案。` },
          ], room), { cwd: room.cwd, abortSignal: aborter.signal, model: member.model, onProgress });
          clearInterval(keepAlive);
          const turn = {
            speaker: member.adapterId,
            displayName: member.displayName,
            content: result.reply,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            anonId,
          };
          this.store.appendTurn(roomId, 'proposals', turn);
          this._recordMetric(room, `proposals:${anonId}`, member.adapterId, member.model, Date.now() - startedAt, result);
          this._resetFailure(roomId);
          this.broadcast(roomId, { type: 'turn_done', kind: 'proposals', macroRound: 1, ...turn });
          return turn;
        } catch (e) {
          clearInterval(keepAlive);
          const turn = {
            speaker: member.adapterId,
            displayName: member.displayName,
            content: '[提案失败] ' + e.message,
            error: true,
            anonId,
          };
          this.store.appendTurn(roomId, 'proposals', turn);
          this._recordMetric(room, `proposals:${anonId}`, member.adapterId, member.model, Date.now() - startedAt, null, e?.name || 'error');
          this._bumpFailure(roomId, aborter.signal.aborted);
          this.broadcast(roomId, { type: 'turn_error', kind: 'proposals', macroRound: 1, speaker: member.adapterId, error: e.message });
          return turn;
        }
      });
      await Promise.all(proposalPromises);
      this.broadcast(roomId, { type: 'round_done', kind: 'proposals', macroRound: 1 });

      // ===== Phase 2：Judge 联网核对 + 合成 =====
      // Judge 优先 claude（WebSearch 强）→ codex → gemini-cli
      const judgeMember = judgeCandidate
        || room.members.find(m => m.adapterId === 'claude' && m.enabled !== false)
        || room.members.find(m => m.adapterId === 'codex' && m.enabled !== false)
        || room.members.find(m => m.adapterId === 'gemini-cli' && m.enabled !== false)
        || proposers[0].member;
      const judge = this.adapters.get(judgeMember.adapterId);
      if (!judge) {
        this.store.setStatus(roomId, 'error');
        this.broadcast(roomId, { type: 'arena_error', error: 'judge adapter 未注册' });
        throw new Error('judge adapter 未注册');
      }

      // 拼接匿名化提案
      const proposalsRound = this.store.get(roomId).rounds.find(r => r.kind === 'proposals');
      const validTurns = (proposalsRound?.turns || []).filter(t => !t.error);
      if (validTurns.length === 0) {
        this.store.setStatus(roomId, 'error');
        this.broadcast(roomId, { type: 'arena_error', error: '所有提案都失败了，无内容可核对' });
        return;
      }
      const anonymized = validTurns.map(t => `## 方案 ${t.anonId}\n\n${t.content}`).join('\n\n===\n\n');

      this.broadcast(roomId, { type: 'judge_start', judge: judgeMember.displayName });
      const judgeStartedAt = Date.now();
      try {
        const judgeResult = await judge.chat(injectSkillsToMessages([
          { role: 'system', content: '你是 Arena 联网事实核对员。你有 WebSearch 和 WebFetch 工具，必须真的去调用。' },
          { role: 'user', content: JUDGE_PROMPT(topic, anonymized, validTurns.length) },
        ], room), { cwd: room.cwd, abortSignal: aborter.signal, model: judgeMember.model });

        this.store.appendTurn(roomId, 'arena_judge', {
          speaker: judgeMember.adapterId,
          displayName: judgeMember.displayName + '（联网核对员）',
          content: judgeResult.reply,
          tokensIn: judgeResult.tokensIn,
          tokensOut: judgeResult.tokensOut,
        });
        this._recordMetric(room, 'arena_judge', judgeMember.adapterId, judgeMember.model, Date.now() - judgeStartedAt, judgeResult);
        this._resetFailure(roomId);
        const MAX = CONTENT_LIMITS.maxReplyChars;
        const fc = (typeof judgeResult.reply === 'string' && judgeResult.reply.length > MAX)
          ? judgeResult.reply.slice(0, MAX) + `\n\n…（已截断，原 ${judgeResult.reply.length} 字符）`
          : judgeResult.reply;
        this.store.update(roomId, { finalConsensus: fc, finalDegraded: false });
        this.broadcast(roomId, { type: 'judge_done', content: judgeResult.reply });
      } catch (e) {
        this.store.appendTurn(roomId, 'arena_judge', {
          speaker: judgeMember.adapterId,
          displayName: judgeMember.displayName + '（联网核对员）',
          content: '[judge 失败] ' + e.message,
          error: true,
        });
        this._recordMetric(room, 'arena_judge', judgeMember.adapterId, judgeMember.model, Date.now() - judgeStartedAt, null, e?.name || 'error');
        this._bumpFailure(roomId, aborter.signal.aborted);
        const fallback = `> ⚠️ Judge 失败，下面是 ${validTurns.length} 份原始提案合并（降级）\n\n` +
          validTurns.map(t => `## 提案 ${t.anonId}（${t.displayName}）\n\n${t.content}`).join('\n\n---\n\n');
        this.store.update(roomId, { finalConsensus: fallback, finalDegraded: true });
        this.broadcast(roomId, { type: 'judge_error', error: e.message, fallback });
      }

      this.store.setStatus(roomId, 'done', { currentRound: -1 });
      this.broadcast(roomId, { type: 'arena_done' });
    } catch (e) {
      const aborted = aborter.signal.aborted;
      this.store.setStatus(roomId, aborted ? 'paused' : 'error');
      this.broadcast(roomId, { type: aborted ? 'arena_paused' : 'arena_error', error: e.message });
      throw e;
    } finally {
      this.activeAborts.delete(roomId);
    }
  }

  abort(roomId) {
    const a = this.activeAborts.get(roomId);
    if (a) {
      a.abort();
      this.activeAborts.delete(roomId);
      this.store.setStatus(roomId, 'paused');
      this.broadcast(roomId, { type: 'arena_paused', reason: 'user_abort' });
      return true;
    }
    return false;
  }

  /** v0.52 Sprint1-D：arena 房局部重试单个提案（kind='proposals'）或 judge 段 */
  async retryTurn(roomId, kind, speakerAdapterId) {
    const room = this.store.get(roomId);
    if (!room) throw new Error('room not found');
    if (room.status === 'running') throw new Error('房间正在运行中，不能局部重试');

    if (kind !== 'proposals' && kind !== 'arena_judge') {
      throw new Error(`arena 房只支持 kind=proposals / arena_judge，收到：${kind}`);
    }
    const round = (room.rounds || []).find(r => r.kind === kind);
    if (!round) throw new Error(`kind=${kind} 的 round 不存在`);
    const turnIdx = (round.turns || []).findIndex(t => t.speaker === speakerAdapterId);
    if (turnIdx < 0) throw new Error(`speaker=${speakerAdapterId} 在 ${kind} 没有 turn`);
    const oldTurn = round.turns[turnIdx];
    if (!oldTurn.error) throw new Error('该 turn 已成功，无需重试');

    const member = (room.members || []).find(m => m.adapterId === speakerAdapterId && m.enabled !== false);
    if (!member) throw new Error('该 adapter 已禁用或被移除');
    const adapter = this.adapters.get(speakerAdapterId);
    if (!adapter) throw new Error(`adapter ${speakerAdapterId} 未注册`);

    const topic = room.topic || '';
    let messages;
    if (kind === 'proposals') {
      const anonId = oldTurn.anonId || 'A';
      messages = [
        { role: 'system', content: PROPOSAL_PROMPT(topic, anonId) },
        { role: 'user', content: `任务：${topic}\n\n请直接给方案。` },
      ];
    } else {
      // arena_judge 重试：重新拼接所有 proposals + 跑 judge
      const proposalsRound = room.rounds.find(r => r.kind === 'proposals');
      const validTurns = (proposalsRound?.turns || []).filter(t => !t.error);
      if (validTurns.length === 0) throw new Error('proposals 全部失败，无法重新 judge');
      const anonymized = validTurns.map(t => `## 方案 ${t.anonId}\n\n${t.content}`).join('\n\n===\n\n');
      messages = [
        { role: 'system', content: '你是 Arena 联网事实核对员。你有 WebSearch 和 WebFetch 工具，必须真的去调用。' },
        { role: 'user', content: JUDGE_PROMPT(topic, anonymized, validTurns.length) },
      ];
    }

    this.broadcast(roomId, { type: 'turn_retry_start', kind, macroRound: 1, speaker: speakerAdapterId, displayName: member.displayName });
    const retryStartedAt = Date.now();
    try {
      const result = await adapter.chat(injectSkillsToMessages(messages, room), { cwd: room.cwd, model: member.model });
      const newTurn = {
        speaker: speakerAdapterId,
        displayName: member.displayName,
        content: result.reply,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        at: new Date().toISOString(),
        retriedAt: new Date().toISOString(),
        anonId: oldTurn.anonId,
      };
      round.turns[turnIdx] = newTurn;
      // judge 重试成功要同步更新 finalConsensus
      if (kind === 'arena_judge') {
        this.store.update(roomId, { finalConsensus: result.reply, finalDegraded: false });
      }
      this.store.save();
      this._recordMetric(room, `${kind}#retry`, speakerAdapterId, member.model, Date.now() - retryStartedAt, result);
      this.broadcast(roomId, { type: 'turn_done', kind, macroRound: 1, ...newTurn, retry: true });
      return { ok: true, turn: newTurn };
    } catch (e) {
      round.turns[turnIdx] = {
        ...oldTurn,
        content: `[重试仍失败] ${e.message}\n\n原错误：${oldTurn.content}`,
        retriedAt: new Date().toISOString(),
      };
      this.store.save();
      this._recordMetric(room, `${kind}#retry`, speakerAdapterId, member.model, Date.now() - retryStartedAt, null, e?.name || 'error');
      this.broadcast(roomId, { type: 'turn_error', kind, macroRound: 1, speaker: speakerAdapterId, error: e.message, retry: true });
      throw e;
    }
  }
}
