// WatcherDispatcher — 决定何时调 watcher.judge() + 限流 + 防抖
//
// 触发条件（全部满足）：
// 1. watcherConfig.enabled = true
// 2. session.watcherEnabled = true（per-session 开关）
// 3. session 刚收到 stream-json result success（busy: true → false 转换且非 error）
// 4. 距上次 judge >= triggers.minIntervalSec（默认 60s）
// 5. 自上次 user message 起 >= triggers.requireIdleSec（30s）—— 但若 claude 直接完成可放宽
// 6. session.watcherCallCount < rateLimit.perSessionPerHour（最近 1h）
// 7. 全局 globalCallCount < rateLimit.globalPerHour

export class WatcherDispatcher {
  constructor({ adapter, adapterPool, config, broadcastFn, dangerDetector, persistSession }) {
    this.adapter = adapter;        // 默认 / 兜底 WatcherAdapter
    this.adapterPool = adapterPool || new Map(); // v0.40 providerId → adapter
    this.config = config;          // WatcherConfig 对象
    this.broadcast = broadcastFn;  // (session, msg) => void
    this.dangerDetector = dangerDetector; // 可选：扫 next_action.prompt
    this.persistSession = persistSession || (() => {}); // v0.45 P1-5: 让外部触发 saveData

    // 每个 session 的 watcher 状态
    this.sessionState = new Map(); // sid → { lastJudgeAt, callCountWindow: [{at}], autoPromptCount, lastResultAt }
    // 全局 rate limit
    this.globalCalls = []; // [{at}]
  }

  setAdapter(adapter) { this.adapter = adapter; }
  setAdapterPool(pool) { this.adapterPool = pool || new Map(); }
  setConfig(config) { this.config = config; }

  /** v0.40: per-session 选 adapter，回退默认；v0.43: provider 不在池里时广播 fallback */
  _pickAdapterFor(session) {
    const pid = session.watcherProviderId;
    if (pid && this.adapterPool.has(pid)) return this.adapterPool.get(pid);
    if (pid && this.adapter) {
      // session 指定了某个 provider 但池里已经没了（被配置变更踢出）→ 用默认 + 通知前端
      this.broadcast(session, { type: 'watcher_fallback', requested: pid, using: this.adapter.name });
    }
    return this.adapter; // 回退默认
  }

  /** Claude session 收到 result（无论 success/error）调用，返回 Promise<{autoExecute, prompt}> */
  async onResultEvent(session, obj) {
    const state = this._ensureSessionState(session.id);
    state.lastResultAt = Date.now();
    if (obj.is_error) return; // 失败不触发 watcher（让 user 介入）
    if (!this.config?.enabled) return;
    const adapter = this._pickAdapterFor(session);
    if (!adapter) return;
    if (!session.watcherEnabled) return;

    // 防抖
    const now = Date.now();
    const minInterval = (this.config.triggers?.minIntervalSec || 60) * 1000;
    if (state.lastJudgeAt && (now - state.lastJudgeAt) < minInterval) {
      return;
    }
    // rate limit per session
    const windowMs = 60 * 60 * 1000; // 1h
    state.callCountWindow = state.callCountWindow.filter(c => now - c.at < windowMs);
    const perSession = this.config.rateLimit?.perSessionPerHour || 10;
    if (state.callCountWindow.length >= perSession) {
      this.broadcast(session, { type: 'watcher_skipped', reason: 'per_session_rate_limit', limit: perSession });
      return;
    }
    // global rate limit
    this.globalCalls = this.globalCalls.filter(c => now - c.at < windowMs);
    const globalLimit = this.config.rateLimit?.globalPerHour || 60;
    if (this.globalCalls.length >= globalLimit) {
      this.broadcast(session, { type: 'watcher_skipped', reason: 'global_rate_limit', limit: globalLimit });
      return;
    }
    // 防自动 prompt 失控（max 单 session 自动注入次数）
    const maxAuto = this.config.safety?.maxAutoPromptsPerSession || 20;
    if ((state.autoPromptCount || 0) >= maxAuto) {
      this.broadcast(session, { type: 'watcher_skipped', reason: 'max_auto_prompts_reached', max: maxAuto });
      return;
    }

    // 直接 await（caller 已经在 child.on('exit') 异步路径，不阻塞 stream-json）
    return await this._performJudge(session, state, adapter);
  }

