// FocusChain — 每 N 轮注入主目标 + 最近进展防漂移
// 移植自 思维镜 Planner/PlannerPrompt.focusChainHeader()

export function focusChainHeader({ mainGoal, doneSummaries = [], userMsgCount, triggerInterval = 5 }) {
  if (!mainGoal || userMsgCount === 0 || userMsgCount % triggerInterval !== 0) {
    return '';
  }
  const recent = doneSummaries.slice(-triggerInterval).map((s, i) => `  ${i + 1}. ${s}`).join('\n') || '  (尚无)';
  return [
    `⚠️ FOCUS CHAIN（每 ${triggerInterval} 轮自动提醒一次）`,
    `🎯 主目标：${mainGoal}`,
    `📋 最近 ${triggerInterval} 步摘要：`,
    recent,
    `⏭️ 本轮只决定下一步那一件事，不要扩散到无关分支。`,
    `--- 用户消息 ---`,
    '',
  ].join('\n');
}

// 从 messages 自动抽 "done summaries"（取最近 assistant 消息每条头 60 字）
export function buildDoneSummaries(messages, max = 10) {
  return messages
    .filter(m => m.role === 'assistant' && m.content)
    .slice(-max)
    .map(m => m.content.replace(/\s+/g, ' ').slice(0, 80));
}
