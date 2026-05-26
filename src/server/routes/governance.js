import { approvalStore as defaultApprovalStore } from '../../approval/ApprovalStore.js';
import { autopilotScheduleStore as defaultAutopilotStore } from '../../autopilot/AutopilotScheduleStore.js';
import { budgetPolicyStore as defaultBudgetStore } from '../../budget/BudgetPolicyStore.js';
import { delegationStore as defaultDelegationStore } from '../../delegation/DelegationStore.js';
import { agentRunStore as defaultAgentRunStore } from '../../agents/AgentRunStore.js';
import { buildApprovalResumeGateAudit, buildApprovalResumeReview, latestApprovalResumeManifest } from '../../agents/AgentRunApprovalResumeReview.js';
import { activityLog as defaultActivityLog } from '../../audit/ActivityLog.js';
import { governanceQueueStore as defaultGovernanceQueueStore } from '../../governance/GovernanceQueueStore.js';
import { requireOwnerToken } from '../auth/owner-token.js';

function compact(items, limit = 5) {
  return Array.isArray(items) ? items.slice(0, limit) : [];
}

function timelineForRun(agentRunTimelines, runId) {
  if (!runId || !agentRunTimelines) return null;
  if (typeof agentRunTimelines.get === 'function') return agentRunTimelines.get(runId) || null;
  return agentRunTimelines[runId] || null;
}

function compactApproval(a = {}, { agentRuns = [], agentRunTimelines = new Map() } = {}) {
  const agentRunId = a.payload?.agentRunId || a.payload?.details?.request?.agentRunId || null;
  const resumeRun = agentRuns.find(run => run.approvalId === a.id || run.id === agentRunId);
  const resumeTimeline = timelineForRun(agentRunTimelines, resumeRun?.id || agentRunId);
  const resumeManifest = resumeTimeline ? latestApprovalResumeManifest(resumeTimeline, a.id) : null;
  const resumeReview = resumeManifest
    ? buildApprovalResumeReview(resumeManifest, { cwd: process.cwd(), runId: resumeRun?.id || agentRunId || '' })
    : null;
  const resumeReviewGateAudit = resumeReview
    ? buildApprovalResumeGateAudit(resumeReview, { status: 'previewed', recordedBy: 'governance-center' })
    : null;
  return {
    id: a.id,
    type: a.type,
    status: a.status,
    title: a.payload?.command || a.payload?.title || a.payload?.summary || a.type,
    action: a.payload?.action || null,
    agentRunId,
    resumeRunId: resumeRun?.id || agentRunId || null,
    canApproveResume: a.status === 'pending'
      && resumeRun?.id
      && resumeRun.status === 'deferred'
      && resumeRun.sourceType === 'idea_to_archive',
    resumeReview,
    resumeReviewGateAudit,
    requesterType: a.requesterType,
    requesterId: a.requesterId,
    createdAt: a.createdAt,
  };
}

function compactBudgetIncident(i = {}) {
  return {
    id: i.id,
    scopeType: i.scopeType,
    scopeId: i.scopeId,
    metric: i.metric,
    thresholdType: i.thresholdType,
    status: i.status,
    observedAmount: i.observedAmount,
    limitAmount: i.limitAmount,
    createdAt: i.createdAt,
  };
}

function compactDelegation(d = {}) {
  return {
    id: d.id,
    title: d.title,
    status: d.status,
    sourceRoomId: d.sourceRoomId,
    targetRoomId: d.targetRoomId,
    sourceTaskId: d.sourceTaskId,
    updatedAt: d.updatedAt,
    createdAt: d.createdAt,
  };
}

function compactJob(j = {}) {
  return {
    id: j.id,
    action: j.action,
    status: j.status,
    targetId: j.targetId,
    updatedAt: j.updatedAt,
    createdAt: j.createdAt,
  };
}

function compactAgentRun(run = {}) {
  return {
    id: run.id,
    status: run.status,
    taskId: run.taskId,
    sourceType: run.sourceType,
    sourceId: run.sourceId,
    agentProfileId: run.agentProfileId,
    deferReason: run.deferReason,
    approvalId: run.approvalId,
    budgetIncidentId: run.budgetIncidentId,
    delegationId: run.delegationId,
    updatedAt: run.updatedAt,
    createdAt: run.createdAt,
  };
}

