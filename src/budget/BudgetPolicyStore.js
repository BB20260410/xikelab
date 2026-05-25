import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/SqliteStore.js';
import { activityLog } from '../audit/ActivityLog.js';

export const BUDGET_SCOPE_TYPES = new Set(['project', 'room', 'session', 'adapter', 'task']);
export const BUDGET_METRICS = new Set(['usd', 'tokens', 'calls']);
export const BUDGET_WINDOW_KINDS = new Set(['monthly', 'daily', 'all_time']);

export class BudgetLimitExceededError extends Error {
  constructor(message, { blocked = [] } = {}) {
    super(message);
    this.name = 'BudgetLimitExceededError';
    this.blocked = blocked;
    this.code = 'BUDGET_LIMIT_EXCEEDED';
  }
}

function nowMs() {
  return Date.now();
}

function normalizeTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return Math.trunc(ts);
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return nowMs();
}

function str(value, max = 512) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, max);
}

function normalizeScopeType(value) {
  const v = String(value || '').toLowerCase();
  if (!BUDGET_SCOPE_TYPES.has(v)) throw new Error(`invalid budget scope_type: ${value}`);
  return v;
}

function normalizeMetric(value) {
  const v = String(value || 'usd').toLowerCase();
  if (!BUDGET_METRICS.has(v)) throw new Error(`invalid budget metric: ${value}`);
  return v;
}

function normalizeWindowKind(value) {
  const v = String(value || 'monthly').toLowerCase();
  if (!BUDGET_WINDOW_KINDS.has(v)) throw new Error(`invalid budget window_kind: ${value}`);
  return v;
}

