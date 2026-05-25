import { homedir } from 'node:os';
import { approvalStore as defaultApprovalStore } from '../../approval/ApprovalStore.js';
import { agentRunStore as defaultAgentRunStore } from '../../agents/AgentRunStore.js';
import { autopilotScheduleStore as defaultScheduleStore } from '../../autopilot/AutopilotScheduleStore.js';
import { delegationStore as defaultDelegationStore } from '../../delegation/DelegationStore.js';
import { getCurrentTier, hasFeature } from '../../license/LicenseManager.js';
import { requireOwnerToken } from '../auth/owner-token.js';

const VALID_MODES = new Set(['chat', 'debate', 'squad', 'arena']);

function safeString(value, max = 512) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).slice(0, max).trim();
}

function defaultMembersForMode(mode, roomAdapterPool) {
  if (mode === 'squad') {
    return [
      { adapterId: 'claude', displayName: 'Claude · PM', role: 'pm', enabled: true },
      { adapterId: 'claude', displayName: 'Claude · Dev', role: 'dev', enabled: true },
      { adapterId: 'codex', displayName: 'Codex · Dev', role: 'dev', enabled: true },
      { adapterId: 'codex', displayName: 'Codex · QA', role: 'qa', enabled: true },
    ];
  }
  if (mode === 'arena') {
    return [
      { adapterId: 'claude', displayName: 'Claude Judge', role: 'judge', enabled: true },
      { adapterId: 'codex', displayName: 'Codex', enabled: true },
      { adapterId: 'gemini-cli', displayName: 'Gemini CLI', enabled: roomAdapterPool?.has?.('gemini-cli') !== false },
      { adapterId: 'minimax', displayName: 'MiniMax', enabled: roomAdapterPool?.has?.('minimax') === true },
    ].filter(m => m.enabled !== false || m.adapterId === 'claude' || m.adapterId === 'codex');
  }
  if (mode === 'chat') {
    return [{ adapterId: 'claude', displayName: 'Claude', enabled: true }];
  }
  return [
    { adapterId: 'claude', displayName: 'Claude', enabled: true },
    { adapterId: 'codex', displayName: 'Codex', enabled: true },
    { adapterId: 'ollama', displayName: 'Ollama', enabled: true },
  ];
}

export function buildDelegatedTopic({ delegation, sourceRoom }) {
  const sourceTitle = sourceRoom?.name || delegation.sourceRoomId;
  const objective = sourceRoom?.objective?.title ? `\n源目标：${sourceRoom.objective.title}` : '';
  const sourceTopic = sourceRoom?.topic ? `\n\n## 源房当前 topic\n${sourceRoom.topic}` : '';
  return `# 委派任务：${delegation.title}

来源房间：${sourceTitle} (${delegation.sourceRoomId})${delegation.sourceTaskId ? `\n来源任务：${delegation.sourceTaskId}` : ''}${objective}

## 执行要求
${delegation.instructions}

## 约束
- 只处理本委派任务，不要扩展成无关工作。
- 产出必须能回溯到来源房间和来源任务。
- 如需执行高风险命令，必须走审批队列。${sourceTopic}`;
}

