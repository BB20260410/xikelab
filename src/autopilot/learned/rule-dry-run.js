// rule-dry-run — autopilot 规则 dry-run helper（W9 Flowise/Langflow 学习）
// 独立函数，未接入 AutopilotController——等 UI 集成

/**
 * 模拟一次事件触发，告诉用户哪些规则会匹配 + 会做什么 action，但不真执行
 * @param {Array} rules            autopilot 规则数组
 * @param {object} event           模拟事件 { type, sourceRoomId, ... }
 * @returns {{ matched, actions, skipped }}
 */
export function dryRun(rules, event) {
  if (!Array.isArray(rules) || !event) {
    return { matched: [], actions: [], skipped: [] };
  }
  const matched = [];
  const actions = [];
  const skipped = [];

  for (const rule of rules) {
    if (rule.enabled === false) {
      skipped.push({ id: rule.id, name: rule.name, reason: 'disabled' });
      continue;
    }
    // 简化条件：type 命中 + sourceRoomId 命中（可扩展更多 condition）
    const typeMatch = !rule.eventTypes || rule.eventTypes.includes(event.type);
    const roomMatch = !rule.sourceRoomFilter || rule.sourceRoomFilter === event.sourceRoomId;
    if (typeMatch && roomMatch) {
      matched.push({ id: rule.id, name: rule.name });
      actions.push({
        ruleName: rule.name,
        action: rule.action,                // e.g. "forward"
        targetMode: rule.targetMode,        // e.g. "squad"
        autoStart: !!rule.autoStart,
        wouldFire: true,
      });
    } else {
      skipped.push({
        id: rule.id,
        name: rule.name,
        reason: !typeMatch ? `event.type !== ${(rule.eventTypes || []).join('|')}` : 'sourceRoom 不匹配',
      });
    }
  }

  return { matched, actions, skipped };
}

/**
 * 用法（未来 UI 接入）：
 *   POST /api/autopilot/dry-run  { event: { type: 'room_done', sourceRoomId: 'xxx' } }
 *     → 返回 { matched, actions, skipped }
 *   前端展示：
 *     - 匹配规则 N 个
 *     - 会触发 action：[forward → squad / forward → arena]
 *     - 跳过 M 个（原因 ...）
 */
