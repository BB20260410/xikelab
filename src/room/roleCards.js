const DEFAULT_SCOPE = {
  pm: ['task_split', 'dependency_planning', 'acceptance_criteria', 'final_summary'],
  dev: ['implementation', 'shell_validation', 'file_changes', 'self_check'],
  qa: ['verification', 'reject_with_evidence', 'acceptance_check', 'risk_review'],
  observer: ['context_watch', 'note_taking'],
  judge: ['compare_outputs', 'fact_check', 'final_decision'],
};

const DEFAULT_RESPONSIBILITY = {
  pm: '拆分任务、定义验收标准、维护依赖关系，并汇总最终交付。',
  dev: '只执行被分配的具体任务，产出可验证实现，并对照验收标准自查。',
  qa: '验证 Dev 交付是否达成验收标准，给出可定位、可修复的 pass/reject 结论。',
  observer: '观察上下文变化，记录风险和用户补充信息，不直接改任务状态。',
  judge: '对多个方案做事实核对、比较和裁决，输出最终选择依据。',
};

const DEFAULT_REPORT_TO = {
  pm: null,
  dev: 'pm',
  qa: 'pm',
  observer: 'pm',
  judge: null,
};

function safeString(value, max = 500) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function normalizeRole(role, mode = 'squad') {
  const r = safeString(role || (mode === 'arena' ? 'judge' : 'dev'), 40).toLowerCase();
  if (['pm', 'dev', 'qa', 'observer', 'judge'].includes(r)) return r;
  return mode === 'arena' ? 'judge' : 'dev';
}

export function defaultRoleCard(role, { memberId = '', displayName = '', mode = 'squad' } = {}) {
  const normalized = normalizeRole(role, mode);
  return {
    id: `${safeString(memberId, 120) || normalized}:${normalized}`,
    memberId: safeString(memberId, 120),
    displayName: safeString(displayName, 120),
    role: normalized,
    title: normalized.toUpperCase(),
    reportTo: DEFAULT_REPORT_TO[normalized],
    responsibility: DEFAULT_RESPONSIBILITY[normalized],
    scope: [...(DEFAULT_SCOPE[normalized] || DEFAULT_SCOPE.dev)],
  };
}

export function sanitizeRoleCard(input = {}, { member = {}, mode = 'squad' } = {}) {
  const role = normalizeRole(input.role || member.role, mode);
  const fallback = defaultRoleCard(role, {
    memberId: member.adapterId || input.memberId,
    displayName: member.displayName || input.displayName,
    mode,
  });
  const scope = Array.isArray(input.scope)
    ? input.scope.map((s) => safeString(s, 80)).filter(Boolean).slice(0, 20)
    : fallback.scope;
  return {
    id: safeString(input.id, 160) || fallback.id,
    memberId: safeString(input.memberId || member.adapterId, 120),
    displayName: safeString(input.displayName || member.displayName, 120),
    role,
    title: safeString(input.title, 120) || fallback.title,
    reportTo: input.reportTo === null ? null : (safeString(input.reportTo, 80) || fallback.reportTo),
    responsibility: safeString(input.responsibility, 1000) || fallback.responsibility,
    scope,
  };
}

export function buildRoleCardsForMembers(members = [], { mode = 'squad', existing = [] } = {}) {
  const existingByMember = new Map((existing || []).map((card) => [card.memberId, card]));
  return (Array.isArray(members) ? members : []).map((member) => {
    const existingCard = existingByMember.get(member.adapterId) || {};
    return sanitizeRoleCard(existingCard, { member, mode });
  });
}

export function findRoleCard(room = {}, member = {}) {
  const cards = Array.isArray(room.roleCards) ? room.roleCards : [];
  return cards.find((card) => card.memberId === member.adapterId)
    || cards.find((card) => card.role === member.role)
    || defaultRoleCard(member.role, { memberId: member.adapterId, displayName: member.displayName, mode: room.mode });
}

export function formatRoleCardForPrompt(card) {
  if (!card) return '';
  return [
    `角色卡：${card.title} (${card.role})`,
    `- 汇报给: ${card.reportTo || '用户 / 最终负责人'}`,
    `- 职责: ${card.responsibility}`,
    `- 允许范围: ${(card.scope || []).join(', ') || '未配置'}`,
  ].join('\n');
}

export function summarizeRoleCards(cards = []) {
  return (Array.isArray(cards) ? cards : []).map((card) => ({
    memberId: card.memberId,
    displayName: card.displayName,
    role: card.role,
    title: card.title,
    reportTo: card.reportTo,
    scope: Array.isArray(card.scope) ? card.scope : [],
  }));
}