function isGovernanceActivity(event = {}) {
  const action = String(event.action || event.tag || '');
  const entityType = String(event.entityType || '');
  return /^(approval|budget|delegation|autopilot|permission\.|agent\.run)/.test(action)
    || ['approval', 'budget_policy', 'delegation', 'autopilot_job', 'agent_run'].includes(entityType);
}

function compactActivity(event = {}) {
  return {
    id: event.id,
    ts: event.ts,
    action: event.action || event.tag,
    entityType: event.entityType,
    entityId: event.entityId,
    severity: event.severity,
    status: event.status,
    agentRunId: event.details?.agentRunId || (event.entityType === 'agent_run' ? event.entityId : null),
    title: event.details?.summary || event.details?.message || event.action || event.tag,
  };
}

function buildNextActions({ approvals = [], budgetIncidents = [], failedDelegations = [], runningJobs = [], agentRuns = [] } = {}) {
  const actions = [];
  if (approvals.length) {
    actions.push({
      type: 'review_pending_approvals',
      label: `Review ${approvals.length} pending approvals`,
      targetKind: 'approval',
      targetId: approvals[0].id,
      severity: 'warn',
      safeToAutoExecute: false,
    });
  }
  const hardBudget = budgetIncidents.find(i => i.thresholdType === 'hard_stop');
  if (hardBudget) {
    actions.push({
      type: 'resolve_budget_hard_stop',
      label: `Resolve budget hard stop ${hardBudget.id}`,
      targetKind: 'budget',
      targetId: hardBudget.id,
      severity: 'error',
      safeToAutoExecute: false,
    });
  }
  if (failedDelegations.length) {
    actions.push({
      type: 'inspect_failed_delegation',
      label: `Inspect failed delegation ${failedDelegations[0].id}`,
      targetKind: 'delegation',
      targetId: failedDelegations[0].id,
      severity: 'error',
      safeToAutoExecute: false,
    });
  }
  if (runningJobs.length) {
    actions.push({
      type: 'inspect_running_autopilot',
      label: `Inspect running autopilot job ${runningJobs[0].id}`,
      targetKind: 'autopilot_job',
      targetId: runningJobs[0].id,
      severity: 'warn',
      safeToAutoExecute: false,
    });
  }
  const deferredRun = agentRuns.find(run => run.status === 'deferred');
  if (deferredRun) {
    actions.push({
      type: 'inspect_deferred_agent_run',
      label: `Inspect deferred Agent Run ${deferredRun.id}`,
      targetKind: 'agent_run',
      targetId: deferredRun.id,
      severity: 'warn',
      safeToAutoExecute: false,
    });
  }
  return compact(actions, 8);
}

export function buildGovernanceSummary({
  approvals = [],
  budgetIncidents = [],
  queuedDelegations = [],
  failedDelegations = [],
  queuedJobs = [],
  runningJobs = [],
  agentRuns = [],
  activityEvents = [],
  agentRunTimelines = new Map(),
} = {}) {
  const blockers = [
    ...approvals.map(a => ({
      kind: 'approval',
      id: a.id,
      title: a.payload?.command || a.payload?.title || a.type,
      status: a.status,
      severity: a.type === 'dangerous_command' ? 'warn' : 'info',
      createdAt: a.createdAt,
    })),
    ...budgetIncidents.map(i => ({
      kind: 'budget',
      id: i.id,
      title: `${i.scopeType}:${i.scopeId}`,
      status: i.status,
      severity: i.thresholdType === 'hard_stop' ? 'error' : 'warn',
      createdAt: i.createdAt,
    })),
    ...queuedDelegations.map(d => ({
      kind: 'delegation',
      id: d.id,
      title: d.title,
      status: d.status,
      severity: 'info',
      createdAt: d.createdAt,
    })),
    ...failedDelegations.map(d => ({
      kind: 'delegation',
      id: d.id,
      title: d.title,
      status: d.status,
      severity: 'error',
      createdAt: d.updatedAt,
    })),
    ...queuedJobs.map(j => ({
      kind: 'autopilot_job',
      id: j.id,
      title: j.action,
      status: j.status,
      severity: 'info',
      createdAt: j.createdAt,
    })),
    ...runningJobs.map(j => ({
      kind: 'autopilot_job',
      id: j.id,
      title: j.action,
      status: j.status,
      severity: 'warn',
      createdAt: j.updatedAt,
    })),
  ].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  const hardBlockers = budgetIncidents.filter(i => i.thresholdType === 'hard_stop').length + approvals.length;
  const attention = budgetIncidents.length + failedDelegations.length + runningJobs.length;
  const governanceActivityEvents = activityEvents.filter(isGovernanceActivity);
  const recentAgentRuns = compact(agentRuns.map(compactAgentRun), 12);
  const recentActivity = compact(governanceActivityEvents.map(compactActivity), 12);
  const nextActions = buildNextActions({ approvals, budgetIncidents, failedDelegations, runningJobs, agentRuns });

  return {
    ok: true,
    generatedAt: Date.now(),
    counts: {
      pendingApprovals: approvals.length,
      openBudgetIncidents: budgetIncidents.length,
      queuedDelegations: queuedDelegations.length,
      failedDelegations: failedDelegations.length,
      queuedAutopilotJobs: queuedJobs.length,
      runningAutopilotJobs: runningJobs.length,
      hardBlockers,
      attention,
      totalOpen: blockers.length,
      governedAgentRuns: agentRuns.length,
      recentActivityEvents: governanceActivityEvents.length,
    },
    blockers: compact(blockers, 20),
    nextActions,
    sections: {
      approvals: compact(approvals.map(approval => compactApproval(approval, { agentRuns, agentRunTimelines })), 12),
      budgetIncidents: compact(budgetIncidents.map(compactBudgetIncident), 12),
      delegations: compact([...queuedDelegations, ...failedDelegations].map(compactDelegation), 12),
      autopilotJobs: compact([...queuedJobs, ...runningJobs].map(compactJob), 12),
      agentRuns: recentAgentRuns,
      activityEvents: recentActivity,
    },
  };
}

