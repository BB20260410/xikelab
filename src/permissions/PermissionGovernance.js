import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { approvalStore as defaultApprovalStore } from '../approval/ApprovalStore.js';
import { activityLog as defaultActivityLog } from '../audit/ActivityLog.js';
import { agentRunStore as defaultAgentRunStore } from '../agents/AgentRunStore.js';
import { DangerousPatternDetector } from '../safety/DangerousPatternDetector.js';

const DECISIONS = new Set(['allow', 'ask', 'deny']);
const MAX_TEXT = 1000;

function nowMs() {
  return Date.now();
}

function safeString(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return {};
  try { return JSON.parse(JSON.stringify(value)); } catch { return {}; }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

function hashParts(parts = []) {
  return createHash('sha256').update(parts.map(part => safeString(part, 2000)).join('\n---\n')).digest('hex').slice(0, 32);
}

function normalizePathLike(value) {
  const text = safeString(value, 2000);
  if (!text || text.includes('\0')) return '';
  return text;
}

function pathInside(base, target) {
  if (!base || !target) return true;
  const root = resolve(base);
  const next = resolve(root, target);
  return next === root || next.startsWith(root + '/');
}

function hostnameFromUrl(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

function isPrivateHost(host = '') {
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === '::1' || host === '[::1]') return true;
  return false;
}

function approvalMatchesActionTarget(approval, { action, target }) {
  const payload = approval?.payload || {};
  return safeString(payload.action, 160) === action && stableJson(safeJson(payload.target)) === stableJson(safeJson(target));
}

export class PermissionPolicy {
  constructor(input = {}) {
    this.shell = input.shell || 'ask_dangerous';
    this.fileWriteDelete = input.fileWriteDelete || 'ask_external_or_sensitive';
    this.externalDirectory = input.externalDirectory || 'ask';
    this.skillPlugin = input.skillPlugin || 'ask';
    this.providerModelConfig = input.providerModelConfig || 'ask';
    this.networkUpload = input.networkUpload || 'ask_public_deny_private';
    this.autoAccept = input.autoAccept || 'low_risk_only';
  }
}

export class PermissionDecision {
  constructor(input = {}) {
    const decision = safeString(input.decision || 'allow', 20);
    if (!DECISIONS.has(decision)) throw new Error(`invalid permission decision: ${decision}`);
    this.id = input.id || `permission-${randomUUID().slice(0, 12)}`;
    this.decision = decision;
    this.reason = safeString(input.reason || decision, 500);
    this.action = safeString(input.action, 160);
    this.actorType = safeString(input.actorType || 'system', 80);
    this.actorId = safeString(input.actorId, 160) || null;
    this.agentRunId = safeString(input.agentRunId, 160) || null;
    this.roomId = safeString(input.roomId, 160) || null;
    this.sessionId = safeString(input.sessionId, 160) || null;
    this.cwd = safeString(input.cwd, 2000) || null;
    this.risk = safeString(input.risk || 'low', 40);
    this.target = safeJson(input.target);
    this.details = safeJson(input.details);
    this.approvalPayload = input.approvalPayload ? safeJson(input.approvalPayload) : null;
    this.approval = input.approval || null;
    this.createdAt = Number(input.createdAt) || nowMs();
  }
}

export class ToolInvocationRecord {
  constructor(input = {}) {
    this.id = input.id || `tool-invocation-${randomUUID().slice(0, 12)}`;
    this.action = safeString(input.action, 160);
    this.toolName = safeString(input.toolName || input.action, 160);
    this.actorType = safeString(input.actorType || 'system', 80);
    this.actorId = safeString(input.actorId, 160) || null;
    this.agentRunId = safeString(input.agentRunId, 160) || null;
    this.roomId = safeString(input.roomId, 160) || null;
    this.sessionId = safeString(input.sessionId, 160) || null;
    this.cwd = safeString(input.cwd, 2000) || null;
    this.target = safeJson(input.target);
    this.permissionDecisionId = safeString(input.permissionDecisionId, 160) || null;
    this.status = safeString(input.status || 'planned', 40);
    this.createdAt = Number(input.createdAt) || nowMs();
  }
}

export class PermissionGovernance {
  constructor({
    policy = new PermissionPolicy(),
    approvalStore = defaultApprovalStore,
    audit = defaultActivityLog,
    agentRuns = defaultAgentRunStore,
    detector = new DangerousPatternDetector(),
  } = {}) {
    this.policy = policy instanceof PermissionPolicy ? policy : new PermissionPolicy(policy);
    this.approvalStore = approvalStore;
    this.audit = audit;
    this.agentRuns = agentRuns;
    this.detector = detector;
  }

  evaluatePermission(input = {}) {
    const action = safeString(input.action, 160);
    const target = safeJson(input.target);
    const approvalId = safeString(input.approvalId || input.permissionApprovalId || input.resumeApprovalId, 160);
    const context = {
      actorType: safeString(input.actorType || 'system', 80),
      actorId: safeString(input.actorId || input.requesterId, 160),
      agentRunId: safeString(input.agentRunId, 160),
      roomId: safeString(input.roomId, 160),
      sessionId: safeString(input.sessionId, 160),
      taskId: safeString(input.taskId, 240),
      cwd: safeString(input.cwd, 2000),
      risk: safeString(input.risk || 'low', 40),
    };
    let decision = this.classify({ ...context, action, target, details: input.details || {} });
    if (decision.decision === 'ask' && approvalId) {
      decision = this.resolveResumeApproval({ approvalId, action, target, decision });
    }
    if (decision.decision === 'ask') {
      const approvalPayload = this.buildApprovalPayload({ ...context, action, target, decision, details: input.details || {} });
      const approval = decision.approval || this.createApproval({ ...context, action, target, decision, approvalPayload });
      decision = { ...decision, approvalPayload, approval };
    }
    const finalDecision = new PermissionDecision({ ...context, action, target, ...decision });
    const invocation = new ToolInvocationRecord({
      ...context,
      action,
      toolName: target.toolName || target.pluginId || target.type || action,
      target,
      permissionDecisionId: finalDecision.id,
      status: finalDecision.decision,
    });
    this.recordDecision(finalDecision, invocation);
    return { ...finalDecision, invocation };
  }

  resolveResumeApproval({ approvalId, action, target, decision }) {
    const approval = this.approvalStore?.getApproval?.(approvalId);
    if (!approval) {
      return {
        decision: 'deny',
        reason: 'approval not found for permission resume',
        risk: 'high',
        details: { resumeApprovalId: approvalId },
      };
    }
    if (!approvalMatchesActionTarget(approval, { action, target })) {
      return {
        decision: 'deny',
        reason: 'approval does not match permission action/target',
        risk: 'high',
        approval,
        approvalPayload: approval.payload || null,
        details: { resumeApprovalId: approvalId, approvalStatus: approval.status || null },
      };
    }
    if (approval.status === 'approved') {
      return {
        decision: 'allow',
        reason: 'approved permission resumed',
        risk: decision.risk || 'high',
        approval,
        approvalPayload: approval.payload || null,
        details: {
          ...(decision.details || {}),
          resumeApprovalId: approvalId,
          approvalStatus: approval.status,
          resumed: true,
        },
      };
    }
    if (approval.status === 'pending') {
      return {
        ...decision,
        approval,
        approvalPayload: approval.payload || null,
        reason: 'approval is still pending',
        details: {
          ...(decision.details || {}),
          resumeApprovalId: approvalId,
          approvalStatus: approval.status,
        },
      };
    }
    return {
      decision: 'deny',
      reason: `approval ${approval.status || 'closed'}; permission resume denied`,
      risk: 'high',
      approval,
      approvalPayload: approval.payload || null,
      details: { resumeApprovalId: approvalId, approvalStatus: approval.status || null },
    };
  }

  classify({ action, target, cwd, risk }) {
    if (action.startsWith('shell.')) {
      const command = safeString(target.command, 4000);
      const hits = this.detector.scan(command);
      const worstSeverity = this.detector.worstSeverity(hits);
      if (this.detector.shouldBlock(hits, target.guardLevel || 'standard')) {
        return {
          decision: 'ask',
          reason: `shell command requires approval: ${worstSeverity || 'dangerous'}`,
          risk: worstSeverity || 'high',
          details: { hits },
        };
      }
      return { decision: 'allow', reason: hits.length ? 'shell command has low-risk warnings' : 'shell command allowed', risk: worstSeverity || risk || 'low' };
    }

    if (action === 'file.write' || action === 'file.delete') {
      const path = normalizePathLike(target.path || target.filePath);
      if (!path) return { decision: 'deny', reason: 'file target path missing', risk: 'high' };
      if (/(^|\/)(\.ssh|\.aws|\.gnupg|\.docker|\.kube)(\/|$)/.test(path) || /(^|\/)\.env(\.|$|\/)?/.test(path)) {
        return { decision: 'ask', reason: 'sensitive file write/delete requires approval', risk: 'high' };
      }
      if (cwd && !pathInside(cwd, path)) {
        return { decision: 'ask', reason: 'external directory file write/delete requires approval', risk: 'high' };
      }
      return { decision: 'allow', reason: 'project-local file operation allowed', risk: risk || 'medium' };
    }

    if (action === 'external_directory.access') {
      const path = normalizePathLike(target.path || target.cwd);
      if (!path) return { decision: 'deny', reason: 'external directory path missing', risk: 'high' };
      if (/(^|\/)(\.ssh|\.aws|\.gnupg|\.docker|\.kube)(\/|$)/.test(path)) return { decision: 'deny', reason: 'sensitive directory denied', risk: 'critical' };
      if (/(^|\/)\.env(\.|$|\/)?/.test(path)) return { decision: 'ask', reason: 'sensitive file access requires approval', risk: 'high' };
      if (cwd && !pathInside(cwd, path)) return { decision: 'ask', reason: 'external directory requires approval', risk: 'high' };
      return { decision: 'allow', reason: 'directory is within cwd', risk: risk || 'low' };
    }

    if (action === 'skill.plugin.execute' || action === 'skill.plugin.configure') {
      return { decision: 'ask', reason: `${action} requires owner approval`, risk: risk || 'high' };
    }

    if (action === 'provider.model_config.write' || action === 'provider.model_config.access') {
      return { decision: 'ask', reason: 'provider/model configuration requires approval', risk: risk || 'high' };
    }

    if (action === 'network.upload') {
      const url = safeString(target.url, 2000);
      const host = hostnameFromUrl(url);
      if (!/^https?:\/\//i.test(url)) return { decision: 'deny', reason: 'network upload URL must be http(s)', risk: 'high' };
      if (isPrivateHost(host)) return { decision: 'deny', reason: 'network upload to private/loopback host denied', risk: 'critical' };
      return { decision: 'ask', reason: 'network upload requires approval', risk: risk || 'high' };
    }

    if (action === 'auto_accept.scope') {
      return risk === 'low'
        ? { decision: 'allow', reason: 'low-risk auto-accept scope allowed', risk }
        : { decision: 'ask', reason: 'auto-accept scope requires approval', risk: risk || 'high' };
    }

    return risk === 'high' || risk === 'critical'
      ? { decision: 'ask', reason: `${action || 'action'} requires approval by risk`, risk }
      : { decision: 'allow', reason: `${action || 'action'} allowed`, risk: risk || 'low' };
  }

  buildApprovalPayload({ action, target, actorType, actorId, agentRunId, roomId, sessionId, cwd, decision, details }) {
    return {
      title: `Permission approval: ${action}`,
      action,
      target,
      actorType,
      actorId: actorId || null,
      agentRunId: agentRunId || null,
      roomId: roomId || null,
      sessionId: sessionId || null,
      cwd: cwd || null,
      risk: decision.risk || 'high',
      reason: decision.reason,
      details: {
        request: safeJson(details),
        classification: safeJson(decision.details),
      },
    };
  }

  createApproval({ action, target, actorType, actorId, agentRunId, roomId, sessionId, cwd, approvalPayload }) {
    const dedupeKey = hashParts(['permission', action, actorType, actorId, agentRunId, roomId, sessionId, cwd, stableJson(target)]);
    return this.approvalStore?.createApproval?.({
      type: 'manual',
      requesterType: actorType || 'system',
      requesterId: actorId || agentRunId || roomId || sessionId || action,
      dedupeKey,
      payload: approvalPayload,
    }) || null;
  }

  recordDecision(decision, invocation) {
    const severity = decision.decision === 'deny' ? 'error' : decision.decision === 'ask' ? 'warn' : 'info';
    this.audit?.recordSafe?.({
      action: 'permission.decision',
      actorType: decision.actorType,
      actorId: decision.actorId,
      roomId: decision.roomId,
      sessionId: decision.sessionId,
      entityType: 'permission_decision',
      entityId: decision.id,
      status: decision.decision,
      severity,
      details: {
        decision,
        invocation,
        approvalId: decision.approval?.id || null,
        agentRunId: decision.agentRunId || null,
      },
    });
    if (decision.agentRunId && this.agentRuns?.appendMessage) {
      try {
        this.agentRuns.appendMessage(decision.agentRunId, {
          kind: 'decision',
          role: 'system',
          status: decision.decision,
          summary: `permission ${decision.decision}: ${decision.action}`,
          payload: {
            permissionDecisionId: decision.id,
            reason: decision.reason,
            approvalId: decision.approval?.id || null,
            invocation,
          },
        });
      } catch {}
    }
  }
}

export const permissionGovernance = new PermissionGovernance();

export function evaluatePermission(input = {}, deps = {}) {
  return new PermissionGovernance(deps).evaluatePermission(input);
}

export function permissionHttpStatus(decision) {
  return decision?.decision === 'deny' ? 403 : 202;
}

export function permissionHttpError(decision) {
  return decision?.decision === 'deny' ? 'permission_denied' : 'approval_required';
}

export function permissionHttpBody(decision) {
  return {
    ok: false,
    error: permissionHttpError(decision),
    approval: decision?.approval || null,
    approvalId: decision?.approval?.id || null,
    permissionDecision: decision || null,
  };
}

export function permissionApprovalIdFromRequest(req) {
  const header = req?.get?.('X-Panel-Approval-Id') || req?.headers?.['x-panel-approval-id'];
  return safeString(
    req?.body?.approvalId ||
      req?.body?.permissionApprovalId ||
      req?.query?.approvalId ||
      req?.query?.permissionApprovalId ||
      header,
    160
  );
}
