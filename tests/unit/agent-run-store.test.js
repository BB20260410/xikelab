import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { AgentRunStore } from '../../src/agents/AgentRunStore.js';
import { close, getStats, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-agent-runs-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('AgentRunStore', () => {
  it('migrates legacy agent_runs tables before creating governance indexes', () => {
    close();
    const dbPath = join(tmp, 'legacy-panel.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued',
        room_id TEXT,
        session_id TEXT,
        task_id TEXT,
        agent_profile_id TEXT,
        agent_profile_title TEXT,
        adapter_id TEXT,
        model_id TEXT,
        skills TEXT NOT NULL DEFAULT '[]',
        dispatch_tags TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    const db = initSqlite(dbPath);
    const columns = new Set(db.prepare('PRAGMA table_info(agent_runs)').all().map((c) => c.name));
    expect(columns.has('delegation_id')).toBe(true);
    expect(columns.has('approval_id')).toBe(true);
    expect(columns.has('source_type')).toBe(true);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_runs_delegation'").get()).toBeTruthy();
  });

  it('creates a run, appends messages and tool results, then exports the timeline', () => {
    const store = new AgentRunStore({ logger: null });
    const run = store.create({
      roomId: 'room-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      agentProfileId: 'xike-builder',
      agentProfileTitle: 'Xike Builder',
      adapterId: 'codex',
      modelId: 'gpt-5.4',
      skills: ['codex', 'review'],
      dispatchTags: ['implementation'],
      governance: { budgetTier: 'medium' },
      approvalId: 'approval-1',
      budgetIncidentId: 'budget-incident-1',
      delegationId: 'delegation-1',
      details: { jobId: 'job-1' },
      status: 'running',
    });

    expect(run).toMatchObject({
      status: 'running',
      roomId: 'room-1',
      agentProfileId: 'xike-builder',
      approvalId: 'approval-1',
      budgetIncidentId: 'budget-incident-1',
      delegationId: 'delegation-1',
      skills: ['codex', 'review'],
      dispatchTags: ['implementation'],
    });

    const message = store.appendMessage(run.id, {
      kind: 'decision',
      role: 'agent',
      summary: 'Implement scoped backend route.',
      payload: { evidence: ['src/server/routes/agentRuns.js'] },
    });
    const toolResult = store.appendToolResult(run.id, {
      toolName: 'npm test',
      status: 'passed',
      inputSummary: 'targeted tests',
      outputSummary: '2 tests passed',
      costUsd: 0,
    });
    const deferred = store.transition(run.id, 'deferred', {
      deferReason: 'approval_pending',
      relatedActivityIds: [99],
    });
    expect(deferred).toMatchObject({ status: 'deferred', deferReason: 'approval_pending' });
    expect(deferred.relatedActivityIds).toContain(99);

    const done = store.transition(run.id, 'succeeded', { reason: 'verified' });
    store.audit.recordSafe({
      action: 'approval.created',
      entityType: 'approval',
      entityId: 'approval-1',
      status: 'pending',
      details: { agentRunId: run.id, approvalId: 'approval-1' },
    });
    store.audit.recordSafe({
      action: 'budget.hard_stop',
      entityType: 'budget_policy',
      entityId: 'budget-policy-1',
      status: 'open',
      details: { agentRunId: run.id, budgetIncidentId: 'budget-incident-1' },
    });
    store.audit.recordSafe({
      action: 'delegation.agent_run_attached',
      entityType: 'delegation',
      entityId: 'delegation-1',
      status: 'queued',
      details: { agentRunId: run.id, delegationId: 'delegation-1', autopilotJobId: 'job-1' },
    });
    store.audit.recordSafe({
      action: 'autopilot.job.deferred',
      entityType: 'autopilot_job',
      entityId: 'job-1',
      status: 'deferred',
      details: { agentRunId: run.id, jobId: 'job-1', delegationId: 'delegation-1' },
    });
    const timeline = store.getTimeline(run.id);
    const exported = store.exportRun(run.id);
    const markdown = store.exportRun(run.id, { format: 'markdown' });

    expect(done.status).toBe('succeeded');
    expect(done.deferReason).toBe('approval_pending');
    expect(timeline.messages).toEqual([expect.objectContaining({ id: message.id, kind: 'decision' })]);
    expect(timeline.toolResults).toEqual([expect.objectContaining({ id: toolResult.id, toolName: 'npm test' })]);
    expect(exported).toMatchObject({
      run: { id: run.id, approvalId: 'approval-1', delegationId: 'delegation-1' },
      messages: [expect.objectContaining({ id: message.id })],
      toolResults: [expect.objectContaining({ id: toolResult.id })],
    });
    expect(timeline.governanceLineage).toMatchObject({
      summary: {
        approvalCount: 1,
        delegationCount: 1,
        budgetIncidentCount: 1,
        autopilotJobCount: 1,
      },
      nextAction: { type: 'resolve_budget_then_retry' },
    });
    expect(timeline.run.lineageSummary.blockerCount).toBe(1);
    expect(exported.activityEvents.map((event) => event.action)).toEqual(expect.arrayContaining([
      'agent.run.created',
      'agent.run.transitioned',
      'agent.run.message_appended',
      'agent.tool_result.recorded',
      'approval.created',
      'budget.hard_stop',
      'delegation.agent_run_attached',
      'autopilot.job.deferred',
    ]));
    expect(exported.governanceLineage.blockers).toEqual([
      expect.objectContaining({ kind: 'budget', id: 'budget-incident-1' }),
    ]);
    expect(markdown).toContain(`# Agent Run ${run.id}`);
    expect(markdown).toContain('Approval: approval-1');
    expect(markdown).toContain('## Governance Lineage');
    expect(markdown).toContain('Budget Incidents: budget-incident-1');
    expect(store.list({ roomId: 'room-1', agentProfileId: 'xike-builder' })).toHaveLength(1);
    expect(store.list({ approvalId: 'approval-1', delegationId: 'delegation-1', budgetIncidentId: 'budget-incident-1' })).toHaveLength(1);
    expect(store.list({ deferReason: 'approval_pending', hasGovernance: true })).toHaveLength(1);
    expect(getStats().counts.agent_runs).toBe(1);
    expect(getStats().counts.agent_messages).toBe(1);
    expect(getStats().counts.agent_tool_results).toBe(1);
  });

  it('fires archiveHook with run + timeline and swallows hook errors (A3)', () => {
    const store = new AgentRunStore({ logger: null });
    const run = store.create({ roomId: 'room-a3', sessionId: 's-a3', status: 'running' });
    store.appendMessage(run.id, { kind: 'decision', role: 'agent', summary: 'did the thing' });
    store.appendToolResult(run.id, { toolName: 'npm test', status: 'passed', outputSummary: 'ok' });

    const calls = [];
    store.setArchiveHook((id, payload) => { calls.push({ id, payload }); });
    const archived = store.recordArchive(run.id, {});
    expect(archived.archive).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe(run.id);
    expect(calls[0].payload.run.id).toBe(run.id);
    expect(calls[0].payload.timeline.messages.some((m) => m.summary === 'did the thing')).toBe(true);
    expect(calls[0].payload.timeline.toolResults.some((t) => t.toolName === 'npm test')).toBe(true);

    // 抛错的 hook 不应阻断归档
    store.setArchiveHook(() => { throw new Error('hook boom'); });
    expect(store.recordArchive(run.id, {}).archive).toBeTruthy();

    // 传 null 清除 hook
    store.setArchiveHook(null);
    expect(() => store.recordArchive(run.id, {})).not.toThrow();
  });

  it('records approval resume gate audit on a run timeline', () => {
    const store = new AgentRunStore({ logger: null });
    const run = store.create({
      id: 'agent-run-gate-audit',
      status: 'deferred',
      sourceType: 'idea_to_archive',
      approvalId: 'approval-gate-1',
      taskId: 'idea:gate audit',
    });

    const result = store.recordApprovalResumeGateAudit(run.id, {
      actorType: 'user',
      audit: {
        id: 'review-abc123',
        sha256: 'a'.repeat(64),
        status: 'accepted',
        approvalId: 'approval-gate-1',
        safeToResume: true,
        counts: { fileChanges: 1, commands: 1, workEvidenceCommands: 1, risks: 0 },
        files: [{ operation: 'create', path: 'output/playwright/gate-audit.js', contentSha256: 'b'.repeat(64), safeToAutoExecute: true }],
        commands: [{ command: 'node --check output/playwright/gate-audit.js', ok: true, safeToAutoExecute: true }],
        stagedDiffReview: {
          id: 'staged-diff-abc123',
          sha256: 'c'.repeat(64),
          safeToResume: true,
          summary: {
            fileCount: 1,
            okFileCount: 1,
            blockedFileCount: 0,
            newFileCount: 1,
            existingFileCount: 0,
            totalAdditions: 1,
            totalRemovals: 0,
            totalNetLineChange: 1,
            verificationCoveredFileCount: 1,
            specificallyVerifiedFileCount: 1,
            workEvidenceCoveredFileCount: 0,
            uncoveredFileCount: 0,
            highRiskFileCount: 0,
            attentionFlagCount: 2,
            operationCounts: { create: 1 },
            extensionCounts: { '.js': 1 },
            attentionFlagCounts: { new_file: 1, script_change: 1 },
            coverageStatusCounts: { verified: 1 },
            riskLevelCounts: { low: 1 },
            topRiskFiles: [{ path: 'output/playwright/gate-audit.js', operation: 'create', riskRank: 1, riskScore: 24, riskLevel: 'low', coverageStatus: 'verified', additions: 1, removals: 0, attentionFlags: ['new_file', 'script_change'] }],
          },
          files: [{
            operation: 'create',
            path: 'output/playwright/gate-audit.js',
            extension: '.js',
            ok: true,
            beforeExists: false,
            additions: 1,
            removals: 0,
            netLineChange: 1,
            coverageStatus: 'verified',
            verificationCommandCount: 1,
            riskScore: 24,
            riskLevel: 'low',
            riskRank: 1,
            attentionFlags: ['new_file', 'script_change'],
          }],
        },
      },
    });

    expect(result.audit).toMatchObject({
      id: 'review-abc123',
      status: 'accepted',
      approvalId: 'approval-gate-1',
      counts: { fileChanges: 1, commands: 1, workEvidenceCommands: 1, risks: 0 },
      stagedDiffReview: { id: 'staged-diff-abc123', summary: { totalAdditions: 1, totalRemovals: 0, verificationCoveredFileCount: 1, uncoveredFileCount: 0 } },
    });
    expect(result.message).toMatchObject({
      kind: 'decision',
      summary: 'Approval resume gate accepted: review-abc123',
    });
    const timeline = store.getTimeline(run.id);
    expect(timeline.run.details.approvalResumeGateAudit).toMatchObject({ id: 'review-abc123', sha256: 'a'.repeat(64) });
    expect(timeline.messages.map((message) => message.summary)).toContain('Approval resume gate accepted: review-abc123');
    expect(timeline.activityEvents.map((event) => event.action)).toContain('agent.run.approval_resume_gate_accepted');
    expect(store.list({ approvalResumeGateId: 'review-abc123' }).map((item) => item.id)).toEqual([run.id]);
    expect(store.list({ approvalResumeGateSha256: 'aaaaaaaaaaaa' }).map((item) => item.id)).toEqual([run.id]);
    expect(store.list({ reviewGateId: 'review-missing' })).toHaveLength(0);

    const reportBeforeArchive = store.getApprovalResumeGateAuditReport(run.id);
    expect(reportBeforeArchive).toMatchObject({
      runId: run.id,
      verified: false,
      gate: { id: 'review-abc123', sha256: 'a'.repeat(64) },
      summary: { runDetails: 1, messages: 1, activityEvents: 2, archives: 0, mismatchCount: 0 },
    });
    expect(reportBeforeArchive.checks.find((check) => check.code === 'archive_evidence_audit')?.status).toBe('warn');

    store.recordArchive(run.id, {
      actorType: 'system',
      requestedBy: 'unit-test',
      summary: 'Gate audit archived.',
      evidence: {
        resumeReviewGateAudit: result.audit,
      },
    });
    const report = store.getApprovalResumeGateAuditReport(run.id);
    expect(report).toMatchObject({
      runId: run.id,
      verified: true,
      summary: { runDetails: 1, messages: 1, activityEvents: 2, archives: 1, mismatchCount: 0 },
    });
    expect(report.sources.map((source) => source.kind)).toEqual(expect.arrayContaining(['run_details', 'message', 'activity', 'archive']));
    const markdownReport = store.getApprovalResumeGateAuditReport(run.id, { format: 'markdown' });
    expect(markdownReport).toContain('# Approval Resume Gate Audit Report');
    expect(markdownReport).toContain('Verified: yes');
    expect(markdownReport).toContain('## Staged Diff Review');
    expect(markdownReport).toContain('output/playwright/gate-audit.js +1/-0');
    expect(markdownReport).toContain('Coverage: 1/1 verified, 0 uncovered');
    expect(markdownReport).toContain('risk:low score:24 coverage:verified');
    expect(markdownReport).toContain('Partition Mismatches: -');
    expect(markdownReport).toContain('partitions:file:');
    const exportedMarkdown = store.exportRun(run.id, { format: 'markdown' });
    expect(exportedMarkdown).toContain('## Approval Resume Gate Audit');
    expect(exportedMarkdown).toContain('Verified: yes');

    const artifactResult = store.recordApprovalResumeGateAuditReportArtifact(run.id, {
      cwd: tmp,
      requestedBy: 'unit-test',
    });
    expect(artifactResult.artifact).toMatchObject({
      kind: 'approval_resume_gate_audit_report',
      gateId: 'review-abc123',
      verified: true,
    });
    expect(artifactResult.artifact.path).toMatch(/^output\/playwright\/gate-audit-reports\/agent-run-gate-audit-review-abc123\.md$/);
    const artifactPath = join(tmp, artifactResult.artifact.path);
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, 'utf8')).toContain('Approval Resume Gate Audit Report');
    expect(artifactResult.archive.evidence.external.gateAuditReportArtifact.path).toBe(artifactResult.artifact.path);
    expect(artifactResult.message.kind).toBe('archive');
  });

  it('partitions approval resume gate audit mismatches by file, command, risk, coverage, and artifact', () => {
    const store = new AgentRunStore({ logger: null });
    const run = store.create({
      id: 'agent-run-gate-partitions',
      status: 'deferred',
      taskId: 'partitioned gate audit',
    });
    const audit = {
      id: 'review-partitions',
      sha256: 'b'.repeat(64),
      status: 'accepted',
      approvalId: 'approval-partitions',
      safeToResume: true,
      counts: { fileChanges: 1, commands: 1, workEvidenceCommands: 1, risks: 0 },
      files: [{
        operation: 'create',
        path: 'output/playwright/partitioned.js',
        contentSha256: 'c'.repeat(64),
        safeToAutoExecute: true,
      }],
      commands: [{ command: 'node --check output/playwright/partitioned.js', ok: true, safeToAutoExecute: true }],
      workEvidenceCommands: [{ command: 'git status --short', ok: true, safeToAutoExecute: true }],
      stagedDiffReview: {
        id: 'staged-diff-partitions',
        sha256: 'd'.repeat(64),
        safeToResume: true,
        summary: {
          fileCount: 1,
          okFileCount: 1,
          blockedFileCount: 0,
          newFileCount: 1,
          existingFileCount: 0,
          totalAdditions: 1,
          totalRemovals: 0,
          totalNetLineChange: 1,
          verificationCoveredFileCount: 1,
          specificallyVerifiedFileCount: 1,
          workEvidenceCoveredFileCount: 0,
          uncoveredFileCount: 0,
          highRiskFileCount: 0,
          operationCounts: { create: 1 },
          extensionCounts: { '.js': 1 },
          coverageStatusCounts: { verified: 1 },
          riskLevelCounts: { low: 1 },
          topRiskFiles: [{ path: 'output/playwright/partitioned.js', operation: 'create', riskRank: 1, riskScore: 20, riskLevel: 'low', coverageStatus: 'verified', additions: 1, removals: 0 }],
        },
        files: [{
          operation: 'create',
          path: 'output/playwright/partitioned.js',
          extension: '.js',
          ok: true,
          beforeExists: false,
          additions: 1,
          removals: 0,
          netLineChange: 1,
          contentSha256: 'c'.repeat(64),
          coverageStatus: 'verified',
          verificationCommandCount: 1,
          verificationCommandDigest: 'v'.repeat(64),
          workEvidenceCommandDigest: 'w'.repeat(64),
          riskScore: 20,
          riskLevel: 'low',
          riskRank: 1,
        }],
      },
    };
    store.recordApprovalResumeGateAudit(run.id, { audit, status: 'accepted' });
    const staleAudit = JSON.parse(JSON.stringify(audit));
    staleAudit.files[0].contentSha256 = 'e'.repeat(64);
    staleAudit.commands[0].command = 'npm test';
    staleAudit.stagedDiffReview.files[0].contentSha256 = 'e'.repeat(64);
    staleAudit.stagedDiffReview.files[0].coverageStatus = 'uncovered';
    staleAudit.stagedDiffReview.files[0].riskLevel = 'high';
    staleAudit.stagedDiffReview.files[0].riskScore = 90;
    staleAudit.stagedDiffReview.summary.uncoveredFileCount = 1;
    staleAudit.stagedDiffReview.summary.verificationCoveredFileCount = 0;
    staleAudit.stagedDiffReview.summary.coverageStatusCounts = { uncovered: 1 };
    staleAudit.stagedDiffReview.summary.highRiskFileCount = 1;
    staleAudit.stagedDiffReview.summary.riskLevelCounts = { high: 1 };
    store.appendMessage(run.id, {
      kind: 'decision',
      status: 'accepted',
      summary: 'Stale partitioned gate audit.',
      payload: { approvalResumeGateAudit: staleAudit },
    });
    store.recordArchive(run.id, {
      summary: 'Gate audit archived with artifact.',
      evidence: {
        resumeReviewGateAudit: audit,
        evidenceArtifacts: [{
          kind: 'approval_resume_gate_audit_report',
          path: 'output/playwright/gate-audit-reports/partitioned.md',
          sha256: 'f'.repeat(64),
          gateId: audit.id,
        }],
      },
    });
    const report = store.getApprovalResumeGateAuditReport(run.id);
    expect(report.verified).toBe(false);
    expect(report.summary.mismatchPartitionCounts).toMatchObject({
      file: expect.any(Number),
      command: expect.any(Number),
      risk: expect.any(Number),
      coverage: expect.any(Number),
      artifact: expect.any(Number),
    });
    for (const partition of ['file', 'command', 'risk', 'coverage', 'artifact']) {
      expect(report.mismatches.some((mismatch) => mismatch.partition === partition)).toBe(true);
    }
    expect(report.mismatches.find((mismatch) => mismatch.partition === 'artifact')).toMatchObject({
      reason: 'unexpected_field',
    });
    const markdown = store.getApprovalResumeGateAuditReport(run.id, { format: 'markdown' });
    expect(markdown).toContain('Partition Mismatches:');
    expect(markdown).toContain('partition:coverage');
    expect(markdown).toContain('partition:artifact');
    expect(markdown).not.toContain('coverage reasons:');
  });

  it('maps a metrics turn into a finished agent run with a metric message', () => {
    const store = new AgentRunStore({ logger: null });
    const run = store.recordMetricTurn({
      ts: '2026-05-25T12:00:00.000Z',
      roomId: 'room-metrics',
      sessionId: 'session-metrics',
      taskId: 'task-metrics',
      turn: 'turn-1',
      adapter: 'codex',
      model: 'gpt-5.4',
      success: true,
      latencyMs: 1234,
      tokensIn: 100,
      tokensOut: 40,
      estCostUSD: 0.01,
      agentProfileId: 'xike-verifier',
      agentProfileTitle: 'Xike Verifier',
      agentDispatchTags: ['verification'],
      agentSkillNames: ['qa'],
      agentGovernance: { budgetScope: 'agent_profile' },
    });

    expect(run).toMatchObject({
      status: 'succeeded',
      sourceType: 'metric_turn',
      agentProfileId: 'xike-verifier',
      adapterId: 'codex',
    });
    const timeline = store.getTimeline(run.id);
    expect(timeline.messages).toHaveLength(1);
    expect(timeline.messages[0]).toMatchObject({
      kind: 'metric',
      status: 'succeeded',
      payload: { tokensIn: 100, tokensOut: 40, estCostUSD: 0.01 },
    });
  });

  it('summarizes all agent runs in a session with governance lineage', () => {
    const store = new AgentRunStore({ logger: null });
    const sessionId = 'session-governed';
    const first = store.create({
      id: 'agent-run-session-first',
      status: 'running',
      roomId: 'room-session',
      sessionId,
      taskId: 'session task one',
      agentProfileId: 'xike-builder',
      sourceType: 'metric_turn',
      details: {
        codebaseQuestionAnswer: {
          question: 'Where is session evidence?',
          answer: 'Session evidence is attached to the run timeline.',
          confidence: 'high',
          citations: [{ id: 'C1', path: 'src/agents/AgentRunStore.js', line: 1 }],
          coverage: { uniqueFileCount: 1, citedResultCount: 1 },
        },
      },
    });
    store.appendMessage(first.id, {
      kind: 'summary',
      role: 'agent',
      status: 'running',
      summary: 'First run session evidence.',
    });
    store.appendToolResult(first.id, {
      toolName: 'npm test',
      status: 'passed',
      outputSummary: 'session tests passed',
    });
    const archive = store.recordArchive(first.id, {
      actorType: 'user',
      requestedBy: 'owner',
      summary: 'Session run archived.',
    });
    const deferred = store.create({
      id: 'agent-run-session-deferred',
      status: 'deferred',
      roomId: 'room-session',
      sessionId,
      taskId: 'session task two',
      agentProfileId: 'xike-verifier',
      sourceType: 'idea_to_archive',
      approvalId: 'approval-session-1',
      deferReason: 'approval_pending',
    });
    store.audit.recordSafe({
      action: 'approval.created',
      entityType: 'approval',
      entityId: 'approval-session-1',
      status: 'pending',
      roomId: 'room-session',
      sessionId,
      details: {
        agentRunId: deferred.id,
        approvalId: 'approval-session-1',
      },
    });
    store.create({
      id: 'agent-run-other-session',
      status: 'queued',
      sessionId: 'other-session',
      taskId: 'unrelated',
    });

    const snapshot = store.getSessionSnapshot(sessionId);
    expect(snapshot).toMatchObject({
      sessionId,
      counts: {
        runs: 2,
        archives: 1,
      },
      statusCounts: {
        running: 1,
        deferred: 1,
      },
      sourceTypeCounts: {
        metric_turn: 1,
        idea_to_archive: 1,
      },
      agentProfileCounts: {
        'xike-builder': 1,
        'xike-verifier': 1,
      },
    });
    expect(snapshot.runs.map((run) => run.id)).toEqual([first.id, deferred.id]);
    expect(snapshot.archives).toEqual([
      expect.objectContaining({
        id: archive.archive.id,
        runId: first.id,
      }),
    ]);
    expect(snapshot.governance.summary).toMatchObject({
      approvalCount: 1,
      blockerCount: 1,
      nextActionCount: 1,
    });
    expect(snapshot.governance.blockers).toEqual([
      expect.objectContaining({
        kind: 'approval',
        id: 'approval-session-1',
        runId: deferred.id,
      }),
    ]);
    expect(snapshot.governance.nextActions).toEqual([
      expect.objectContaining({
        type: 'approval_decision_then_retry',
        approvalId: 'approval-session-1',
        runId: deferred.id,
      }),
    ]);
    expect(snapshot.activityEvents.map((event) => event.action)).toEqual(expect.arrayContaining([
      'agent.run.created',
      'agent.run.archived',
      'approval.created',
    ]));
    expect(snapshot.evidenceChain.summary).toMatchObject({
      runCount: 2,
      archiveCount: 1,
      codebaseQuestionCount: 1,
      approvalResumeGateCount: 0,
    });
    expect(snapshot.evidenceChain.refs).toMatchObject({
      runIds: [first.id, deferred.id],
      approvalIds: ['approval-session-1'],
      citationIds: ['C1'],
    });
    expect(snapshot.evidenceChain.items.map((item) => item.kind)).toEqual(expect.arrayContaining([
      'run',
      'message',
      'tool_result',
      'archive',
      'activity',
      'codebase_question',
    ]));
    expect(snapshot.evidenceChain.items.map((item) => item.sequence)).toEqual(
      snapshot.evidenceChain.items.map((_, index) => index + 1),
    );
    const exportedSession = store.exportSession(sessionId);
    expect(exportedSession.evidenceChain.id).toBe(snapshot.evidenceChain.id);
    const exportedMarkdown = store.exportSession(sessionId, { format: 'markdown' });
    expect(exportedMarkdown).toContain(`# Agent Run Session ${sessionId}`);
    expect(exportedMarkdown).toContain('## Session Evidence Chain');
    expect(exportedMarkdown).toContain('codebase_question');
    const sessionArtifact = store.recordSessionEvidenceArtifact(sessionId, {
      cwd: tmp,
      runId: first.id,
      requestedBy: 'unit-test',
    });
    expect(sessionArtifact.artifact).toMatchObject({
      kind: 'agent_run_session_evidence_markdown',
      sessionId,
      runCount: 2,
    });
    expect([first.id, deferred.id]).toContain(sessionArtifact.artifact.latestRunId);
    expect(sessionArtifact.artifact.path).toMatch(/^output\/playwright\/session-evidence\/agent-run-session-session-governed-session-chain-.+\.md$/);
    const sessionArtifactPath = join(tmp, sessionArtifact.artifact.path);
    expect(existsSync(sessionArtifactPath)).toBe(true);
    expect(readFileSync(sessionArtifactPath, 'utf8')).toContain(`# Agent Run Session ${sessionId}`);
    expect(sessionArtifact.archive.evidence.external.sessionEvidenceArtifact.path).toBe(sessionArtifact.artifact.path);
    expect(sessionArtifact.archive.evidence.external.sessionEvidence.summary.itemCount).toBeGreaterThan(0);
    expect(sessionArtifact.message.kind).toBe('archive');
    const artifactList = store.listArtifacts(first.id, { sessionId });
    expect(artifactList).toMatchObject({
      count: 1,
      allowedRoots: expect.arrayContaining(['output/playwright/session-evidence']),
    });
    expect(artifactList.artifacts[0]).toMatchObject({
      kind: 'agent_run_session_evidence_markdown',
      path: sessionArtifact.artifact.path,
      sessionId,
      downloadable: true,
    });
    const artifactRead = store.readArtifact(first.id, {
      artifactId: artifactList.artifacts[0].id,
      cwd: tmp,
    });
    expect(artifactRead).toMatchObject({
      contentType: 'text/markdown; charset=utf-8',
      artifact: {
        id: artifactList.artifacts[0].id,
        path: sessionArtifact.artifact.path,
        exists: true,
      },
    });
    expect(artifactRead.content).toContain(`# Agent Run Session ${sessionId}`);
    const archiveActivity = store.getTimeline(first.id).activityEvents.find((event) => event.action === 'agent.run.archived' && event.details?.artifactCount);
    expect(archiveActivity?.details.artifacts[0]).toMatchObject({
      id: artifactList.artifacts[0].id,
      path: sessionArtifact.artifact.path,
      downloadable: true,
    });
    rmSync(sessionArtifactPath, { force: true });
    expect(() => store.readArtifact(first.id, {
      artifactId: artifactList.artifacts[0].id,
      cwd: tmp,
    })).toThrow(/artifact file not found/);
    expect(store.getSessionSnapshot('missing-session')).toBeNull();
  });

  it('refuses archive artifact reads outside recorded safe roots', () => {
    const store = new AgentRunStore({ logger: null });
    const run = store.create({
      id: 'agent-run-artifact-policy',
      status: 'running',
      taskId: 'artifact policy',
    });
    store.recordArchive(run.id, {
      actorType: 'user',
      requestedBy: 'owner',
      summary: 'Unsafe artifact archived.',
      evidence: {
        evidenceArtifacts: [
          {
            kind: 'screenshot',
            label: 'Screenshot outside markdown roots',
            path: 'output/playwright/screenshots/unsafe.png',
            exists: true,
          },
          {
            kind: 'traversal',
            label: 'Traversal artifact',
            path: '../secret.md',
            exists: true,
          },
        ],
      },
    });
    const listed = store.listArtifacts(run.id);
    expect(listed.count).toBe(1);
    expect(listed.artifacts[0]).toMatchObject({
      path: 'output/playwright/screenshots/unsafe.png',
      downloadable: false,
    });
    expect(() => store.readArtifact(run.id, {
      artifactId: listed.artifacts[0].id,
      cwd: tmp,
    })).toThrow(/not allowed/);
    expect(() => store.readArtifact(run.id, {
      path: '../secret.md',
      cwd: tmp,
    })).toThrow(/not recorded/);
  });

  it('enforces server-computed downloadable, digest, and file-type on artifact read (C1/P9)', () => {
    const store = new AgentRunStore({ logger: null });
    const run = store.create({ id: 'agent-run-artifact-c1', status: 'running', taskId: 'artifact c1' });

    // 1) payload 注入 downloadable:true 但 path 不在 allowlist → 服务端重算为 false，读被拒
    store.recordArchive(run.id, {
      actorType: 'user', requestedBy: 'owner', summary: 'forged downloadable',
      evidence: { evidenceArtifacts: [
        { kind: 'forge', label: 'forged', path: 'output/playwright/screenshots/forged.png', exists: true, downloadable: true },
      ] },
    });
    const forged = store.listArtifacts(run.id).artifacts.find((a) => a.path === 'output/playwright/screenshots/forged.png');
    expect(forged.downloadable).toBe(false);
    expect(() => store.readArtifact(run.id, { artifactId: forged.id, cwd: tmp })).toThrow(/not allowed/);

    // 2) 记录的 sha256 与磁盘内容不符（文件被篡改）→ digest mismatch
    const tamperRel = 'output/playwright/session-evidence/c1-tamper.md';
    const tamperAbs = join(tmp, tamperRel);
    mkdirSync(dirname(tamperAbs), { recursive: true });
    writeFileSync(tamperAbs, 'original evidence body', 'utf8');
    store.recordArchive(run.id, {
      actorType: 'user', requestedBy: 'owner', summary: 'sha recorded',
      evidence: { evidenceArtifacts: [
        { kind: 'evidence', label: 'tamper', path: tamperRel, exists: true, sha256: 'deadbeef'.repeat(8) },
      ] },
    });
    const tamper = store.listArtifacts(run.id).artifacts.find((a) => a.path === tamperRel);
    expect(tamper.downloadable).toBe(true);
    expect(() => store.readArtifact(run.id, { artifactId: tamper.id, cwd: tmp })).toThrow(/digest mismatch/);

    // 3) allowlist 内但路径指向目录 → not a file
    const dirRel = 'output/playwright/session-evidence/c1-dir';
    mkdirSync(join(tmp, dirRel), { recursive: true });
    store.recordArchive(run.id, {
      actorType: 'user', requestedBy: 'owner', summary: 'dir artifact',
      evidence: { evidenceArtifacts: [
        { kind: 'dir', label: 'dir', path: dirRel, exists: true },
      ] },
    });
    const dirArtifact = store.listArtifacts(run.id).artifacts.find((a) => a.path === dirRel);
    expect(() => store.readArtifact(run.id, { artifactId: dirArtifact.id, cwd: tmp })).toThrow(/not a file/);
  });

  it('does not mark historical budget incident references as blockers without an open or deferred state', () => {
    const store = new AgentRunStore({ logger: null });
    const run = store.create({
      id: 'agent-run-historical-budget',
      status: 'succeeded',
      roomId: 'room-budget',
      budgetIncidentId: 'budget-closed-1',
      details: { budgetIncidentId: 'budget-closed-1' },
    });

    const timeline = store.getTimeline(run.id);
    expect(timeline.governanceLineage.budgetIncidents).toEqual([
      expect.objectContaining({ id: 'budget-closed-1' }),
    ]);
    expect(timeline.governanceLineage.blockers).toEqual([]);
    expect(timeline.governanceLineage.nextAction.type).toBe('none');
  });

  it('records a safe replay plan for failed runs without auto-executing it', () => {
    const store = new AgentRunStore({ logger: null });
    const run = store.create({
      status: 'failed',
      roomId: 'room-replay',
      taskId: 'task-replay',
      agentProfileId: 'xike-verifier',
      error: 'npm test failed',
      details: { error: 'npm test failed' },
    });
    const tool = store.appendToolResult(run.id, {
      toolName: 'npm test',
      status: 'failed',
      inputSummary: 'full suite',
      outputSummary: '1 failed',
    });

    const result = store.recordReplayPlan(run.id, { actorType: 'user', requestedBy: 'owner' });
    expect(result.replayPlan).toMatchObject({
      runId: run.id,
      safeToAutoExecute: false,
      nextAction: { type: 'inspect_failure_then_retry' },
      evidence: { failedToolResultIds: [tool.id] },
    });
    expect(result.message).toMatchObject({
      kind: 'replay_plan',
      status: 'planned',
    });
    const timeline = store.getTimeline(run.id);
    expect(timeline.messages.map((message) => message.kind)).toContain('replay_plan');
    expect(timeline.activityEvents.map((event) => event.action)).toContain('agent.run.replay_planned');

    const archived = store.recordReplayResult(run.id, {
      actorType: 'user',
      requestedBy: 'owner',
      status: 'recorded',
      summary: 'Retry passed after scoped fix.',
    });
    expect(archived.replayResult).toMatchObject({
      runId: run.id,
      replayPlanId: result.replayPlan.id,
      safeToAutoExecute: false,
      summary: 'Retry passed after scoped fix.',
    });
    expect(archived.message).toMatchObject({
      kind: 'replay_result',
      status: 'recorded',
    });
    const archivedTimeline = store.getTimeline(run.id);
    expect(archivedTimeline.messages.map((message) => message.kind)).toEqual(expect.arrayContaining(['replay_plan', 'replay_result']));
    expect(archivedTimeline.activityEvents.map((event) => event.action)).toContain('agent.run.replay_result_recorded');
    expect(store.get(run.id).status).toBe('failed');

    const archive = store.recordArchive(run.id, {
      actorType: 'user',
      requestedBy: 'owner',
      summary: 'Failed run archived with replay evidence.',
      affectedFiles: ['src/agents/AgentRunStore.js'],
    });
    expect(archive.archive).toMatchObject({
      runId: run.id,
      status: 'failed',
      safeToAutoExecute: false,
      summary: 'Failed run archived with replay evidence.',
      evidence: {
        files: ['src/agents/AgentRunStore.js'],
      },
      verification: {
        toolResultCount: 1,
        toolStatusCounts: { failed: 1 },
      },
    });
    expect(archive.message).toMatchObject({
      kind: 'archive',
      status: 'archived',
    });
    const archiveTimeline = store.getTimeline(run.id);
    expect(archiveTimeline.archives).toEqual([
      expect.objectContaining({
        id: archive.archive.id,
        messageId: archive.message.id,
        summary: 'Failed run archived with replay evidence.',
      }),
    ]);
    expect(archiveTimeline.activityEvents.map((event) => event.action)).toContain('agent.run.archived');
    const archiveMarkdown = store.exportRun(run.id, { format: 'markdown' });
    expect(archiveMarkdown).toContain('## Execution Archives');
    expect(archiveMarkdown).toContain('Failed run archived with replay evidence.');
  });

  it('creates an Idea-to-Archive run draft with plan, audit, and intake archive', () => {
    const store = new AgentRunStore({ logger: null });
    const result = store.createIdeaRun({
      actorType: 'user',
      requestedBy: 'owner',
      idea: 'Build the local Idea-to-Archive flow',
      role: 'dev',
      affectedFiles: ['public/app.js', 'src/agents/AgentRunStore.js'],
      classification: {
        profile: {
          id: 'xike-builder',
          title: 'Xike Builder',
          governance: { budgetTier: 'high', approvalPolicy: 'dangerous_commands' },
        },
        matches: [
          { tag: 'implementation', agentId: 'xike-builder', score: 5 },
          { tag: 'verification', agentId: 'xike-verifier', score: 3 },
        ],
        installedSkillNames: ['codex', 'qa'],
        missingSkillNames: ['careful'],
        codeContextEvidenceSummary: { fileCount: 2, symbolCount: 12 },
      },
      codebaseQuestionAnswer: {
        question: 'Agent Run 在哪里归档 Codebase 证据？',
        confidence: 'medium',
        answer: 'Most relevant local evidence points to src/agents/AgentRunStore.js:1588.',
        citations: [
          { id: 'C1', path: 'src/agents/AgentRunStore.js', line: 1588, label: 'src/agents/AgentRunStore.js:1588', reasons: ['store:createIdeaRun'] },
        ],
        coverage: { resultCount: 1, citedResultCount: 1, uniqueFileCount: 1 },
      },
    });

    expect(result.run).toMatchObject({
      status: 'queued',
      sourceType: 'idea_to_archive',
      taskId: 'idea:Build the local Idea-to-Archive flow',
      agentProfileId: 'xike-builder',
      skills: ['codex', 'qa'],
      dispatchTags: ['implementation', 'verification'],
      details: {
        codebaseQuestionCitationCount: 1,
        codebaseQuestionAnswer: {
          question: 'Agent Run 在哪里归档 Codebase 证据？',
          citations: [expect.objectContaining({ id: 'C1', path: 'src/agents/AgentRunStore.js' })],
        },
      },
    });
    expect(result.plan).toMatchObject({
      safeToAutoExecute: false,
      stage: 'idea_intake',
      suggested: {
        agentProfileId: 'xike-builder',
      },
    });
    expect(result.decision).toMatchObject({ kind: 'decision', status: 'drafted' });
    expect(result.summary).toMatchObject({ kind: 'summary', status: 'drafted' });
    expect(result.archive).toMatchObject({
      runId: result.run.id,
      status: 'queued',
      safeToAutoExecute: false,
      evidence: {
        files: ['public/app.js', 'src/agents/AgentRunStore.js'],
        external: {
          codebaseQuestionAnswer: {
            citations: [expect.objectContaining({ id: 'C1' })],
          },
        },
      },
      context: {
        codebaseQuestionCitationCount: 1,
      },
    });
    const timeline = store.getTimeline(result.run.id);
    expect(timeline.archives).toEqual([
      expect.objectContaining({ id: result.archive.id, summary: expect.stringContaining('Idea intake archived') }),
    ]);
    expect(timeline.messages.map((message) => message.kind)).toEqual(expect.arrayContaining(['decision', 'summary', 'archive']));
    expect(timeline.activityEvents.map((event) => event.action)).toEqual(expect.arrayContaining([
      'agent.run.idea_intake_created',
      'agent.run.archived',
    ]));

    const manifestDraft = store.recordIdeaManifestDraft(result.run.id, {
      actorType: 'user',
      requestedBy: 'owner',
    });
    expect(manifestDraft.run.status).toBe('queued');
    expect(manifestDraft.message).toMatchObject({
      kind: 'manifest_draft',
      status: 'drafted',
      summary: expect.stringContaining('Manifest draft generated'),
    });
    expect(manifestDraft.manifestDraft).toMatchObject({
      runId: result.run.id,
      stage: 'idea_manifest_draft',
      safeToAutoExecute: false,
      manifest: {
        fileChanges: [
          expect.objectContaining({
            operation: 'create',
            path: expect.stringMatching(/^output\/playwright\/idea-work-agent-run-/),
            content: expect.stringContaining('# Xike Idea Work Manifest'),
            summary: 'Record the generated Agent work manifest artifact.',
          }),
          expect.objectContaining({
            operation: 'create',
            path: expect.stringMatching(/^output\/playwright\/idea-agent-change-agent-run-/),
            content: expect.stringContaining('local-agent-filechange-synthesizer'),
            summary: 'Record the generated local Agent file-change plan.',
          }),
        ],
        workEvidenceCommands: ['git status --porcelain=v1', 'git diff --stat'],
        commands: expect.arrayContaining([
          'git diff --check',
          'node --check public/app.js',
          expect.stringMatching(/^node --check output\/playwright\/idea-agent-change-agent-run-/),
          'npm test -- tests/unit/agent-run-store.test.js',
        ]),
      },
    });
    expect(manifestDraft.manifestDraft.manifest.fileChanges[0].content).toContain('Build the local Idea-to-Archive flow');
    expect(manifestDraft.manifestDraft.manifest.fileChanges[0].content).toContain('public/app.js');
    expect(manifestDraft.manifestDraft.manifest.fileChanges[1].content).toContain('xikeIdeaAgentChange');
    expect(manifestDraft.manifestDraft.manifest.fileChanges[1].content).toContain('Build the local Idea-to-Archive flow');
    expect(manifestDraft.manifestDraft.manifest.fileChanges[1].content).toContain('src/agents/AgentRunStore.js');
    expect(manifestDraft.manifestDraft.rationale).toEqual(expect.arrayContaining([
      expect.stringContaining('Generated a governed work artifact at output/playwright/idea-work-agent-run-'),
      expect.stringContaining('Generated a local Agent file-change plan at output/playwright/idea-agent-change-agent-run-'),
    ]));
    const manifestTimeline = store.getTimeline(result.run.id);
    expect(manifestTimeline.messages.map((message) => message.kind)).toContain('manifest_draft');
    expect(manifestTimeline.activityEvents.map((event) => event.action)).toContain('agent.run.idea_manifest_drafted');
    expect(manifestTimeline.activityEvents.find((event) => event.action === 'agent.run.idea_manifest_drafted')?.details).toMatchObject({
      fileChangeCount: 2,
      commandCount: expect.any(Number),
      workEvidenceCommandCount: 2,
    });

    const patchDraft = store.recordIdeaPatchManifestDraft(result.run.id, {
      actorType: 'user',
      requestedBy: 'owner',
    });
    expect(patchDraft.message).toMatchObject({
      kind: 'manifest_draft',
      status: 'drafted',
      summary: expect.stringContaining('Patch manifest draft generated: Patch quality'),
    });
    expect(patchDraft.manifestDraft).toMatchObject({
      runId: result.run.id,
      stage: 'idea_patch_manifest_draft',
      safeToAutoExecute: false,
      generation: { mode: 'local_fallback' },
      patchQuality: {
        grade: expect.any(String),
        score: expect.any(Number),
        safeToAutoExecute: false,
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'touches_affected_file' }),
          expect.objectContaining({ code: 'proposal_only_patch' }),
        ]),
      },
      manifest: {
        fileChanges: [
          expect.objectContaining({
            operation: 'append',
            path: 'public/app.js',
            content: expect.stringContaining('Xike Agent: Idea: Build the local Idea-to-Archive flow'),
            summary: 'Append a governed local Agent source patch proposal.',
          }),
        ],
        workEvidenceCommands: ['git status --porcelain=v1', 'git diff --stat'],
        commands: expect.arrayContaining([
          'git diff --check',
          'node --check public/app.js',
          'npm test -- tests/unit/agent-run-store.test.js',
        ]),
      },
    });
    const patchTimeline = store.getTimeline(result.run.id);
    expect(patchTimeline.activityEvents.map((event) => event.action)).toContain('agent.run.idea_patch_manifest_drafted');
    expect(patchTimeline.activityEvents.find((event) => event.action === 'agent.run.idea_patch_manifest_drafted')?.details).toMatchObject({
      fileChangeCount: 1,
      generation: { mode: 'local_fallback' },
      patchQuality: {
        grade: patchDraft.manifestDraft.patchQuality.grade,
        score: patchDraft.manifestDraft.patchQuality.score,
      },
      safeToAutoExecute: false,
    });

    const completed = store.completeIdeaRun(result.run.id, {
      actorType: 'user',
      requestedBy: 'owner',
      status: 'succeeded',
      summary: 'Idea implementation finished and verified.',
      verificationResults: [
        {
          command: 'npm test -- tests/unit/agent-run-store.test.js',
          status: 'passed',
          outputSummary: 'targeted tests passed',
        },
      ],
    });
    expect(completed.run).toMatchObject({
      status: 'succeeded',
      sourceType: 'idea_to_archive',
      details: {
        stage: 'idea_archived',
        executionSummary: 'Idea implementation finished and verified.',
        safeToAutoExecute: false,
      },
    });
    expect(completed.execution).toMatchObject({
      finalStatus: 'succeeded',
      safeToAutoExecute: false,
      verificationResults: [
        expect.objectContaining({
          name: 'npm test -- tests/unit/agent-run-store.test.js',
          status: 'passed',
        }),
      ],
    });
    expect(completed.toolResults).toEqual([
      expect.objectContaining({
        toolName: 'npm test -- tests/unit/agent-run-store.test.js',
        status: 'passed',
      }),
    ]);
    expect(completed.archive).toMatchObject({
      runId: result.run.id,
      status: 'succeeded',
      summary: 'Idea implementation finished and verified.',
      verification: {
        toolStatusCounts: { passed: 1 },
      },
      evidence: {
        external: {
          stage: 'idea_final_archive',
          ideaExecutionId: completed.execution.id,
          verificationToolResultIds: completed.toolResults.map((item) => item.id),
        },
      },
    });
    const completedTimeline = store.getTimeline(result.run.id);
    expect(completedTimeline.archives.length).toBe(2);
    expect(completedTimeline.messages.map((message) => message.kind)).toEqual(expect.arrayContaining(['decision', 'summary', 'archive']));
    expect(completedTimeline.activityEvents.map((event) => event.action)).toEqual(expect.arrayContaining([
      'agent.run.transitioned',
      'agent.tool_result.recorded',
      'agent.run.idea_execution_completed',
      'agent.run.archived',
    ]));
    expect(store.exportRun(result.run.id, { format: 'markdown' })).toContain('Idea implementation finished and verified.');
    expect(() => store.completeIdeaRun(result.run.id, { summary: 'duplicate completion' })).toThrow('already finished');
  });
});