export function registerGovernanceRoutes(app, {
  approvalStore = defaultApprovalStore,
  budgetStore = defaultBudgetStore,
  delegationStore = defaultDelegationStore,
  autopilotStore = defaultAutopilotStore,
  agentRunStore = defaultAgentRunStore,
  activityLog = defaultActivityLog,
  governanceQueueStore = defaultGovernanceQueueStore,
} = {}) {
  const collectSummary = () => {
    const approvals = approvalStore.listApprovals({ status: 'pending', limit: 50 });
    const budgetIncidents = budgetStore.listIncidents({ status: 'open', limit: 50 });
    const queuedDelegations = delegationStore.list({ status: 'queued', limit: 50 });
    const failedDelegations = delegationStore.list({ status: 'failed', limit: 50 });
    const queuedJobs = autopilotStore.listJobs({ status: 'queued', limit: 50 });
    const runningJobs = autopilotStore.listJobs({ status: 'running', limit: 50 });
    const agentRuns = agentRunStore.list({ hasGovernance: true, limit: 50 });
    const agentRunTimelines = new Map();
    for (const run of agentRuns) {
      if (run.status !== 'deferred' || run.sourceType !== 'idea_to_archive' || !run.approvalId) continue;
      try {
        const timeline = agentRunStore.getTimeline?.(run.id);
        if (timeline) agentRunTimelines.set(run.id, timeline);
      } catch {}
    }
    const activityEvents = activityLog.list({ limit: 200 });
    return buildGovernanceSummary({
      approvals,
      budgetIncidents,
      queuedDelegations,
      failedDelegations,
      queuedJobs,
      runningJobs,
      agentRuns,
      agentRunTimelines,
      activityEvents,
    });
  };

  app.get('/api/governance/summary', requireOwnerToken, (req, res) => {
    try {
      res.json(collectSummary());
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  // P5：治理工作队列——从 summary 阻塞项派生队列项并返回（按状态分组或过滤）
  app.get('/api/governance/queue', requireOwnerToken, (req, res) => {
    try {
      const summary = collectSummary();
      governanceQueueStore.syncFromBlockers(summary.blockers || []);
      const state = typeof req.query?.state === 'string' ? req.query.state : '';
      const queue = state ? governanceQueueStore.list({ state }) : governanceQueueStore.grouped();
      res.json({ ok: true, queue, counts: summary.counts || {} });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  // P5：推进队列项状态（待审批/待验证/待归档/待修复/已处理）
  app.post('/api/governance/queue/:id/state', requireOwnerToken, (req, res) => {
    try {
      const { state, note } = req.body || {};
      const ok = governanceQueueStore.setState(req.params.id, state, note || '');
      if (!ok) return res.status(404).json({ ok: false, error: 'queue item not found' });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });
}
