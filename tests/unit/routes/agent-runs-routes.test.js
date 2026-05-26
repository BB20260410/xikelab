import { describe, expect, it } from 'vitest';
import { registerAgentRunRoutes } from '../../../src/server/routes/agentRuns.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) {
    app[method] = (path, ...handlers) => {
      routes.push({ method, path, handlers });
    };
  }
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
    setHeader(name, value) { this.headers = { ...(this.headers || {}), [name]: value }; return this; },
    send(body) { this.payload = body; return this; },
  };
}

describe('agent run routes', () => {
  it('registers run list, idea execution, timeline, message, tool result, and transition endpoints', async () => {
    const run = { id: 'run-1', status: 'queued', roomId: 'room-1', sessionId: 'session-1' };
    const message = { id: 'msg-1', runId: 'run-1', kind: 'summary' };
    const toolResult = { id: 'tool-1', runId: 'run-1', toolName: 'npm test' };
    const sessionTimeline = {
      sessionId: 'session-1',
      counts: { runs: 1 },
      runs: [run],
      evidenceChain: { id: 'session-chain-route', summary: { itemCount: 1 }, items: [] },
    };
    const replayPlan = { id: 'replay-plan-1', runId: 'run-1', safeToAutoExecute: false };
    const replayResult = { id: 'replay-result-1', runId: 'run-1', replayPlanId: 'replay-plan-1', safeToAutoExecute: false };
    const archive = { id: 'agent-archive-1', runId: 'run-1', safeToAutoExecute: false, summary: 'Run archived' };
    const recordedArtifact = {
      id: 'artifact-route-1',
      runId: 'run-1',
      archiveId: 'agent-archive-1',
      kind: 'agent_run_session_evidence_markdown',
      path: 'output/playwright/session-evidence/agent-run-session-session-1-session-chain-route.md',
      size: 128,
      sha256: 'a'.repeat(64),
      sessionId: 'session-1',
      downloadable: true,
    };
    const ideaResult = { run: { id: 'run-idea', status: 'queued', sourceType: 'idea_to_archive' }, archive };
    const resumeManifest = {
      approvalId: 'approval-resume-1',
      fileChanges: [
        { operation: 'create', path: 'output/playwright/resume.js', content: 'const resumed = true;\n', requiresApproval: true },
        { operation: 'create', path: 'output/playwright/resume-helper.mjs', content: 'export const resumedHelper = true;\n' },
      ],
      commands: ['node --check output/playwright/resume.js', 'node --check output/playwright/resume-helper.mjs'],
      workEvidenceCommands: ['git status --porcelain=v1'],
      evidenceArtifacts: [],
    };
    const ideaTimelineRun = { ...ideaResult.run, status: 'deferred', approvalId: 'approval-resume-1' };
    const ideaExecution = { id: 'idea-execution-1', runId: 'run-idea', finalStatus: 'succeeded', safeToAutoExecute: false };
    const ideaAutoExecution = { id: 'idea-execution-auto-1', runId: 'run-idea', finalStatus: 'succeeded', safeToAutoExecute: false };
    const manifestDraft = { id: 'idea-manifest-1', runId: 'run-idea', safeToAutoExecute: false, manifest: { commands: ['git diff --check'] } };
    const patchManifestDraft = {
      id: 'idea-patch-manifest-1',
      runId: 'run-idea',
      safeToAutoExecute: false,
      manifest: { fileChanges: [{ operation: 'append', path: 'public/app.js', content: '// patch' }] },
      generation: { mode: 'local_fallback' },
    };
    const agentRunStore = {
      list(query) {
        expect(query).toMatchObject({
          roomId: 'room-1',
          sessionId: 'session-1',
          agentProfileId: 'xike-builder',
          approvalId: 'approval-1',
          budgetIncidentId: 'budget-1',
          delegationId: 'delegation-1',
          deferReason: 'budget_blocked',
          approvalResumeGateId: 'review-route-1',
          approvalResumeGateSha256: 'abc123',
          hasGovernance: 'true',
        });
        return [run];
      },
      create(input) {
        expect(input).toMatchObject({ roomId: 'room-1', agentProfileId: 'xike-builder', actorType: 'user' });
        return run;
      },
      createIdeaRun(input) {
        expect(input).toMatchObject({
          idea: 'Build the local idea flow',
          roomId: 'room-1',
          agentProfileId: 'xike-builder',
          actorType: 'user',
          requestedBy: 'owner',
        });
        return ideaResult;
      },
      completeIdeaRun(id, input) {
        expect(id).toBe('run-idea');
        expect(input).toMatchObject({
          actorType: 'user',
          requestedBy: 'owner',
          summary: 'Idea execution complete',
        });
        return { run: { ...ideaResult.run, status: 'succeeded' }, execution: ideaExecution, archive };
      },
      recordIdeaManifestDraft(id, input) {
        expect(id).toBe('run-idea');
        expect(input).toMatchObject({
          actorType: 'user',
          requestedBy: 'owner',
        });
        return { run: ideaResult.run, manifestDraft, message: { id: 'msg-manifest', kind: 'manifest_draft' } };
      },
      recordIdeaPatchManifestDraft(id, input) {
        expect(id).toBe('run-idea');
        expect(input).toMatchObject({
          actorType: 'user',
          requestedBy: 'owner',
          generation: { mode: 'local_fallback' },
        });
        return { run: ideaResult.run, manifestDraft: patchManifestDraft, message: { id: 'msg-patch-manifest', kind: 'manifest_draft' } };
      },
      getTimeline(id) {
        expect(['run-1', 'run-idea']).toContain(id);
        if (id === 'run-idea') {
          return {
            run: ideaTimelineRun,
            messages: [
              { id: 'msg-resume', kind: 'summary', payload: { resumeManifest } },
            ],
            toolResults: [],
          };
        }
        return { run, messages: [message], toolResults: [toolResult] };
      },
      getSessionSnapshot(sessionId, options) {
        expect(sessionId).toBe('session-1');
        expect(['20', undefined]).toContain(options.limit);
        return sessionTimeline;
      },
      exportSession(sessionId, options) {
        expect(sessionId).toBe('session-1');
        expect(options).toMatchObject({ format: 'markdown', limit: '20' });
        return '# Agent Run Session session-1\n\n## Session Evidence Chain';
      },
      recordSessionEvidenceArtifact(sessionId, input) {
        expect(sessionId).toBe('session-1');
        expect(input).toMatchObject({ actorType: 'user', requestedBy: 'owner', runId: 'run-1' });
        return {
          sessionTimeline,
          artifact: { path: 'output/playwright/session-evidence/agent-run-session-session-1-session-chain-route.md', sessionId },
          archive,
          message: { id: 'msg-session-archive', kind: 'archive' },
          run,
        };
      },
      exportRun(id, options) {
        expect(id).toBe('run-1');
        if (options.format === 'markdown') return '# Agent Run run-1';
        return { run, messages: [message], toolResults: [toolResult], activityEvents: [] };
      },
      getApprovalResumeGateAuditReport(id, options) {
        expect(id).toBe('run-1');
        if (options.format === 'markdown') return '# Approval Resume Gate Audit Report\n\n- Verified: yes';
        return { runId: id, verified: true, gate: { id: 'review-route-1' } };
      },
      recordApprovalResumeGateAuditReportArtifact(id, input) {
        expect(id).toBe('run-1');
        expect(input).toMatchObject({ actorType: 'user', requestedBy: 'owner' });
        return {
          report: { runId: id, verified: true, gate: { id: 'review-route-1' } },
          artifact: { path: 'output/playwright/gate-audit-reports/run-1-review-route-1.md', verified: true },
          archive,
          message: { id: 'msg-gate-report', kind: 'archive' },
          run,
        };
      },
      listArtifacts(id, filters) {
        expect(id).toBe('run-1');
        expect(filters).toMatchObject({ sessionId: 'session-1' });
        return {
          run,
          artifacts: [recordedArtifact],
          count: 1,
          allowedRoots: ['output/playwright/session-evidence', 'output/playwright/gate-audit-reports'],
        };
      },
      readArtifact(id, input) {
        expect(id).toBe('run-1');
        expect(input).toMatchObject({ artifactId: 'artifact-route-1' });
        return {
          artifact: recordedArtifact,
          content: '# Agent Run Session session-1\n\n## Session Evidence Chain',
          contentType: 'text/markdown; charset=utf-8',
          filename: 'agent-run-session-session-1-session-chain-route.md',
        };
      },
      appendMessage(id, input) {
        expect(id).toBe('run-1');
        expect(input.kind).toBe('summary');
        return message;
      },
      appendToolResult(id, input) {
        expect(id).toBe('run-1');
        expect(input.toolName).toBe('npm test');
        return toolResult;
      },
      transition(id, status, details) {
        expect(id).toBe('run-1');
        expect(status).toBe('succeeded');
        expect(details).toMatchObject({ verified: true });
        return { ...run, status };
      },
      recordReplayPlan(id, input) {
        expect(id).toBe('run-1');
        expect(input.actorType).toBe('user');
        return { replayPlan, message: { id: 'msg-replay', kind: 'replay_plan' }, run };
      },
      recordReplayResult(id, input) {
        expect(id).toBe('run-1');
        expect(input.actorType).toBe('user');
        expect(input.summary).toBe('Retry passed');
        return { replayResult, message: { id: 'msg-replay-result', kind: 'replay_result' }, run };
      },
      recordArchive(id, input) {
        expect(id).toBe('run-1');
        expect(input.actorType).toBe('user');
        expect(input.summary).toBe('Run archived');
        return { archive, message: { id: 'msg-archive', kind: 'archive' }, run };
      },
    };
    const approvalStore = {
      getApproval(id) {
        expect(id).toBe('approval-resume-1');
        return { id, status: 'approved', payload: { agentRunId: 'run-idea' } };
      },
    };
    const executeIdeaRunCalls = [];
    const verificationExecutor = {
      async executeIdeaRun(id, input) {
        expect(id).toBe('run-idea');
        expect(input).toMatchObject({
          actorType: 'user',
          requestedBy: 'owner',
        });
        executeIdeaRunCalls.push(input);
        return { run: { ...ideaResult.run, status: 'succeeded' }, execution: ideaAutoExecution, archive };
      },
    };
    const { app, routes } = makeApp();
    registerAgentRunRoutes(app, { agentRunStore, approvalStore, verificationExecutor });

    const listRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs')
      .handlers[1]({
        query: {
          roomId: 'room-1',
          sessionId: 'session-1',
          agentProfileId: 'xike-builder',
          approvalId: 'approval-1',
          budgetIncidentId: 'budget-1',
          delegationId: 'delegation-1',
          deferReason: 'budget_blocked',
          approvalResumeGateId: 'review-route-1',
          reviewSha256: 'abc123',
          hasGovernance: 'true',
        },
      }, listRes);
    expect(listRes.payload).toEqual({ ok: true, runs: [run] });

    const sessionRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/session/:sessionId')
      .handlers[1]({ params: { sessionId: 'session-1' }, query: { limit: '20' } }, sessionRes);
    expect(sessionRes.payload).toEqual({ ok: true, sessionTimeline });

    const sessionMarkdownRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/session/:sessionId')
      .handlers[1]({ params: { sessionId: 'session-1' }, query: { limit: '20', format: 'markdown' } }, sessionMarkdownRes);
    expect(sessionMarkdownRes.headers['Content-Type']).toBe('text/markdown; charset=utf-8');
    expect(sessionMarkdownRes.payload).toContain('Session Evidence Chain');

    const sessionArchiveRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/session/:sessionId/archive')
      .handlers[1]({ params: { sessionId: 'session-1' }, body: { requestedBy: 'owner', runId: 'run-1' } }, sessionArchiveRes);
    expect(sessionArchiveRes.statusCode).toBe(201);
    expect(sessionArchiveRes.payload).toMatchObject({
      ok: true,
      artifact: { path: 'output/playwright/session-evidence/agent-run-session-session-1-session-chain-route.md', sessionId: 'session-1' },
      message: { id: 'msg-session-archive', kind: 'archive' },
    });

    const approvalResumePreviewRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/:id/approval-resume-preview')
      .handlers[1]({ params: { id: 'run-idea' }, query: { approvalId: 'approval-resume-1' } }, approvalResumePreviewRes);
    expect(approvalResumePreviewRes.statusCode).toBe(200);
    expect(approvalResumePreviewRes.payload.resumeReview).toMatchObject({
      approvalId: 'approval-resume-1',
      safeToResume: true,
      fileChangeCount: 2,
      commandCount: 2,
      workEvidenceCommandCount: 1,
    });
    expect(approvalResumePreviewRes.payload.resumeReview.gate).toMatchObject({
      id: expect.stringMatching(/^review-/),
      required: true,
      safeToResume: true,
    });
    expect(approvalResumePreviewRes.payload.resumeReviewGate).toMatchObject({
      id: approvalResumePreviewRes.payload.resumeReview.gate.id,
      sha256: approvalResumePreviewRes.payload.resumeReview.gate.sha256,
    });
    expect(approvalResumePreviewRes.payload.resumeReviewGateAudit).toMatchObject({
      id: approvalResumePreviewRes.payload.resumeReview.gate.id,
      status: 'previewed',
      counts: { fileChanges: 2, commands: 2, workEvidenceCommands: 1, risks: 0 },
    });
    expect(approvalResumePreviewRes.payload.resumeReview.fileChanges[0]).toMatchObject({
      operation: 'create',
      path: 'output/playwright/resume.js',
      ok: true,
    });
    expect(approvalResumePreviewRes.payload.resumeReview.fileChanges[0].previewLines.join('\n')).toContain('+const resumed = true;');
    expect(approvalResumePreviewRes.payload.resumeReview.stagedDiffReview).toMatchObject({
      id: expect.stringMatching(/^staged-diff-/),
      summary: {
        fileCount: 2,
        totalAdditions: 2,
        totalRemovals: 0,
        newFileCount: 2,
        verificationCoveredFileCount: 2,
        uncoveredFileCount: 0,
        highRiskFileCount: 0,
        operationCounts: { create: 2 },
        coverageStatusCounts: { verified: 2 },
      },
    });
    expect(approvalResumePreviewRes.payload.resumeReview.fileChanges[0]).toMatchObject({
      coverageStatus: 'verified',
      riskRank: expect.any(Number),
      commandCoverage: { status: 'verified', verificationCommandCount: 1 },
    });

    const createRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs')
      .handlers[1]({ body: { roomId: 'room-1', agentProfileId: 'xike-builder' } }, createRes);
    expect(createRes.statusCode).toBe(201);
    expect(createRes.payload.run).toBe(run);

    const ideaRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/idea')
      .handlers[1]({ body: { idea: 'Build the local idea flow', roomId: 'room-1', agentProfileId: 'xike-builder' } }, ideaRes);
    expect(ideaRes.statusCode).toBe(201);
    expect(ideaRes.payload.run).toBe(ideaResult.run);
    expect(ideaRes.payload.archive).toBe(archive);

    const ideaExecutionRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/idea-execution')
      .handlers[1]({ params: { id: 'run-idea' }, body: { summary: 'Idea execution complete' } }, ideaExecutionRes);
    expect(ideaExecutionRes.statusCode).toBe(201);
    expect(ideaExecutionRes.payload.run.status).toBe('succeeded');
    expect(ideaExecutionRes.payload.execution).toBe(ideaExecution);

    const ideaAutoRes = makeRes();
    await routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/idea-auto-execute')
      .handlers[1]({ params: { id: 'run-idea' }, body: {} }, ideaAutoRes);
    expect(ideaAutoRes.statusCode).toBe(201);
    expect(ideaAutoRes.payload.run.status).toBe('succeeded');
    expect(ideaAutoRes.payload.execution).toBe(ideaAutoExecution);

    const callsBeforeMissingGate = executeIdeaRunCalls.length;
    const approvalResumeMissingGateRes = makeRes();
    await routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/approval-resume')
      .handlers[1]({
        params: { id: 'run-idea' },
        body: { approvalId: 'approval-resume-1' },
      }, approvalResumeMissingGateRes);
    expect(approvalResumeMissingGateRes.statusCode).toBe(428);
    expect(approvalResumeMissingGateRes.payload.error).toMatch(/gate required/);
    expect(executeIdeaRunCalls).toHaveLength(callsBeforeMissingGate);

    const callsBeforeGateMismatch = executeIdeaRunCalls.length;
    const approvalResumeGateMismatchRes = makeRes();
    await routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/approval-resume')
      .handlers[1]({
        params: { id: 'run-idea' },
        body: { approvalId: 'approval-resume-1', reviewGateId: 'review-stale', reviewSha256: 'stale' },
      }, approvalResumeGateMismatchRes);
    expect(approvalResumeGateMismatchRes.statusCode).toBe(409);
    expect(approvalResumeGateMismatchRes.payload.error).toMatch(/gate mismatch/);
    expect(approvalResumeGateMismatchRes.payload.resumeReviewGate.id).toBe(approvalResumePreviewRes.payload.resumeReview.gate.id);
    expect(approvalResumeGateMismatchRes.payload.resumeReviewGateAudit).toMatchObject({ status: 'blocked' });
    expect(executeIdeaRunCalls).toHaveLength(callsBeforeGateMismatch);

    const approvalResumeGate = approvalResumePreviewRes.payload.resumeReview.gate;
    const approvalResumeRes = makeRes();
    await routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/approval-resume')
      .handlers[1]({
        params: { id: 'run-idea' },
        body: {
          approvalId: 'approval-resume-1',
          reviewGateId: approvalResumeGate.id,
          reviewSha256: approvalResumeGate.sha256,
        },
      }, approvalResumeRes);
    expect(approvalResumeRes.statusCode).toBe(201);
    expect(approvalResumeRes.payload.approval).toMatchObject({ id: 'approval-resume-1', status: 'approved' });
    expect(approvalResumeRes.payload.resumeReview.fileChanges[0].contentSha256).toBeTruthy();
    expect(approvalResumeRes.payload.resumeReviewGate).toMatchObject({
      id: approvalResumeGate.id,
      sha256: approvalResumeGate.sha256,
    });
    expect(approvalResumeRes.payload.resumeReviewGateAudit).toMatchObject({
      id: approvalResumeGate.id,
      sha256: approvalResumeGate.sha256,
      status: 'accepted',
      counts: { fileChanges: 2, commands: 2, workEvidenceCommands: 1, risks: 0 },
      stagedDiffReview: {
        summary: { fileCount: 2, totalAdditions: 2, totalRemovals: 0, verificationCoveredFileCount: 2, uncoveredFileCount: 0 },
      },
    });
    expect(executeIdeaRunCalls.at(-1)).toMatchObject({
      approvalId: 'approval-resume-1',
      permissionApprovalId: 'approval-resume-1',
      resumeApprovalId: 'approval-resume-1',
      resumeReviewGate: {
        id: approvalResumeGate.id,
        sha256: approvalResumeGate.sha256,
      },
      resumeReviewGateAudit: {
        id: approvalResumeGate.id,
        status: 'accepted',
      },
      fileChanges: resumeManifest.fileChanges,
      commands: resumeManifest.commands,
      workEvidenceCommands: resumeManifest.workEvidenceCommands,
    });

    const ideaManifestRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/idea-manifest-draft')
      .handlers[1]({ params: { id: 'run-idea' }, body: {} }, ideaManifestRes);
    expect(ideaManifestRes.statusCode).toBe(201);
    expect(ideaManifestRes.payload.manifestDraft).toBe(manifestDraft);

    const ideaPatchManifestRes = makeRes();
    await routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/idea-patch-manifest-draft')
      .handlers[1]({ params: { id: 'run-idea' }, body: { useModel: false } }, ideaPatchManifestRes);
    expect(ideaPatchManifestRes.statusCode).toBe(201);
    expect(ideaPatchManifestRes.payload.manifestDraft).toBe(patchManifestDraft);

    const getRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/:id')
      .handlers[1]({ params: { id: 'run-1' }, query: { includeSession: 'true' } }, getRes);
    expect(getRes.payload).toMatchObject({ ok: true, run, messages: [message], toolResults: [toolResult], sessionTimeline });

    const exportJsonRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/:id/export')
      .handlers[1]({ params: { id: 'run-1' }, query: { format: 'json' } }, exportJsonRes);
    expect(exportJsonRes.payload).toMatchObject({ ok: true, export: { run } });

    const exportMarkdownRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/:id/export')
      .handlers[1]({ params: { id: 'run-1' }, query: { format: 'markdown' } }, exportMarkdownRes);
    expect(exportMarkdownRes.headers['Content-Type']).toBe('text/markdown; charset=utf-8');
    expect(exportMarkdownRes.payload).toBe('# Agent Run run-1');

    const gateReportJsonRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/:id/approval-resume-gate-audit')
      .handlers[1]({ params: { id: 'run-1' }, query: { format: 'json' } }, gateReportJsonRes);
    expect(gateReportJsonRes.payload).toMatchObject({
      ok: true,
      report: { runId: 'run-1', verified: true, gate: { id: 'review-route-1' } },
    });

    const gateReportMarkdownRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/:id/approval-resume-gate-audit')
      .handlers[1]({ params: { id: 'run-1' }, query: { format: 'markdown' } }, gateReportMarkdownRes);
    expect(gateReportMarkdownRes.headers['Content-Type']).toBe('text/markdown; charset=utf-8');
    expect(gateReportMarkdownRes.payload).toContain('Approval Resume Gate Audit Report');

    const gateReportArchiveRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/approval-resume-gate-audit/archive')
      .handlers[1]({ params: { id: 'run-1' }, body: { requestedBy: 'owner' } }, gateReportArchiveRes);
    expect(gateReportArchiveRes.statusCode).toBe(201);
    expect(gateReportArchiveRes.payload).toMatchObject({
      ok: true,
      artifact: { path: 'output/playwright/gate-audit-reports/run-1-review-route-1.md', verified: true },
      message: { id: 'msg-gate-report', kind: 'archive' },
    });

    const artifactListRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/:id/artifacts')
      .handlers[1]({ params: { id: 'run-1' }, query: { sessionId: 'session-1' } }, artifactListRes);
    expect(artifactListRes.payload).toMatchObject({
      ok: true,
      count: 1,
      artifacts: [recordedArtifact],
    });

    const artifactDownloadRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/:id/artifacts/:artifactId/download')
      .handlers[1]({ params: { id: 'run-1', artifactId: 'artifact-route-1' } }, artifactDownloadRes);
    expect(artifactDownloadRes.headers).toMatchObject({
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Xike-Artifact-Path': recordedArtifact.path,
    });
    expect(artifactDownloadRes.headers['Content-Disposition']).toContain('agent-run-session-session-1-session-chain-route.md');
    expect(artifactDownloadRes.payload).toContain('Session Evidence Chain');

    const msgRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/messages')
      .handlers[1]({ params: { id: 'run-1' }, body: { kind: 'summary' } }, msgRes);
    expect(msgRes.statusCode).toBe(201);
    expect(msgRes.payload.message).toBe(message);

    const toolRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/tool-results')
      .handlers[1]({ params: { id: 'run-1' }, body: { toolName: 'npm test' } }, toolRes);
    expect(toolRes.statusCode).toBe(201);
    expect(toolRes.payload.toolResult).toBe(toolResult);

    const transitionRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/transition')
      .handlers[1]({ params: { id: 'run-1' }, body: { status: 'succeeded', details: { verified: true } } }, transitionRes);
    expect(transitionRes.payload.run).toMatchObject({ status: 'succeeded' });

    const replayRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/replay-plan')
      .handlers[1]({ params: { id: 'run-1' }, body: { requestedBy: 'owner' } }, replayRes);
    expect(replayRes.statusCode).toBe(201);
    expect(replayRes.payload.replayPlan).toBe(replayPlan);

    const replayResultRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/replay-result')
      .handlers[1]({ params: { id: 'run-1' }, body: { summary: 'Retry passed' } }, replayResultRes);
    expect(replayResultRes.statusCode).toBe(201);
    expect(replayResultRes.payload.replayResult).toBe(replayResult);

    const archiveRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/archive')
      .handlers[1]({ params: { id: 'run-1' }, body: { summary: 'Run archived' } }, archiveRes);
    expect(archiveRes.statusCode).toBe(201);
    expect(archiveRes.payload.archive).toBe(archive);
  });

  it('can generate a patch manifest draft from an optional model adapter', async () => {
    const run = {
      id: 'run-model-patch',
      status: 'queued',
      sourceType: 'idea_to_archive',
      taskId: 'idea:model patch',
      agentProfileId: 'xike-builder',
      dispatchTags: ['implementation'],
      skills: ['qa'],
      details: {
        idea: 'Generate a source patch',
        affectedFiles: ['public/app.js'],
      },
    };
    const patchManifestDraft = {
      id: 'idea-patch-manifest-model',
      runId: run.id,
      safeToAutoExecute: false,
      generation: { mode: 'model_adapter', adapterId: 'codex' },
      manifest: {
        fileChanges: [{ operation: 'append', path: 'public/app.js', content: '// model patch' }],
      },
    };
    const agentRunStore = {
      getTimeline(id) {
        expect(id).toBe(run.id);
        return { run, messages: [], toolResults: [] };
      },
      recordIdeaPatchManifestDraft(id, input) {
        expect(id).toBe(run.id);
        expect(input).toMatchObject({
          actorType: 'user',
          requestedBy: 'owner',
          generation: {
            mode: 'model_adapter',
            adapterId: 'codex',
          },
        });
        expect(input.modelManifest).toMatchObject({
          fileChanges: [expect.objectContaining({ path: 'public/app.js' })],
        });
        return { run, manifestDraft: patchManifestDraft, message: { id: 'msg-model-patch', kind: 'manifest_draft' } };
      },
    };
    const roomAdapterPool = new Map([[
      'codex',
      {
        model: 'gpt-local',
        async chat(messages, opts) {
          expect(messages[1].content).toContain('Generate a source patch');
          expect(opts.agentRunLifecycle).toBe(false);
          expect(opts.agentRunId).toBe(run.id);
          return {
            reply: JSON.stringify({
              fileChanges: [{
                operation: 'append',
                path: 'public/app.js',
                content: '// model patch\n',
                summary: 'Append model patch',
              }],
              commands: ['git diff --check'],
            }),
          };
        },
      },
    ]]);
    const { app, routes } = makeApp();
    registerAgentRunRoutes(app, {
      agentRunStore,
      verificationExecutor: { async executeIdeaRun() {} },
      getRoomAdapterPool: () => roomAdapterPool,
    });

    const res = makeRes();
    await routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/idea-patch-manifest-draft')
      .handlers[1]({ params: { id: run.id }, body: { useModel: true, adapterId: 'codex' } }, res);
    expect(res.statusCode).toBe(201);
    expect(res.payload.manifestDraft).toBe(patchManifestDraft);
  });
});
