import { activityLog } from '../audit/ActivityLog.js';
import { approvalStore as defaultApprovalStore } from '../approval/ApprovalStore.js';
import { budgetPolicyStore as defaultBudgetStore, BudgetLimitExceededError } from '../budget/BudgetPolicyStore.js';
import { delegationStore as defaultDelegationStore } from '../delegation/DelegationStore.js';
import { agentRunStore as defaultAgentRunStore } from '../agents/AgentRunStore.js';
import { executeDelegation } from '../server/routes/delegations.js';

const DEFAULT_GATE_POLL_MS = 30_000;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value, max = 512) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).slice(0, max).trim();
}

export function delegationAutostartApprovalDedupeKey(delegationId) {
  return `delegation-autostart-approval:${delegationId}`;
}

function deferGate({ job, reason, runAfter, approval = null, budgetBlocked = [] } = {}) {
  return {
    __defer: true,
    runAfter,
    reason,
    result: {
      ok: true,
      waiting: reason,
      jobId: job?.id || null,
      approvalId: approval?.id || null,
      budgetBlocked,
      agentRunId: job?.payload?.agentRunId || null,
    },
  };
}

function buildBudgetContext({ job, delegation, sourceRoom, targetRoom = null } = {}) {
  const estimate = job.payload?.budgetEstimate || job.payload?.budget || {};
  const projectId = job.projectId || targetRoom?.cwd || sourceRoom?.cwd || delegation.payload?.projectId || null;
  return {
    projectId,
    cwd: projectId,
    roomId: targetRoom?.id || delegation.targetRoomId || delegation.sourceRoomId,
    sessionId: job.sessionId || null,
    adapterId: estimate.adapterId || job.payload?.adapterId || 'autopilot',
    taskId: job.taskId || delegation.sourceTaskId || `delegation:${delegation.id}`,
    agentRunId: job.payload?.agentRunId || delegation.payload?.agentRunId || null,
    estimateUSD: num(estimate.estimateUSD ?? estimate.usd, 0),
    estimateTokens: num(estimate.estimateTokens ?? estimate.tokens, 0),
    estimateCalls: num(estimate.estimateCalls ?? estimate.calls, 1),
  };
}

function ensureApproval({ approvalStore, job, delegation, sourceRoom, now, pollMs } = {}) {
  if (job.payload?.requireApproval === false) return { ok: true, approval: null };
  const approvalId = str(job.payload?.approvalId, 160);
  const dedupeKey = delegationAutostartApprovalDedupeKey(delegation.id);
  const approval = approvalId
    ? approvalStore.getApproval(approvalId)
    : approvalStore.getLatestByDedupeKey?.(dedupeKey);

  if (approval) {
    if (approval.status === 'approved') return { ok: true, approval };
    if (approval.status === 'pending') {
      return {
        ok: false,
        deferred: deferGate({ job, reason: 'approval_pending', runAfter: now + pollMs, approval }),
      };
    }
    throw new Error(`delegation autostart approval ${approval.status}`);
  }

  const created = approvalStore.createApproval({
    type: 'manual',
    requesterType: 'autopilot',
    requesterId: job.id,
    dedupeKey,
    payload: {
      title: `启动委派房：${delegation.title}`,
      delegationId: delegation.id,
      sourceRoomId: delegation.sourceRoomId,
      sourceRoomName: sourceRoom?.name || '',
      targetMode: delegation.targetMode,
      jobId: job.id,
      agentRunId: job.payload?.agentRunId || delegation.payload?.agentRunId || null,
      risk: 'Autopilot will create and start a delegated room after budget gates pass.',
    },
  });
  return {
    ok: false,
    deferred: deferGate({ job, reason: 'approval_created', runAfter: now + pollMs, approval: created }),
  };
}

function checkBudget({ budgetStore, job, delegation, sourceRoom, targetRoom, now, pollMs } = {}) {
  try {
    return budgetStore.preflight(buildBudgetContext({ job, delegation, sourceRoom, targetRoom }));
  } catch (e) {
    if (e instanceof BudgetLimitExceededError || e?.code === 'BUDGET_LIMIT_EXCEEDED') {
      return deferGate({
        job,
        reason: 'budget_blocked',
        runAfter: now + pollMs,
        budgetBlocked: e.blocked || [],
      });
    }
    throw e;
  }
}

