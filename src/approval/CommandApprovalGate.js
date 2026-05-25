import { approvalStore as defaultApprovalStore } from './ApprovalStore.js';
import { DangerousPatternDetector } from '../safety/DangerousPatternDetector.js';

function normalizeHits(hits = []) {
  return hits.map((h) => ({
    severity: h.rule?.severity,
    category: h.rule?.category,
    advice: h.rule?.advice,
    snippet: h.snippet,
  }));
}

export function createDangerousCommandApproval({
  command,
  detector = new DangerousPatternDetector(),
  approvalStore = defaultApprovalStore,
  guardLevel = 'standard',
  source = 'unknown',
  cwd = null,
  requesterType = null,
  requesterId = null,
  metadata = {},
} = {}) {
  const hits = detector.scan(command);
  if (!detector.shouldBlock(hits, guardLevel)) {
    return { requiresApproval: false, hits, approval: null, worstSeverity: detector.worstSeverity(hits) };
  }
  const worstSeverity = detector.worstSeverity(hits);
  const approval = approvalStore.createDangerousCommandApproval({
    command,
    hits: normalizeHits(hits),
    worstSeverity,
    source,
    cwd,
    requesterType,
    requesterId,
    metadata,
  });
  return { requiresApproval: true, hits, approval, worstSeverity };
}

function updateLineBuffer(buffer, data) {
  let next = buffer || '';
  for (const ch of String(data || '')) {
    if (ch === '\u0003') {
      next = '';
    } else if (ch === '\u007f' || ch === '\b') {
      next = next.slice(0, -1);
    } else if (ch !== '\r' && ch !== '\n') {
      next += ch;
      if (next.length > 8000) next = next.slice(-8000);
    }
  }
  return next;
}

export class TerminalApprovalGate {
  constructor({ detector = new DangerousPatternDetector(), approvalStore = defaultApprovalStore, guardLevel = 'standard' } = {}) {
    this.detector = detector;
    this.approvalStore = approvalStore;
    this.guardLevel = guardLevel;
  }

  inspectCommand(command, context = {}) {
    return createDangerousCommandApproval({
      command,
      detector: this.detector,
      approvalStore: this.approvalStore,
      guardLevel: context.guardLevel || this.guardLevel,
      source: context.source || 'terminal',
      cwd: context.cwd || null,
      requesterType: context.requesterType || 'terminal',
      requesterId: context.requesterId || null,
      metadata: context.metadata || {},
    });
  }

  processInput(state = {}, data = '', context = {}) {
    const incoming = String(data || '');
    const currentLine = updateLineBuffer(state.approvalInputBuffer || '', incoming);
    const hasEnter = incoming.includes('\r') || incoming.includes('\n');
    if (!hasEnter) {
      state.approvalInputBuffer = currentLine;
      return { allowed: true, data: incoming, approval: null, command: null };
    }

    const command = currentLine.trim();
    state.approvalInputBuffer = '';
    if (!command) return { allowed: true, data: incoming, approval: null, command };

    const result = this.inspectCommand(command, context);
    if (!result.requiresApproval) {
      return { allowed: true, data: incoming, approval: null, command, hits: result.hits };
    }
    return {
      allowed: false,
      data: '\u0003',
      approval: result.approval,
      command,
      hits: normalizeHits(result.hits),
      worstSeverity: result.worstSeverity,
    };
  }
}