export function createTargetRoom({ delegation, sourceRoom, roomStore, roomAdapterPool, safeResolveFsPath }) {
  const mode = VALID_MODES.has(delegation.targetMode) ? delegation.targetMode : 'debate';
  if ((mode === 'squad' || mode === 'arena') && !hasFeature(mode)) {
    const err = new Error(`${mode === 'squad' ? 'AI 团队拆活（squad）' : '多模型联网核对（arena）'} 模式需要 Pro license`);
    err.statusCode = 402;
    err.extra = { tier: getCurrentTier(), feature: mode };
    throw err;
  }

  let cwd = sourceRoom?.cwd || homedir();
  if (safeResolveFsPath) cwd = safeResolveFsPath(cwd) || homedir();
  const room = roomStore.create({
    name: `委派：${delegation.title}`,
    cwd,
    members: defaultMembersForMode(mode, roomAdapterPool),
    mode,
    objective: {
      id: delegation.objectiveId,
      title: delegation.title,
      description: delegation.instructions,
      acceptanceCriteria: Array.isArray(delegation.payload?.acceptanceCriteria)
        ? delegation.payload.acceptanceCriteria
        : [],
    },
    lineage: {
      projectId: cwd,
      parentRoomId: delegation.sourceRoomId,
      parentTaskId: delegation.sourceTaskId,
      taskId: `delegation:${delegation.id}`,
      objectiveId: delegation.objectiveId,
      source: 'delegation',
    },
  });
  roomStore.update(room.id, {
    topic: buildDelegatedTopic({ delegation, sourceRoom }),
    parentRoomId: delegation.sourceRoomId,
    delegatedFrom: {
      delegationId: delegation.id,
      sourceRoomId: delegation.sourceRoomId,
      sourceTaskId: delegation.sourceTaskId,
    },
  });
  return roomStore.get(room.id) || room;
}

export function executeDelegation({
  id,
  delegationStore = defaultDelegationStore,
  roomStore,
  roomAdapterPool,
  safeResolveFsPath,
} = {}) {
  if (!roomStore) throw new Error('executeDelegation requires roomStore');
  const delegation = delegationStore.get(id);
  if (!delegation) {
    const err = new Error('delegation not found');
    err.statusCode = 404;
    throw err;
  }
  if (delegation.status === 'created' && delegation.targetRoomId) {
    return { delegation, room: roomStore.get(delegation.targetRoomId) || null, reused: true };
  }
  if (delegation.status === 'cancelled') {
    const err = new Error('delegation cancelled');
    err.statusCode = 409;
    throw err;
  }
  const sourceRoom = roomStore.get(delegation.sourceRoomId);
  if (!sourceRoom) {
    const err = new Error('source room not found');
    err.statusCode = 404;
    throw err;
  }
  const room = createTargetRoom({ delegation, sourceRoom, roomStore, roomAdapterPool, safeResolveFsPath });
  const updated = delegationStore.markCreated(delegation.id, { targetRoomId: room.id });
  return { delegation: updated, room };
}

function parseListQuery(query = {}) {
  return {
    status: query.status || undefined,
    sourceRoomId: query.sourceRoomId || query.sourceRoom || undefined,
    sourceTaskId: query.sourceTaskId || query.sourceTask || undefined,
    targetRoomId: query.targetRoomId || query.targetRoom || undefined,
    limit: query.limit,
  };
}