export function makeDelegationAutostartHandler({
  delegationStore = defaultDelegationStore,
  approvalStore = defaultApprovalStore,
  budgetStore = defaultBudgetStore,
  roomStore,
  roomAdapterPool,
  safeResolveFsPath,
  startRoom,
  agentRunStore = defaultAgentRunStore,
  now = () => Date.now(),
  gatePollMs = DEFAULT_GATE_POLL_MS,
} = {}) {
  if (!roomStore) throw new Error('makeDelegationAutostartHandler requires roomStore');
  if (typeof startRoom !== 'function') throw new Error('makeDelegationAutostartHandler requires startRoom');

  return async function delegationAutostart(job) {
    const ts = now();
    const pollMs = Math.max(1_000, Math.trunc(num(job.payload?.gatePollMs, gatePollMs)));
    const delegationId = str(job.payload?.delegationId || job.targetId, 160);
    if (!delegationId) throw new Error('start_delegation job requires delegationId');
    const delegation = delegationStore.get(delegationId);
    if (!delegation) throw new Error('delegation not found');
    if (delegation.status === 'cancelled') throw new Error('delegation cancelled');

    const sourceRoom = roomStore.get(delegation.sourceRoomId);
    if (!sourceRoom) throw new Error('source room not found');

    const approvalGate = ensureApproval({ approvalStore, job, delegation, sourceRoom, now: ts, pollMs });
    if (!approvalGate.ok) {
      const agentRunId = job.payload?.agentRunId || delegation.payload?.agentRunId || null;
      if (agentRunId) {
        try {
          agentRunStore.transition(agentRunId, 'deferred', {
            deferReason: approvalGate.deferred.reason,
            approvalId: approvalGate.deferred.result?.approvalId || null,
            delegationId: delegation.id,
            jobId: job.id,
          });
        } catch {}
      }
      return approvalGate.deferred;
    }

    const budgetGate = checkBudget({ budgetStore, job, delegation, sourceRoom, now: ts, pollMs });
    if (budgetGate?.__defer) {
      const agentRunId = job.payload?.agentRunId || delegation.payload?.agentRunId || null;
      const incidents = (budgetGate.result?.budgetBlocked || []).map((item) => item?.incident).filter(Boolean);
      if (agentRunId) {
        try {
          agentRunStore.transition(agentRunId, 'deferred', {
            deferReason: 'budget_blocked',
            approvalId: approvalGate.approval?.id || null,
            delegationId: delegation.id,
            jobId: job.id,
            budgetIncidentId: incidents[0]?.id || null,
            budgetIncidentIds: incidents.map((incident) => incident.id).filter(Boolean),
            relatedActivityIds: incidents.map((incident) => incident.activityId).filter(Boolean),
          });
        } catch {}
      }
      return budgetGate;
    }

    const execution = executeDelegation({
      id: delegation.id,
      delegationStore,
      roomStore,
      roomAdapterPool,
      safeResolveFsPath,
    });
    const targetRoom = execution.room;
    const targetBudgetGate = checkBudget({
      budgetStore,
      job,
      delegation: execution.delegation,
      sourceRoom,
      targetRoom,
      now: ts,
      pollMs,
    });
    if (targetBudgetGate?.__defer) {
      const agentRunId = job.payload?.agentRunId || execution.delegation.payload?.agentRunId || null;
      const incidents = (targetBudgetGate.result?.budgetBlocked || []).map((item) => item?.incident).filter(Boolean);
      if (agentRunId) {
        try {
          agentRunStore.transition(agentRunId, 'deferred', {
            deferReason: 'budget_blocked',
            approvalId: approvalGate.approval?.id || null,
            delegationId: execution.delegation.id,
            jobId: job.id,
            targetRoomId: targetRoom?.id || execution.delegation.targetRoomId,
            budgetIncidentId: incidents[0]?.id || null,
            budgetIncidentIds: incidents.map((incident) => incident.id).filter(Boolean),
            relatedActivityIds: incidents.map((incident) => incident.activityId).filter(Boolean),
          });
        } catch {}
      }
      return targetBudgetGate;
    }

    const autoStart = job.payload?.autoStart !== false;
    const startResult = autoStart && targetRoom?.mode !== 'chat'
      ? await startRoom({ room: targetRoom, delegation: execution.delegation, job })
      : { started: false, reason: targetRoom?.mode === 'chat' ? 'chat_room' : 'auto_start_disabled' };

    activityLog.recordSafe({
      action: 'delegation.autostart',
      actorType: 'autopilot',
      actorId: job.id,
      roomId: targetRoom?.id || execution.delegation.targetRoomId,
      taskId: job.taskId || execution.delegation.sourceTaskId,
      entityType: 'delegation',
      entityId: execution.delegation.id,
      status: startResult.started ? 'started' : 'created',
      details: {
        sourceRoomId: execution.delegation.sourceRoomId,
        targetRoomId: targetRoom?.id || execution.delegation.targetRoomId,
        targetMode: execution.delegation.targetMode,
        started: !!startResult.started,
        approvalId: approvalGate.approval?.id || null,
        agentRunId: job.payload?.agentRunId || execution.delegation.payload?.agentRunId || null,
      },
    });

    const agentRunId = job.payload?.agentRunId || execution.delegation.payload?.agentRunId || null;
    if (agentRunId) {
      try {
        agentRunStore.transition(agentRunId, 'succeeded', {
          approvalId: approvalGate.approval?.id || null,
          delegationId: execution.delegation.id,
          jobId: job.id,
          targetRoomId: targetRoom?.id || execution.delegation.targetRoomId,
          started: !!startResult.started,
        });
      } catch {}
    }

    return {
      ok: true,
      delegation: execution.delegation,
      room: targetRoom,
      started: !!startResult.started,
      startResult,
      approvalId: approvalGate.approval?.id || null,
      agentRunId,
    };
  };
}
