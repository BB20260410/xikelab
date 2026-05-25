import * as sqliteStore from '../storage/SqliteStore.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_STRING = 8000;
const MAX_ARRAY = 100;
const MAX_OBJECT_KEYS = 120;
const MAX_DEPTH = 5;
const SECRET_KEY_RE = /(?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)/i;

function normalizeTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function safeString(value, max = 512) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, max);
}

function sanitizeDetails(value, depth = 0, key = '') {
  if (SECRET_KEY_RE.test(key)) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}\n…(truncated ${value.length - MAX_STRING} chars)`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: typeof value.stack === 'string' ? value.stack.slice(0, MAX_STRING) : undefined,
    };
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((item) => sanitizeDetails(item, depth + 1, key));
    if (value.length > MAX_ARRAY) out.push(`…(${value.length - MAX_ARRAY} more items)`);
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    for (const [k, v] of entries) out[k] = sanitizeDetails(v, depth + 1, k);
    const skipped = Object.keys(value).length - entries.length;
    if (skipped > 0) out.__truncatedKeys = skipped;
    return out;
  }
  return String(value);
}

function normalizeActivityRow(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    action: payload.action || row.tag,
    tag: row.tag,
    roomId: row.roomId || row.room_id || payload.roomId || null,
    sessionId: row.sessionId || row.session_id || payload.sessionId || null,
    taskId: row.taskId || row.task_id || payload.taskId || null,
    actorType: payload.actorType || 'system',
    actorId: payload.actorId || null,
    entityType: row.entityType || row.entity_type || payload.entityType || null,
    entityId: row.entityId || row.entity_id || payload.entityId || null,
    severity: payload.severity || 'info',
    status: payload.status || null,
    details: payload.details || {},
  };
}

function collectValues(value, out = []) {
  if (value === null || value === undefined || value === '') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectValues(item, out);
    return out;
  }
  if (typeof value === 'object') {
    if (value.name) out.push(value.name);
    else if (value.id) out.push(value.id);
    return out;
  }
  out.push(value);
  return out;
}

function stringSet(values) {
  return new Set(collectValues(values).map((item) => String(item).trim()).filter(Boolean));
}

function activityAgentProfileIds(event) {
  const details = event.details || {};
  const ids = new Set();
  if (event.entityType === 'agent_profile' && event.entityId) ids.add(String(event.entityId));
  for (const value of [
    details.agentProfileId,
    details.profileId,
    details.agentProfile?.id,
    details.agent?.profileId,
  ]) {
    if (value) ids.add(String(value));
  }
  return ids;
}

function activitySkillNames(event) {
  const details = event.details || {};
  return stringSet([
    details.agentSkillNames,
    details.skillNames,
    details.skills,
    details.agentSkillBindings,
    details.skillBindings,
  ]);
}

function activityDiagnosticCodes(event) {
  const details = event.details || {};
  return stringSet([
    (details.diagnostics || []).map((item) => item?.code),
    (details.agentSkillDiagnostics || []).map((item) => item?.code),
    details.diagnosticCode,
  ]);
}

function hasAgentActivity(event) {
  const action = String(event.action || '');
  return action.startsWith('agent.')
    || activityAgentProfileIds(event).size > 0
    || activitySkillNames(event).size > 0
    || activityDiagnosticCodes(event).size > 0;
}

export class ActivityLog {
  constructor({ storage = sqliteStore, logger = console } = {}) {
    this.storage = storage;
    this.logger = logger;
  }

  record(input = {}) {
    const action = safeString(input.action, 160);
    if (!action) throw new Error('action required');

    const event = {
      action,
      actorType: safeString(input.actorType || 'system', 80) || 'system',
      actorId: safeString(input.actorId, 512),
      roomId: safeString(input.roomId, 512),
      sessionId: safeString(input.sessionId, 512),
      taskId: safeString(input.taskId, 512),
      entityType: safeString(input.entityType || 'unknown', 120) || 'unknown',
      entityId: safeString(input.entityId, 512),
      severity: safeString(input.severity || 'info', 40) || 'info',
      status: safeString(input.status, 80),
      details: sanitizeDetails(input.details || {}),
    };
    const ts = normalizeTs(input.ts ?? input.at);
    const id = this.storage.appendEvent({
      kind: 'activity',
      ts,
      roomId: event.roomId,
      sessionId: event.sessionId,
      tag: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      taskId: event.taskId,
      ...event,
    });
    return { id: Number(id), ts, ...event };
  }

  recordSafe(input = {}) {
    try {
      return this.record(input);
    } catch (e) {
      this.logger?.warn?.('[activity] record failed:', e?.message || e);
      return null;
    }
  }

  list(query = {}) {
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number(query.limit) || DEFAULT_LIMIT));
    const rows = this.storage.listEvents({
      kind: 'activity',
      roomId: safeString(query.roomId ?? query.room, 512) || undefined,
      sessionId: safeString(query.sessionId ?? query.session, 512) || undefined,
      tag: safeString(query.action ?? query.tag, 160) || undefined,
      entityType: safeString(query.entityType, 120) || undefined,
      entityId: safeString(query.entityId, 512) || undefined,
      taskId: safeString(query.taskId, 512) || undefined,
      sinceTs: query.sinceTs ?? query.since,
      untilTs: query.untilTs ?? query.until,
      limit,
      order: query.order === 'ASC' ? 'ASC' : 'DESC',
    });
    let events = rows.map(normalizeActivityRow);
    if (query.actorType) events = events.filter((e) => e.actorType === query.actorType);
    if (query.severity) events = events.filter((e) => e.severity === query.severity);
    if (query.status) events = events.filter((e) => e.status === query.status);
    if (query.agentOnly) events = events.filter(hasAgentActivity);
    if (query.agentProfileId) {
      const target = String(query.agentProfileId);
      events = events.filter((e) => activityAgentProfileIds(e).has(target));
    }
    if (query.skillName) {
      const target = String(query.skillName);
      events = events.filter((e) => activitySkillNames(e).has(target));
    }
    if (query.diagnosticCode) {
      const target = String(query.diagnosticCode);
      events = events.filter((e) => activityDiagnosticCodes(e).has(target));
    }
    return events;
  }
}

export const activityLog = new ActivityLog();
