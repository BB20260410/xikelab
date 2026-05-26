import { inferCodeContextSignals } from './CodeContextSignals.js';
import { normalizeCodeContextEvidence, summarizeCodeContextEvidence } from './CodeContextEvidence.js';
import { normalizeSymbolGraph, summarizeSymbolGraph } from './SymbolGraph.js';

const DEFAULT_AGENT_PROFILES = [
  {
    id: 'xike-chief',
    roles: ['pm'],
    title: 'Xike Chief Planner',
    mission: 'Turn the user objective into a small set of verifiable, dependency-aware tasks.',
    boundaries: [
      'define acceptance criteria before implementation',
      'prefer parallelizable tasks when dependencies are not real',
      'summarize risks and handoffs without doing dev work',
    ],
    skillBindings: ['autoplan', 'plan-eng-review', 'retro'],
    governance: {
      budgetTier: 'standard',
      commandGuard: 'standard',
      approvalPolicy: 'plan_changes_only',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-builder',
    roles: ['dev'],
    title: 'Xike Builder',
    mission: 'Implement the assigned task, run the narrowest meaningful verification, and explain the changed surface.',
    boundaries: [
      'stay inside the assigned task boundary',
      'prefer existing project patterns over new abstractions',
      'include concrete verification evidence',
    ],
    skillBindings: ['codex', 'careful'],
    governance: {
      budgetTier: 'high',
      commandGuard: 'standard',
      approvalPolicy: 'dangerous_commands',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-verifier',
    roles: ['qa'],
    title: 'Xike Verifier',
    mission: 'Verify claims against files, commands, rendered UI, and tests before accepting a result.',
    boundaries: [
      'reject vague claims without evidence',
      'name the exact failing file, command, selector, or requirement',
      'separate blocker, bug, risk, and suggestion',
    ],
    skillBindings: ['qa', 'qa-only', 'browse'],
    governance: {
      budgetTier: 'standard',
      commandGuard: 'strict',
      approvalPolicy: 'dangerous_commands',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-architect',
    roles: ['architect'],
    title: 'Xike Architect',
    mission: 'Find the simplest durable architecture that can support future agents, skills, models, and governance.',
    boundaries: [
      'optimize for clear contracts and replacement points',
      'write migration steps when changing a shared interface',
      'avoid framework churn unless the current boundary is exhausted',
    ],
    skillBindings: ['plan-eng-review', 'investigate', 'benchmark'],
    governance: {
      budgetTier: 'high',
      commandGuard: 'strict',
      approvalPolicy: 'architecture_changes',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-judge',
    roles: ['judge'],
    title: 'Xike Judge',
    mission: 'Compare candidate outputs, check factual support, and decide the best next action.',
    boundaries: [
      'judge the evidence, not the model identity',
      'call out uncertainty instead of smoothing it over',
      'produce one decision with rollback or follow-up criteria',
    ],
    skillBindings: ['review', 'qa', 'office-hours'],
    governance: {
      budgetTier: 'standard',
      commandGuard: 'strict',
      approvalPolicy: 'final_decision',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-shipper',
    roles: ['shipper'],
    title: 'Xike Shipper',
    mission: 'Prepare the verified change for release, deployment, rollback, and operator handoff.',
    boundaries: [
      'never skip rollback notes for risky changes',
      'surface data, protocol, storage, and compatibility impact',
      'keep release artifacts reproducible',
    ],
    skillBindings: ['ship', 'setup-deploy', 'land-and-deploy', 'canary'],
    governance: {
      budgetTier: 'restricted',
      commandGuard: 'strict',
      approvalPolicy: 'release_and_destructive_actions',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-designer',
    roles: ['designer'],
    title: 'Xike Designer',
    mission: 'Translate product intent into clear, usable, domain-specific interaction flows.',
    boundaries: [
      'prioritize the primary workflow over decorative UI',
      'make state, progress, and risk legible',
      'verify text and controls fit across viewport sizes',
    ],
    skillBindings: ['design-consultation', 'design-review', 'document-release'],
    governance: {
      budgetTier: 'standard',
      commandGuard: 'standard',
      approvalPolicy: 'asset_export_changes',
      auditLevel: 'standard',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-observer',
    roles: ['observer'],
    title: 'Xike Observer',
    mission: 'Track context drift, recurring risks, and useful memory without mutating work.',
    boundaries: [
      'record evidence and open questions',
      'avoid changing task state',
      'escalate when context contradicts the plan',
    ],
    skillBindings: ['investigate', 'retro'],
    governance: {
      budgetTier: 'low',
      commandGuard: 'strict',
      approvalPolicy: 'read_only',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
];

const DEFAULT_DISPATCH_RULES = [
  {
    tag: 'planning',
    agentId: 'xike-chief',
    keywords: ['plan', 'roadmap', 'split', 'breakdown', 'acceptance', 'priority', '规划', '计划', '拆解', '验收', '优先级'],
    skillHints: ['autoplan', 'plan-eng-review'],
  },
  {
    tag: 'implementation',
    agentId: 'xike-builder',
    keywords: ['implement', 'build', 'code', 'refactor', 'fix', 'patch', '实现', '开发', '编码', '重构', '修复'],
    skillHints: ['codex', 'careful'],
  },
  {
    tag: 'verification',
    agentId: 'xike-verifier',
    keywords: ['test', 'verify', 'qa', 'browser', 'screenshot', 'regression', '测试', '验证', '回归', '截图', '浏览器'],
    skillHints: ['qa', 'qa-only', 'browse'],
  },
  {
    tag: 'architecture',
    agentId: 'xike-architect',
    keywords: ['architecture', 'system', 'contract', 'migration', 'scalability', '架构', '系统', '接口', '迁移', '扩展'],
    skillHints: ['plan-eng-review', 'investigate'],
  },
  {
    tag: 'debugging',
    agentId: 'xike-architect',
    keywords: ['debug', 'root cause', 'perf', 'benchmark', 'trace', '排查', '根因', '性能', '基准', '链路'],
    skillHints: ['investigate', 'benchmark'],
  },
  {
    tag: 'release',
    agentId: 'xike-shipper',
    keywords: ['release', 'deploy', 'ship', 'canary', 'rollback', '上线', '部署', '发布', '回滚', '灰度'],
    skillHints: ['ship', 'setup-deploy', 'canary'],
  },
  {
    tag: 'design',
    agentId: 'xike-designer',
    keywords: ['ui', 'ux', 'design', 'layout', 'interaction', 'copy', '界面', '交互', '设计', '文案', '布局'],
    skillHints: ['design-consultation', 'design-review'],
  },
  {
    tag: 'governance',
    agentId: 'xike-judge',
    keywords: ['approval', 'budget', 'audit', 'policy', 'guard', 'governance', '审批', '预算', '审计', '治理', '权限'],
    skillHints: ['review', 'qa'],
  },
];

const ROLE_FALLBACK = {
  pm: 'xike-chief',
  dev: 'xike-builder',
  qa: 'xike-verifier',
  architect: 'xike-architect',
  judge: 'xike-judge',
  shipper: 'xike-shipper',
  designer: 'xike-designer',
  observer: 'xike-observer',
};

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function normalizeId(value) {
  const s = safeString(value, 80).toLowerCase();
  if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(s)) return '';
  return s;
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const id = normalizeId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function uniqueText(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = safeString(value, 80).toLowerCase();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function uniqueLimited(values, limit = 8) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = safeString(value, 240);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function resolveCodeContextSignals(input = {}) {
  const candidate = input?.codeContext || input;
  if (candidate && typeof candidate === 'object' && Array.isArray(candidate.tags)) return candidate;
  return inferCodeContextSignals(candidate || {});
}

function resolveCodeContextEvidence(input = {}) {
  const candidate = input?.codeContext || input;
  return normalizeCodeContextEvidence(candidate || {});
}

function resolveCodeContextGraph(input = {}) {
  const candidate = input?.codeContext || input;
  return normalizeSymbolGraph(candidate || {});
}

export function normalizeCodebaseQuestionAnswer(input = {}) {
  const candidate = input?.codebaseQuestionAnswer || input?.questionAnswer || input;
  if (!candidate || typeof candidate !== 'object') return null;
  const citations = Array.isArray(candidate.citations) ? candidate.citations.slice(0, 6).map((item, index) => {
    const id = safeString(item.id, 20) || `C${index + 1}`;
    const path = safeString(item.path, 300);
    const line = Math.max(1, Number(item.line) || 1);
    const label = safeString(item.label, 340) || (path ? `${path}:${line}` : id);
    return {
      id,
      path,
      line,
      label,
      kind: safeString(item.kind, 100) || 'file',
      anchor: safeString(item.anchor, 180),
      parser: safeString(item.parser, 80) || 'unknown',
      score: Number(item.score || 0),
      semanticScore: Number.isFinite(Number(item.semanticScore)) ? Number(item.semanticScore) : null,
      reasons: Array.isArray(item.reasons) ? item.reasons.map((reason) => safeString(reason, 120)).filter(Boolean).slice(0, 4) : [],
      snippet: safeString(item.snippet, 260),
      evidenceCount: Math.max(0, Number(item.evidenceCount) || 0),
      graphReferenceCount: Math.max(0, Number(item.graphReferenceCount) || 0),
      routeUsageCount: Math.max(0, Number(item.routeUsageCount) || 0),
    };
  }).filter((item) => item.path || item.label) : [];
  const question = safeString(candidate.question, 500);
  const answer = safeString(candidate.answer, 1200);
  if (!question && !answer && citations.length === 0) return null;
  const coverage = candidate.coverage && typeof candidate.coverage === 'object' ? candidate.coverage : {};
  return {
    ok: candidate.ok !== false,
    mode: safeString(candidate.mode, 80) || 'local-codebase-question',
    generatedBy: safeString(candidate.generatedBy, 120) || 'CodebaseIndexStore',
    question,
    confidence: safeString(candidate.confidence, 40) || 'unknown',
    answer,
    answerLines: Array.isArray(candidate.answerLines) ? candidate.answerLines.map((line) => safeString(line, 360)).filter(Boolean).slice(0, 6) : [],
    citations,
    coverage: {
      resultCount: Math.max(0, Number(coverage.resultCount) || 0),
      citedResultCount: Math.max(0, Number(coverage.citedResultCount) || citations.length),
      uniqueFileCount: Math.max(0, Number(coverage.uniqueFileCount) || new Set(citations.map((item) => item.path).filter(Boolean)).size),
      evidenceItemCount: Math.max(0, Number(coverage.evidenceItemCount) || 0),
      graphReferenceCount: Math.max(0, Number(coverage.graphReferenceCount) || 0),
      routeUsageCount: Math.max(0, Number(coverage.routeUsageCount) || 0),
    },
    nextActions: Array.isArray(candidate.nextActions) ? candidate.nextActions.map((item) => safeString(item, 180)).filter(Boolean).slice(0, 6) : [],
    limitations: Array.isArray(candidate.limitations) ? candidate.limitations.map((item) => safeString(item, 180)).filter(Boolean).slice(0, 6) : [],
  };
}

export function normalizeGovernancePolicy(input = {}) {
  const policy = input && typeof input === 'object' ? input : {};
  const budgetTier = normalizeId(policy.budgetTier) || 'standard';
  const commandGuard = normalizeId(policy.commandGuard) || 'standard';
  const approvalPolicy = normalizeId(policy.approvalPolicy) || 'dangerous_commands';
  const auditLevel = normalizeId(policy.auditLevel) || 'standard';
  const budgetScope = normalizeId(policy.budgetScope) || 'agent_profile';
  return {
    budgetTier,
    commandGuard,
    approvalPolicy,
    auditLevel,
    budgetScope,
  };
}

function normalizeProfile(input = {}) {
  const id = normalizeId(input.id);
  if (!id) return null;
  return {
    id,
    roles: unique(input.roles || []),
    title: safeString(input.title, 120) || id,
    mission: safeString(input.mission, 800),
    boundaries: Array.isArray(input.boundaries)
      ? input.boundaries.map((item) => safeString(item, 240)).filter(Boolean).slice(0, 12)
      : [],
    skillBindings: unique(input.skillBindings || []),
    governance: normalizeGovernancePolicy(input.governance),
  };
}

function normalizeRule(input = {}) {
  const tag = normalizeId(input.tag);
  const agentId = normalizeId(input.agentId);
  if (!tag || !agentId) return null;
  return {
    tag,
    agentId,
    keywords: Array.isArray(input.keywords)
      ? input.keywords.map((item) => safeString(item, 80).toLowerCase()).filter(Boolean).slice(0, 40)
      : [],
    skillHints: unique(input.skillHints || []),
  };
}

export function buildAgentSkillRegistry(overrides = {}) {
  const profiles = [
    ...DEFAULT_AGENT_PROFILES,
    ...(Array.isArray(overrides.profiles) ? overrides.profiles : []),
  ].map(normalizeProfile).filter(Boolean);
  const rules = [
    ...DEFAULT_DISPATCH_RULES,
    ...(Array.isArray(overrides.dispatchRules) ? overrides.dispatchRules : []),
  ].map(normalizeRule).filter(Boolean);
  return {
    profiles,
    rules,
    profileById: new Map(profiles.map((profile) => [profile.id, profile])),
    roleFallback: {
      ...ROLE_FALLBACK,
      ...(overrides.roleFallback && typeof overrides.roleFallback === 'object' ? overrides.roleFallback : {}),
    },
  };
}

export const DEFAULT_AGENT_SKILL_REGISTRY = buildAgentSkillRegistry();

export function mergeAgentGovernanceOverrides(registry = DEFAULT_AGENT_SKILL_REGISTRY, overridesByProfileId = {}) {
  const overrides = overridesByProfileId && typeof overridesByProfileId === 'object' ? overridesByProfileId : {};
  const profiles = (registry.profiles || []).map((profile) => {
    const override = overrides[profile.id];
    if (!override) return profile;
    return {
      ...profile,
      governance: normalizeGovernancePolicy({
        ...(profile.governance || {}),
        ...override,
      }),
      governanceOverridden: true,
    };
  });
  return {
    profiles,
    rules: registry.rules || [],
    profileById: new Map(profiles.map((profile) => [profile.id, profile])),
    roleFallback: registry.roleFallback || {},
  };
}

export function classifyTask(text, registry = DEFAULT_AGENT_SKILL_REGISTRY, options = {}) {
  const haystack = safeString(text, 12000).toLowerCase();
  const codeContextSignals = resolveCodeContextSignals(options);
  if (!haystack && (!codeContextSignals.tags || codeContextSignals.tags.length === 0)) return [];
  const matches = [];
  if (haystack) {
    for (const rule of registry.rules || []) {
      const matched = [];
      let score = 0;
      for (const keyword of rule.keywords || []) {
        if (!keyword) continue;
        let pos = haystack.indexOf(keyword);
        while (pos >= 0) {
          matched.push(keyword);
          score += keyword.length > 2 ? 2 : 1;
          pos = haystack.indexOf(keyword, pos + keyword.length);
        }
      }
      if (score > 0) {
        matches.push({
          tag: rule.tag,
          agentId: rule.agentId,
          score,
          textScore: score,
          matched: uniqueText(matched),
          skillHints: [...rule.skillHints],
        });
      }
    }
  }

  const byTag = new Map(matches.map((match) => [match.tag, match]));
  for (const signal of codeContextSignals.tags || []) {
    const tag = normalizeId(signal.tag);
    if (!tag) continue;
    const rule = (registry.rules || []).find((item) => item.tag === tag);
    if (!rule) continue;
    const bonus = Math.max(1, Math.min(16, Number(signal.score) || 1));
    let match = byTag.get(tag);
    if (!match) {
      match = {
        tag,
        agentId: rule.agentId,
        score: 0,
        textScore: 0,
        matched: [],
        skillHints: [...rule.skillHints],
      };
      byTag.set(tag, match);
      matches.push(match);
    }
    match.score += bonus;
    match.codeScore = (match.codeScore || 0) + bonus;
    match.contextReasons = uniqueLimited([...(match.contextReasons || []), ...(signal.reasons || [])], 8);
    match.contextPaths = uniqueLimited([...(match.contextPaths || []), ...(signal.paths || [])], 10);
  }

  matches.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
  return matches.slice(0, Math.max(1, Number(options.maxTags) || 6));
}

export function resolveAgentProfile(member = {}, room = {}, registry = DEFAULT_AGENT_SKILL_REGISTRY) {
  const explicitId = normalizeId(member.agentId || member.profileId || member.agentProfileId);
  if (explicitId && registry.profileById.has(explicitId)) return registry.profileById.get(explicitId);

  const roomBindings = room?.agentBindings && typeof room.agentBindings === 'object' ? room.agentBindings : {};
  const memberId = normalizeId(member.adapterId || member.id);
  const boundId = normalizeId(roomBindings[memberId] || roomBindings[member.role]);
  if (boundId && registry.profileById.has(boundId)) return registry.profileById.get(boundId);

  const role = normalizeId(member.role);
  const fallbackId = normalizeId(registry.roleFallback?.[role]);
  if (fallbackId && registry.profileById.has(fallbackId)) return registry.profileById.get(fallbackId);

  const byRole = registry.profiles.find((profile) => profile.roles.includes(role));
  if (byRole) return byRole;

  return registry.profileById.get('xike-builder') || registry.profiles[0] || null;
}

function addSkillBindingSource(bindings, name, source) {
  const id = normalizeId(name);
  if (!id) return;
  if (!bindings.has(id)) bindings.set(id, { name: id, sources: [] });
  const binding = bindings.get(id);
  if (source && !binding.sources.includes(source)) binding.sources.push(source);
}

function parseSkillNameList(value) {
  if (Array.isArray(value)) return unique(value);
  if (typeof value !== 'string') return [];
  return unique(value.split(/[,\s]+/).filter(Boolean));
}

function skillGovernanceMetadata(skill = {}) {
  const extra = skill?.extra && typeof skill.extra === 'object' ? skill.extra : {};
  return {
    exclusiveGroup: normalizeId(extra.exclusiveGroup || extra.exclusive_group),
    conflictsWith: parseSkillNameList(extra.conflictsWith || extra.conflicts_with),
  };
}

export function resolveAgentSkillBindings({ profile, dispatchMatches = [], room = {}, skillStore = null } = {}) {
  const bindings = new Map();
  for (const name of profile?.skillBindings || []) {
    addSkillBindingSource(bindings, name, 'profile');
  }
  for (const match of dispatchMatches || []) {
    const source = match?.tag ? `dispatch:${normalizeId(match.tag) || match.tag}` : 'dispatch';
    for (const name of match?.skillHints || []) addSkillBindingSource(bindings, name, source);
  }
  const roomSkills = Array.isArray(room?.skills) ? room.skills : [];
  for (const name of roomSkills) addSkillBindingSource(bindings, name, 'room');
  let out = [...bindings.values()];
  if (!skillStore || typeof skillStore.get !== 'function') return out;
  out = out.map((binding) => {
    const skill = skillStore.get(binding.name);
    const governance = skillGovernanceMetadata(skill);
    return {
      ...binding,
      displayName: skill?.displayName || binding.name,
      installed: !!skill,
      enabled: skill ? skill.enabled !== false : false,
      bodyLen: skill?.body ? skill.body.length : 0,
      ...(governance.exclusiveGroup ? { exclusiveGroup: governance.exclusiveGroup } : {}),
      ...(governance.conflictsWith.length ? { conflictsWith: governance.conflictsWith } : {}),
    };
  });
  return out.filter((binding) => {
    const skill = skillStore.get(binding.name);
    return skill && skill.enabled !== false;
  });
}

export function diagnoseAgentSkillBindings(skillBindings = [], options = {}) {
  const bindings = Array.isArray(skillBindings) ? skillBindings : [];
  const maxSkills = Math.max(1, Number(options.maxSkills) || 8);
  const maxBodyChars = Math.max(1000, Number(options.maxBodyChars) || 120_000);
  const diagnostics = [];
  const names = new Set(bindings.map((binding) => binding.name).filter(Boolean));
  const totalBodyChars = bindings.reduce((sum, binding) => sum + Math.max(0, Number(binding.bodyLen) || 0), 0);

  if (bindings.length > maxSkills) {
    diagnostics.push({
      code: 'too_many_skills',
      severity: 'warn',
      message: `This turn has ${bindings.length} installed skills; consider narrowing room-level bindings.`,
      count: bindings.length,
      limit: maxSkills,
    });
  }

  if (totalBodyChars > maxBodyChars) {
    diagnostics.push({
      code: 'skill_prompt_too_large',
      severity: 'warn',
      message: `Skill prompt payload is ${totalBodyChars} chars; trim bindings or split work.`,
      totalBodyChars,
      limit: maxBodyChars,
    });
  }

  const byExclusiveGroup = new Map();
  for (const binding of bindings) {
    if (!binding?.exclusiveGroup) continue;
    if (!byExclusiveGroup.has(binding.exclusiveGroup)) byExclusiveGroup.set(binding.exclusiveGroup, []);
    byExclusiveGroup.get(binding.exclusiveGroup).push(binding.name);
  }
  for (const [group, groupNames] of byExclusiveGroup.entries()) {
    if (groupNames.length <= 1) continue;
    diagnostics.push({
      code: 'exclusive_skill_group_conflict',
      severity: 'warn',
      message: `Skills in exclusive group "${group}" are both active: ${groupNames.join(', ')}.`,
      group,
      skills: groupNames,
    });
  }

  const emittedPairs = new Set();
  for (const binding of bindings) {
    for (const other of binding.conflictsWith || []) {
      if (!names.has(other)) continue;
      const pair = [binding.name, other].sort().join('::');
      if (emittedPairs.has(pair)) continue;
      emittedPairs.add(pair);
      diagnostics.push({
        code: 'skill_conflict',
        severity: 'warn',
        message: `Skill "${binding.name}" declares a conflict with "${other}".`,
        skills: [binding.name, other],
      });
    }
  }

  return diagnostics;
}

export function resolveAgentSkillNames({ profile, dispatchMatches = [], room = {}, skillStore = null } = {}) {
  const names = resolveAgentSkillBindings({ profile, dispatchMatches, room, skillStore }).map((binding) => binding.name);
  if (!skillStore || typeof skillStore.get !== 'function') return names;
  return names.filter((name) => {
    const skill = skillStore.get(name);
    return skill && skill.enabled !== false;
  });
}

export function buildAgentRuntimeContext({ room = {}, member = {}, objective = '', codeContext = null, skillStore = null, registry = DEFAULT_AGENT_SKILL_REGISTRY } = {}) {
  const profile = resolveAgentProfile(member, room, registry);
  const codeContextSignals = resolveCodeContextSignals({
    codeContext: codeContext || room?.codeContext || { affectedFiles: room?.affectedFiles || room?.changedFiles || [] },
  });
  const codeContextEvidence = resolveCodeContextEvidence({
    codeContext: codeContext || room?.codeContext || room?.codeContextEvidence || [],
  });
  const codeContextGraph = resolveCodeContextGraph({
    codeContext: codeContext || room?.codeContext || room?.codeContextGraph || {},
  });
  const codebaseQuestionAnswer = normalizeCodebaseQuestionAnswer(
    codeContext?.codebaseQuestionAnswer
      || codeContext?.questionAnswer
      || room?.codeContext?.codebaseQuestionAnswer
      || room?.codeContext?.questionAnswer
      || room?.codebaseQuestionAnswer,
  );
  const targetText = [
    objective,
    room?.topic,
    room?.name,
    member?.role,
    member?.displayName,
  ].map((part) => safeString(part, 4000)).filter(Boolean).join('\n');
  const dispatchMatches = classifyTask(targetText, registry, { codeContext: codeContextSignals });
  const skillBindings = resolveAgentSkillBindings({ profile, dispatchMatches, room, skillStore });
  const skillNames = skillBindings.map((binding) => binding.name);
  const skillDiagnostics = diagnoseAgentSkillBindings(skillBindings);
  const governance = profile?.governance || normalizeGovernancePolicy();
  return {
    profile,
    dispatchMatches,
    skillNames,
    skillBindings,
    skillDiagnostics,
    codeContextSignals,
    codeContextEvidence,
    codeContextGraph,
    codebaseQuestionAnswer,
    governance,
    prompt: formatAgentRuntimeContext({ profile, dispatchMatches, skillNames, skillBindings, skillDiagnostics, codeContextSignals, codeContextEvidence, codeContextGraph, codebaseQuestionAnswer, member, governance }),
  };
}

export function summarizeAgentRuntimeContext(agentContext = {}) {
  const profile = agentContext.profile || null;
  return {
    agentProfileId: profile?.id || null,
    agentProfileTitle: profile?.title || null,
    agentDispatchTags: (agentContext.dispatchMatches || []).map((match) => match.tag).filter(Boolean),
    agentDispatchMatches: (agentContext.dispatchMatches || []).map((match) => ({
      tag: match.tag,
      agentId: match.agentId,
      score: match.score,
      textScore: match.textScore || 0,
      codeScore: match.codeScore || 0,
      matched: match.matched || [],
      contextReasons: match.contextReasons || [],
      contextPaths: match.contextPaths || [],
    })),
    agentCodeContextSignals: agentContext.codeContextSignals || null,
    agentCodeContextEvidence: normalizeCodeContextEvidence(agentContext.codeContextEvidence || []),
    agentCodeContextGraph: normalizeSymbolGraph(agentContext.codeContextGraph || {}),
    agentCodebaseQuestionAnswer: normalizeCodebaseQuestionAnswer(agentContext.codebaseQuestionAnswer),
    agentSkillNames: Array.isArray(agentContext.skillNames) ? agentContext.skillNames : [],
    agentSkillBindings: Array.isArray(agentContext.skillBindings) ? agentContext.skillBindings : [],
    agentSkillDiagnostics: Array.isArray(agentContext.skillDiagnostics) ? agentContext.skillDiagnostics : [],
    agentGovernance: agentContext.governance || profile?.governance || normalizeGovernancePolicy(),
  };
}

function formatCodeContextLine(codeContextSignals = null) {
  const tags = Array.isArray(codeContextSignals?.tags) ? codeContextSignals.tags.slice(0, 4) : [];
  if (tags.length === 0) return null;
  const parts = tags.map((tag) => {
    const reasons = (tag.reasons || []).slice(0, 3).join('/');
    const paths = (tag.paths || []).slice(0, 2).join(', ');
    return `${tag.tag}:${tag.score}${reasons ? ` (${reasons})` : ''}${paths ? ` @ ${paths}` : ''}`;
  });
  return `- Code context signals: ${parts.join('; ')}`;
}

function formatCodeEvidenceLine(codeContextEvidence = []) {
  const summary = summarizeCodeContextEvidence(codeContextEvidence);
  if (summary.fileCount === 0 || (summary.symbolCount === 0 && summary.anchorCount === 0)) return null;
  const symbols = summary.topSymbols.slice(0, 5).map((item) => `${item.name}@${item.path}:${item.line}`);
  const anchors = summary.topAnchors.slice(0, 4).map((item) => `${item.kind}:${item.name}@${item.path}:${item.line}`);
  const details = [
    symbols.length ? `symbols ${symbols.join(', ')}` : '',
    anchors.length ? `anchors ${anchors.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  const parserCounts = summary.parserCounts && typeof summary.parserCounts === 'object'
    ? Object.entries(summary.parserCounts).map(([parser, count]) => `${parser}:${count}`).join(', ')
    : '';
  return `- Code evidence: ${summary.fileCount} files, ${summary.symbolCount} symbols, ${summary.anchorCount} anchors, ${summary.referenceCount || 0} references${parserCounts ? `, parsers ${parserCounts}` : ''}${details ? `; ${details}` : ''}`;
}

function formatCodeGraphLine(codeContextGraph = {}) {
  const summary = summarizeSymbolGraph(codeContextGraph);
  if (summary.definitionCount === 0 && summary.routeCount === 0) return null;
  const defs = summary.topDefinitions.slice(0, 4).map((item) => `${item.name}@${item.path}:${item.line} refs=${item.referenceCount}`);
  const routes = summary.topRoutes.slice(0, 3).map((item) => `${item.route}@${item.path}:${item.line} uses=${item.usageCount}`);
  const details = [
    defs.length ? `defs ${defs.join(', ')}` : '',
    routes.length ? `routes ${routes.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  return `- Symbol graph: ${summary.definitionCount} definitions, ${summary.referenceCount} references, ${summary.callCount} calls, ${summary.typeImplementationCount || 0} type implementations, ${summary.routeUsageCount} route uses${details ? `; ${details}` : ''}`;
}

function formatCodebaseQuestionAnswerLine(codebaseQuestionAnswer = null) {
  const answer = normalizeCodebaseQuestionAnswer(codebaseQuestionAnswer);
  if (!answer) return null;
  const coverage = answer.coverage || {};
  const citations = (answer.citations || []).slice(0, 4).map((item) => `${item.id}:${item.label}`);
  const parts = [
    answer.question ? `question "${answer.question}"` : '',
    `${answer.confidence} confidence`,
    `${coverage.uniqueFileCount || 0} files`,
    citations.length ? `citations ${citations.join(', ')}` : '',
    answer.answer ? `answer ${safeString(answer.answer, 320)}` : '',
  ].filter(Boolean);
  return `- Code question answer: ${parts.join('; ')}`;
}

export function formatAgentRuntimeContext({ profile, dispatchMatches = [], skillNames = [], skillBindings = [], skillDiagnostics = [], codeContextSignals = null, codeContextEvidence = [], codeContextGraph = {}, codebaseQuestionAnswer = null, member = {}, governance = null } = {}) {
  if (!profile) return '';
  const tagLine = dispatchMatches.length > 0
    ? dispatchMatches.map((match) => `${match.tag}:${match.agentId}`).join(', ')
    : 'none';
  const boundaryLines = profile.boundaries.length > 0
    ? profile.boundaries.map((item) => `- ${item}`).join('\n')
    : '- Follow the room role card and current task boundary.';
  const bindingList = Array.isArray(skillBindings) && skillBindings.length > 0
    ? skillBindings
    : skillNames.map((name) => ({ name, sources: [] }));
  const skillsLine = bindingList.length > 0
    ? bindingList.map((binding) => {
      const sourceLine = Array.isArray(binding.sources) && binding.sources.length > 0
        ? ` [${binding.sources.join('+')}]`
        : '';
      return `${binding.name}${sourceLine}`;
    }).join(', ')
    : 'none installed for this turn';
  const policy = governance || profile.governance || normalizeGovernancePolicy();
  const diagnosticsLine = Array.isArray(skillDiagnostics) && skillDiagnostics.length > 0
    ? `- Skill diagnostics: ${skillDiagnostics.map((item) => `${item.severity}:${item.code}`).join(', ')}`
    : null;
  const codeContextLine = formatCodeContextLine(codeContextSignals);
  const codeEvidenceLine = formatCodeEvidenceLine(codeContextEvidence);
  const codeGraphLine = formatCodeGraphLine(codeContextGraph);
  const codeQuestionLine = formatCodebaseQuestionAnswerLine(codebaseQuestionAnswer);
  return [
    '# Xike Agent Runtime Context',
    '',
    `- Agent profile: ${profile.title} (${profile.id})`,
    `- Room member: ${safeString(member.displayName || member.adapterId || 'unknown', 160)}`,
    `- Mission: ${profile.mission || 'Complete the assigned work with evidence.'}`,
    `- Matched dispatch tags: ${tagLine}`,
    codeContextLine,
    codeQuestionLine,
    codeEvidenceLine,
    codeGraphLine,
    `- Installed bound skills for this turn: ${skillsLine}`,
    diagnosticsLine,
    `- Governance: budget=${policy.budgetScope}:${profile.id}/${policy.budgetTier}; guard=${policy.commandGuard}; approval=${policy.approvalPolicy}; audit=${policy.auditLevel}`,
    '',
    '## Operating boundaries',
    boundaryLines,
  ].filter((line) => line !== null).join('\n');
}
