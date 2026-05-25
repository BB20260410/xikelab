// SoloChatDispatcher — 1v1 持续对话编排
//
// 跟 Debate / Squad 不同：
// - 只 1 个 AI 成员
// - 用户主导，每次 sendMessage 触发 adapter.chat()
// - conversation = 完整历史（按时间），AI 每次能看到所有上下文
//
// 数据：room.conversation = [{ at, from:'user'|'<adapterId>', content, error? }]

import { ROOM_LIMITS, CONTENT_LIMITS } from './squad-limits.js';
import { metricsStore as defaultMetricsStore } from '../metrics/MetricsStore.js';
import { injectSkillsToMessages } from './skillInjector.js';

const AUTO_PAUSE_THRESHOLD = 5;  // v0.53 Sprint 3.5

export class SoloChatDispatcher {
  constructor({ store, adapters, broadcast, metrics }) {
    this.store = store;
    this.adapters = adapters;
    this.broadcast = broadcast || (() => {});
    this.metrics = metrics || defaultMetricsStore;  // v0.53 Sprint 3
    this.activeAborts = new Map(); // roomId → AbortController
    this._fails = new Map();  // v0.53 Sprint 3.5
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
      try { this.broadcast(roomId, { type: 'room_auto_paused', reason: `连续 ${AUTO_PAUSE_THRESHOLD} 次 chat 失败/超时` }); } catch {}
    }
  }
  _resetFailure(roomId) { this._fails.delete(roomId); }

  abort(roomId) {
    const a = this.activeAborts.get(roomId);
    if (a) {
      a.abort();
      this.activeAborts.delete(roomId);
      this.broadcast(roomId, { type: 'chat_aborted' });
      return true;
    }
    return false;
  }

  /** 用户发一条消息，触发一次 AI 回应 */
  async sendMessage(roomId, userText) {
    const room = this.store.get(roomId);
    if (!room) throw new Error('room not found');
    if (room.mode !== 'chat') throw new Error('room mode != chat');
    // v0.51 T-39 fix: 防并发 sendMessage（用户快速双击发送会让两个 adapter 并行 spawn）
    if (this.activeAborts.has(roomId)) {
      throw new Error('chat 房正在处理上一条消息，请等待回复或先 abort');
    }

    const enabled = (room.members || []).filter(m => m.enabled !== false);
    if (enabled.length === 0) throw new Error('chat 房需要 1 个启用成员');
    const member = enabled[0]; // 1v1 只取第一个
    const adapter = this.adapters.get(member.adapterId);
    if (!adapter) throw new Error('adapter not registered: ' + member.adapterId);

    // 1. 追加用户消息到 conversation（v0.49 N-15: 持久化封顶）
    if (!Array.isArray(room.conversation)) room.conversation = [];
    const userMsg = { at: new Date().toISOString(), from: 'user', content: String(userText).slice(0, 16000) };
    room.conversation.push(userMsg);
    const maxKeep = ROOM_LIMITS.chatConversationMax || 200;
    if (room.conversation.length > maxKeep) {
      room.conversation = room.conversation.slice(-maxKeep);
    }
    this.store.update(roomId, { conversation: room.conversation });
    this.broadcast(roomId, { type: 'chat_user_msg', message: userMsg });

    // 2. 通知前端 AI 思考中
    this.broadcast(roomId, { type: 'chat_thinking', member: member.adapterId, displayName: member.displayName });

    // 3. 拍平 conversation → messages 数组给 adapter（v0.49 N-15: 发 LLM 时只取最近 N 条防 token 爆炸）
    const ctxMax = ROOM_LIMITS.chatContextMaxTurns || 40;
    const ctxSlice = room.conversation.slice(-ctxMax);
    const messages = [
      { role: 'system', content: `你是 ${member.displayName}，正在和用户进行 1 对 1 对话。请用中文清晰回答。如有具体任务（写代码/查信息/做计算）请尽量真的去做。` },
      ...ctxSlice.map(m => ({
        role: m.from === 'user' ? 'user' : 'assistant',
        content: m.content,
      })),
    ];

    const aborter = new AbortController();
    this.activeAborts.set(roomId, aborter);
    const startedAt = Date.now();
    try {
      const result = await adapter.chat(injectSkillsToMessages(messages, room), {
        cwd: room.cwd,
        abortSignal: aborter.signal,
        model: member.model,
        budgetContext: { projectId: room.cwd, roomId: room.id, adapterId: member.adapterId },
      });
      // v0.51 ZZZZ-02 fix: AI reply 长度 cap，防极长输出撑爆 rooms.json
      const MAX_REPLY = CONTENT_LIMITS.maxReplyChars;  // v0.52 256KB
      const replyContent = (typeof result.reply === 'string' && result.reply.length > MAX_REPLY)
        ? result.reply.slice(0, MAX_REPLY) + `\n\n…（已截断，原 ${result.reply.length} 字符）`
        : result.reply;
      const aiMsg = {
        at: new Date().toISOString(),
        from: member.adapterId,
        displayName: member.displayName,
        content: replyContent,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      };
      room.conversation.push(aiMsg);
      this.store.update(roomId, { conversation: room.conversation });
      try {
        this.metrics?.record?.({
          roomId: room.id, roomMode: 'chat', roomName: room.name,
          projectId: room.cwd,
          turn: 'chat', adapter: member.adapterId, model: member.model || '',
          latencyMs: Date.now() - startedAt,
          tokensIn: result.tokensIn || 0, tokensOut: result.tokensOut || 0,
          success: true, errorKind: null,
        });
      } catch {}
      this._resetFailure(roomId);
      this.broadcast(roomId, { type: 'chat_ai_msg', message: aiMsg });
      return aiMsg;
    } catch (e) {
      const errMsg = {
        at: new Date().toISOString(),
        from: member.adapterId,
        displayName: member.displayName,
        content: '[失败] ' + e.message,
        error: true,
      };
      room.conversation.push(errMsg);
      this.store.update(roomId, { conversation: room.conversation });
      try {
        this.metrics?.record?.({
          roomId: room.id, roomMode: 'chat', roomName: room.name,
          projectId: room.cwd,
          turn: 'chat', adapter: member.adapterId, model: member.model || '',
          latencyMs: Date.now() - startedAt,
          tokensIn: 0, tokensOut: 0,
          success: false, errorKind: e?.name || 'error',
        });
      } catch {}
      this._bumpFailure(roomId, aborter.signal.aborted);
      this.broadcast(roomId, { type: 'chat_error', error: e.message, message: errMsg });
      throw e;
    } finally {
      this.activeAborts.delete(roomId);
    }
  }
}