function startOfWindow(ts, windowKind) {
  if (windowKind === 'all_time') return 0;
  const d = new Date(ts);
  if (windowKind === 'daily') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function endOfWindow(ts, windowKind) {
  if (windowKind === 'all_time') return Number.MAX_SAFE_INTEGER;
  const start = startOfWindow(ts, windowKind);
  const d = new Date(start);
  if (windowKind === 'daily') return start + 24 * 60 * 60 * 1000;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function rowToPolicy(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    metric: row.metric,
    windowKind: row.window_kind,
    amount: Number(row.amount) || 0,
    warnPercent: Number(row.warn_percent) || 0.8,
    hardStopEnabled: row.hard_stop_enabled !== 0,
    notifyEnabled: row.notify_enabled !== 0,
    isActive: row.is_active !== 0,
    note: row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToIncident(row) {
  if (!row) return null;
  return {
    id: row.id,
    policyId: row.policy_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    metric: row.metric,
    windowKind: row.window_kind,
    windowStart: row.window_start,
    thresholdType: row.threshold_type,
    observedAmount: Number(row.observed_amount) || 0,
    limitAmount: Number(row.limit_amount) || 0,
    status: row.status,
    activityId: row.activity_id || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null,
  };
}

function normalizePolicyInput(input = {}, existing = {}) {
  const scopeType = normalizeScopeType(input.scopeType ?? input.scope_type ?? existing.scopeType);
  const scopeId = str(input.scopeId ?? input.scope_id ?? existing.scopeId);
  if (!scopeId) throw new Error('scopeId required');
  const metric = normalizeMetric(input.metric ?? existing.metric);
  const windowKind = normalizeWindowKind(input.windowKind ?? input.window_kind ?? existing.windowKind);
  const amount = Number(input.amount ?? existing.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be > 0');
  const warnPercentRaw = Number(input.warnPercent ?? input.warn_percent ?? existing.warnPercent ?? 0.8);
  const warnPercent = Math.max(0.01, Math.min(0.99, Number.isFinite(warnPercentRaw) ? warnPercentRaw : 0.8));
  return {
    scopeType,
    scopeId,
    metric,
    windowKind,
    amount,
    warnPercent,
    hardStopEnabled: input.hardStopEnabled ?? input.hard_stop_enabled ?? existing.hardStopEnabled ?? true,
    notifyEnabled: input.notifyEnabled ?? input.notify_enabled ?? existing.notifyEnabled ?? true,
    isActive: input.isActive ?? input.is_active ?? existing.isActive ?? true,
    note: str(input.note ?? existing.note ?? '', 2000) || '',
  };
}

function usageScopesFromMetric(summary = {}) {
  const scopes = [];
  const projectId = str(summary.projectId || summary.cwd);
  const roomId = str(summary.roomId);
  const sessionId = str(summary.sessionId);
  const adapterId = str(summary.adapter || summary.adapterId);
  const taskId = str(summary.taskId);
  if (projectId) scopes.push({ scopeType: 'project', scopeId: projectId });
  if (roomId) scopes.push({ scopeType: 'room', scopeId: roomId });
  if (sessionId) scopes.push({ scopeType: 'session', scopeId: sessionId });
  if (adapterId) scopes.push({ scopeType: 'adapter', scopeId: adapterId });
  if (taskId) scopes.push({ scopeType: 'task', scopeId: taskId });
  return scopes;
}

function metricAmounts(summary = {}) {
  const tokens = Math.max(0, Number(summary.tokensIn) || 0) + Math.max(0, Number(summary.tokensOut) || 0);
  return [
    { metric: 'usd', amount: Math.max(0, Number(summary.estCostUSD) || 0) },
    { metric: 'tokens', amount: tokens },
    { metric: 'calls', amount: 1 },
  ];
}

export class BudgetPolicyStore {
  constructor({ logger = console, audit = activityLog } = {}) {
    this.logger = logger;
    this.audit = audit;
  }

  db() {
    return getDb();
  }

  createPolicy(input = {}) {
    const now = nowMs();
    const p = normalizePolicyInput(input);
    const id = str(input.id, 160) || `budget-${randomUUID().slice(0, 12)}`;
    this.db().prepare(`
      INSERT INTO budget_policies(
        id, scope_type, scope_id, metric, window_kind, amount, warn_percent,
        hard_stop_enabled, notify_enabled, is_active, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_id, metric, window_kind) DO UPDATE SET
        amount = excluded.amount,
        warn_percent = excluded.warn_percent,
        hard_stop_enabled = excluded.hard_stop_enabled,
        notify_enabled = excluded.notify_enabled,
        is_active = excluded.is_active,
        note = excluded.note,
        updated_at = excluded.updated_at
    `).run(
      id,
      p.scopeType,
      p.scopeId,
      p.metric,
      p.windowKind,
      p.amount,
      p.warnPercent,
      p.hardStopEnabled ? 1 : 0,
      p.notifyEnabled ? 1 : 0,
      p.isActive ? 1 : 0,
      p.note,
      now,
      now
    );
    const policy = this.getPolicyByScope(p);
    this.audit.recordSafe({
      action: 'budget.policy_upserted',
      actorType: 'user',
      entityType: 'budget_policy',
      entityId: policy.id,
      status: policy.isActive ? 'active' : 'inactive',
      details: policy,
    });
    return policy;
  }

  getPolicy(id) {
    return rowToPolicy(this.db().prepare('SELECT * FROM budget_policies WHERE id = ?').get(id));
  }

  getPolicyByScope({ scopeType, scopeId, metric = 'usd', windowKind = 'monthly' }) {
    return rowToPolicy(this.db().prepare(`
      SELECT * FROM budget_policies
      WHERE scope_type = ? AND scope_id = ? AND metric = ? AND window_kind = ?
    `).get(scopeType, scopeId, metric, windowKind));
  }

  listPolicies({ scopeType, scopeId, metric, activeOnly = false, limit = 500 } = {}) {
    const where = [];
    const args = [];
    if (scopeType) { where.push('scope_type = ?'); args.push(normalizeScopeType(scopeType)); }
    if (scopeId) { where.push('scope_id = ?'); args.push(scopeId); }
    if (metric) { where.push('metric = ?'); args.push(normalizeMetric(metric)); }
    if (activeOnly) where.push('is_active = 1');
    args.push(Math.max(1, Math.min(1000, Number(limit) || 500)));
    return this.db().prepare(`
      SELECT * FROM budget_policies
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...args).map(rowToPolicy);
  }

  updatePolicy(id, patch = {}) {
    const current = this.getPolicy(id);
    if (!current) return null;
    const p = normalizePolicyInput(patch, current);
    const now = nowMs();
    this.db().prepare(`
      UPDATE budget_policies SET
        scope_type = ?, scope_id = ?, metric = ?, window_kind = ?, amount = ?,
        warn_percent = ?, hard_stop_enabled = ?, notify_enabled = ?, is_active = ?,
        note = ?, updated_at = ?
      WHERE id = ?
    `).run(
      p.scopeType,
      p.scopeId,
      p.metric,
      p.windowKind,
      p.amount,
      p.warnPercent,
      p.hardStopEnabled ? 1 : 0,
      p.notifyEnabled ? 1 : 0,
      p.isActive ? 1 : 0,
      p.note,
      now,
      id
    );
    const policy = this.getPolicy(id);
    this.audit.recordSafe({
      action: 'budget.policy_updated',
      actorType: 'user',
      entityType: 'budget_policy',
      entityId: id,
      status: policy?.isActive ? 'active' : 'inactive',
      details: policy,
    });
    return policy;
  }

  deletePolicy(id) {
    const policy = this.getPolicy(id);
    if (!policy) return false;
    this.db().prepare('DELETE FROM budget_policies WHERE id = ?').run(id);
    this.audit.recordSafe({
      action: 'budget.policy_deleted',
      actorType: 'user',
      entityType: 'budget_policy',
      entityId: id,
      status: 'deleted',
      details: policy,
    });
    return true;
  }

  recordMetric(summary = {}) {
    const scopes = usageScopesFromMetric(summary);
    const amounts = metricAmounts(summary).filter((m) => m.amount > 0 || m.metric === 'calls');
    const ts = normalizeTs(summary.ts);
    const inserted = [];
    const db = this.db();
    const stmt = db.prepare(`
      INSERT INTO budget_usage(
        ts, scope_type, scope_id, metric, amount, source,
        room_id, session_id, task_id, adapter_id, project_id, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const payload = {
      roomMode: summary.roomMode || null,
      roomName: summary.roomName || null,
      turn: summary.turn || null,
      model: summary.model || null,
      success: summary.success !== false,
      errorKind: summary.errorKind || null,
    };
    for (const scope of scopes) {
      for (const metric of amounts) {
        const info = {
          ts,
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          metric: metric.metric,
          amount: metric.amount,
          source: 'metrics.recorded',
          roomId: str(summary.roomId),
          sessionId: str(summary.sessionId),
          taskId: str(summary.taskId),
          adapterId: str(summary.adapter || summary.adapterId),
          projectId: str(summary.projectId || summary.cwd),
          payload,
        };
        const result = stmt.run(
          info.ts,
          info.scopeType,
          info.scopeId,
          info.metric,
          info.amount,
          info.source,
          info.roomId,
          info.sessionId,
          info.taskId,
          info.adapterId,
          info.projectId,
          JSON.stringify(info.payload)
        );
        inserted.push({ id: Number(result.lastInsertRowid), ...info });
      }
    }
    const checks = [];
    for (const scope of scopes) {
      for (const metric of amounts) {
        checks.push(this.checkScope({
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          metric: metric.metric,
          estimateAmount: 0,
          ts,
          source: 'metrics.recorded',
          details: payload,
        }));
      }
    }
    return {
      usageCount: inserted.length,
      inserted,
      incidents: checks.flatMap((c) => c.incidents),
      blocked: checks.flatMap((c) => c.blocked),
      warnings: checks.flatMap((c) => c.warnings),
    };
  }

  preflight(context = {}) {
    const summary = {
      projectId: context.projectId || context.cwd,
      roomId: context.roomId,
      sessionId: context.sessionId,
      adapter: context.adapterId || context.adapter,
      taskId: context.taskId,
      estCostUSD: Math.max(0, Number(context.estimateUSD) || 0),
      tokensIn: Math.max(0, Number(context.estimateTokens) || 0),
      tokensOut: 0,
    };
    const scopes = usageScopesFromMetric(summary);
    const estimates = [
      { metric: 'usd', amount: summary.estCostUSD },
      { metric: 'tokens', amount: summary.tokensIn },
      { metric: 'calls', amount: Number(context.estimateCalls) >= 0 ? Number(context.estimateCalls) : 1 },
    ];
    const checks = [];
    const ts = normalizeTs(context.ts);
    for (const scope of scopes) {
      for (const estimate of estimates) {
        checks.push(this.checkScope({
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          metric: estimate.metric,
          estimateAmount: estimate.amount,
          ts,
          source: 'preflight',
          details: { adapterId: summary.adapter, roomId: summary.roomId, taskId: summary.taskId },
        }));
      }
    }
    const blocked = checks.flatMap((c) => c.blocked);
    const warnings = checks.flatMap((c) => c.warnings);
    if (blocked.length > 0) {
      throw new BudgetLimitExceededError(
        `预算已达上限：${blocked.map((b) => `${b.scopeType}:${b.scopeId}/${b.metric}`).join(', ')}`,
        { blocked }
      );
    }
    return { ok: true, blocked, warnings, checks };
  }

  checkScope({ scopeType, scopeId, metric = 'usd', estimateAmount = 0, ts = nowMs(), source = 'manual', details = {} } = {}) {
    const normalizedScopeType = normalizeScopeType(scopeType);
    const normalizedMetric = normalizeMetric(metric);
    const normalizedScopeId = str(scopeId);
    if (!normalizedScopeId) throw new Error('scopeId required');
    const policies = this.listPolicies({
      scopeType: normalizedScopeType,
      scopeId: normalizedScopeId,
      metric: normalizedMetric,
      activeOnly: true,
    });
    const incidents = [];
    const warnings = [];
    const blocked = [];
    for (const policy of policies) {
      const observed = this.usageForPolicy(policy, ts);
      const projected = observed + Math.max(0, Number(estimateAmount) || 0);
      const warnLimit = policy.amount * policy.warnPercent;
      const hardStopReached = source === 'preflight'
        ? (observed >= policy.amount || projected > policy.amount)
        : projected >= policy.amount;
      if (policy.notifyEnabled && projected >= warnLimit && !hardStopReached) {
        const incident = this.ensureIncident({
          policy,
          thresholdType: 'warning',
          observedAmount: projected,
          ts,
          source,
          details,
        });
        if (incident) {
          incidents.push(incident);
          warnings.push({ ...policy, observedAmount: projected, incident });
        }
      }
      if (hardStopReached) {
        const incident = this.ensureIncident({
          policy,
          thresholdType: 'hard_stop',
          observedAmount: projected,
          ts,
          source,
          details,
        });
        if (incident) incidents.push(incident);
        const blockedItem = { ...policy, observedAmount: projected, incident: incident || null };
        if (policy.hardStopEnabled) blocked.push(blockedItem);
        else warnings.push(blockedItem);
      }
    }
    return { ok: blocked.length === 0, scopeType: normalizedScopeType, scopeId: normalizedScopeId, metric: normalizedMetric, incidents, warnings, blocked };
  }

  usageForPolicy(policy, ts = nowMs()) {
    const start = startOfWindow(ts, policy.windowKind);
    const end = endOfWindow(ts, policy.windowKind);
    const row = this.db().prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount FROM budget_usage
      WHERE scope_type = ? AND scope_id = ? AND metric = ? AND ts >= ? AND ts < ?
    `).get(policy.scopeType, policy.scopeId, policy.metric, start, end);
    return Number(row?.amount) || 0;
  }

  listUsage({ scopeType, scopeId, metric = 'usd', windowKind = 'monthly', ts = nowMs() } = {}) {
    const p = {
      scopeType: normalizeScopeType(scopeType),
      scopeId: str(scopeId),
      metric: normalizeMetric(metric),
      windowKind: normalizeWindowKind(windowKind),
    };
    if (!p.scopeId) throw new Error('scopeId required');
    const start = startOfWindow(normalizeTs(ts), p.windowKind);
    const end = endOfWindow(normalizeTs(ts), p.windowKind);
    const amount = Number(this.db().prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount FROM budget_usage
      WHERE scope_type = ? AND scope_id = ? AND metric = ? AND ts >= ? AND ts < ?
    `).get(p.scopeType, p.scopeId, p.metric, start, end)?.amount) || 0;
    return { ...p, windowStart: start, windowEnd: end, amount };
  }

  ensureIncident({ policy, thresholdType, observedAmount, ts = nowMs(), source = 'manual', details = {} } = {}) {
    const windowStart = startOfWindow(ts, policy.windowKind);
    const existing = this.db().prepare(`
      SELECT * FROM budget_incidents
      WHERE policy_id = ? AND window_start = ? AND threshold_type = ? AND status = 'open'
      ORDER BY created_at DESC LIMIT 1
    `).get(policy.id, windowStart, thresholdType);
    if (existing) return rowToIncident(existing);

    const id = `budget-incident-${randomUUID().slice(0, 12)}`;
    const activity = this.audit.recordSafe({
      action: thresholdType === 'hard_stop' ? 'budget.hard_stop' : 'budget.warning',
      actorType: 'system',
      entityType: 'budget_policy',
      entityId: policy.id,
      severity: thresholdType === 'hard_stop' ? 'error' : 'warn',
      status: 'open',
      details: {
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        metric: policy.metric,
        windowKind: policy.windowKind,
        thresholdType,
        observedAmount,
        limitAmount: policy.amount,
        source,
        ...details,
      },
    });
    this.db().prepare(`
      INSERT INTO budget_incidents(
        id, policy_id, scope_type, scope_id, metric, window_kind, window_start,
        threshold_type, observed_amount, limit_amount, status, activity_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      id,
      policy.id,
      policy.scopeType,
      policy.scopeId,
      policy.metric,
      policy.windowKind,
      windowStart,
      thresholdType,
      observedAmount,
      policy.amount,
      activity?.id || null,
      nowMs()
    );
    return this.getIncident(id);
  }

  getIncident(id) {
    return rowToIncident(this.db().prepare('SELECT * FROM budget_incidents WHERE id = ?').get(id));
  }

  listIncidents({ scopeType, scopeId, status, thresholdType, limit = 500 } = {}) {
    const where = [];
    const args = [];
    if (scopeType) { where.push('scope_type = ?'); args.push(normalizeScopeType(scopeType)); }
    if (scopeId) { where.push('scope_id = ?'); args.push(scopeId); }
    if (status) { where.push('status = ?'); args.push(status); }
    if (thresholdType) { where.push('threshold_type = ?'); args.push(thresholdType); }
    args.push(Math.max(1, Math.min(1000, Number(limit) || 500)));
    return this.db().prepare(`
      SELECT * FROM budget_incidents
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...args).map(rowToIncident);
  }

  resolveIncident(id) {
    const incident = this.getIncident(id);
    if (!incident) return null;
    this.db().prepare(`
      UPDATE budget_incidents SET status = 'resolved', resolved_at = ? WHERE id = ?
    `).run(nowMs(), id);
    const updated = this.getIncident(id);
    this.audit.recordSafe({
      action: 'budget.incident_resolved',
      actorType: 'user',
      entityType: 'budget_incident',
      entityId: id,
      status: 'resolved',
      details: updated,
    });
    return updated;
  }
}

export const budgetPolicyStore = new BudgetPolicyStore();
