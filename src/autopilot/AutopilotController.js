// v0.56 Sprint 15-R4 — Autopilot Controller
//
// 监听 broadcastRoom，按 AutopilotStore 规则触发跨房 forward / notify
// 边界：
//   1. 全局 enabled=false 时啥也不做
//   2. 房被用户 claim 时不动它（claimedBy='user'）
//   3. 每条链最多 maxHops（防无限循环）
//   4. 同一房同一事件去重（避免重复触发）

import { autopilotStore } from './AutopilotStore.js';
import { randomUUID } from 'crypto';

const DEDUP_WINDOW_MS = 5000;   // 同房同事件 5s 内只触发一次

export class AutopilotController {
  /**
   * @param {object} deps
   * @param {object} deps.roomStore
   * @param {function} deps.forwardRoom  (sourceRoomId, targetMode, autoStart, name?) => Promise<{newRoomId}>
   * @param {function} deps.broadcastGlobal
   */
  constructor({ roomStore, forwardRoom, broadcastGlobal }) {
    if (!roomStore || !forwardRoom) throw new Error('AutopilotController: roomStore + forwardRoom required');
    this.roomStore = roomStore;
    this.forwardRoom = forwardRoom;
    this.broadcastGlobal = broadcastGlobal || (() => {});
    this.recentEvents = new Map();  // 'roomId:event' → ts
  }

  /** 由 server.js broadcastRoom 调 */
  onRoomEvent(roomId, msg) {
    try {
      if (!autopilotStore.isEnabled()) return;
      if (!msg || typeof msg.type !== 'string') return;
      // dedup
      const key = `${roomId}:${msg.type}`;
      const last = this.recentEvents.get(key) || 0;
      const now = Date.now();
      if (now - last < DEDUP_WINDOW_MS) return;
      this.recentEvents.set(key, now);

      const room = this.roomStore.get(roomId);
      if (!room) return;
      if (room.claimedBy === 'user') return;  // user 接手，autopilot 不动

      const rules = autopilotStore.matchingRules(msg.type, room.mode);
      if (rules.length === 0) return;

      for (const rule of rules) {
        this._triggerRule(rule, room, msg).catch((e) => {
          autopilotStore.log({ type: 'rule_error', ruleId: rule.id, roomId, error: e?.message });
        });
      }
    } catch (e) {
      console.warn('[autopilot] onRoomEvent fail:', e.message);
    }
  }

  async _triggerRule(rule, room, _msg) {
    const hops = Number(room.autopilotHops) || 0;
    const maxHops = autopilotStore.getConfig().maxHopsDefault;
    if (hops >= maxHops) {
      autopilotStore.log({
        type: 'rule_hop_limit', ruleId: rule.id, roomId: room.id, hops, maxHops,
      });
      return;
    }

    if (rule.action === 'notify') {
      // 只记录 + 广播 toast；不操作房
      const msg2 = `🤖 Autopilot · 规则「${rule.name}」匹配 · 房《${room.name || room.id}》· 事件 ${rule.when}`;
      autopilotStore.log({ type: 'rule_notify', ruleId: rule.id, roomId: room.id, eventType: rule.when });
      try { this.broadcastGlobal({ type: 'autopilot_notify', message: msg2, ruleId: rule.id, roomId: room.id }); } catch {}
      return;
    }

    if (rule.action === 'forward') {
      if (!rule.targetMode) return;
      // 必须源房有 finalConsensus（forward 才能用作 topic）
      if (!room.finalConsensus) {
        autopilotStore.log({ type: 'rule_skip_no_consensus', ruleId: rule.id, roomId: room.id });
        return;
      }
      // 执行 forward
      const jobId = 'ap-' + randomUUID().slice(0, 8);
      autopilotStore.log({
        type: 'rule_forward_start', ruleId: rule.id, jobId,
        sourceRoomId: room.id, targetMode: rule.targetMode, autoStart: !!rule.autoStart, hops,
      });
      try {
        const result = await this.forwardRoom({
          sourceRoomId: room.id,
          targetMode: rule.targetMode,
          autoStart: !!rule.autoStart,
          name: `🤖 ${rule.targetMode}（来自《${room.name || room.id}》）`,
          autopilotHops: hops + 1,
          claimedBy: 'autopilot:' + jobId,
        });
        autopilotStore.log({
          type: 'rule_forward_ok', ruleId: rule.id, jobId,
          sourceRoomId: room.id, newRoomId: result?.newRoomId,
        });
        try {
          this.broadcastGlobal({
            type: 'autopilot_forward', ruleId: rule.id, jobId,
            sourceRoomId: room.id, newRoomId: result?.newRoomId,
            targetMode: rule.targetMode, message: `🤖 已 forward → ${rule.targetMode} 房`,
          });
        } catch {}
      } catch (e) {
        autopilotStore.log({ type: 'rule_forward_fail', ruleId: rule.id, jobId, error: e?.message });
      }
      return;
    }
  }

  /** 清 dedup map（避免内存累积） */
  _gc() {
    const now = Date.now();
    for (const [k, ts] of this.recentEvents) {
      if (now - ts > DEDUP_WINDOW_MS * 4) this.recentEvents.delete(k);
    }
  }
}