export function registerDelegationRoutes(app, {
  delegationStore = defaultDelegationStore,
  scheduleStore = defaultScheduleStore,
  approvalStore = defaultApprovalStore,
  agentRunStore = defaultAgentRunStore,
  roomStore,
  roomAdapterPool,
  safeResolveFsPath,
} = {}) {
  if (!roomStore) throw new Error('registerDelegationRoutes requires roomStore');

  app.get('/api/delegations', requireOwnerToken, (req, res) => {
    try {
      res.json({ ok: true, delegations: delegationStore.list(parseListQuery(req.query || {})) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/delegations', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const sourceRoomId = safeString(body.sourceRoomId || body.source_room_id);
      const sourceRoom = roomStore.get(sourceRoomId);
      if (!sourceRoom) return res.status(404).json({ ok: false, error: 'source room not found' });
      const delegation = delegationStore.create({
        sourceRoomId,
        sourceTaskId: body.sourceTaskId || body.source_task_id || sourceRoom.lineage?.taskId || null,
        targetMode: body.targetMode || body.target_mode || 'debate',
        title: body.title || sourceRoom.objective?.title || sourceRoom.name || '委派任务',
        instructions: body.instructions || body.prompt || sourceRoom.finalConsensus || sourceRoom.topic || '',
        objectiveId: body.objectiveId || body.objective_id,
        payload: body.payload || {},
        actorType: 'user',
      });
      res.json({ ok: true, delegation });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/delegations/:id/execute', requireOwnerToken, (req, res) => {
    try {
      res.json({ ok: true, ...executeDelegation({
        id: req.params.id,
        delegationStore,
        roomStore,
        roomAdapterPool,
        safeResolveFsPath,
      }) });
    } catch (e) {
      if (!e.statusCode || e.statusCode >= 500 || e.statusCode === 402) {
        try { delegationStore.markFailed(req.params.id, e.message || String(e)); } catch {}
      }
      res.status(e.statusCode || 500).json({ ok: false, error: e.message || String(e), ...(e.extra || {}) });
    }
  });

  app.post('/api/delegations/:id/autostart', requireOwnerToken, (req, res) => {
    try {
      const delegation = delegationStore.get(req.params.id);
      if (!delegation) return res.status(404).json({ ok: false, error: 'delegation not found' });
      if (delegation.status === 'cancelled') return res.status(409).json({ ok: false, error: 'delegation cancelled' });
      const sourceRoom = roomStore.get(delegation.sourceRoomId);
      if (!sourceRoom) return res.status(404).json({ ok: false, error: 'source room not found' });
      const requireApproval = req.body?.requireApproval !== false;
      const agentRunId = `agent-run-delegation-${delegation.id}`;
      const approval = requireApproval
        ? approvalStore.createApproval({
          type: 'manual',
          requesterType: 'autopilot',
          requesterId: req.params.id,
          dedupeKey: `delegation-autostart-approval:${req.params.id}`,
          payload: {
            title: `启动委派房：${delegation.title}`,
            delegationId: delegation.id,
            agentRunId,
            sourceRoomId: delegation.sourceRoomId,
            sourceRoomName: sourceRoom.name || '',
            targetMode: delegation.targetMode,
            risk: 'Autopilot will create and start a delegated room after budget gates pass.',
          },
        })
        : null;
      const job = scheduleStore.enqueueJob({
        action: 'start_delegation',
        targetType: 'delegation',
        targetId: delegation.id,
        roomId: delegation.sourceRoomId,
        taskId: delegation.sourceTaskId || `delegation:${delegation.id}`,
        projectId: sourceRoom.cwd || null,
        priority: req.body?.priority,
        runAfter: req.body?.runAfter || Date.now(),
        maxAttempts: req.body?.maxAttempts || 500,
        retryBackoffMs: req.body?.retryBackoffMs || 30_000,
        dedupeKey: `delegation-autostart:${delegation.id}`,
        payload: {
          ...(req.body?.payload || {}),
          delegationId: delegation.id,
          agentRunId,
          approvalId: approval?.id || req.body?.approvalId || null,
          requireApproval,
          autoStart: req.body?.autoStart !== false,
          gatePollMs: req.body?.gatePollMs || 30_000,
          budgetEstimate: req.body?.budgetEstimate || req.body?.budget || {},
        },
      });
      const agentRun = agentRunStore?.create?.({
        id: agentRunId,
        status: 'queued',
        roomId: delegation.sourceRoomId,
        taskId: delegation.sourceTaskId || `delegation:${delegation.id}`,
        approvalId: approval?.id || req.body?.approvalId || null,
        delegationId: delegation.id,
        agentProfileId: 'xike-chief',
        agentProfileTitle: 'Xike Chief',
        sourceType: 'delegation_autostart',
        sourceId: delegation.id,
        dispatchTags: ['governance'],
        details: {
          delegationId: delegation.id,
          agentRunId,
          approvalId: approval?.id || null,
          jobId: job?.id || null,
          targetMode: delegation.targetMode,
          autoStart: req.body?.autoStart !== false,
        },
      }) || null;
      try {
        delegationStore.attachAgentRun?.(delegation.id, {
          agentRunId,
          approvalId: approval?.id || req.body?.approvalId || null,
          jobId: job?.id || null,
        });
      } catch {}
      res.status(201).json({ ok: true, job, approval, agentRun });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/delegations/:id/cancel', requireOwnerToken, (req, res) => {
    try {
      const delegation = delegationStore.cancel(req.params.id, {
        reason: req.body?.reason || '',
        actorType: 'user',
      });
      res.json({ ok: true, delegation });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });
}
