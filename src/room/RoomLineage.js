import { randomUUID } from 'node:crypto';

const MAX_TITLE = 200;
const MAX_TEXT = 2000;
const MAX_CRITERIA = 20;
const MAX_ID = 200;

function safeString(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function safeId(value, fallbackPrefix = '') {
  const s = safeString(value, MAX_ID);
  if (s) return s;
  return fallbackPrefix ? `${fallbackPrefix}-${randomUUID().slice(0, 8)}` : '';
}

export function sanitizeObjective(input, { fallbackTitle = '' } = {}) {
  if (input === undefined || input === null || input === '') return null;
  const obj = typeof input === 'string' ? { title: input } : input;
  if (!obj || typeof obj !== 'object') return null;
  const title = safeString(obj.title || fallbackTitle, MAX_TITLE);
  const description = safeString(obj.description, MAX_TEXT);
  const acceptanceCriteria = Array.isArray(obj.acceptanceCriteria)
    ? obj.acceptanceCriteria.map((item) => safeString(item, 500)).filter(Boolean).slice(0, MAX_CRITERIA)
    : [];
  if (!title && !description && acceptanceCriteria.length === 0) return null;
  return {
    id: safeId(obj.id, 'obj'),
    title: title || '未命名目标',
    description,
    acceptanceCriteria,
    status: ['active', 'done', 'paused', 'cancelled'].includes(obj.status) ? obj.status : 'active',
    createdAt: safeString(obj.createdAt, 80) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function sanitizeLineage(input, { projectId = '', parentRoomId = null, parentTaskId = null } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const clean = {
    projectId: safeString(src.projectId || projectId, 1024),
    parentRoomId: safeString(src.parentRoomId || parentRoomId, MAX_ID) || null,
    parentTaskId: safeString(src.parentTaskId || parentTaskId, MAX_ID) || null,
    taskId: safeString(src.taskId, MAX_ID) || null,
    objectiveId: safeString(src.objectiveId, MAX_ID) || null,
    source: safeString(src.source || 'manual', 80) || 'manual',
    createdAt: safeString(src.createdAt, 80) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return clean;
}

export function objectiveSummary(objective) {
  if (!objective) return null;
  return {
    id: objective.id,
    title: objective.title,
    status: objective.status || 'active',
    acceptanceCount: Array.isArray(objective.acceptanceCriteria) ? objective.acceptanceCriteria.length : 0,
  };
}
