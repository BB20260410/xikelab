import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { activityLog } from '../audit/ActivityLog.js';
import { getDb } from '../storage/SqliteStore.js';

export const AGENT_RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'deferred']);
export const AGENT_MESSAGE_KINDS = new Set(['message', 'tool_call', 'tool_result', 'metric', 'decision', 'summary', 'work_plan', 'manifest_draft', 'replay_plan', 'replay_result', 'archive']);
const FINISHED_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const ARCHIVE_ARTIFACT_DOWNLOAD_ROOTS = [
  'output/playwright/session-evidence',
  'output/playwright/gate-audit-reports',
];

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

function normalizeArtifactRelPath(value) {
  const text = str(value, 2000);
  if (!text || text.includes('\0')) return null;
  const normalized = text.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

function artifactPathDownloadRoot(path) {
  const relPath = normalizeArtifactRelPath(path);
  if (!relPath) return null;
  return ARCHIVE_ARTIFACT_DOWNLOAD_ROOTS.find((root) => relPath === root || relPath.startsWith(`${root}/`)) || null;
}

function archiveArtifactId(runId, archiveId, artifact = {}) {
  const source = [
    runId || '',
    archiveId || '',
    artifact.kind || '',
    artifact.path || '',
    artifact.sha256 || '',
  ].join('|');
  return `artifact-${createHash('sha1').update(source).digest('hex').slice(0, 16)}`;
}

function normalizeArchiveArtifact(raw, { archive = {}, runId = '', source = 'evidenceArtifacts' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const relPath = normalizeArtifactRelPath(raw.path);
  if (!relPath) return null;
  const resolvedRunId = str(raw.runId || archive.runId || runId, 160);
  const normalized = {
    runId: resolvedRunId,
    archiveId: str(archive.id, 160),
    messageId: str(archive.messageId, 160),
    kind: str(raw.kind, 120) || 'archive_artifact',
    label: str(raw.label, 240) || relPath,
    path: relPath,
    exists: raw.exists !== false,
    size: Math.max(0, Number(raw.size) || 0),
    sha256: str(raw.sha256, 128),
    sessionId: str(raw.sessionId || archive.source?.sessionId, 160),
    gateId: str(raw.gateId || raw.approvalResumeGateId, 160),
    reportId: str(raw.reportId, 160),
    evidenceChainId: str(raw.evidenceChainId, 160),
    latestRunId: str(raw.latestRunId, 160),
    verified: raw.verified === undefined ? null : Boolean(raw.verified),
    createdAt: str(archive.createdAt, 80),
    source,
    downloadable: Boolean(artifactPathDownloadRoot(relPath)),
  };
  normalized.id = archiveArtifactId(resolvedRunId, normalized.archiveId, normalized);
  return normalized;
}

function archiveArtifactEntries(archive = {}) {
  const external = archive.evidence?.external || {};
  const entries = [];
  for (const artifact of Array.isArray(external.evidenceArtifacts) ? external.evidenceArtifacts : []) {
    entries.push({ source: 'evidenceArtifacts', artifact });
  }
  if (external.sessionEvidenceArtifact) {
    entries.push({ source: 'sessionEvidenceArtifact', artifact: external.sessionEvidenceArtifact });
  }
  if (external.gateAuditReportArtifact) {
    entries.push({ source: 'gateAuditReportArtifact', artifact: external.gateAuditReportArtifact });
  }
  return entries;
}

function collectArchiveArtifacts(archives = [], runId = '') {
  const out = [];
  const seen = new Set();
  for (const archive of archives || []) {
    for (const entry of archiveArtifactEntries(archive)) {
      const artifact = normalizeArchiveArtifact(entry.artifact, { archive, runId, source: entry.source });
      if (!artifact) continue;
      const key = `${artifact.path}:${artifact.sha256 || artifact.kind}:${artifact.archiveId || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(artifact);
    }
  }
  return out;
}

function filterArtifacts(artifacts = [], filters = {}) {
  const sessionId = str(filters.sessionId || filters.session, 160);
  const gateId = str(filters.gateId || filters.approvalResumeGateId || filters.reviewGateId, 160);
  const kind = str(filters.kind, 120);
  return artifacts.filter((artifact) => {
    if (sessionId && artifact.sessionId !== sessionId) return false;
    if (gateId && artifact.gateId !== gateId) return false;
    if (kind && artifact.kind !== kind) return false;
    return true;
  });
}

function archiveArtifactActivitySummary(artifacts = []) {
  return artifacts.slice(0, 12).map((artifact) => ({
    id: artifact.id,
    runId: artifact.runId,
    archiveId: artifact.archiveId,
    kind: artifact.kind,
    label: artifact.label,
    path: artifact.path,
    size: artifact.size,
    sha256: artifact.sha256,
    sessionId: artifact.sessionId,
    gateId: artifact.gateId,
    downloadable: artifact.downloadable,
  }));
}

function normalizeCodebaseQuestionAnswer(input = {}) {
  const candidate = input?.codebaseQuestionAnswer || input?.questionAnswer || input;
  if (!candidate || typeof candidate !== 'object') return null;
  const citations = Array.isArray(candidate.citations) ? candidate.citations.slice(0, 6).map((item, index) => {
    const id = str(item.id, 20) || `C${index + 1}`;
    const path = str(item.path, 300);
    const line = Math.max(1, Number(item.line) || 1);
    const label = str(item.label, 340) || (path ? `${path}:${line}` : id);
    return {
      id,
      path,
      line,
      label,
      kind: str(item.kind, 100) || 'file',
      anchor: str(item.anchor, 180),
      parser: str(item.parser, 80) || 'unknown',
      score: Number(item.score || 0),
      semanticScore: Number.isFinite(Number(item.semanticScore)) ? Number(item.semanticScore) : null,
      reasons: normalizeArray(item.reasons || []).slice(0, 4),
      snippet: str(item.snippet, 260),
      evidenceCount: Math.max(0, Number(item.evidenceCount) || 0),
      graphReferenceCount: Math.max(0, Number(item.graphReferenceCount) || 0),
      routeUsageCount: Math.max(0, Number(item.routeUsageCount) || 0),
    };
  }).filter((item) => item.path || item.label) : [];
  const question = str(candidate.question, 500);
  const answer = str(candidate.answer, 1200);
  if (!question && !answer && citations.length === 0) return null;
  const coverage = candidate.coverage && typeof candidate.coverage === 'object' ? candidate.coverage : {};
  return {
    ok: candidate.ok !== false,
    mode: str(candidate.mode, 80) || 'local-codebase-question',
    generatedBy: str(candidate.generatedBy, 120) || 'CodebaseIndexStore',
    question,
    confidence: str(candidate.confidence, 40) || 'unknown',
    answer,
    answerLines: normalizeArray(candidate.answerLines || []).slice(0, 6),
    citations,
    coverage: {
      resultCount: Math.max(0, Number(coverage.resultCount) || 0),
      citedResultCount: Math.max(0, Number(coverage.citedResultCount) || citations.length),
      uniqueFileCount: Math.max(0, Number(coverage.uniqueFileCount) || new Set(citations.map((item) => item.path).filter(Boolean)).size),
      evidenceItemCount: Math.max(0, Number(coverage.evidenceItemCount) || 0),
      graphReferenceCount: Math.max(0, Number(coverage.graphReferenceCount) || 0),
      routeUsageCount: Math.max(0, Number(coverage.routeUsageCount) || 0),
    },
    nextActions: normalizeArray(candidate.nextActions || []).slice(0, 6),
    limitations: normalizeArray(candidate.limitations || []).slice(0, 6),
  };
}

function normalizeCountMap(value = {}, limit = 20) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, count]) => [str(key, 120), Math.max(0, Number(count) || 0)])
      .filter(([key, count]) => key && count > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit),
  );
}

function normalizeCoverageExplanations(value = []) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item) => ({
    kind: str(item.kind, 80) || 'coverage',
    status: str(item.status, 80) || 'unknown',
    command: str(item.command, 1000),
    reason: str(item.reason, 240),
  })).filter((item) => item.command || item.reason);
}

function normalizeStagedDiffReview(input = {}) {
  const candidate = input && typeof input === 'object' ? input : {};
  const rawSummary = candidate.summary && typeof candidate.summary === 'object' ? candidate.summary : {};
  const rawLargest = rawSummary.largestChange && typeof rawSummary.largestChange === 'object'
    ? rawSummary.largestChange
    : null;
  const files = Array.isArray(candidate.files) ? candidate.files.slice(0, 8).map((item, index) => ({
    index: Math.max(0, Number(item.index ?? index) || index),
    operation: str(item.operation, 40) || 'update',
    path: str(item.path, 2000),
    extension: str(item.extension, 40) || 'none',
    ok: item.ok !== false,
    beforeExists: Boolean(item.beforeExists),
    additions: Math.max(0, Number(item.additions) || 0),
    removals: Math.max(0, Number(item.removals) || 0),
    netLineChange: Number(item.netLineChange) || 0,
    beforeLines: Math.max(0, Number(item.beforeLines) || 0),
    afterLines: Math.max(0, Number(item.afterLines) || 0),
    changed: Boolean(item.changed),
    contentBytes: Math.max(0, Number(item.contentBytes) || 0),
    beforeSize: Math.max(0, Number(item.beforeSize) || 0),
    beforeSha256: str(item.beforeSha256, 128),
    contentSha256: str(item.contentSha256, 128),
    safeToAutoExecute: Boolean(item.safeToAutoExecute),
    requiresApproval: Boolean(item.requiresApproval),
    attentionFlags: normalizeArray(item.attentionFlags || []).slice(0, 10),
    coverageStatus: str(item.coverageStatus || item.commandCoverage?.status, 80) || 'uncovered',
    verificationCommandCount: Math.max(0, Number(item.verificationCommandCount ?? item.commandCoverage?.verificationCommandCount) || 0),
    workEvidenceCommandCount: Math.max(0, Number(item.workEvidenceCommandCount ?? item.commandCoverage?.workEvidenceCommandCount) || 0),
    projectWideVerificationCommandCount: Math.max(0, Number(item.projectWideVerificationCommandCount ?? item.commandCoverage?.projectWideVerificationCommandCount) || 0),
    projectWideWorkEvidenceCommandCount: Math.max(0, Number(item.projectWideWorkEvidenceCommandCount ?? item.commandCoverage?.projectWideWorkEvidenceCommandCount) || 0),
    verificationCommandDigest: str(item.verificationCommandDigest || item.commandCoverage?.verificationCommandDigest, 128),
    workEvidenceCommandDigest: str(item.workEvidenceCommandDigest || item.commandCoverage?.workEvidenceCommandDigest, 128),
    coverageExplanations: normalizeCoverageExplanations(item.coverageExplanations || item.commandCoverage?.coverageExplanations || []),
    coverageExplanationSummary: str(item.coverageExplanationSummary || item.commandCoverage?.coverageExplanationSummary, 1000),
    riskScore: Math.max(0, Number(item.riskScore) || 0),
    riskLevel: str(item.riskLevel, 40) || 'low',
    riskRank: Math.max(0, Number(item.riskRank) || 0),
  })).filter((item) => item.path) : [];
  const id = str(candidate.id, 160);
  const sha256 = str(candidate.sha256, 128);
  if (!id && !sha256 && !files.length) return null;
  const summary = {
    fileCount: Math.max(0, Number(rawSummary.fileCount ?? files.length) || files.length),
    okFileCount: Math.max(0, Number(rawSummary.okFileCount ?? files.filter(file => file.ok).length) || 0),
    blockedFileCount: Math.max(0, Number(rawSummary.blockedFileCount ?? files.filter(file => !file.ok).length) || 0),
    newFileCount: Math.max(0, Number(rawSummary.newFileCount ?? files.filter(file => !file.beforeExists).length) || 0),
    existingFileCount: Math.max(0, Number(rawSummary.existingFileCount ?? files.filter(file => file.beforeExists).length) || 0),
    safeToAutoExecuteCount: Math.max(0, Number(rawSummary.safeToAutoExecuteCount ?? files.filter(file => file.safeToAutoExecute).length) || 0),
    approvalRequiredCount: Math.max(0, Number(rawSummary.approvalRequiredCount ?? files.filter(file => file.requiresApproval).length) || 0),
    totalAdditions: Math.max(0, Number(rawSummary.totalAdditions ?? files.reduce((sum, file) => sum + file.additions, 0)) || 0),
    totalRemovals: Math.max(0, Number(rawSummary.totalRemovals ?? files.reduce((sum, file) => sum + file.removals, 0)) || 0),
    totalNetLineChange: Number(rawSummary.totalNetLineChange ?? files.reduce((sum, file) => sum + file.netLineChange, 0)) || 0,
    totalContentBytes: Math.max(0, Number(rawSummary.totalContentBytes ?? files.reduce((sum, file) => sum + file.contentBytes, 0)) || 0),
    attentionFlagCount: Math.max(0, Number(rawSummary.attentionFlagCount ?? files.reduce((sum, file) => sum + file.attentionFlags.length, 0)) || 0),
    verificationCoveredFileCount: Math.max(0, Number(rawSummary.verificationCoveredFileCount ?? files.filter(file => ['verified', 'project_wide_verified'].includes(file.coverageStatus)).length) || 0),
    specificallyVerifiedFileCount: Math.max(0, Number(rawSummary.specificallyVerifiedFileCount ?? files.filter(file => file.coverageStatus === 'verified').length) || 0),
    workEvidenceCoveredFileCount: Math.max(0, Number(rawSummary.workEvidenceCoveredFileCount ?? files.filter(file => file.coverageStatus === 'evidence_only').length) || 0),
    uncoveredFileCount: Math.max(0, Number(rawSummary.uncoveredFileCount ?? files.filter(file => file.coverageStatus === 'uncovered').length) || 0),
    highRiskFileCount: Math.max(0, Number(rawSummary.highRiskFileCount ?? files.filter(file => ['blocked', 'high'].includes(file.riskLevel)).length) || 0),
    coverageExplanationCount: Math.max(0, Number(rawSummary.coverageExplanationCount ?? files.reduce((sum, file) => sum + file.coverageExplanations.length, 0)) || 0),
    operationCounts: normalizeCountMap(rawSummary.operationCounts),
    extensionCounts: normalizeCountMap(rawSummary.extensionCounts),
    attentionFlagCounts: normalizeCountMap(rawSummary.attentionFlagCounts),
    coverageStatusCounts: normalizeCountMap(rawSummary.coverageStatusCounts),
    riskLevelCounts: normalizeCountMap(rawSummary.riskLevelCounts),
    largestChange: rawLargest ? {
      path: str(rawLargest.path, 2000),
      additions: Math.max(0, Number(rawLargest.additions) || 0),
      removals: Math.max(0, Number(rawLargest.removals) || 0),
      contentBytes: Math.max(0, Number(rawLargest.contentBytes) || 0),
    } : null,
    topRiskFiles: Array.isArray(rawSummary.topRiskFiles) ? rawSummary.topRiskFiles.slice(0, 5).map((item) => ({
      path: str(item.path, 2000),
      operation: str(item.operation, 40),
      riskRank: Math.max(0, Number(item.riskRank) || 0),
      riskScore: Math.max(0, Number(item.riskScore) || 0),
      riskLevel: str(item.riskLevel, 40) || 'low',
      coverageStatus: str(item.coverageStatus, 80) || 'uncovered',
      additions: Math.max(0, Number(item.additions) || 0),
      removals: Math.max(0, Number(item.removals) || 0),
      attentionFlags: normalizeArray(item.attentionFlags || []).slice(0, 10),
    })).filter((item) => item.path) : [],
  };
  return {
    id,
    sha256,
    safeToResume: candidate.safeToResume !== false,
    summary,
    files,
  };
}

function normalizeApprovalResumeGateAudit(input = {}) {
  const candidate = input && typeof input === 'object' ? input : {};
  const id = str(candidate.id || candidate.gateId, 160);
  const sha256 = str(candidate.sha256 || candidate.reviewSha256, 128);
  if (!id && !sha256) return null;
  const counts = candidate.counts && typeof candidate.counts === 'object' ? candidate.counts : {};
  const normalizeAuditCommands = (value) => Array.isArray(value) ? value.slice(0, 8).map((item) => ({
    command: str(item.command, 1000),
    ok: item.ok !== false,
    reason: str(item.reason, 500),
    safeToAutoExecute: Boolean(item.safeToAutoExecute),
  })).filter((item) => item.command) : [];
  return {
    id,
    sha256,
    status: str(candidate.status, 80) || 'reviewed',
    approvalId: str(candidate.approvalId, 160),
    safeToResume: Boolean(candidate.safeToResume),
    recordedAt: str(candidate.recordedAt, 80) || new Date().toISOString(),
    recordedBy: str(candidate.recordedBy, 120) || 'system',
    counts: {
      fileChanges: Math.max(0, Number(counts.fileChanges) || 0),
      commands: Math.max(0, Number(counts.commands) || 0),
      workEvidenceCommands: Math.max(0, Number(counts.workEvidenceCommands) || 0),
      evidenceArtifacts: Math.max(0, Number(counts.evidenceArtifacts) || 0),
      risks: Math.max(0, Number(counts.risks) || 0),
    },
    files: Array.isArray(candidate.files) ? candidate.files.slice(0, 8).map((item) => ({
      operation: str(item.operation, 40),
      path: str(item.path, 2000),
      beforeSha256: str(item.beforeSha256, 128),
      contentSha256: str(item.contentSha256, 128),
      safeToAutoExecute: Boolean(item.safeToAutoExecute),
    })).filter((item) => item.path) : [],
    commands: normalizeAuditCommands(candidate.commands),
    workEvidenceCommands: normalizeAuditCommands(candidate.workEvidenceCommands),
    stagedDiffReview: normalizeStagedDiffReview(candidate.stagedDiffReview || candidate.diffReview),
    risks: normalizeArray(candidate.risks || []).slice(0, 12),
  };
}

function normalizeIdArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0))].slice(0, 200);
}

function uniqueStrings(values) {
  const out = [];
  const visit = (value) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const text = String(value).trim();
    if (text && !out.includes(text)) out.push(text);
  };
  visit(values);
  return out.slice(0, 80);
}

function countBy(values = [], mapper = (item) => item) {
  const counts = {};
  for (const item of values || []) {
    const key = str(mapper(item), 160) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function activityEventKey(event = {}) {
  if (event.id !== undefined && event.id !== null) return `id:${event.id}`;
  return [
    event.ts || event.createdAt || '',
    event.action || event.tag || '',
    event.entityType || '',
    event.entityId || '',
  ].join('\u001f');
}

function safeSlug(value, fallback = 'run') {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
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
  const { run, messages, toolResults, activityEvents, governanceLineage } = snapshot;
  const archives = snapshot.archives || [];
  const gateReport = snapshot.approvalResumeGateAuditReport || null;
  const sessionEvidenceChain = snapshot.sessionTimeline?.evidenceChain || null;
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
    `- Next Governance Action: ${governanceLineage?.nextAction?.type || 'none'}`,
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
  lines.push('', '## Governance Lineage');
  if (!governanceLineage) {
    lines.push('', '_none_');
  } else {
    lines.push('', `- Approvals: ${governanceLineage.approvals.map((item) => item.id).join(', ') || '-'}`);
    lines.push(`- Delegations: ${governanceLineage.delegations.map((item) => item.id).join(', ') || '-'}`);
    lines.push(`- Budget Incidents: ${governanceLineage.budgetIncidents.map((item) => item.id).join(', ') || '-'}`);
    lines.push(`- Autopilot Jobs: ${governanceLineage.autopilotJobs.map((item) => item.id).join(', ') || '-'}`);
    lines.push(`- Blockers: ${governanceLineage.blockers.map((item) => `${item.kind}:${item.id || '-'}`).join(', ') || '-'}`);
  }
  lines.push('', '## Execution Archives');
  if (archives.length === 0) lines.push('', '_none_');
  for (const archive of archives) {
    lines.push('', `### ${archive.id}`, '');
    lines.push(`- Status: ${archive.status || '-'}`);
    lines.push(`- Summary: ${archive.summary || '-'}`);
    lines.push(`- Safe To Auto Execute: ${archive.safeToAutoExecute ? 'yes' : 'no'}`);
    lines.push(`- Tool Results: ${archive.verification?.toolResultCount || 0}`);
    lines.push(`- Blockers: ${(archive.governance?.blockers || []).map((item) => `${item.kind}:${item.id || '-'}`).join(', ') || '-'}`);
  }
  if (gateReport) {
    lines.push('', '## Approval Resume Gate Audit', '');
    lines.push(`- Gate: ${gateReport.gate?.id || '-'}`);
    lines.push(`- SHA256: ${gateReport.gate?.sha256 || '-'}`);
    lines.push(`- Verified: ${gateReport.verified ? 'yes' : 'no'}`);
    lines.push(`- Sources: ${gateReport.summary?.sourceCount || 0}`);
    lines.push(`- Mismatches: ${gateReport.summary?.mismatchCount || 0}`);
  }
  if (sessionEvidenceChain) {
    lines.push('', '## Session Evidence Chain', '');
    lines.push(`- Chain: ${sessionEvidenceChain.id || '-'}`);
    lines.push(`- Items: ${sessionEvidenceChain.summary?.itemCount || 0}`);
    lines.push(`- Runs: ${sessionEvidenceChain.summary?.runCount || 0}`);
    lines.push(`- Messages: ${sessionEvidenceChain.summary?.messageCount || 0}`);
    lines.push(`- Tool Results: ${sessionEvidenceChain.summary?.toolResultCount || 0}`);
    lines.push(`- Archives: ${sessionEvidenceChain.summary?.archiveCount || 0}`);
    lines.push(`- Activity: ${sessionEvidenceChain.summary?.activityEventCount || 0}`);
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
  const run = {
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
  return withRunLineageSummary(run);
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

function lineageIdsFromRun(run = {}) {
  const details = run.details || {};
  return {
    approvalIds: uniqueStrings([run.approvalId, details.approvalId, details.approvalIds, details.approval?.id]),
    delegationIds: uniqueStrings([run.delegationId, details.delegationId, details.delegationIds, details.delegation?.id]),
    budgetIncidentIds: uniqueStrings([run.budgetIncidentId, details.budgetIncidentId, details.budgetIncidentIds]),
    autopilotJobIds: uniqueStrings([details.jobId, details.autopilotJobId, details.autopilotJobIds]),
    activityEventIds: normalizeIdArray([...(run.relatedActivityIds || []), ...(details.relatedActivityIds || [])]),
  };
}

function lineageIdsFromEvent(event = {}) {
  const details = event.details || {};
  const fromEntity = (kind) => (event.entityType === kind ? event.entityId : null);
  return {
    approvalIds: uniqueStrings([
      fromEntity('approval'),
      details.approvalId,
      details.approvalIds,
      event.entityType === 'approval' ? details.id : null,
    ]),
    delegationIds: uniqueStrings([
      fromEntity('delegation'),
      details.delegationId,
      details.delegationIds,
      event.entityType === 'delegation' ? details.id : null,
    ]),
    budgetIncidentIds: uniqueStrings([
      fromEntity('budget_incident'),
      details.budgetIncidentId,
      details.budgetIncidentIds,
      event.entityType === 'budget_incident' ? details.id : null,
    ]),
    autopilotJobIds: uniqueStrings([
      fromEntity('autopilot_job'),
      details.jobId,
      details.autopilotJobId,
      details.autopilotJobIds,
      event.entityType === 'autopilot_job' ? details.id : null,
    ]),
    activityEventIds: event.id ? [Number(event.id)].filter((id) => Number.isFinite(id)) : [],
  };
}

function mergeLineageIds(...groups) {
  return {
    approvalIds: uniqueStrings(groups.map((item) => item?.approvalIds || [])),
    delegationIds: uniqueStrings(groups.map((item) => item?.delegationIds || [])),
    budgetIncidentIds: uniqueStrings(groups.map((item) => item?.budgetIncidentIds || [])),
    autopilotJobIds: uniqueStrings(groups.map((item) => item?.autopilotJobIds || [])),
    activityEventIds: normalizeIdArray(groups.flatMap((item) => item?.activityEventIds || [])),
  };
}

function eventMatchesLineage(event, key, id) {
  return lineageIdsFromEvent(event)[key]?.includes(id);
}

function lineageItems(key, ids, activityEvents = []) {
  return ids.map((id) => {
    const events = activityEvents.filter((event) => eventMatchesLineage(event, key, id));
    const latest = events[events.length - 1] || null;
    return {
      id,
      status: latest?.status || null,
      latestAction: latest?.action || latest?.tag || null,
      activityEventIds: normalizeIdArray(events.map((event) => event.id)),
      updatedAt: latest?.ts || latest?.createdAt || null,
    };
  });
}

function lineageBlockers(run = {}, lineage = {}) {
  const blockers = [];
  const deferReason = str(run.deferReason || run.details?.deferReason || run.details?.reason, 160);
  const firstPendingApproval = (lineage.approvals || []).find((item) => item.status === 'pending') || lineage.approvals?.[0];
  const firstBudgetIncident = lineage.budgetIncidents?.[0];
  const firstOpenBudget = (lineage.budgetIncidents || []).find((item) => item.status === 'open');
  if (run.status === 'deferred' && /approval/i.test(deferReason || '') && firstPendingApproval) {
    blockers.push({
      kind: 'approval',
      id: firstPendingApproval.id,
      reason: deferReason || 'approval_pending',
      resolution: 'Approve or reject in Approval Center; HTTP/API actions can retry with the approved approvalId.',
    });
  }
  if ((run.status === 'deferred' && /budget/i.test(deferReason || '')) || firstOpenBudget) {
    blockers.push({
      kind: 'budget',
      id: firstOpenBudget?.id || firstBudgetIncident?.id || run.budgetIncidentId || run.details?.budgetIncidentId || null,
      reason: deferReason || 'budget_blocked',
      resolution: 'Resolve the incident or adjust the local budget policy before retrying the run.',
    });
  }
  if (run.status === 'failed') {
    blockers.push({
      kind: 'failure',
      id: run.id,
      reason: run.error || run.details?.error || 'run_failed',
      resolution: 'Inspect messages, tool results, and Activity before retrying.',
    });
  }
  return blockers;
}

function nextLineageAction(lineage = {}) {
  const blocker = lineage.blockers?.[0] || null;
  if (!blocker) {
    return { type: 'none', label: 'No blocking governance action', safeToAutoReplay: false };
  }
  if (blocker.kind === 'approval') {
    return {
      type: 'approval_decision_then_retry',
      label: 'Decide approval, then retry the same approved HTTP/API action when available',
      approvalId: blocker.id,
      safeToAutoReplay: false,
    };
  }
  if (blocker.kind === 'budget') {
    return {
      type: 'resolve_budget_then_retry',
      label: 'Resolve budget incident or policy, then retry',
      budgetIncidentId: blocker.id,
      safeToAutoReplay: false,
    };
  }
  return {
    type: 'inspect_failure_then_retry',
    label: 'Inspect failure evidence before retry',
    safeToAutoReplay: false,
  };
}

function buildReplayPlan(timeline = {}, input = {}) {
  const run = timeline.run || {};
  const lineage = timeline.governanceLineage || buildGovernanceLineage(run, timeline.activityEvents || []);
  const failedTools = (timeline.toolResults || []).filter((item) => /failed|error/i.test(item.status || ''));
  const failedMessages = (timeline.messages || []).filter((item) => /failed|error/i.test(item.status || '') || item.payload?.errorKind);
  const blockers = lineage.blockers || [];
  const steps = [];
  for (const blocker of blockers) {
    if (blocker.kind === 'approval') {
      steps.push({
        type: 'approval_decision',
        targetId: blocker.id,
        title: 'Resolve pending approval',
        detail: blocker.resolution,
        safeToAutoExecute: false,
      });
    } else if (blocker.kind === 'budget') {
      steps.push({
        type: 'budget_resolution',
        targetId: blocker.id,
        title: 'Resolve budget blocker',
        detail: blocker.resolution,
        safeToAutoExecute: false,
      });
    } else {
      steps.push({
        type: 'failure_inspection',
        targetId: run.id,
        title: 'Inspect failed run evidence',
        detail: blocker.resolution,
        safeToAutoExecute: false,
      });
    }
  }
  if (failedTools.length) {
    steps.push({
      type: 'rerun_failed_tool',
      targetId: failedTools[failedTools.length - 1].id,
      title: `Re-run or replace ${failedTools[failedTools.length - 1].toolName}`,
      detail: failedTools[failedTools.length - 1].outputSummary || failedTools[failedTools.length - 1].inputSummary || '',
      safeToAutoExecute: false,
    });
  }
  if (!steps.length && run.status === 'failed') {
    steps.push({
      type: 'inspect_failure',
      targetId: run.id,
      title: 'Inspect failure and retry with a scoped verification command',
      detail: run.error || failedMessages[failedMessages.length - 1]?.summary || 'No specific failure evidence recorded.',
      safeToAutoExecute: false,
    });
  }
  if (!steps.length) {
    steps.push({
      type: 'verify_current_state',
      targetId: run.id,
      title: 'Verify current state before replay',
      detail: 'No active blocker or failure evidence was found.',
      safeToAutoExecute: false,
    });
  }
  const summary = blockers.length
    ? `Replay requires ${blockers.map((item) => item.kind).join(', ')} resolution.`
    : (run.status === 'failed' ? 'Replay requires failure inspection.' : 'Replay plan recorded for audit.');
  return {
    id: `replay-plan-${randomUUID().slice(0, 12)}`,
    runId: run.id,
    createdAt: new Date().toISOString(),
    requestedBy: str(input.requestedBy || input.actorType || 'system', 120) || 'system',
    safeToAutoExecute: false,
    nextAction: lineage.nextAction,
    summary,
    blockers,
    steps,
    evidence: {
      messageIds: (timeline.messages || []).map((item) => item.id),
      failedToolResultIds: failedTools.map((item) => item.id),
      activityEventIds: lineage.activityEventIds || [],
    },
  };
}

function latestReplayPlanId(messages = []) {
  for (const message of [...messages].reverse()) {
    if (message?.kind !== 'replay_plan') continue;
    const id = message.payload?.replayPlan?.id || message.payload?.replayPlanId;
    if (id) return str(id, 160);
  }
  return null;
}

function buildReplayResult(timeline = {}, input = {}) {
  const run = timeline.run || {};
  const status = str(input.status || 'recorded', 80) || 'recorded';
  const replayPlanId = str(input.replayPlanId || latestReplayPlanId(timeline.messages || []), 160);
  const summary = str(input.summary || input.outputSummary || `Replay result ${status}`, 2000) || `Replay result ${status}`;
  return {
    id: `replay-result-${randomUUID().slice(0, 12)}`,
    runId: run.id,
    replayPlanId,
    status,
    summary,
    recordedAt: new Date().toISOString(),
    recordedBy: str(input.requestedBy || input.actorType || 'system', 120) || 'system',
    safeToAutoExecute: false,
    evidence: parseJson(input.evidence, {}),
  };
}

function latestMessage(messages = [], kinds = []) {
  const allowed = new Set(kinds);
  for (const message of [...messages].reverse()) {
    if (!allowed.size || allowed.has(message.kind)) return message;
  }
  return null;
}

function toolStatusCounts(toolResults = []) {
  const counts = {};
  for (const result of toolResults || []) {
    const status = str(result.status || 'unknown', 80) || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function buildExecutionArchive(timeline = {}, input = {}) {
  const run = timeline.run || {};
  const messages = timeline.messages || [];
  const toolResults = timeline.toolResults || [];
  const activityEvents = timeline.activityEvents || [];
  const governanceLineage = timeline.governanceLineage || buildGovernanceLineage(run, activityEvents);
  const latestSummary = latestMessage(messages, ['summary', 'replay_result', 'metric', 'decision']);
  const latestReplayResult = latestMessage(messages, ['replay_result']);
  const failedToolResults = toolResults.filter((item) => /failed|error/i.test(item.status || ''));
  const summary = str(input.summary, 2000)
    || latestReplayResult?.summary
    || latestSummary?.summary
    || `${run.status || 'unknown'} Agent Run archived.`;
  return {
    id: `agent-archive-${randomUUID().slice(0, 12)}`,
    runId: run.id,
    createdAt: new Date().toISOString(),
    archivedBy: str(input.requestedBy || input.actorType || 'system', 120) || 'system',
    safeToAutoExecute: false,
    status: run.status,
    summary,
    source: {
      roomId: run.roomId,
      sessionId: run.sessionId,
      taskId: run.taskId,
      agentProfileId: run.agentProfileId,
      adapterId: run.adapterId,
      modelId: run.modelId,
      sourceType: run.sourceType,
      sourceId: run.sourceId,
    },
    context: {
      skills: run.skills || [],
      dispatchTags: run.dispatchTags || [],
      governance: run.governance || {},
      codeContextSignals: run.details?.codeContextSignals || null,
      codeContextEvidenceCount: Number(run.details?.codeContextEvidenceCount) || 0,
      codebaseQuestionAnswer: normalizeCodebaseQuestionAnswer(run.details?.codebaseQuestionAnswer),
      codebaseQuestionCitationCount: Array.isArray(run.details?.codebaseQuestionAnswer?.citations) ? run.details.codebaseQuestionAnswer.citations.length : 0,
    },
    outcome: {
      status: run.status,
      error: run.error || run.details?.error || null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      latestSummary: latestSummary?.summary || null,
      latestReplayResult: latestReplayResult?.payload?.replayResult || null,
    },
    verification: {
      toolResultCount: toolResults.length,
      toolStatusCounts: toolStatusCounts(toolResults),
      failedToolResults: failedToolResults.map((item) => ({
        id: item.id,
        toolName: item.toolName,
        status: item.status,
        outputSummary: item.outputSummary,
      })),
    },
    governance: {
      summary: governanceLineage.summary,
      nextAction: governanceLineage.nextAction,
      blockers: governanceLineage.blockers || [],
      ids: governanceLineage.ids || {},
    },
    evidence: {
      messageIds: messages.map((item) => item.id),
      toolResultIds: toolResults.map((item) => item.id),
      activityEventIds: normalizeIdArray(activityEvents.map((item) => item.id)),
      relatedActivityIds: normalizeIdArray(run.relatedActivityIds || []),
      files: normalizeArray(input.files || input.affectedFiles || run.details?.affectedFiles || []),
      notes: str(input.notes, 2000),
      external: parseJson(input.evidence, {}),
    },
  };
}

function digestComparable(value) {
  return value === null || value === undefined
    ? null
    : createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function gateAuditArtifactComparable(artifacts = []) {
  return (Array.isArray(artifacts) ? artifacts : [])
    .map((artifact) => {
      if (!artifact || typeof artifact !== 'object') return null;
      const path = normalizeArtifactRelPath(artifact.path);
      if (!path) return null;
      return {
        kind: str(artifact.kind, 120) || 'artifact',
        path,
        size: Math.max(0, Number(artifact.size) || 0),
        sha256: str(artifact.sha256, 128),
        sessionId: str(artifact.sessionId, 160),
        gateId: str(artifact.gateId, 160),
        reportId: str(artifact.reportId, 160),
      };
    })
    .filter(Boolean)
    .sort((a, b) => `${a.kind}:${a.path}`.localeCompare(`${b.kind}:${b.path}`));
}

function approvalResumeGateAuditComparableParts(audit = {}, artifacts = []) {
  const normalized = normalizeApprovalResumeGateAudit(audit);
  if (!normalized) return null;
  const diff = normalized.stagedDiffReview;
  const summary = diff?.summary || {};
  const diffFiles = diff?.files || [];
  const base = {
    id: normalized.id,
    sha256: normalized.sha256,
    status: normalized.status,
    approvalId: normalized.approvalId,
    safeToResume: normalized.safeToResume,
    counts: normalized.counts,
  };
  const file = {
    id: normalized.id,
    sha256: normalized.sha256,
    counts: { fileChanges: normalized.counts.fileChanges },
    files: normalized.files.map((item) => ({
      operation: item.operation,
      path: item.path,
      beforeSha256: item.beforeSha256,
      contentSha256: item.contentSha256,
      safeToAutoExecute: item.safeToAutoExecute,
    })),
    stagedDiffReview: diff ? {
      id: diff.id,
      sha256: diff.sha256,
      safeToResume: diff.safeToResume,
      summary: {
        fileCount: summary.fileCount,
        okFileCount: summary.okFileCount,
        blockedFileCount: summary.blockedFileCount,
        newFileCount: summary.newFileCount,
        existingFileCount: summary.existingFileCount,
        safeToAutoExecuteCount: summary.safeToAutoExecuteCount,
        approvalRequiredCount: summary.approvalRequiredCount,
        totalAdditions: summary.totalAdditions,
        totalRemovals: summary.totalRemovals,
        totalNetLineChange: summary.totalNetLineChange,
        operationCounts: summary.operationCounts,
        extensionCounts: summary.extensionCounts,
        attentionFlagCount: summary.attentionFlagCount,
        attentionFlagCounts: summary.attentionFlagCounts,
      },
      files: diffFiles.map((item) => ({
        operation: item.operation,
        path: item.path,
        extension: item.extension,
        ok: item.ok,
        beforeExists: item.beforeExists,
        additions: item.additions,
        removals: item.removals,
        netLineChange: item.netLineChange,
        beforeSha256: item.beforeSha256,
        contentSha256: item.contentSha256,
        safeToAutoExecute: item.safeToAutoExecute,
        requiresApproval: item.requiresApproval,
      })),
    } : null,
  };
  const command = {
    counts: {
      commands: normalized.counts.commands,
      workEvidenceCommands: normalized.counts.workEvidenceCommands,
    },
    commands: normalized.commands.map((item) => ({
      command: item.command,
      ok: item.ok,
      reason: item.reason,
      safeToAutoExecute: item.safeToAutoExecute,
    })),
    workEvidenceCommands: normalized.workEvidenceCommands.map((item) => ({
      command: item.command,
      ok: item.ok,
      reason: item.reason,
      safeToAutoExecute: item.safeToAutoExecute,
    })),
    stagedDiffReview: diff ? {
      id: diff.id,
      sha256: diff.sha256,
      files: diffFiles.map((item) => ({
        path: item.path,
        verificationCommandCount: item.verificationCommandCount,
        workEvidenceCommandCount: item.workEvidenceCommandCount,
        projectWideVerificationCommandCount: item.projectWideVerificationCommandCount,
        projectWideWorkEvidenceCommandCount: item.projectWideWorkEvidenceCommandCount,
        verificationCommandDigest: item.verificationCommandDigest,
        workEvidenceCommandDigest: item.workEvidenceCommandDigest,
      })),
    } : null,
  };
  const risk = {
    counts: { risks: normalized.counts.risks },
    risks: normalized.risks,
    stagedDiffReview: diff ? {
      id: diff.id,
      sha256: diff.sha256,
      summary: {
        highRiskFileCount: summary.highRiskFileCount,
        riskLevelCounts: summary.riskLevelCounts,
      },
      files: diffFiles.map((item) => ({
        path: item.path,
        riskScore: item.riskScore,
        riskLevel: item.riskLevel,
        riskRank: item.riskRank,
      })),
    } : null,
  };
  const coverage = {
    counts: {
      fileChanges: normalized.counts.fileChanges,
      commands: normalized.counts.commands,
      workEvidenceCommands: normalized.counts.workEvidenceCommands,
    },
    stagedDiffReview: diff ? {
      id: diff.id,
      sha256: diff.sha256,
      summary: {
        verificationCoveredFileCount: summary.verificationCoveredFileCount,
        specificallyVerifiedFileCount: summary.specificallyVerifiedFileCount,
        workEvidenceCoveredFileCount: summary.workEvidenceCoveredFileCount,
        uncoveredFileCount: summary.uncoveredFileCount,
        coverageStatusCounts: summary.coverageStatusCounts,
      },
      files: diffFiles.map((item) => ({
        path: item.path,
        coverageStatus: item.coverageStatus,
        verificationCommandCount: item.verificationCommandCount,
        workEvidenceCommandCount: item.workEvidenceCommandCount,
        projectWideVerificationCommandCount: item.projectWideVerificationCommandCount,
        projectWideWorkEvidenceCommandCount: item.projectWideWorkEvidenceCommandCount,
        verificationCommandDigest: item.verificationCommandDigest,
        workEvidenceCommandDigest: item.workEvidenceCommandDigest,
      })),
    } : null,
  };
  const artifactItems = gateAuditArtifactComparable(artifacts);
  return {
    base,
    file,
    command,
    risk,
    coverage,
    artifact: artifactItems.length ? { artifacts: artifactItems } : null,
  };
}

function approvalResumeGateAuditComparable(audit = {}) {
  const parts = approvalResumeGateAuditComparableParts(audit);
  if (!parts) return null;
  return {
    ...parts.base,
    file: parts.file,
    command: parts.command,
    risk: parts.risk,
    coverage: parts.coverage,
  };
}

function approvalResumeGateAuditPartitionDigests(audit = {}, artifacts = []) {
  const parts = approvalResumeGateAuditComparableParts(audit, artifacts);
  if (!parts) return null;
  return {
    file: digestComparable(parts.file),
    command: digestComparable(parts.command),
    risk: digestComparable(parts.risk),
    coverage: digestComparable(parts.coverage),
    artifact: digestComparable(parts.artifact),
  };
}

function approvalResumeGateAuditDigest(audit = {}) {
  return digestComparable(approvalResumeGateAuditComparable(audit));
}

function gateAuditPartitionMissingFields(source = {}, partition) {
  const audit = source.audit || {};
  const diff = audit.stagedDiffReview || null;
  if (partition === 'artifact') return source.partitionDigests?.artifact ? [] : ['artifact'];
  if (partition === 'file') return diff ? [] : ['stagedDiffReview'];
  if (partition === 'command') {
    const missing = [];
    if (!Array.isArray(audit.commands) || audit.commands.length === 0) missing.push('commands');
    if (!Array.isArray(audit.workEvidenceCommands) || audit.workEvidenceCommands.length === 0) missing.push('workEvidenceCommands');
    if (!diff) missing.push('stagedDiffReview.commandCoverage');
    return missing;
  }
  if (partition === 'coverage') return diff ? [] : ['stagedDiffReview.coverage'];
  if (partition === 'risk') return diff ? [] : ['stagedDiffReview.risk'];
  return [];
}

function gateAuditPartitionMismatchReason(expectedDigest, actualDigest) {
  if (!expectedDigest && actualDigest) return 'unexpected_field';
  if (expectedDigest && !actualDigest) return 'missing_field';
  return 'digest_mismatch';
}

function buildGateAuditPartitionMismatches(canonical, sources = []) {
  const partitions = ['file', 'command', 'risk', 'coverage', 'artifact'];
  const mismatches = [];
  for (const source of sources) {
    for (const partition of partitions) {
      const expectedDigest = canonical.partitionDigests?.[partition] || null;
      const actualDigest = source.partitionDigests?.[partition] || null;
      if (!expectedDigest && !actualDigest) continue;
      if (expectedDigest === actualDigest) continue;
      mismatches.push({
        sourceKind: source.kind,
        sourceId: source.id,
        partition,
        reason: gateAuditPartitionMismatchReason(expectedDigest, actualDigest),
        expectedDigest,
        actualDigest,
        missingFields: gateAuditPartitionMissingFields(source, partition),
      });
    }
  }
  return mismatches;
}

function partitionMismatchCounts(mismatches = []) {
  const counts = {};
  for (const mismatch of mismatches || []) {
    const partition = mismatch.partition || 'unknown';
    counts[partition] = (counts[partition] || 0) + 1;
  }
  return counts;
}

function addApprovalResumeGateAuditSource(out, source = {}) {
  const audit = normalizeApprovalResumeGateAudit(source.audit);
  if (!audit) return;
  const digest = approvalResumeGateAuditDigest(audit);
  const partitionDigests = approvalResumeGateAuditPartitionDigests(audit, source.artifacts || []);
  out.push({
    kind: str(source.kind, 80) || 'unknown',
    id: str(source.id, 240),
    label: str(source.label, 400),
    action: str(source.action, 160),
    status: str(source.status || audit.status, 80),
    at: source.at || source.ts || null,
    digest,
    partitionDigests,
    audit,
  });
}

function buildApprovalResumeGateAuditReport(timeline = {}) {
  const run = timeline.run || {};
  const sources = [];
  addApprovalResumeGateAuditSource(sources, {
    kind: 'run_details',
    id: run.id,
    label: 'run.details.approvalResumeGateAudit',
    status: run.status,
    at: run.updatedAt,
    audit: run.details?.approvalResumeGateAudit,
  });
  for (const message of timeline.messages || []) {
    addApprovalResumeGateAuditSource(sources, {
      kind: 'message',
      id: message.id,
      label: `${message.kind || 'message'}:${message.summary || message.id}`,
      status: message.status,
      at: message.createdAt,
      audit: message.payload?.approvalResumeGateAudit || message.payload?.resumeReviewGateAudit,
    });
    addApprovalResumeGateAuditSource(sources, {
      kind: 'archive',
      id: message.id,
      label: `archive message:${message.payload?.archive?.id || message.id}`,
      status: message.payload?.archive?.status || message.status,
      at: message.createdAt,
      audit: message.payload?.archive?.evidence?.external?.resumeReviewGateAudit,
      artifacts: message.payload?.archive ? collectArchiveArtifacts([{ ...message.payload.archive, messageId: message.id }], run.id) : [],
    });
  }
  for (const event of timeline.activityEvents || []) {
    addApprovalResumeGateAuditSource(sources, {
      kind: 'activity',
      id: event.id,
      label: event.action || event.tag || `activity:${event.id}`,
      action: event.action || event.tag,
      status: event.status,
      at: event.ts || event.createdAt,
      audit: event.details?.approvalResumeGateAudit || event.details?.resumeReviewGateAudit,
      artifacts: event.details?.artifacts || [],
    });
  }
  const canonical = sources.find((source) => source.kind === 'run_details') || sources[0] || null;
  if (!canonical) return null;
  const mismatches = buildGateAuditPartitionMismatches(canonical, sources);
  const mismatchPartitionCounts = partitionMismatchCounts(mismatches);
  const kindCounts = countBy(sources, (source) => source.kind);
  const check = (code, passed, message) => ({ code, status: passed ? 'passed' : 'warn', message });
  const checks = [
    check('run_details_audit', Boolean(kindCounts.run_details), 'Run details include approvalResumeGateAudit.'),
    check('decision_message_audit', Boolean((timeline.messages || []).some((message) => message.payload?.approvalResumeGateAudit)), 'Decision message includes approvalResumeGateAudit.'),
    check('activity_audit', Boolean(kindCounts.activity), 'Activity stream includes approval resume gate audit.'),
    check('archive_evidence_audit', Boolean(kindCounts.archive), 'Execution archive evidence includes approval resume gate audit.'),
    {
      code: 'gate_consistency',
      status: mismatches.length ? 'failed' : 'passed',
      message: mismatches.length ? `${mismatches.length} gate audit source mismatch(es).` : 'All gate audit source digests match.',
    },
  ];
  const verified = checks.every((item) => item.status === 'passed');
  return {
    id: `gate-audit-${createHash('sha1').update(`${run.id}:${canonical.audit.id}:${canonical.digest}`).digest('hex').slice(0, 12)}`,
    runId: run.id,
    generatedAt: new Date().toISOString(),
    verified,
    gate: canonical.audit,
    canonicalDigest: canonical.digest,
    sources,
    mismatches,
    checks,
    summary: {
      sourceCount: sources.length,
      mismatchCount: mismatches.length,
      mismatchPartitionCounts,
      runDetails: kindCounts.run_details || 0,
      messages: kindCounts.message || 0,
      activityEvents: kindCounts.activity || 0,
      archives: kindCounts.archive || 0,
    },
  };
}

function formatApprovalResumeGateAuditReportMarkdown(report = {}) {
  const gate = report.gate || {};
  const summary = report.summary || {};
  const lines = [
    `# Approval Resume Gate Audit Report`,
    '',
    `- Report: ${report.id || '-'}`,
    `- Run: ${report.runId || '-'}`,
    `- Gate: ${gate.id || '-'}`,
    `- SHA256: ${gate.sha256 || '-'}`,
    `- Approval: ${gate.approvalId || '-'}`,
    `- Status: ${gate.status || '-'}`,
    `- Verified: ${report.verified ? 'yes' : 'no'}`,
    `- Canonical Digest: ${report.canonicalDigest || '-'}`,
    '',
    '## Summary',
    '',
    `- Sources: ${summary.sourceCount || 0}`,
    `- Run Details: ${summary.runDetails || 0}`,
    `- Messages: ${summary.messages || 0}`,
    `- Activity Events: ${summary.activityEvents || 0}`,
    `- Archives: ${summary.archives || 0}`,
    `- Mismatches: ${summary.mismatchCount || 0}`,
    `- Partition Mismatches: ${Object.entries(summary.mismatchPartitionCounts || {}).map(([key, value]) => `${key}:${value}`).join(', ') || '-'}`,
    '',
    '## Checks',
  ];
  for (const check of report.checks || []) {
    lines.push(`- ${check.status}: ${check.code} - ${check.message || ''}`.trim());
  }
  if (gate.stagedDiffReview) {
    const diff = gate.stagedDiffReview;
    const diffSummary = diff.summary || {};
    lines.push(
      '',
      '## Staged Diff Review',
      '',
      `- Diff: ${diff.id || '-'} ${diff.sha256 || '-'}`,
      `- Files: ${diffSummary.fileCount || 0} (${diffSummary.newFileCount || 0} new, ${diffSummary.existingFileCount || 0} existing, ${diffSummary.blockedFileCount || 0} blocked)`,
      `- Lines: +${diffSummary.totalAdditions || 0} / -${diffSummary.totalRemovals || 0} / net ${diffSummary.totalNetLineChange || 0}`,
      `- Coverage: ${diffSummary.verificationCoveredFileCount || 0}/${diffSummary.fileCount || 0} verified, ${diffSummary.uncoveredFileCount || 0} uncovered, ${diffSummary.workEvidenceCoveredFileCount || 0} evidence-only`,
      `- Coverage Explanations: ${diffSummary.coverageExplanationCount || 0}`,
      `- Attention Flags: ${diffSummary.attentionFlagCount || 0}`,
      `- High Risk Files: ${diffSummary.highRiskFileCount || 0}`,
    );
    if ((diffSummary.topRiskFiles || []).length) {
      lines.push('- Top Risk: ' + diffSummary.topRiskFiles.map(file => `${file.riskRank || '-'}:${file.path || '-'}:${file.riskLevel || '-'}:${file.coverageStatus || '-'}`).join('; '));
    }
    for (const file of diff.files || []) {
      lines.push(`- ${file.operation || '-'} ${file.path || '-'} +${file.additions || 0}/-${file.removals || 0} risk:${file.riskLevel || '-'} score:${file.riskScore || 0} coverage:${file.coverageStatus || '-'} ${file.attentionFlags?.length ? `flags:${file.attentionFlags.join(',')}` : ''}`.trim());
      if ((file.coverageExplanations || []).length) {
        lines.push(`  - coverage reasons: ${file.coverageExplanations.map(item => `${item.kind}:${item.status}${item.command ? `:${item.command}` : ''}`).join('; ')}`);
      }
    }
  }
  lines.push('', '## Sources');
  for (const source of report.sources || []) {
    const parts = source.partitionDigests || {};
    const partitionText = ['file', 'command', 'risk', 'coverage', 'artifact']
      .map((key) => `${key}:${parts[key] ? String(parts[key]).slice(0, 12) : '-'}`)
      .join(' ');
    lines.push(`- ${source.kind} ${source.id || '-'} ${source.action || ''} ${source.status || ''} digest:${source.digest || '-'} partitions:${partitionText}`.trim());
  }
  if ((report.mismatches || []).length) {
    lines.push('', '## Mismatches');
    for (const mismatch of report.mismatches || []) {
      const missing = (mismatch.missingFields || []).length ? ` missing:${mismatch.missingFields.join(',')}` : '';
      lines.push(`- ${mismatch.sourceKind}:${mismatch.sourceId || '-'} partition:${mismatch.partition || 'unknown'} reason:${mismatch.reason || 'digest_mismatch'} expected ${mismatch.expectedDigest || '-'} got ${mismatch.actualDigest || '-'}${missing}`);
    }
  }
  return lines.join('\n');
}

function buildIdeaRunDraft(input = {}) {
  const classification = parseJson(input.classification, {});
  const inputDetails = parseJson(input.details, {});
  const idea = str(input.idea || input.text || input.summary, 4000) || 'Untitled idea';
  const affectedFiles = normalizeArray(input.affectedFiles || input.files || []);
  const matches = Array.isArray(classification.matches) ? classification.matches : [];
  const profile = classification.profile || {};
  const skills = normalizeArray(input.skills || classification.installedSkillNames || classification.suggestedSkillNames || []);
  const dispatchTags = normalizeArray(input.dispatchTags || matches.map((match) => match.tag));
  const governance = parseJson(input.governance || classification.governance || profile.governance || {}, {});
  const codebaseQuestionAnswer = normalizeCodebaseQuestionAnswer(
    input.codebaseQuestionAnswer
      || input.questionAnswer
      || classification.codebaseQuestionAnswer
      || inputDetails.codebaseQuestionAnswer,
  );
  const plan = {
    title: `Idea intake: ${idea.slice(0, 120)}`,
    safeToAutoExecute: false,
    stage: 'idea_intake',
    steps: [
      { type: 'scope', title: 'Scope task and acceptance criteria', status: 'drafted' },
      { type: 'dispatch', title: 'Select agent profile, skills, and code context', status: 'drafted' },
      { type: 'governance', title: 'Check budget, approval, and audit boundary before execution', status: 'pending' },
      { type: 'execute', title: 'Execute through scoped Agent Run lifecycle', status: 'pending' },
      { type: 'archive', title: 'Archive result, verification, and follow-up evidence', status: 'pending' },
    ],
    acceptanceCriteria: normalizeArray(input.acceptanceCriteria || []),
    suggested: {
      agentProfileId: str(input.agentProfileId || profile.id, 160),
      agentProfileTitle: str(input.agentProfileTitle || profile.title, 240),
      dispatchTags,
      skills,
    },
    governance,
    codeContext: {
      affectedFiles,
      evidenceSummary: classification.codeContextEvidenceSummary || input.codeContextEvidenceSummary || null,
      symbolGraphSummary: classification.codeContextGraphSummary || input.codeContextGraphSummary || null,
      questionAnswer: codebaseQuestionAnswer,
    },
  };
  return {
    idea,
    affectedFiles,
    classification,
    plan,
    profile,
    skills,
    dispatchTags,
    governance,
    codebaseQuestionAnswer,
  };
}

function normalizeVerificationResults(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') {
      return {
        name: str(item, 160) || 'verification',
        status: 'recorded',
        inputSummary: str(item, 2000),
        outputSummary: 'Verification evidence recorded.',
      };
    }
    if (!item || typeof item !== 'object') return null;
    const name = str(item.name || item.toolName || item.command || item.title || 'verification', 160) || 'verification';
    return {
      name,
      status: str(item.status || item.result || 'recorded', 80) || 'recorded',
      inputSummary: str(item.inputSummary || item.input || item.command || name, 2000),
      outputSummary: str(item.outputSummary || item.output || item.summary || '', 4000),
      costUsd: Math.max(0, Number(item.costUsd || item.costUSD) || 0),
      approvalId: str(item.approvalId, 160),
      payload: parseJson(item.payload || item.evidence || {}, {}),
    };
  }).filter(Boolean).slice(0, 12);
}

function buildIdeaExecutionRecord(timeline = {}, input = {}) {
  const run = timeline.run || {};
  const summary = str(input.summary || input.executionSummary || input.resultSummary, 2000)
    || `Idea execution recorded for ${run.taskId || run.id}.`;
  const requestedStatus = str(input.status || input.outcomeStatus || 'succeeded', 80) || 'succeeded';
  const finalStatus = /fail|error|block/i.test(requestedStatus) ? 'failed' : 'succeeded';
  const verificationResults = normalizeVerificationResults(input.verificationResults || input.verification || []);
  if (!verificationResults.length) {
    verificationResults.push({
      name: 'manual verification',
      status: finalStatus === 'succeeded' ? 'passed' : 'failed',
      inputSummary: 'Manual verification evidence',
      outputSummary: str(input.verificationSummary || summary, 4000) || summary,
      costUsd: 0,
      payload: {},
    });
  }
  return {
    id: `idea-execution-${randomUUID().slice(0, 12)}`,
    runId: run.id,
    stage: 'idea_execution',
    finalStatus,
    summary,
    recordedAt: new Date().toISOString(),
    recordedBy: str(input.requestedBy || input.actorType || 'system', 120) || 'system',
    safeToAutoExecute: false,
    affectedFiles: normalizeArray(input.affectedFiles || input.files || run.details?.affectedFiles || []),
    verificationResults,
    evidence: parseJson(input.evidence, {}),
  };
}

function manifestTestFilesForAffectedFiles(files = []) {
  const testFiles = [];
  const add = (file) => {
    if (file && !testFiles.includes(file)) testFiles.push(file);
  };
  for (const file of files) {
    if (file === 'src/agents/AgentRunStore.js') add('tests/unit/agent-run-store.test.js');
    if (file === 'src/server/routes/agentRuns.js') add('tests/unit/routes/agent-runs-routes.test.js');
    if (file === 'src/agents/AgentRunVerificationExecutor.js') add('tests/unit/agent-run-verification-executor.test.js');
    if (file === 'src/permissions/PermissionGovernance.js') add('tests/unit/permission-governance.test.js');
    if (file === 'src/audit/ActivityLog.js') add('tests/unit/activity-log.test.js');
    if (file === 'src/server/routes/activity.js') add('tests/unit/routes/activity-routes.test.js');
    if (/^tests\/unit\/.+\.test\.[cm]?js$/.test(file)) add(file);
  }
  return testFiles.slice(0, 8);
}

function manifestCheckCommandsForAffectedFiles(files = []) {
  const commands = [];
  for (const file of files) {
    if (file === 'public/app.js') commands.push('node --check public/app.js');
    if (/^(src|public|tests|scripts)\/.+\.(mjs|cjs|js)$/.test(file) && !file.endsWith('.test.js')) {
      commands.push(`node --check ${file}`);
    }
  }
  return [...new Set(commands)].slice(0, 4);
}

function modelPatchTargetForAffectedFiles(files = []) {
  const allowedExt = /\.(js|mjs|cjs|ts|tsx|jsx|css|html|md)$/;
  return files.find((file) => /^(src|public|tests|docs)\//.test(file) && allowedExt.test(file) && !/\.test\.[cm]?js$/.test(file))
    || files.find((file) => /^(src|public|tests|docs)\//.test(file) && allowedExt.test(file))
    || 'docs/xikelab-agent-skill-registry.md';
}

function commentBlockForFile(path, lines = []) {
  const cleanLines = lines.map((line) => String(line || '').replace(/\*\//g, '* /').trim()).filter(Boolean);
  const body = cleanLines.length ? cleanLines : ['Xike Agent patch proposal.'];
  if (/\.(html|htm|md)$/.test(path)) {
    return `\n\n<!--\n${body.map((line) => `Xike Agent: ${line}`).join('\n')}\n-->\n`;
  }
  if (/\.css$/.test(path)) {
    return `\n\n/*\n${body.map((line) => `Xike Agent: ${line}`).join('\n')}\n*/\n`;
  }
  return `\n\n${body.map((line) => `// Xike Agent: ${line}`).join('\n')}\n`;
}

function safeModelFileChanges(manifest = {}) {
  if (!manifest || typeof manifest !== 'object') return [];
  const source = Array.isArray(manifest.fileChanges) ? manifest.fileChanges : [];
  return source.map((change) => {
    if (!change || typeof change !== 'object') return null;
    const path = str(change.path || change.filePath || change.file, 1000);
    const operation = str(change.operation || change.action || 'append', 40) || 'append';
    const content = String(change.content ?? change.text ?? '');
    if (!path || !/^(src|public|tests|docs|output\/playwright)\//.test(path)) return null;
    if (!/\.(js|mjs|cjs|ts|tsx|jsx|css|html|md|json|txt)$/.test(path)) return null;
    if (!content.trim()) return null;
    return {
      operation: ['create', 'update', 'append'].includes(operation) ? operation : 'append',
      path,
      content: content.slice(0, 16 * 1024),
      summary: str(change.summary || change.reason || 'Model generated source patch.', 500) || 'Model generated source patch.',
    };
  }).filter(Boolean).slice(0, 4);
}

function buildFallbackSourcePatch(timeline = {}, draft = {}) {
  const run = timeline.run || {};
  const details = run.details || {};
  const idea = str(details.idea || run.taskId || run.id, 1000) || 'Idea Run';
  const target = modelPatchTargetForAffectedFiles(draft.affectedFiles || details.affectedFiles || []);
  return {
    operation: 'append',
    path: target,
    content: commentBlockForFile(target, [
      `Patch draft for run ${run.id || draft.runId || '-'}.`,
      `Idea: ${idea}`,
      'Review this governed source patch before execution.',
      'Execution must go through idea-auto-execute and PermissionGovernance.',
    ]),
    summary: 'Append a governed local Agent source patch proposal.',
  };
}

function sourcePatchQuality(manifest = {}, { generation = {}, affectedFiles = [], source = '' } = {}) {
  const fileChanges = Array.isArray(manifest.fileChanges) ? manifest.fileChanges : [];
  const commands = Array.isArray(manifest.commands) ? manifest.commands : [];
  const workEvidenceCommands = Array.isArray(manifest.workEvidenceCommands) ? manifest.workEvidenceCommands : [];
  const findings = [];
  const blockers = [];
  let score = 68;
  if (!fileChanges.length) {
    blockers.push({ code: 'no_file_changes', severity: 'error', message: 'Patch manifest has no file changes.' });
    score -= 45;
  } else {
    score += Math.min(12, fileChanges.length * 6);
  }
  const affectedSet = new Set((affectedFiles || []).filter(Boolean));
  const touchesAffected = fileChanges.some(change => affectedSet.has(change.path));
  if (affectedSet.size && touchesAffected) {
    score += 10;
    findings.push({ code: 'touches_affected_file', severity: 'info', message: 'Patch targets at least one affected file.' });
  } else if (affectedSet.size) {
    score -= 8;
    findings.push({ code: 'outside_affected_files', severity: 'warn', message: 'Patch target is not one of the affected files.' });
  }
  if (commands.includes('git diff --check')) score += 8;
  else findings.push({ code: 'missing_diff_check', severity: 'warn', message: 'Patch manifest should include git diff --check.' });
  if (commands.some(command => /^node --check\b/.test(command) || /^npm test\b/.test(command))) score += 8;
  else findings.push({ code: 'missing_runtime_verification', severity: 'warn', message: 'Patch manifest has no syntax or test command.' });
  if (workEvidenceCommands.includes('git status --porcelain=v1') && workEvidenceCommands.includes('git diff --stat')) score += 5;
  else findings.push({ code: 'missing_work_evidence', severity: 'warn', message: 'Patch manifest should collect git status and diff stat evidence.' });
  if (fileChanges.some(change => /Xike Agent:|patch proposal|Review this governed source patch/i.test(change.content || ''))) {
    score -= 8;
    findings.push({ code: 'proposal_only_patch', severity: 'warn', message: 'Patch is a governed proposal marker, not a complete implementation.' });
  }
  if (fileChanges.some(change => Buffer.byteLength(String(change.content || ''), 'utf8') > 8 * 1024)) {
    score -= 8;
    findings.push({ code: 'large_patch_content', severity: 'warn', message: 'Patch content is large and should be reviewed before execution.' });
  }
  if (generation.mode === 'model_adapter') score += 5;
  if (generation.mode === 'local_fallback') score -= 3;
  if (generation.error) {
    score -= 10;
    findings.push({ code: 'generation_fallback', severity: 'warn', message: generation.error });
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 85 ? 'high' : score >= 70 ? 'medium' : score >= 50 ? 'low' : 'blocked';
  return {
    score,
    grade,
    source,
    safeToAutoExecute: false,
    fileChangeCount: fileChanges.length,
    commandCount: commands.length,
    workEvidenceCommandCount: workEvidenceCommands.length,
    findings,
    blockers,
    summary: `Patch quality ${grade} ${score}/100`,
  };
}

function buildIdeaWorkManifestContent(timeline = {}, draft = {}) {
  const run = timeline.run || {};
  const idea = str(run.details?.idea || run.taskId || run.id, 1000) || 'Idea Run';
  const files = draft.affectedFiles?.length ? draft.affectedFiles : ['none'];
  const tags = draft.dispatchTags?.length ? draft.dispatchTags : ['none'];
  const skills = draft.skills?.length ? draft.skills : ['none'];
  return [
    '# Xike Idea Work Manifest',
    '',
    `Run: ${run.id || '-'}`,
    `Idea: ${idea}`,
    `Agent Profile: ${draft.agentProfileId || run.agentProfileId || '-'}`,
    `Generated: ${draft.generatedAt || new Date().toISOString()}`,
    '',
    '## Scope',
    '',
    ...files.map((file) => `- ${file}`),
    '',
    '## Dispatch',
    '',
    `Tags: ${tags.join(', ')}`,
    `Skills: ${skills.join(', ')}`,
    '',
    '## Proposed Work',
    '',
    '- Review the affected files and apply the smallest project-local change that satisfies the idea.',
    '- Keep budget, approval, audit, delegation, Agent Run, Codebase Index, and Agent/Skill Registry behavior intact.',
    '- Verify with the allowlisted commands in this manifest before final archive.',
    '',
    '## Governance',
    '',
    '- This file is generated as a governed manifest artifact.',
    '- Draft generation does not write files or execute commands.',
    '- Execution must go through idea-auto-execute, PermissionGovernance, work evidence, verification, and final archive.',
    '',
  ].join('\n');
}

function buildLocalAgentChangeModuleContent(timeline = {}, draft = {}) {
  const run = timeline.run || {};
  const details = run.details || {};
  const idea = str(details.idea || run.taskId || run.id, 1000) || 'Idea Run';
  const affectedFiles = draft.affectedFiles?.length ? draft.affectedFiles : [];
  const proposedChanges = affectedFiles.length
    ? affectedFiles.map((file) => ({
      target: file,
      intent: `Review ${file} and apply the smallest project-local change needed for the idea.`,
      guardrail: 'Do not remove budget, approval, audit, delegation, Agent Run, Codebase Index, or Agent/Skill Registry behavior.',
    }))
    : [{
      target: 'project-local safe root',
      intent: 'Choose the smallest safe project-local file change after code context review.',
      guardrail: 'Keep the generated manifest editable and governed before execution.',
    }];
  const payload = {
    generator: 'local-agent-filechange-synthesizer',
    runId: run.id || draft.runId || null,
    manifestDraftId: draft.id || null,
    idea,
    agentProfileId: draft.agentProfileId || run.agentProfileId || null,
    dispatchTags: draft.dispatchTags || [],
    skills: draft.skills || [],
    affectedFiles,
    proposedChanges,
    acceptance: [
      'Manifest review happens before any file write.',
      'Execution must go through idea-auto-execute and PermissionGovernance.',
      'Work evidence and verification results must be archived on the Agent Run.',
    ],
    safeToAutoExecute: false,
  };
  return [
    'const xikeIdeaAgentChange = ',
    JSON.stringify(payload, null, 2),
    ';',
    '',
    'void xikeIdeaAgentChange;',
    '',
  ].join('\n');
}

function buildIdeaManifestDraft(timeline = {}, input = {}) {
  const run = timeline.run || {};
  const details = run.details || {};
  const affectedFiles = uniqueStrings([
    input.affectedFiles,
    input.files,
    details.affectedFiles,
  ]).slice(0, 12);
  const testFiles = manifestTestFilesForAffectedFiles(affectedFiles);
  const testCommand = testFiles.length
    ? `npm test -- ${testFiles.join(' ')}`
    : 'npm test -- tests/unit/agent-run-store.test.js tests/unit/routes/agent-runs-routes.test.js';
  const id = `idea-manifest-${randomUUID().slice(0, 12)}`;
  const generatedAt = new Date().toISOString();
  const draftBase = {
    id,
    runId: run.id,
    stage: 'idea_manifest_draft',
    generatedAt,
    generatedBy: str(input.requestedBy || input.actorType || 'system', 120) || 'system',
    agentProfileId: run.agentProfileId || details.agentProfileId || null,
    dispatchTags: normalizeArray(run.dispatchTags || details.dispatchTags || []),
    skills: normalizeArray(run.skills || details.skills || []),
    affectedFiles,
    safeToAutoExecute: false,
  };
  const workArtifactPath = `output/playwright/idea-work-${safeSlug(run.id)}-${id.replace(/^idea-manifest-/, '')}.md`;
  const agentChangePath = `output/playwright/idea-agent-change-${safeSlug(run.id)}-${id.replace(/^idea-manifest-/, '')}.js`;
  const fileChanges = input.includeFileChanges === false ? [] : [{
    operation: 'create',
    path: workArtifactPath,
    content: buildIdeaWorkManifestContent(timeline, draftBase),
    summary: 'Record the generated Agent work manifest artifact.',
  }, {
    operation: 'create',
    path: agentChangePath,
    content: buildLocalAgentChangeModuleContent(timeline, draftBase),
    summary: 'Record the generated local Agent file-change plan.',
  }];
  const agentCheckCommand = fileChanges.length ? `node --check ${agentChangePath}` : null;
  const affectedCheckCommands = manifestCheckCommandsForAffectedFiles(affectedFiles).slice(0, agentCheckCommand ? 3 : 4);
  const commands = [
    'git diff --check',
    ...(agentCheckCommand ? [agentCheckCommand] : []),
    ...affectedCheckCommands,
    testCommand,
  ];
  const manifest = {
    fileChanges,
    workEvidenceCommands: ['git status --porcelain=v1', 'git diff --stat'],
    commands: [...new Set(commands)].slice(0, 6),
    evidenceArtifacts: [],
  };
  if (input.approvalId || run.approvalId || details.approvalId) {
    manifest.approvalId = str(input.approvalId || run.approvalId || details.approvalId, 160);
  }
  const rationale = [
    affectedFiles.length ? `Scoped from ${affectedFiles.length} affected files.` : 'No affected files supplied; use baseline Agent Run verification.',
    fileChanges.length ? `Generated a governed work artifact at ${workArtifactPath}.` : 'No file changes requested for this draft.',
    fileChanges.length ? `Generated a local Agent file-change plan at ${agentChangePath}.` : null,
    'Only allowlisted project-local commands are suggested.',
    'Draft generation does not write files or execute commands.',
  ].filter(Boolean);
  return {
    ...draftBase,
    manifest,
    rationale,
    summary: `Generated work manifest draft with ${manifest.fileChanges.length} file changes, ${manifest.commands.length} verification commands, and ${manifest.workEvidenceCommands.length} work evidence commands.`,
  };
}

function buildIdeaPatchManifestDraft(timeline = {}, input = {}) {
  const run = timeline.run || {};
  const details = run.details || {};
  const affectedFiles = uniqueStrings([
    input.affectedFiles,
    input.files,
    details.affectedFiles,
  ]).slice(0, 12);
  const id = `idea-patch-manifest-${randomUUID().slice(0, 12)}`;
  const generatedAt = new Date().toISOString();
  const generation = {
    mode: str(input.generation?.mode || input.providerMode || 'local_fallback', 80) || 'local_fallback',
    adapterId: str(input.generation?.adapterId || input.adapterId, 160),
    modelId: str(input.generation?.modelId || input.modelId, 160),
    error: str(input.generation?.error || input.modelError, 1000),
    rawSummary: str(input.generation?.rawSummary || input.modelRawSummary, 1000),
  };
  const modelFileChanges = safeModelFileChanges(input.modelManifest || input.manifest);
  const fileChanges = input.includeFileChanges === false
    ? []
    : (modelFileChanges.length ? modelFileChanges : [buildFallbackSourcePatch(timeline, { affectedFiles, runId: run.id })]);
  const sourcePatchChecks = manifestCheckCommandsForAffectedFiles(fileChanges.map((item) => item.path)).slice(0, 3);
  const fallbackTests = manifestTestFilesForAffectedFiles([...affectedFiles, ...fileChanges.map((item) => item.path)]);
  const testCommand = fallbackTests.length
    ? `npm test -- ${fallbackTests.join(' ')}`
    : 'npm test -- tests/unit/agent-run-store.test.js tests/unit/routes/agent-runs-routes.test.js';
  const manifest = {
    fileChanges,
    workEvidenceCommands: ['git status --porcelain=v1', 'git diff --stat'],
    commands: [...new Set(['git diff --check', ...sourcePatchChecks, testCommand])].slice(0, 6),
    evidenceArtifacts: [],
  };
  if (input.approvalId || run.approvalId || details.approvalId) {
    manifest.approvalId = str(input.approvalId || run.approvalId || details.approvalId, 160);
  }
  const source = modelFileChanges.length ? 'model adapter output' : 'local fallback synthesizer';
  const patchQuality = sourcePatchQuality(manifest, { generation, affectedFiles, source });
  return {
    id,
    runId: run.id,
    stage: 'idea_patch_manifest_draft',
    generatedAt,
    generatedBy: str(input.requestedBy || input.actorType || 'system', 120) || 'system',
    agentProfileId: run.agentProfileId || details.agentProfileId || null,
    dispatchTags: normalizeArray(run.dispatchTags || details.dispatchTags || []),
    skills: normalizeArray(run.skills || details.skills || []),
    affectedFiles,
    generation,
    patchQuality,
    safeToAutoExecute: false,
    manifest,
    rationale: [
      `Generated ${fileChanges.length} governed source patch file changes from ${source}.`,
      patchQuality.summary,
      generation.error ? `Model adapter unavailable or failed: ${generation.error}` : null,
      'Patch draft generation does not write files or execute commands.',
      'Execution must go through idea-auto-execute, PermissionGovernance, work evidence, verification, and final archive.',
    ].filter(Boolean),
    summary: `Generated source patch manifest draft with ${manifest.fileChanges.length} file changes via ${generation.mode}; ${patchQuality.summary}.`,
  };
}

function buildGovernanceLineage(run = {}, activityEvents = []) {
  const eventIds = activityEvents.map(lineageIdsFromEvent);
  const ids = mergeLineageIds(lineageIdsFromRun(run), ...eventIds);
  const lineage = {
    ids,
    approvals: lineageItems('approvalIds', ids.approvalIds, activityEvents),
    delegations: lineageItems('delegationIds', ids.delegationIds, activityEvents),
    budgetIncidents: lineageItems('budgetIncidentIds', ids.budgetIncidentIds, activityEvents),
    autopilotJobs: lineageItems('autopilotJobIds', ids.autopilotJobIds, activityEvents),
    activityEventIds: ids.activityEventIds,
  };
  lineage.blockers = lineageBlockers(run, lineage);
  lineage.nextAction = nextLineageAction(lineage);
  lineage.summary = {
    approvalCount: lineage.approvals.length,
    delegationCount: lineage.delegations.length,
    budgetIncidentCount: lineage.budgetIncidents.length,
    autopilotJobCount: lineage.autopilotJobs.length,
    activityEventCount: lineage.activityEventIds.length,
    blockerCount: lineage.blockers.length,
    nextActionType: lineage.nextAction.type,
  };
  return lineage;
}

function withRunLineageSummary(run, activityEvents = []) {
  if (!run) return null;
  const lineage = buildGovernanceLineage(run, activityEvents);
  return { ...run, lineageSummary: lineage.summary };
}

function buildSessionGovernance(timelines = [], activityEvents = []) {
  const lineageItemsByKind = {
    approvals: new Map(),
    delegations: new Map(),
    budgetIncidents: new Map(),
    autopilotJobs: new Map(),
  };
  const blockers = [];
  const nextActions = [];
  for (const timeline of timelines || []) {
    const run = timeline?.run || {};
    const lineage = timeline?.governanceLineage || {};
    for (const kind of Object.keys(lineageItemsByKind)) {
      for (const item of lineage[kind] || []) {
        if (!item?.id) continue;
        lineageItemsByKind[kind].set(item.id, {
          ...lineageItemsByKind[kind].get(item.id),
          ...item,
          runIds: uniqueStrings([lineageItemsByKind[kind].get(item.id)?.runIds || [], run.id]),
        });
      }
    }
    for (const blocker of lineage.blockers || []) {
      blockers.push({
        ...blocker,
        runId: run.id,
        runStatus: run.status,
      });
    }
    const action = lineage.nextAction || {};
    if (action.type && action.type !== 'none') {
      nextActions.push({
        ...action,
        runId: run.id,
        runStatus: run.status,
      });
    }
  }
  const approvals = [...lineageItemsByKind.approvals.values()];
  const delegations = [...lineageItemsByKind.delegations.values()];
  const budgetIncidents = [...lineageItemsByKind.budgetIncidents.values()];
  const autopilotJobs = [...lineageItemsByKind.autopilotJobs.values()];
  return {
    approvals,
    delegations,
    budgetIncidents,
    autopilotJobs,
    blockers,
    nextActions,
    activityEventIds: normalizeIdArray(activityEvents.map((event) => event.id)),
    summary: {
      approvalCount: approvals.length,
      delegationCount: delegations.length,
      budgetIncidentCount: budgetIncidents.length,
      autopilotJobCount: autopilotJobs.length,
      blockerCount: blockers.length,
      nextActionCount: nextActions.length,
      activityEventCount: activityEvents.length,
    },
  };
}

function evidenceTime(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function evidenceIso(value) {
  const time = evidenceTime(value);
  return time > 0 ? new Date(time).toISOString() : null;
}

function compactText(value, max = 260) {
  return str(value, max) || '';
}

function pushSessionEvidenceItem(items, input = {}) {
  const kind = str(input.kind, 80);
  const id = str(input.id, 240);
  const runId = str(input.runId, 160);
  if (!kind || (!id && !runId)) return;
  items.push({
    kind,
    subkind: str(input.subkind, 120),
    id: id || `${kind}:${runId}:${items.length + 1}`,
    runId,
    at: evidenceIso(input.at) || evidenceIso(input.createdAt) || evidenceIso(input.updatedAt),
    status: str(input.status, 80),
    title: compactText(input.title, 220) || kind,
    summary: compactText(input.summary, 500),
    refs: {
      messageId: str(input.messageId, 160),
      toolResultId: str(input.toolResultId, 160),
      archiveId: str(input.archiveId, 160),
      activityEventId: Number.isFinite(Number(input.activityEventId)) ? Number(input.activityEventId) : null,
      approvalId: str(input.approvalId, 160),
      delegationId: str(input.delegationId, 160),
      budgetIncidentId: str(input.budgetIncidentId, 160),
      gateId: str(input.gateId, 160),
      gateSha256: str(input.gateSha256, 128),
      citationIds: normalizeArray(input.citationIds || []).slice(0, 12),
      paths: normalizeArray(input.paths || []).slice(0, 12),
    },
    counts: {
      messages: Math.max(0, Number(input.messageCount) || 0),
      toolResults: Math.max(0, Number(input.toolResultCount) || 0),
      activityEvents: Math.max(0, Number(input.activityEventCount) || 0),
      citations: Math.max(0, Number(input.citationCount) || 0),
      files: Math.max(0, Number(input.fileCount) || 0),
      commands: Math.max(0, Number(input.commandCount) || 0),
    },
  });
}

function codeQuestionCitationIds(answer = {}) {
  return Array.isArray(answer?.citations)
    ? answer.citations.map((item) => item.id || item.label || item.path).filter(Boolean)
    : [];
}

function buildSessionEvidenceChain({ sessionId, timelines = [], activityEvents = [], archives = [] } = {}) {
  const items = [];
  for (const timeline of timelines || []) {
    const run = timeline?.run || {};
    if (!run.id) continue;
    pushSessionEvidenceItem(items, {
      kind: 'run',
      subkind: run.sourceType || 'manual',
      id: run.id,
      runId: run.id,
      at: run.createdAt,
      status: run.status,
      title: run.taskId || run.sourceType || run.id,
      summary: `${run.agentProfileId || 'unassigned'} · ${run.status || 'unknown'} · ${run.sourceType || 'manual'}`,
      approvalId: run.approvalId || run.details?.approvalId,
      delegationId: run.delegationId || run.details?.delegationId,
      budgetIncidentId: run.budgetIncidentId || run.details?.budgetIncidentId,
      messageCount: (timeline.messages || []).length,
      toolResultCount: (timeline.toolResults || []).length,
      activityEventCount: (timeline.activityEvents || []).length,
    });
    const codeQuestion = normalizeCodebaseQuestionAnswer(run.details?.codebaseQuestionAnswer);
    if (codeQuestion) {
      pushSessionEvidenceItem(items, {
        kind: 'codebase_question',
        subkind: codeQuestion.mode,
        id: `${run.id}:codebase-question`,
        runId: run.id,
        at: run.createdAt,
        status: codeQuestion.confidence,
        title: codeQuestion.question || 'Local Code Answer',
        summary: codeQuestion.answer || codeQuestion.answerLines?.join(' '),
        citationIds: codeQuestionCitationIds(codeQuestion),
        citationCount: codeQuestion.citations.length,
        fileCount: codeQuestion.coverage?.uniqueFileCount || 0,
      });
    }
    const gate = normalizeApprovalResumeGateAudit(run.details?.approvalResumeGateAudit);
    if (gate) {
      pushSessionEvidenceItem(items, {
        kind: 'approval_resume_gate',
        subkind: gate.status,
        id: `${run.id}:${gate.id}`,
        runId: run.id,
        at: gate.recordedAt || run.updatedAt,
        status: gate.safeToResume ? 'accepted' : 'blocked',
        title: gate.id,
        summary: `gate ${gate.sha256 || '-'} · files ${gate.counts.fileChanges || 0} · commands ${gate.counts.commands || 0}`,
        approvalId: gate.approvalId,
        gateId: gate.id,
        gateSha256: gate.sha256,
        fileCount: gate.counts.fileChanges,
        commandCount: gate.counts.commands,
      });
    }
    for (const message of timeline.messages || []) {
      pushSessionEvidenceItem(items, {
        kind: 'message',
        subkind: message.kind,
        id: message.id,
        runId: run.id,
        messageId: message.id,
        at: message.createdAt,
        status: message.status,
        title: `${message.kind || 'message'} / ${message.role || '-'}`,
        summary: message.summary || message.content || message.payload?.archive?.summary || message.payload?.manifestDraft?.summary,
        citationIds: codeQuestionCitationIds(message.payload?.codebaseQuestionAnswer || message.payload?.archive?.context?.codebaseQuestionAnswer),
      });
      const messageGate = normalizeApprovalResumeGateAudit(message.payload?.approvalResumeGateAudit || message.payload?.resumeReviewGateAudit);
      if (messageGate) {
        pushSessionEvidenceItem(items, {
          kind: 'approval_resume_gate',
          subkind: `message:${message.kind}`,
          id: `${message.id}:${messageGate.id}`,
          runId: run.id,
          messageId: message.id,
          at: message.createdAt,
          status: messageGate.safeToResume ? 'accepted' : 'blocked',
          title: messageGate.id,
          summary: `message gate ${messageGate.sha256 || '-'}`,
          approvalId: messageGate.approvalId,
          gateId: messageGate.id,
          gateSha256: messageGate.sha256,
          fileCount: messageGate.counts.fileChanges,
          commandCount: messageGate.counts.commands,
        });
      }
    }
    for (const result of timeline.toolResults || []) {
      pushSessionEvidenceItem(items, {
        kind: 'tool_result',
        subkind: result.toolName,
        id: result.id,
        runId: run.id,
        toolResultId: result.id,
        at: result.createdAt,
        status: result.status,
        title: result.toolName,
        summary: result.outputSummary || result.inputSummary,
        approvalId: result.approvalId,
      });
    }
  }
  for (const archive of archives || []) {
    pushSessionEvidenceItem(items, {
      kind: 'archive',
      subkind: archive.status || 'archive',
      id: archive.id || archive.messageId,
      runId: archive.runId,
      messageId: archive.messageId,
      archiveId: archive.id,
      at: archive.createdAt,
      status: archive.status,
      title: archive.id || 'Execution Archive',
      summary: archive.summary,
      messageCount: archive.evidence?.messageIds?.length || 0,
      toolResultCount: archive.evidence?.toolResultIds?.length || archive.verification?.toolResultCount || 0,
      activityEventCount: archive.evidence?.activityEventIds?.length || 0,
      citationIds: codeQuestionCitationIds(archive.context?.codebaseQuestionAnswer || archive.evidence?.external?.codebaseQuestionAnswer),
      citationCount: archive.context?.codebaseQuestionCitationCount || archive.evidence?.external?.codebaseQuestionAnswer?.citations?.length || 0,
      fileCount: archive.evidence?.files?.length || archive.evidence?.external?.fileChanges?.length || 0,
    });
  }
  for (const event of activityEvents || []) {
    pushSessionEvidenceItem(items, {
      kind: 'activity',
      subkind: event.action || event.tag,
      id: `activity:${event.id}`,
      runId: event.agentRunId || event.details?.agentRunId || (event.entityType === 'agent_run' ? event.entityId : null),
      activityEventId: event.id,
      at: event.ts || event.createdAt,
      status: event.status,
      title: event.action || event.tag || `activity:${event.id}`,
      summary: event.entityType ? `${event.entityType}:${event.entityId || '-'}` : event.severity,
      approvalId: event.details?.approvalId || (event.entityType === 'approval' ? event.entityId : null),
      delegationId: event.details?.delegationId || (event.entityType === 'delegation' ? event.entityId : null),
      budgetIncidentId: event.details?.budgetIncidentId || (event.entityType === 'budget_incident' ? event.entityId : null),
      gateId: event.details?.approvalResumeGateAudit?.id || event.details?.resumeReviewGateAudit?.id,
      gateSha256: event.details?.approvalResumeGateAudit?.sha256 || event.details?.resumeReviewGateAudit?.sha256,
    });
  }
  const sorted = items
    .sort((a, b) => evidenceTime(a.at) - evidenceTime(b.at) || String(a.kind).localeCompare(String(b.kind)) || String(a.id).localeCompare(String(b.id)))
    .map((item, index) => ({ sequence: index + 1, ...item }));
  const kindCounts = countBy(sorted, (item) => item.kind);
  const signature = JSON.stringify(sorted.map((item) => [item.kind, item.id, item.runId, item.at, item.status]));
  return {
    id: `session-chain-${createHash('sha1').update(`${sessionId || ''}:${signature}`).digest('hex').slice(0, 12)}`,
    sessionId: str(sessionId, 240),
    generatedAt: new Date().toISOString(),
    summary: {
      itemCount: sorted.length,
      runCount: kindCounts.run || 0,
      messageCount: kindCounts.message || 0,
      toolResultCount: kindCounts.tool_result || 0,
      archiveCount: kindCounts.archive || 0,
      activityEventCount: kindCounts.activity || 0,
      codebaseQuestionCount: kindCounts.codebase_question || 0,
      approvalResumeGateCount: kindCounts.approval_resume_gate || 0,
      firstAt: sorted[0]?.at || null,
      lastAt: sorted[sorted.length - 1]?.at || null,
      kindCounts,
    },
    refs: {
      runIds: uniqueStrings(sorted.map((item) => item.runId)),
      messageIds: uniqueStrings(sorted.map((item) => item.refs.messageId)),
      toolResultIds: uniqueStrings(sorted.map((item) => item.refs.toolResultId)),
      archiveIds: uniqueStrings(sorted.map((item) => item.refs.archiveId)),
      activityEventIds: normalizeIdArray(sorted.map((item) => item.refs.activityEventId)),
      approvalIds: uniqueStrings(sorted.map((item) => item.refs.approvalId)),
      delegationIds: uniqueStrings(sorted.map((item) => item.refs.delegationId)),
      budgetIncidentIds: uniqueStrings(sorted.map((item) => item.refs.budgetIncidentId)),
      gateIds: uniqueStrings(sorted.map((item) => item.refs.gateId)),
      citationIds: uniqueStrings(sorted.flatMap((item) => item.refs.citationIds || [])),
    },
    items: sorted,
  };
}

function formatAgentRunSessionMarkdown(snapshot = {}) {
  const counts = snapshot.counts || {};
  const governance = snapshot.governance || {};
  const chain = snapshot.evidenceChain || {};
  const lines = [
    `# Agent Run Session ${snapshot.sessionId || '-'}`,
    '',
    `- Exported At: ${snapshot.exportedAt || '-'}`,
    `- Latest Run: ${snapshot.latestRun?.id || '-'}`,
    `- Runs: ${counts.runs || 0}`,
    `- Messages: ${counts.messages || 0}`,
    `- Tool Results: ${counts.toolResults || 0}`,
    `- Archives: ${counts.archives || 0}`,
    `- Activity Events: ${counts.activityEvents || 0}`,
    '',
    '## Governance',
    '',
    `- Approvals: ${governance.summary?.approvalCount || 0}`,
    `- Delegations: ${governance.summary?.delegationCount || 0}`,
    `- Budget Incidents: ${governance.summary?.budgetIncidentCount || 0}`,
    `- Autopilot Jobs: ${governance.summary?.autopilotJobCount || 0}`,
    `- Blockers: ${governance.summary?.blockerCount || 0}`,
    `- Next Actions: ${governance.summary?.nextActionCount || 0}`,
    '',
    '## Session Evidence Chain',
    '',
    `- Chain: ${chain.id || '-'}`,
    `- Items: ${chain.summary?.itemCount || 0}`,
    `- Runs: ${chain.summary?.runCount || 0}`,
    `- Messages: ${chain.summary?.messageCount || 0}`,
    `- Tool Results: ${chain.summary?.toolResultCount || 0}`,
    `- Archives: ${chain.summary?.archiveCount || 0}`,
    `- Activity: ${chain.summary?.activityEventCount || 0}`,
    `- Code Questions: ${chain.summary?.codebaseQuestionCount || 0}`,
    `- Approval Gates: ${chain.summary?.approvalResumeGateCount || 0}`,
  ];
  for (const item of chain.items || []) {
    lines.push('', `### ${item.sequence}. ${item.kind}${item.subkind ? ` / ${item.subkind}` : ''}`, '');
    lines.push(`- Run: ${item.runId || '-'}`);
    lines.push(`- ID: ${item.id || '-'}`);
    lines.push(`- At: ${item.at || '-'}`);
    lines.push(`- Status: ${item.status || '-'}`);
    lines.push(`- Title: ${item.title || '-'}`);
    if (item.summary) lines.push(`- Summary: ${item.summary}`);
  }
  return lines.join('\n');
}

export class AgentRunStore {
  constructor({ logger = console, audit = activityLog } = {}) {
    this.logger = logger;
    this.audit = audit;
    // 可选归档钩子（server.js 注入）：run 归档后增量索引证据知识库。
    // 解耦 agents→knowledge，失败由 recordArchive 内 try/catch 吞掉，不阻断归档。
    this._archiveHook = null;
  }

  // 注入归档钩子；传 null 清除。签名 (id, { run, timeline }) => void
  setArchiveHook(fn) {
    this._archiveHook = typeof fn === 'function' ? fn : null;
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
    if (query.deferReason) { where.push('defer_reason = ?'); args.push(str(query.deferReason, 160)); }
    if (query.approvalResumeGateId || query.reviewGateId) {
      const gateId = str(query.approvalResumeGateId || query.reviewGateId, 160);
      where.push("(json_extract(details, '$.approvalResumeGateId') = ? OR json_extract(details, '$.approvalResumeGateAudit.id') = ?)");
      args.push(gateId, gateId);
    }
    if (query.approvalResumeGateSha256 || query.reviewSha256) {
      const gateSha = str(query.approvalResumeGateSha256 || query.reviewSha256, 128);
      where.push("(json_extract(details, '$.approvalResumeGateSha256') LIKE ? OR json_extract(details, '$.approvalResumeGateAudit.sha256') LIKE ?)");
      args.push(`${gateSha}%`, `${gateSha}%`);
    }
    if (query.hasGovernance === true || query.hasGovernance === 'true' || query.hasGovernance === '1') {
      where.push('(approval_id IS NOT NULL OR budget_incident_id IS NOT NULL OR delegation_id IS NOT NULL)');
    }
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 100));
    const sql = `SELECT * FROM agent_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`;
    return this.db().prepare(sql).all(...args, limit).map(rowToRun);
  }

  getSessionSnapshot(sessionId, options = {}) {
    const sid = str(sessionId);
    if (!sid) return null;
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 100));
    const rows = this.db().prepare('SELECT * FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?').all(sid, limit).reverse();
    if (!rows.length) return null;
    const timelines = rows.map((row) => this.getTimeline(row.id)).filter(Boolean);
    const runs = timelines.map((timeline) => timeline.run);
    const eventMap = new Map();
    const sessionEvents = typeof this.audit?.list === 'function'
      ? this.audit.list({ sessionId: sid, order: 'ASC', limit: 1000 })
      : [];
    for (const event of sessionEvents || []) eventMap.set(activityEventKey(event), event);
    for (const timeline of timelines) {
      for (const event of timeline.activityEvents || []) eventMap.set(activityEventKey(event), event);
    }
    const activityEvents = [...eventMap.values()]
      .sort((a, b) => Number(a.ts || a.createdAt || 0) - Number(b.ts || b.createdAt || 0));
    const archives = timelines.flatMap((timeline) => (timeline.archives || []).map((archive) => ({
      ...archive,
      runId: timeline.run.id,
      runStatus: timeline.run.status,
    })));
    const artifacts = collectArchiveArtifacts(archives, null);
    const evidenceChain = buildSessionEvidenceChain({
      sessionId: sid,
      timelines,
      activityEvents,
      archives,
    });
    const latestRun = [...runs].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
    const messageCount = timelines.reduce((sum, timeline) => sum + (timeline.messages || []).length, 0);
    const toolResultCount = timelines.reduce((sum, timeline) => sum + (timeline.toolResults || []).length, 0);
    return {
      sessionId: sid,
      latestRun,
      runs,
      counts: {
        runs: runs.length,
        messages: messageCount,
        toolResults: toolResultCount,
        archives: archives.length,
        artifacts: artifacts.length,
        activityEvents: activityEvents.length,
      },
      statusCounts: countBy(runs, (run) => run.status),
      sourceTypeCounts: countBy(runs, (run) => run.sourceType || 'manual'),
      agentProfileCounts: countBy(runs, (run) => run.agentProfileId || 'unassigned'),
      governance: buildSessionGovernance(timelines, activityEvents),
      archives,
      artifacts,
      activityEvents,
      evidenceChain,
    };
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

  relatedActivityEvents(run) {
    const activityEvents = [];
    if (!run || typeof this.audit?.list !== 'function') return activityEvents;
    const directEvents = this.audit.list({ entityType: 'agent_run', entityId: run.id, order: 'ASC', limit: 1000 });
    const recentEvents = this.audit.list({ order: 'ASC', limit: 1000 });
    const relatedIds = new Set(run.relatedActivityIds || []);
    const approvalId = run.approvalId || run.details?.approvalId;
    const delegationId = run.delegationId || run.details?.delegationId;
    const jobId = run.details?.jobId || run.details?.autopilotJobId;
    const budgetIncidentIds = new Set([
      run.budgetIncidentId,
      ...(run.details?.budgetIncidentIds || []),
    ].filter(Boolean));
    const includeEvent = (event) => {
      if (!event) return false;
      if (event.entityType === 'agent_run' && event.entityId === run.id) return true;
      if (relatedIds.has(Number(event.id))) return true;
      if (event.details?.agentRunId === run.id) return true;
      if (approvalId && event.entityType === 'approval' && event.entityId === approvalId) return true;
      if (delegationId && event.entityType === 'delegation' && event.entityId === delegationId) return true;
      if (jobId && event.entityType === 'autopilot_job' && event.entityId === jobId) return true;
      if (event.details?.approvalId && event.details.approvalId === approvalId) return true;
      if (event.details?.delegationId && event.details.delegationId === delegationId) return true;
      if (event.details?.jobId && event.details.jobId === jobId) return true;
      if (event.details?.autopilotJobId && event.details.autopilotJobId === jobId) return true;
      if (event.details?.budgetIncidentId && budgetIncidentIds.has(event.details.budgetIncidentId)) return true;
      return false;
    };
    const byId = new Map();
    for (const event of [...directEvents, ...recentEvents].filter(includeEvent)) byId.set(event.id, event);
    activityEvents.push(...[...byId.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)));
    return activityEvents;
  }

  getTimeline(id) {
    const run = this.get(id);
    if (!run) return null;
    const messages = this.db().prepare('SELECT * FROM agent_messages WHERE run_id = ? ORDER BY created_at ASC').all(id).map(rowToMessage);
    const toolResults = this.db().prepare('SELECT * FROM agent_tool_results WHERE run_id = ? ORDER BY created_at ASC').all(id).map(rowToToolResult);
    const activityEvents = this.relatedActivityEvents(run);
    const governanceLineage = buildGovernanceLineage(run, activityEvents);
    const archives = messages
      .filter((message) => message.kind === 'archive' && message.payload?.archive)
      .map((message) => ({ ...message.payload.archive, messageId: message.id }));
    const artifacts = collectArchiveArtifacts(archives, run.id);
    return {
      run: { ...run, lineageSummary: governanceLineage.summary },
      messages,
      toolResults,
      activityEvents,
      governanceLineage,
      archives,
      artifacts,
    };
  }

  listArtifacts(id, filters = {}) {
    const timeline = this.getTimeline(id);
    if (!timeline) return null;
    const artifacts = filterArtifacts(timeline.artifacts || collectArchiveArtifacts(timeline.archives, timeline.run.id), filters);
    return {
      run: timeline.run,
      artifacts,
      count: artifacts.length,
      allowedRoots: ARCHIVE_ARTIFACT_DOWNLOAD_ROOTS,
    };
  }

  readArtifact(id, input = {}) {
    const listed = this.listArtifacts(id);
    if (!listed) throw new Error('agent run not found');
    const artifactId = str(input.artifactId || input.id, 200);
    const requestedPath = normalizeArtifactRelPath(input.path);
    const artifact = listed.artifacts.find((item) => (
      (artifactId && item.id === artifactId) || (requestedPath && item.path === requestedPath)
    ));
    if (!artifact) throw new Error('artifact is not recorded for this agent run');
    if (!artifact.downloadable) throw new Error('artifact path is not allowed for download');
    const cwd = resolve(str(input.cwd, 2000) || process.cwd());
    const relPath = normalizeArtifactRelPath(artifact.path);
    const downloadRoot = artifactPathDownloadRoot(relPath);
    if (!relPath || !downloadRoot) throw new Error('artifact path is not allowed for download');
    const targetPath = resolve(cwd, relPath);
    const safeRoot = resolve(cwd, downloadRoot);
    if (!targetPath.startsWith(`${safeRoot}/`) && targetPath !== safeRoot) {
      throw new Error('artifact path escapes allowed archive roots');
    }
    if (!existsSync(targetPath)) throw new Error('artifact file not found');
    const stat = statSync(targetPath);
    if (!stat.isFile()) throw new Error('artifact path is not a file');
    const content = readFileSync(targetPath, 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (artifact.sha256 && artifact.sha256 !== sha256) throw new Error('artifact digest mismatch');
    return {
      artifact: {
        ...artifact,
        exists: true,
        size: stat.size,
        sha256,
      },
      content,
      contentType: 'text/markdown; charset=utf-8',
      filename: basename(relPath),
    };
  }

  recordReplayPlan(id, input = {}) {
    const timeline = this.getTimeline(id);
    if (!timeline) throw new Error('agent run not found');
    const replayPlan = buildReplayPlan(timeline, input);
    const message = this.appendMessage(id, {
      kind: 'replay_plan',
      role: 'system',
      status: 'planned',
      summary: replayPlan.summary,
      payload: { replayPlan },
    });
    const run = this.get(id);
    this.recordRunActivity({
      action: 'agent.run.replay_planned',
      actorType: input.actorType || 'system',
      run,
      status: run.status,
      details: {
        replayPlanId: replayPlan.id,
        messageId: message.id,
        nextActionType: replayPlan.nextAction?.type || 'none',
        blockerKinds: replayPlan.blockers.map((item) => item.kind),
        safeToAutoExecute: replayPlan.safeToAutoExecute,
      },
    });
    return { replayPlan, message, run: this.get(id) };
  }

  recordReplayResult(id, input = {}) {
    const timeline = this.getTimeline(id);
    if (!timeline) throw new Error('agent run not found');
    const replayResult = buildReplayResult(timeline, input);
    const message = this.appendMessage(id, {
      kind: 'replay_result',
      role: 'system',
      status: replayResult.status,
      summary: replayResult.summary,
      payload: { replayResult },
    });
    const run = this.get(id);
    this.recordRunActivity({
      action: 'agent.run.replay_result_recorded',
      actorType: input.actorType || 'system',
      run,
      status: replayResult.status,
      severity: /fail|error/i.test(replayResult.status) ? 'error' : 'info',
      details: {
        replayResultId: replayResult.id,
        replayPlanId: replayResult.replayPlanId,
        messageId: message.id,
        safeToAutoExecute: replayResult.safeToAutoExecute,
      },
    });
    return { replayResult, message, run: this.get(id) };
  }

  recordArchive(id, input = {}) {
    const timeline = this.getTimeline(id);
    if (!timeline) throw new Error('agent run not found');
    const archive = buildExecutionArchive(timeline, input);
    const message = this.appendMessage(id, {
      kind: 'archive',
      role: 'system',
      status: 'archived',
      summary: archive.summary,
      payload: { archive },
    });
    const run = this.get(id);
    const artifacts = collectArchiveArtifacts([{ ...archive, messageId: message.id }], run.id);
    this.recordRunActivity({
      action: 'agent.run.archived',
      actorType: input.actorType || 'system',
      run,
      status: run.status,
      details: {
        archiveId: archive.id,
        messageId: message.id,
        safeToAutoExecute: archive.safeToAutoExecute,
        toolResultCount: archive.verification.toolResultCount,
        blockerCount: archive.governance.summary?.blockerCount || 0,
        artifactCount: artifacts.length,
        artifacts: archiveArtifactActivitySummary(artifacts),
      },
    });
    const result = { archive, message, run: this.get(id) };
    if (this._archiveHook) {
      try { this._archiveHook(id, { run: result.run, timeline }); }
      catch (e) { this.logger?.warn?.('archiveHook 失败（忽略，不阻断归档）:', e?.message || e); }
    }
    return result;
  }

  recordApprovalResumeGateAudit(id, input = {}) {
    const run = this.get(id);
    if (!run) throw new Error('agent run not found');
    const audit = normalizeApprovalResumeGateAudit(input.audit || input.approvalResumeGateAudit || input.resumeReviewGateAudit || input);
    if (!audit) throw new Error('approval resume gate audit required');
    const status = str(input.status || audit.status || 'accepted', 80) || 'accepted';
    const storedAudit = { ...audit, status };
    const updated = this.transition(id, run.status, {
      approvalId: storedAudit.approvalId || run.approvalId,
      approvalResumeGateAudit: storedAudit,
      approvalResumeGateId: storedAudit.id,
      approvalResumeGateSha256: storedAudit.sha256,
    });
    const message = this.appendMessage(id, {
      kind: 'decision',
      role: 'system',
      status,
      summary: `Approval resume gate ${status}: ${storedAudit.id}`,
      payload: {
        approvalResumeGateAudit: storedAudit,
      },
    });
    this.recordRunActivity({
      action: `agent.run.approval_resume_gate_${status}`,
      actorType: input.actorType || 'system',
      run: updated,
      status: updated.status,
      details: {
        messageId: message.id,
        approvalResumeGateAudit: storedAudit,
      },
    });
    return {
      audit: storedAudit,
      message,
      run: this.get(id),
    };
  }

  createIdeaRun(input = {}) {
    const draft = buildIdeaRunDraft(input);
    const run = this.create({
      id: str(input.id, 160),
      status: input.status || 'queued',
      roomId: input.roomId,
      sessionId: input.sessionId,
      taskId: str(input.taskId, 240) || `idea:${draft.idea.slice(0, 120)}`,
      agentProfileId: str(input.agentProfileId || draft.profile?.id, 160),
      agentProfileTitle: str(input.agentProfileTitle || draft.profile?.title, 240),
      adapterId: input.adapterId || input.adapter,
      modelId: input.modelId || input.model,
      sourceType: 'idea_to_archive',
      sourceId: str(input.sourceId, 240) || `idea:${createHash('sha1').update(draft.idea).digest('hex').slice(0, 12)}`,
      skills: draft.skills,
      dispatchTags: draft.dispatchTags,
      governance: draft.governance,
      details: {
        ...(parseJson(input.details, {})),
        stage: 'idea_intake',
        idea: draft.idea,
        affectedFiles: draft.affectedFiles,
        ideaPlan: draft.plan,
        codebaseQuestionAnswer: draft.codebaseQuestionAnswer,
        codebaseQuestionCitationCount: draft.codebaseQuestionAnswer?.citations?.length || 0,
        codeContextEvidenceCount: Number(draft.classification?.codeContextEvidenceSummary?.fileCount) || 0,
        codeContextSignals: draft.classification?.codeContextSignals || null,
        missingSkillNames: normalizeArray(draft.classification?.missingSkillNames || []),
        skillDiagnostics: Array.isArray(draft.classification?.skillDiagnostics) ? draft.classification.skillDiagnostics.slice(0, 12) : [],
        safeToAutoExecute: false,
      },
      actorType: input.actorType || 'system',
    });
    const decision = this.appendMessage(run.id, {
      kind: 'decision',
      role: 'system',
      status: 'drafted',
      summary: `Idea intake drafted for ${draft.plan.suggested.agentProfileId || 'agent'}.`,
      payload: {
        idea: draft.idea,
        plan: draft.plan,
        codebaseQuestionAnswer: draft.codebaseQuestionAnswer,
        safeToAutoExecute: false,
      },
    });
    const summary = this.appendMessage(run.id, {
      kind: 'summary',
      role: 'system',
      status: 'drafted',
      summary: `Idea-to-Archive draft captured ${draft.affectedFiles.length} files, ${draft.dispatchTags.length} dispatch tags, and ${draft.codebaseQuestionAnswer?.citations?.length || 0} code question citations.`,
      payload: {
        dispatchTags: draft.dispatchTags,
        skills: draft.skills,
        missingSkillNames: normalizeArray(draft.classification?.missingSkillNames || []),
        codebaseQuestionAnswer: draft.codebaseQuestionAnswer,
      },
    });
    this.recordRunActivity({
      action: 'agent.run.idea_intake_created',
      actorType: input.actorType || 'system',
      run: this.get(run.id),
      status: 'queued',
      details: {
        idea: draft.idea,
        planMessageId: decision.id,
        summaryMessageId: summary.id,
        affectedFiles: draft.affectedFiles,
        dispatchTags: draft.dispatchTags,
        codebaseQuestionCoverage: draft.codebaseQuestionAnswer?.coverage || null,
        codebaseQuestionCitationCount: draft.codebaseQuestionAnswer?.citations?.length || 0,
        safeToAutoExecute: false,
      },
    });
    const archive = this.recordArchive(run.id, {
      actorType: input.actorType || 'system',
      requestedBy: input.requestedBy || input.actorType || 'system',
      summary: `Idea intake archived: ${draft.idea.slice(0, 160)}`,
      affectedFiles: draft.affectedFiles,
      evidence: {
        stage: 'idea_intake',
        dispatchTags: draft.dispatchTags,
        skills: draft.skills,
        missingSkillNames: normalizeArray(draft.classification?.missingSkillNames || []),
        codebaseQuestionAnswer: draft.codebaseQuestionAnswer,
      },
    });
    return {
      run: this.get(run.id),
      decision,
      summary,
      archive: archive.archive,
      archiveMessage: archive.message,
      plan: draft.plan,
    };
  }

  recordIdeaManifestDraft(id, input = {}) {
    const timeline = this.getTimeline(id);
    if (!timeline) throw new Error('agent run not found');
    if (timeline.run.sourceType !== 'idea_to_archive') throw new Error('agent run is not an idea_to_archive draft');
    if (FINISHED_STATUSES.has(timeline.run.status)) throw new Error('agent run already finished');
    const manifestDraft = buildIdeaManifestDraft(timeline, input);
    const message = this.appendMessage(id, {
      kind: 'manifest_draft',
      role: 'system',
      status: 'drafted',
      summary: `Manifest draft generated: ${manifestDraft.manifest.commands.join(', ')}`,
      payload: { manifestDraft },
    });
    const run = this.get(id);
    this.recordRunActivity({
      action: 'agent.run.idea_manifest_drafted',
      actorType: input.actorType || 'system',
      run,
      status: run.status,
      details: {
        manifestDraftId: manifestDraft.id,
        messageId: message.id,
        fileChangeCount: manifestDraft.manifest.fileChanges.length,
        commandCount: manifestDraft.manifest.commands.length,
        workEvidenceCommandCount: manifestDraft.manifest.workEvidenceCommands.length,
        affectedFiles: manifestDraft.affectedFiles,
        safeToAutoExecute: false,
      },
    });
    return { manifestDraft, message, run: this.get(id) };
  }

  recordIdeaPatchManifestDraft(id, input = {}) {
    const timeline = this.getTimeline(id);
    if (!timeline) throw new Error('agent run not found');
    if (timeline.run.sourceType !== 'idea_to_archive') throw new Error('agent run is not an idea_to_archive draft');
    if (FINISHED_STATUSES.has(timeline.run.status)) throw new Error('agent run already finished');
    const manifestDraft = buildIdeaPatchManifestDraft(timeline, input);
    const qualityFindings = (manifestDraft.patchQuality?.findings || []).map(item => item.code).filter(Boolean).slice(0, 4).join(', ');
    const message = this.appendMessage(id, {
      kind: 'manifest_draft',
      role: 'system',
      status: 'drafted',
      summary: `Patch manifest draft generated: ${manifestDraft.patchQuality?.summary || 'quality unavailable'}${qualityFindings ? `; findings ${qualityFindings}` : ''}; ${manifestDraft.manifest.commands.join(', ')}`,
      payload: { manifestDraft },
    });
    const run = this.get(id);
    this.recordRunActivity({
      action: 'agent.run.idea_patch_manifest_drafted',
      actorType: input.actorType || 'system',
      run,
      status: run.status,
      details: {
        manifestDraftId: manifestDraft.id,
        messageId: message.id,
        fileChangeCount: manifestDraft.manifest.fileChanges.length,
        commandCount: manifestDraft.manifest.commands.length,
        workEvidenceCommandCount: manifestDraft.manifest.workEvidenceCommands.length,
        affectedFiles: manifestDraft.affectedFiles,
        generation: manifestDraft.generation,
        patchQuality: manifestDraft.patchQuality,
        safeToAutoExecute: false,
      },
    });
    return { manifestDraft, message, run: this.get(id) };
  }

  completeIdeaRun(id, input = {}) {
    const timeline = this.getTimeline(id);
    if (!timeline) throw new Error('agent run not found');
    if (timeline.run.sourceType !== 'idea_to_archive') throw new Error('agent run is not an idea_to_archive draft');
    if (FINISHED_STATUSES.has(timeline.run.status)) throw new Error('agent run already finished');
    const execution = buildIdeaExecutionRecord(timeline, input);
    const started = timeline.run.status === 'running'
      ? timeline.run
      : this.transition(id, 'running', {
        stage: 'idea_execution',
        ideaExecutionId: execution.id,
        safeToAutoExecute: false,
      });
    const decision = this.appendMessage(id, {
      kind: 'decision',
      role: 'system',
      status: 'running',
      summary: `Idea execution started for ${started.taskId || id}.`,
      payload: {
        ideaExecutionId: execution.id,
        safeToAutoExecute: false,
      },
    });
    const toolResults = execution.verificationResults.map((item) => this.appendToolResult(id, {
      toolName: item.name,
      status: item.status,
      inputSummary: item.inputSummary,
      outputSummary: item.outputSummary,
      costUsd: item.costUsd,
      approvalId: item.approvalId,
      payload: {
        ...(item.payload || {}),
        ideaExecutionId: execution.id,
        stage: 'verification',
      },
    }));
    const summary = this.appendMessage(id, {
      kind: 'summary',
      role: 'system',
      status: execution.finalStatus,
      summary: execution.summary,
      payload: {
        ideaExecution: execution,
        verificationToolResultIds: toolResults.map((item) => item.id),
      },
    });
    const completed = this.transition(id, execution.finalStatus, {
      stage: 'idea_archived',
      ideaExecutionId: execution.id,
      executionSummary: execution.summary,
      verificationToolResultIds: toolResults.map((item) => item.id),
      affectedFiles: execution.affectedFiles,
      safeToAutoExecute: false,
      error: execution.finalStatus === 'failed' ? execution.summary : null,
    });
    this.recordRunActivity({
      action: 'agent.run.idea_execution_completed',
      actorType: input.actorType || 'system',
      run: completed,
      status: completed.status,
      severity: completed.status === 'failed' ? 'error' : 'info',
      details: {
        ideaExecutionId: execution.id,
        decisionMessageId: decision.id,
        summaryMessageId: summary.id,
        verificationToolResultIds: toolResults.map((item) => item.id),
        affectedFiles: execution.affectedFiles,
        safeToAutoExecute: false,
      },
    });
    const archive = this.recordArchive(id, {
      actorType: input.actorType || 'system',
      requestedBy: input.requestedBy || input.actorType || 'system',
      summary: input.archiveSummary || execution.summary,
      affectedFiles: execution.affectedFiles,
      evidence: {
        ...(execution.evidence || {}),
        stage: 'idea_final_archive',
        ideaExecutionId: execution.id,
        verificationToolResultIds: toolResults.map((item) => item.id),
      },
    });
    return {
      run: this.get(id),
      execution,
      decision,
      summary,
      toolResults,
      archive: archive.archive,
      archiveMessage: archive.message,
    };
  }

  exportRun(id, { format = 'json' } = {}) {
    const timeline = this.getTimeline(id);
    if (!timeline) return null;
    const approvalResumeGateAuditReport = buildApprovalResumeGateAuditReport(timeline);
    const sessionTimeline = timeline.run.sessionId ? this.getSessionSnapshot(timeline.run.sessionId) : null;
    const snapshot = {
      exportedAt: new Date().toISOString(),
      ...timeline,
      ...(sessionTimeline ? { sessionTimeline } : {}),
      ...(approvalResumeGateAuditReport ? { approvalResumeGateAuditReport } : {}),
      relatedActivityIds: normalizeIdArray([
        ...(timeline.run.relatedActivityIds || []),
        ...timeline.activityEvents.map((event) => event.id),
      ]),
    };
    if (String(format || 'json').toLowerCase() === 'markdown' || String(format || '').toLowerCase() === 'md') {
      return formatAgentRunMarkdown(snapshot);
    }
    return snapshot;
  }

  exportSession(sessionId, { format = 'json', limit } = {}) {
    const snapshot = this.getSessionSnapshot(sessionId, { limit });
    if (!snapshot) return null;
    const exported = {
      exportedAt: new Date().toISOString(),
      ...snapshot,
    };
    if (String(format || 'json').toLowerCase() === 'markdown' || String(format || '').toLowerCase() === 'md') {
      return formatAgentRunSessionMarkdown(exported);
    }
    return exported;
  }

  recordSessionEvidenceArtifact(sessionId, input = {}) {
    const exported = this.exportSession(sessionId, { format: 'json', limit: input.limit });
    if (!exported) throw new Error('agent run session not found');
    const sid = exported.sessionId;
    const archiveRunId = str(input.runId || input.agentRunId, 160) || exported.latestRun?.id;
    const archiveRun = this.get(archiveRunId);
    if (!archiveRun) throw new Error('agent run not found for session archive');
    if (archiveRun.sessionId !== sid) throw new Error('agent run does not belong to session');
    const cwd = resolve(str(input.cwd, 2000) || process.cwd());
    const chainId = exported.evidenceChain?.id || 'snapshot';
    const relPath = `output/playwright/session-evidence/agent-run-session-${safeSlug(sid, 'session')}-${safeSlug(chainId, 'chain')}.md`;
    const targetPath = resolve(cwd, relPath);
    const safeRoot = resolve(cwd, 'output/playwright/session-evidence');
    if (!targetPath.startsWith(`${safeRoot}/`) && targetPath !== safeRoot) {
      throw new Error('session evidence archive path must stay under output/playwright/session-evidence');
    }
    const markdown = formatAgentRunSessionMarkdown(exported);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `${markdown}\n`, 'utf8');
    const stat = statSync(targetPath);
    const artifact = {
      kind: 'agent_run_session_evidence_markdown',
      label: `Session evidence ${sid}`,
      path: relPath,
      exists: true,
      size: stat.size,
      sha256: createHash('sha256').update(`${markdown}\n`).digest('hex'),
      sessionId: sid,
      evidenceChainId: chainId,
      latestRunId: exported.latestRun?.id || null,
      runCount: exported.counts?.runs || 0,
      itemCount: exported.evidenceChain?.summary?.itemCount || 0,
      exportedAt: exported.exportedAt,
    };
    const archive = this.recordArchive(archiveRun.id, {
      actorType: input.actorType || 'system',
      requestedBy: input.requestedBy || 'owner',
      summary: input.summary || `Session evidence archived: ${artifact.path}`,
      evidence: {
        stage: 'session_evidence_archive',
        sessionEvidence: {
          sessionId: sid,
          exportedAt: exported.exportedAt,
          evidenceChainId: chainId,
          counts: exported.counts || {},
          summary: exported.evidenceChain?.summary || {},
          refs: exported.evidenceChain?.refs || {},
        },
        sessionEvidenceArtifact: artifact,
        evidenceArtifacts: [artifact],
      },
      affectedFiles: [artifact.path],
    });
    return {
      sessionTimeline: exported,
      artifact,
      archive: archive.archive,
      message: archive.message,
      run: archive.run,
    };
  }

  getApprovalResumeGateAuditReport(id, { format = 'json' } = {}) {
    const timeline = this.getTimeline(id);
    if (!timeline) return null;
    const report = buildApprovalResumeGateAuditReport(timeline);
    if (!report) return null;
    if (String(format || 'json').toLowerCase() === 'markdown' || String(format || '').toLowerCase() === 'md') {
      return formatApprovalResumeGateAuditReportMarkdown(report);
    }
    return report;
  }

  recordApprovalResumeGateAuditReportArtifact(id, input = {}) {
    const report = this.getApprovalResumeGateAuditReport(id);
    if (!report) throw new Error('approval resume gate audit not found');
    const cwd = resolve(str(input.cwd, 2000) || process.cwd());
    const relPath = `output/playwright/gate-audit-reports/${safeSlug(id)}-${safeSlug(report.gate?.id || report.id)}.md`;
    const targetPath = resolve(cwd, relPath);
    const safeRoot = resolve(cwd, 'output/playwright/gate-audit-reports');
    if (!targetPath.startsWith(`${safeRoot}/`) && targetPath !== safeRoot) {
      throw new Error('gate audit report path must stay under output/playwright/gate-audit-reports');
    }
    const markdown = formatApprovalResumeGateAuditReportMarkdown(report);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `${markdown}\n`, 'utf8');
    const stat = statSync(targetPath);
    const artifact = {
      kind: 'approval_resume_gate_audit_report',
      label: `Gate audit report ${report.gate?.id || report.id}`,
      path: relPath,
      exists: true,
      size: stat.size,
      sha256: createHash('sha256').update(`${markdown}\n`).digest('hex'),
      reportId: report.id,
      gateId: report.gate?.id || null,
      verified: Boolean(report.verified),
    };
    const archive = this.recordArchive(id, {
      actorType: input.actorType || 'system',
      requestedBy: input.requestedBy || 'owner',
      summary: input.summary || `Gate audit report archived: ${artifact.path}`,
      evidence: {
        stage: 'approval_resume_gate_audit_report',
        resumeReviewGateAudit: report.gate,
        gateAuditReport: {
          reportId: report.id,
          verified: report.verified,
          sourceCount: report.summary?.sourceCount || 0,
          mismatchCount: report.summary?.mismatchCount || 0,
        },
        gateAuditReportArtifact: artifact,
        evidenceArtifacts: [artifact],
      },
      affectedFiles: [artifact.path],
    });
    return {
      report,
      artifact,
      archive: archive.archive,
      message: archive.message,
      run: archive.run,
    };
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
