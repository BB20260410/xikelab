import { randomUUID, createHash } from 'node:crypto';
import { activityLog } from '../audit/ActivityLog.js';
import { getDb } from '../storage/SqliteStore.js';

export const AGENT_RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'deferred']);
export const AGENT_MESSAGE_KINDS = new Set(['message', 'tool_call', 'tool_result', 'metric', 'decision', 'summary']);
const FINISHED_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function nowMs() {
  return Date.now();
}

function str(value, max = 512) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, max).trim() || null;
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function json(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50);
}

function normalizeIdArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0))].slice(0, 200);
}

function normalizeStatus(value, fallback = 'queued') {
  const status = String(value || fallback).toLowerCase();
  if (!AGENT_RUN_STATUSES.has(status)) throw new Error(`invalid agent run status: ${value}`);
  return status;
}

function formatJsonBlock(value) {
  const body = JSON.stringify(value || {}, null, 2);
  return body === '{}' ? '_none_' : `\n\`\`\`json\n${body}\n\`\`\``;
}

function formatAgentRunMarkdown(snapshot) {
  const { run, messages, toolResults, activityEvents } = snapshot;
  const lines = [
    `# Agent Run ${run.id}`,
    '',
    `- Status: ${run.status}`,
    `- Room: ${run.roomId || '-'}`,
    `- Session: ${run.sessionId || '-'}`,
    `- Task: ${run.taskId || '-'}`,
    `- Agent Profile: ${run.agentProfileId || '-'}${run.agentProfileTitle ? ` (${run.agentProfileTitle})` : ''}`,
    `- Adapter: ${run.adapterId || '-'} / ${run.modelId || '-'}`,
    `- Source: ${run.sourceType || '-'} / ${run.sourceId || '-'}`,
    `- Defer Reason: ${run.deferReason || '-'}`,
    `- Approval: ${run.approvalId || '-'}`,
    `- Budget Incident: ${run.budgetIncidentId || '-'}`,
    `- Delegation: ${run.delegationId || '-'}`,
    '',
    '## Dispatch',
    '',
    `- Tags: ${run.dispatchTags.length ? run.dispatchTags.join(', ') : '-'}`,
    `- Skills: ${run.skills.length ? run.skills.join(', ') : '-'}`,
    `- Governance: ${formatJsonBlock(run.governance)}`,
    '',
    '## Details',
    formatJsonBlock(run.details),
    '',
    '## Messages',
  ];
  if (messages.length === 0) lines.push('', '_none_');
  for (const message of messages) {
    lines.push('', `### ${message.kind} / ${message.role} / ${message.status || '-'}`, '');
    if (message.summary) lines.push(message.summary, '');
    if (message.content) lines.push(message.content, '');
    if (Object.keys(message.payload || {}).length) lines.push(formatJsonBlock(message.payload));
  }
  lines.push('', '## Tool Results');
  if (toolResults.length === 0) lines.push('', '_none_');
  for (const result of toolResults) {
    lines.push('', `### ${result.toolName} / ${result.status}`, '');
    if (result.inputSummary) lines.push(`Input: ${result.inputSummary}`);
    if (result.outputSummary) lines.push(`Output: ${result.outputSummary}`);
    lines.push(`Cost USD: ${result.costUsd || 0}`);
    if (result.approvalId) lines.push(`Approval: ${result.approvalId}`);
  }
  lines.push('', '## Activity');
  if (activityEvents.length === 0) lines.push('', '_none_');
  for (const event of activityEvents) {
    lines.push('', `- #${event.id} ${event.action || event.tag} ${event.status || ''}`.trim());
  }
  return lines.join('\n');
}

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    roomId: row.room_id || null,
    sessionId: row.session_id || null,
    taskId: row.task_id || null,
    agentProfileId: row.agent_profile_id || null,
    agentProfileTitle: row.agent_profile_title || null,
    adapterId: row.adapter_id || null,
    modelId: row.model_id || null,
    turnId: row.turn_id || null,
    sourceType: row.source_type || null,
    sourceId: row.source_id || null,
    deferReason: row.defer_reason || null,
    approvalId: row.approval_id || null,
    budgetIncidentId: row.budget_incident_id || null,
    delegationId: row.delegation_id || null,
    relatedActivityIds: normalizeIdArray(parseJson(row.related_activity_ids, [])),
    skills: parseJson(row.skills, []),
    dispatchTags: parseJson(row.dispatch_tags, []),
    governance: parseJson(row.governance, {}),
    details: parseJson(row.details, {}),
    error: row.error || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    role: row.role,
    status: row.status || null,
    summary: row.summary || null,
    content: row.content || null,
    payload: parseJson(row.payload, {}),
    createdAt: row.created_at,
  };
}

function rowToToolResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    toolName: row.tool_name,
    status: row.status,
    inputSummary: row.input_summary || null,
    outputSummary: row.output_summary || null,
    costUsd: Number(row.cost_usd) || 0,
    approvalId: row.approval_id || null,
    payload: parseJson(row.payload, {}),
    createdAt: row.created_at,
  };
}

function stableMetricRunId(metric = {}) {
  const source = [
    metric.roomId || '',
    metric.sessionId || '',
    metric.taskId || '',
    metric.turn || '',
    metric.agentProfileId || '',
    metric.adapter || '',
    metric.model || '',
    metric.ts || '',
  ].join('\u001f');
  return `agent-run-${createHash('sha1').update(source).digest('hex').slice(0, 16)}`;
}

export class AgentRunStore {
  constructor({ logger = console, audit = activityLog } = {}) {
    this.logger = logger;
    this.audit = audit;
  }

  db() {
    return getDb();
  }

  addRelatedActivityId(id, activityId) {
    const run = this.get(id);
    const n = Number(activityId);
    if (!run || !Number.isFinite(n) || n <= 0) return run;
    const relatedActivityIds = normalizeIdArray([...run.relatedActivityIds, n]);
    this.db().prepare('UPDATE agent_runs SET related_activity_ids = ?, updated_at = ? WHERE id = ?')
      .run(json(relatedActivityIds, []), nowMs(), id);
    return this.get(id);
  }

  recordRunActivity({ action, run, actorType = 'system', status = run?.status, severity = 'info', details = {} } = {}) {
    if (!run?.id || !action) return null;
    const event = this.audit?.recordSafe?.({
      action,
      actorType,
      roomId: run.roomId,
      sessionId: run.sessionId,
      taskId: run.taskId,
      entityType: 'agent_run',
      entityId: run.id,
      status,
      severity,
      details: {
        agentRunId: run.id,
        agentProfileId: run.agentProfileId,
        adapterId: run.adapterId,
        modelId: run.modelId,
        sourceType: run.sourceType,
        sourceId: run.sourceId,
        deferReason: run.deferReason,
        approvalId: run.approvalId,
        budgetIncidentId: run.budgetIncidentId,
        delegationId: run.delegationId,
        ...details,
      },
    });
    if (event?.id) this.addRelatedActivityId(run.id, event.id);
    return event || null;
  }

  create(input = {}) {
    const id = str(input.id, 160) || `agent-run-${randomUUID().slice(0, 12)}`;
    const now = nowMs();
    const status = normalizeStatus(input.status || (input.startedAt ? 'running' : 'queued'));
    const details = parseJson(input.details, {});
    const deferReason = status === 'deferred'
      ? str(input.deferReason || details.deferReason || details.reason, 160)
      : str(input.deferReason || details.deferReason, 160);
    const startedAt = input.startedAt === undefined ? (status === 'running' ? now : null) : Number(input.startedAt) || null;
    const finishedAt = input.finishedAt === undefined ? (FINISHED_STATUSES.has(status) ? now : null) : Number(input.finishedAt) || null;
    this.db().prepare(`
      INSERT INTO agent_runs(
        id, status, room_id, session_id, task_id, agent_profile_id, agent_profile_title,
        adapter_id, model_id, turn_id, source_type, source_id, defer_reason, approval_id,
        budget_incident_id, delegation_id, related_activity_ids, skills, dispatch_tags,
        governance, details, error, started_at, finished_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        room_id = COALESCE(excluded.room_id, agent_runs.room_id),
        session_id = COALESCE(excluded.session_id, agent_runs.session_id),
        task_id = COALESCE(excluded.task_id, agent_runs.task_id),
        agent_profile_id = COALESCE(excluded.agent_profile_id, agent_runs.agent_profile_id),
        agent_profile_title = COALESCE(excluded.agent_profile_title, agent_runs.agent_profile_title),
        adapter_id = COALESCE(excluded.adapter_id, agent_runs.adapter_id),
        model_id = COALESCE(excluded.model_id, agent_runs.model_id),
        turn_id = COALESCE(excluded.turn_id, agent_runs.turn_id),
        source_type = COALESCE(excluded.source_type, agent_runs.source_type),
        source_id = COALESCE(excluded.source_id, agent_runs.source_id),
        defer_reason = COALESCE(excluded.defer_reason, agent_runs.defer_reason),
        approval_id = COALESCE(excluded.approval_id, agent_runs.approval_id),
        budget_incident_id = COALESCE(excluded.budget_incident_id, agent_runs.budget_incident_id),
        delegation_id = COALESCE(excluded.delegation_id, agent_runs.delegation_id),
        skills = excluded.skills,
        dispatch_tags = excluded.dispatch_tags,
        governance = excluded.governance,
        details = excluded.details,
        error = excluded.error,
        started_at = COALESCE(excluded.started_at, agent_runs.started_at),
        finished_at = COALESCE(excluded.finished_at, agent_runs.finished_at),
        updated_at = excluded.updated_at
    `).run(
      id,
      status,
      str(input.roomId),
      str(input.sessionId),
      str(input.taskId, 240),
      str(input.agentProfileId, 160),
      str(input.agentProfileTitle, 240),
      str(input.adapterId || input.adapter, 160),
      str(input.modelId || input.model, 240),
      str(input.turnId || input.turn, 240),
      str(input.sourceType, 120),
      str(input.sourceId, 240),
      deferReason,
      str(input.approvalId || details.approvalId, 160),
      str(input.budgetIncidentId || details.budgetIncidentId, 160),
      str(input.delegationId || details.delegationId, 160),
      json(normalizeIdArray(input.relatedActivityIds), []),
      json(normalizeArray(input.skills || input.agentSkillNames), []),
      json(normalizeArray(input.dispatchTags || input.agentDispatchTags), []),
      json(parseJson(input.governance || input.agentGovernance, {}), {}),
      json(details, {}),
      str(input.error, 4000),
      startedAt,
      finishedAt,
      Number(input.createdAt) || now,
      now
    );
    const run = this.get(id);
    this.recordRunActivity({
      action: 'agent.run.created',
      actorType: input.actorType || 'system',
      run,
      status: run.status,
      details: {
        skills: run.skills,
        dispatchTags: run.dispatchTags,
      },
    });
    return this.get(id);
  }