  async _performJudge(session, state, adapter) {
    const now = Date.now();
    state.lastJudgeAt = now;
    state.callCountWindow.push({ at: now });
    this.globalCalls.push({ at: now });

    this.broadcast(session, { type: 'watcher_judging', provider: adapter.name });

    try {
      const sessionState = {
        id: session.id,
        name: session.name,
        cwd: session.cwd,
        mainGoal: session.mainGoal || null,
        messages: (session.messages || []).slice(-30),
        runState: session.runState || 'idle',
      };
      const verdict = await adapter.judge(sessionState);
      // DangerDetector 扫 next_action.prompt
      let dangerHits = [];
      if (this.dangerDetector && this.config.safety?.dangerScanNextAction && verdict.next_action?.prompt) {
        dangerHits = this.dangerDetector.scan(verdict.next_action.prompt);
        if (dangerHits.length > 0 && this.dangerDetector.shouldBlock(dangerHits, 'standard')) {
          verdict.next_action.danger_level = 'needs_review';
          verdict.next_action.danger_hits = dangerHits.map(h => h.rule.category);
        }
      }
      // 记历史
      if (!session.watcherHistory) session.watcherHistory = [];
      // v0.51 ZZZZ-03 fix: LLM 输出的 verdict 字段可能很长，cap 防 watcherHistory 撑爆
      const cappedVerdict = {
        ...verdict,
        reasoning: typeof verdict.reasoning === 'string' ? verdict.reasoning.slice(0, 4000) : verdict.reasoning,
        next_action: verdict.next_action ? {
          ...verdict.next_action,
          prompt: typeof verdict.next_action.prompt === 'string' ? verdict.next_action.prompt.slice(0, 4000) : verdict.next_action.prompt,
        } : verdict.next_action,
        completed_items: Array.isArray(verdict.completed_items) ? verdict.completed_items.slice(0, 30) : [],
        remaining_items: Array.isArray(verdict.remaining_items) ? verdict.remaining_items.slice(0, 30) : [],
      };
      session.watcherHistory.push({
        ts: new Date().toISOString(),
        provider: adapter.name,
        verdict: cappedVerdict,
      });
      if (session.watcherHistory.length > 50) session.watcherHistory = session.watcherHistory.slice(-50);
      // v0.45 P1-5: 持久化（避免重启丢 watcher 历史）
      try { this.persistSession(session); } catch {}

      this.broadcast(session, { type: 'watcher_verdict', verdict, provider: adapter.name });

      // 自动模式 + 安全检查通过 → 自动发回 claude
      const auto = this.config.autoMode;
      const driftBlock = this.config.safety?.blockOnDrift && verdict.drift_detected;
      const dangerBlock = verdict.next_action.danger_level === 'needs_review';
      if (auto && !driftBlock && !dangerBlock
          && verdict.next_action.type === 'continue'
          && verdict.next_action.prompt
          && verdict.confidence >= 0.6) {
        state.autoPromptCount = (state.autoPromptCount || 0) + 1;
        this.broadcast(session, {
          type: 'watcher_auto_executing',
          prompt: verdict.next_action.prompt,
          autoPromptCount: state.autoPromptCount,
        });
        // 让调用方真的把 prompt 发回 claude（避免循环依赖，dispatcher 不直接 sendMessageToClaude）
        return { autoExecute: true, prompt: verdict.next_action.prompt };
      }
      return { autoExecute: false };
    } catch (e) {
      this.broadcast(session, { type: 'watcher_error', error: e.message });
      return { autoExecute: false, error: e.message };
    }
  }

  _ensureSessionState(sid) {
    if (!this.sessionState.has(sid)) {
      this.sessionState.set(sid, {
        lastJudgeAt: 0,
        callCountWindow: [],
        autoPromptCount: 0,
        lastResultAt: 0,
      });
    }
    return this.sessionState.get(sid);
  }

  /** 重置某 session 的 watcher 状态（如用户手动触发） */
  resetSession(sid) {
    this.sessionState.delete(sid);
  }
  // v0.51 A-02 fix: 用户 interrupt / reset-busy 后只清 autoPromptCount，
  // 保留 lastJudgeAt / callCountWindow 限速状态（防滥用）
  clearAutoPromptCount(sid) {
    const s = this.sessionState.get(sid);
    if (s) s.autoPromptCount = 0;
  }
}
