import { approvalStore as defaultApprovalStore } from '../../approval/ApprovalStore.js';
import { autopilotScheduleStore as defaultAutopilotStore } from '../../autopilot/AutopilotScheduleStore.js';
import { budgetPolicyStore as defaultBudgetStore } from '../../budget/BudgetPolicyStore.js';
import { delegationStore as defaultDelegationStore } from '../../delegation/DelegationStore.js';
import { requireOwnerToken } from '../auth/owner-token.js';

function compact(items, limit = 5) {
  return Array.isArray(items) ? items.slice(0, limit) : [];
}

export function buildGovernanceSummary({
  approvals = [],
  budgetIncidents = [],
  queuedDelegations = [],
  failedDelegations = [],
  queuedJobs = [],
  runningJobs = [],
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
    },
    blockers: compact(blockers, 20),
  };
}

export function registerGovernanceRoutes(app, {
  approvalStore = defaultApprovalStore,
  budgetStore = defaultBudgetStore,
  delegationStore = defaultDelegationStore,
  autopilotStore = defaultAutopilotStore,
} = {}) {
  app.get('/api/governance/summary', requireOwnerToken, (req, res) => {
    try {
      const approvals = approvalStore.listApprovals({ status: 'pending', limit: 50 });
      const budgetIncidents = budgetStore.listIncidents({ status: 'open', limit: 50 });
      const queuedDelegations = delegationStore.list({ status: 'queued', limit: 50 });
      const failedDelegations = delegationStore.list({ status: 'failed', limit: 50 });
      const queuedJobs = autopilotStore.listJobs({ status: 'queued', limit: 50 });
      const runningJobs = autopilotStore.listJobs({ status: 'running', limit: 50 });
      res.json(buildGovernanceSummary({
        approvals,
        budgetIncidents,
        queuedDelegations,
        failedDelegations,
        queuedJobs,
        runningJobs,
      }));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });
}