  get(id) {
    return rowToRun(this.db().prepare('SELECT * FROM agent_runs WHERE id = ?').get(id));
  }

  list(query = {}) {
    const where = [];
    const args = [];
    if (query.status) { where.push('status = ?'); args.push(normalizeStatus(query.status)); }
    if (query.roomId) { where.push('room_id = ?'); args.push(str(query.roomId)); }
    if (query.sessionId) { where.push('session_id = ?'); args.push(str(query.sessionId)); }
    if (query.taskId) { where.push('task_id = ?'); args.push(str(query.taskId, 240)); }
    if (query.agentProfileId) { where.push('agent_profile_id = ?'); args.push(str(query.agentProfileId, 160)); }
    if (query.sourceType) { where.push('source_type = ?'); args.push(str(query.sourceType, 120)); }
    if (query.sourceId) { where.push('source_id = ?'); args.push(str(query.sourceId, 240)); }
    if (query.approvalId) { where.push('approval_id = ?'); args.push(str(query.approvalId, 160)); }
    if (query.budgetIncidentId) { where.push('budget_incident_id = ?'); args.push(str(query.budgetIncidentId, 160)); }
    if (query.delegationId) { where.push('delegation_id = ?'); args.push(str(query.delegationId, 160)); }
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 100));
    const sql = `SELECT * FROM agent_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`;
    return this.db().prepare(sql).all(...args, limit).map(rowToRun);
  }

  transition(id, status, details = {}) {
    const normalizedStatus = normalizeStatus(status);
    const run = this.get(id);
    if (!run) throw new Error('agent run not found');
    const now = nowMs();
    const finishedAt = FINISHED_STATUSES.has(normalizedStatus) ? now : run.finishedAt;
    const startedAt = normalizedStatus === 'running' && !run.startedAt ? now : run.startedAt;
    const error = normalizedStatus === 'failed' ? str(details.error || details.message, 4000) : null;
    const nextDetails = { ...(run.details || {}), ...(details || {}) };
    const deferReason = normalizedStatus === 'deferred'
      ? str(details.deferReason || details.reason || run.deferReason, 160)
      : (normalizedStatus === 'running' ? null : run.deferReason);
    const approvalId = str(details.approvalId || run.approvalId, 160);
    const budgetIncidentId = str(details.budgetIncidentId || run.budgetIncidentId, 160);
    const delegationId = str(details.delegationId || run.delegationId, 160);
    const relatedActivityIds = normalizeIdArray([...(run.relatedActivityIds || []), ...(details.relatedActivityIds || [])]);
    this.db().prepare(`
      UPDATE agent_runs
      SET status = ?, defer_reason = ?, approval_id = ?, budget_incident_id = ?, delegation_id = ?,
        related_activity_ids = ?, details = ?, error = ?, started_at = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      normalizedStatus,
      deferReason,
      approvalId,
      budgetIncidentId,
      delegationId,
      json(relatedActivityIds, []),
      json(nextDetails, {}),
      error,
      startedAt,
      finishedAt,
      now,
      id
    );
    const updated = this.get(id);
    this.recordRunActivity({
      action: 'agent.run.transitioned',
      actorType: 'system',
      run: updated,
      status: updated.status,
      severity: updated.status === 'failed' ? 'error' : 'info',
      details: nextDetails,
    });
    return this.get(id);
  }

  appendMessage(runId, input = {}) {
    if (!this.get(runId)) throw new Error('agent run not found');
    const kind = AGENT_MESSAGE_KINDS.has(String(input.kind || 'message')) ? String(input.kind || 'message') : 'message';
    const id = str(input.id, 160) || `agent-msg-${randomUUID().slice(0, 12)}`;
    const createdAt = Number(input.createdAt) || nowMs();
    this.db().prepare(`
      INSERT INTO agent_messages(id, run_id, kind, role, status, summary, content, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      runId,
      kind,
      str(input.role || 'system', 80) || 'system',
      str(input.status, 80),
      str(input.summary, 2000),
      str(input.content, 16_000),
      json(parseJson(input.payload, {}), {}),
      createdAt
    );
    const message = rowToMessage(this.db().prepare('SELECT * FROM agent_messages WHERE id = ?').get(id));
    const run = this.get(runId);
    this.recordRunActivity({
      action: 'agent.run.message_appended',
      run,
      status: message.status || run.status,
      details: { messageId: message.id, kind: message.kind, role: message.role, summary: message.summary },
    });
    return message;
  }

  appendToolResult(runId, input = {}) {
    if (!this.get(runId)) throw new Error('agent run not found');
    const toolName = str(input.toolName || input.tool, 160);
    if (!toolName) throw new Error('toolName required');
    const id = str(input.id, 160) || `agent-tool-${randomUUID().slice(0, 12)}`;
    const createdAt = Number(input.createdAt) || nowMs();
    this.db().prepare(`
      INSERT INTO agent_tool_results(
        id, run_id, tool_name, status, input_summary, output_summary, cost_usd, approval_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      runId,
      toolName,
      str(input.status || 'done', 80) || 'done',
      str(input.inputSummary, 2000),
      str(input.outputSummary, 4000),
      Math.max(0, Number(input.costUsd || input.costUSD) || 0),
      str(input.approvalId, 160),
      json(parseJson(input.payload, {}), {}),
      createdAt
    );
    const toolResult = rowToToolResult(this.db().prepare('SELECT * FROM agent_tool_results WHERE id = ?').get(id));
    const run = this.get(runId);
    this.recordRunActivity({
      action: 'agent.tool_result.recorded',
      run,
      status: toolResult.status,
      severity: toolResult.status === 'failed' || toolResult.status === 'error' ? 'error' : 'info',
      details: {
        toolResultId: toolResult.id,
        toolName: toolResult.toolName,
        approvalId: toolResult.approvalId,
        costUsd: toolResult.costUsd,
      },
    });
    return toolResult;
  }

  getTimeline(id) {
    const run = this.get(id);
    if (!run) return null;
    const messages = this.db().prepare('SELECT * FROM agent_messages WHERE run_id = ? ORDER BY created_at ASC').all(id).map(rowToMessage);
    const toolResults = this.db().prepare('SELECT * FROM agent_tool_results WHERE run_id = ? ORDER BY created_at ASC').all(id).map(rowToToolResult);
    return { run, messages, toolResults };
  }

  exportRun(id, { format = 'json' } = {}) {
    const timeline = this.getTimeline(id);
    if (!timeline) return null;
    const activityEvents = [];
    if (typeof this.audit?.list === 'function') {
      const directEvents = this.audit.list({ entityType: 'agent_run', entityId: id, order: 'ASC', limit: 1000 });
      const recentEvents = this.audit.list({ order: 'ASC', limit: 1000 });
      const relatedIds = new Set(timeline.run.relatedActivityIds || []);
      const approvalId = timeline.run.approvalId || timeline.run.details?.approvalId;
      const delegationId = timeline.run.delegationId || timeline.run.details?.delegationId;
      const jobId = timeline.run.details?.jobId || timeline.run.details?.autopilotJobId;
      const budgetIncidentIds = new Set([
        timeline.run.budgetIncidentId,
        ...(timeline.run.details?.budgetIncidentIds || []),
      ].filter(Boolean));
      const includeEvent = (event) => {
        if (!event) return false;
        if (event.entityType === 'agent_run' && event.entityId === id) return true;
        if (relatedIds.has(Number(event.id))) return true;
        if (event.details?.agentRunId === id) return true;
        if (approvalId && event.entityType === 'approval' && event.entityId === approvalId) return true;
        if (delegationId && event.entityType === 'delegation' && event.entityId === delegationId) return true;
        if (jobId && event.entityType === 'autopilot_job' && event.entityId === jobId) return true;
        if (event.details?.approvalId && event.details.approvalId === approvalId) return true;
        if (event.details?.delegationId && event.details.delegationId === delegationId) return true;
        if (event.details?.jobId && event.details.jobId === jobId) return true;
        if (event.details?.budgetIncidentId && budgetIncidentIds.has(event.details.budgetIncidentId)) return true;
        return false;
      };
      const byId = new Map();
      for (const event of [...directEvents, ...recentEvents].filter(includeEvent)) byId.set(event.id, event);
      activityEvents.push(...[...byId.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)));
    }
    const snapshot = {
      exportedAt: new Date().toISOString(),
      ...timeline,
      relatedActivityIds: normalizeIdArray([
        ...(timeline.run.relatedActivityIds || []),
        ...activityEvents.map((event) => event.id),
      ]),
      activityEvents,
    };
    if (String(format || 'json').toLowerCase() === 'markdown' || String(format || '').toLowerCase() === 'md') {
      return formatAgentRunMarkdown(snapshot);
    }
    return snapshot;
  }

  recordMetricTurn(metric = {}) {
    if (!metric || typeof metric !== 'object') return null;
    const id = str(metric.agentRunId, 160) || stableMetricRunId(metric);
    const status = metric.success === false ? 'failed' : 'succeeded';
    const details = {
      latencyMs: metric.latencyMs,
      tokensIn: metric.tokensIn,
      tokensOut: metric.tokensOut,
      estCostUSD: metric.estCostUSD,
      diagnostics: metric.agentSkillDiagnostics || [],
      codeContextSignals: metric.agentCodeContextSignals || null,
      codeContextEvidenceCount: Array.isArray(metric.agentCodeContextEvidence) ? metric.agentCodeContextEvidence.length : 0,
      budgetIncidentId: metric.budgetIncidentId || null,
      budgetIncidentIds: Array.isArray(metric.budgetIncidentIds) ? metric.budgetIncidentIds : [],
      relatedActivityIds: Array.isArray(metric.budgetActivityIds) ? metric.budgetActivityIds : [],
    };
    let run = this.get(id);
    if (run) {
      run = this.transition(id, status, details);
    } else {
      run = this.create({
        id,
        status,
        roomId: metric.roomId,
        sessionId: metric.sessionId,
        taskId: metric.taskId,
        agentProfileId: metric.agentProfileId,
        agentProfileTitle: metric.agentProfileTitle,
        adapterId: metric.adapter,
        modelId: metric.model,
        turnId: metric.turn,
        sourceType: 'metric_turn',
        sourceId: `${metric.ts || ''}:${metric.adapter || ''}:${metric.turn || ''}`,
        skills: metric.agentSkillNames,
        dispatchTags: metric.agentDispatchTags,
        governance: metric.agentGovernance,
        budgetIncidentId: metric.budgetIncidentId || null,
        relatedActivityIds: Array.isArray(metric.budgetActivityIds) ? metric.budgetActivityIds : [],
        details,
        startedAt: metric.ts ? Date.parse(metric.ts) || nowMs() : nowMs(),
        finishedAt: metric.ts ? Date.parse(metric.ts) || nowMs() : nowMs(),
        error: metric.errorKind || null,
      });
    }
    this.appendMessage(run.id, {
      kind: 'metric',
      role: 'system',
      status: run.status,
      summary: `${metric.adapter || 'unknown'} ${metric.model || ''} turn ${metric.turn || ''}`.trim(),
      payload: {
        latencyMs: metric.latencyMs,
        tokensIn: metric.tokensIn,
        tokensOut: metric.tokensOut,
        estCostUSD: metric.estCostUSD,
        success: metric.success,
        errorKind: metric.errorKind,
      },
      createdAt: metric.ts ? Date.parse(metric.ts) || nowMs() : nowMs(),
    });
    return run;
  }
}

export const agentRunStore = new AgentRunStore();
