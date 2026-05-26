import { describe, expect, it } from 'vitest';
import { buildGovernanceSummary, registerGovernanceRoutes } from '../../../src/server/routes/governance.js';

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
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

describe('governance routes', () => {
  it('builds a local governance summary across pending control queues', () => {
    const summary = buildGovernanceSummary({
      approvals: [
        { id: 'approval-1', type: 'manual', status: 'pending', payload: { title: 'Approve file write', action: 'file.write', agentRunId: 'agent-run-1' }, createdAt: 100 },
      ],
      budgetIncidents: [
        { id: 'incident-1', scopeType: 'room', scopeId: 'room-1', thresholdType: 'hard_stop', status: 'open', createdAt: 200 },
        { id: 'incident-2', scopeType: 'adapter', scopeId: 'codex', thresholdType: 'warning', status: 'open', createdAt: 150 },
      ],
      queuedDelegations: [
        { id: 'delegation-1', title: 'Review task', status: 'queued', createdAt: 300 },
      ],
      failedDelegations: [
        { id: 'delegation-2', title: 'Failed task', status: 'failed', updatedAt: 250 },
      ],
      queuedJobs: [
        { id: 'job-1', action: 'heartbeat', status: 'queued', createdAt: 350 },
      ],
      runningJobs: [
        { id: 'job-2', action: 'notify', status: 'running', updatedAt: 50 },
      ],
      agentRuns: [
        { id: 'agent-run-1', status: 'deferred', taskId: 'task-1', sourceType: 'idea_to_archive', deferReason: 'approval_pending', approvalId: 'approval-1', updatedAt: 400 },
      ],
      activityEvents: [
        { id: 1, action: 'agent.run.created', entityType: 'agent_run', entityId: 'agent-run-1', severity: 'info', status: 'queued', ts: 500, details: { agentRunId: 'agent-run-1' } },
        { id: 2, action: 'room.updated', entityType: 'room', entityId: 'room-1', severity: 'info', ts: 450, details: {} },
      ],
      agentRunTimelines: new Map([['agent-run-1', {
        run: { id: 'agent-run-1', sourceType: 'idea_to_archive', status: 'deferred', approvalId: 'approval-1' },
        messages: [{
          id: 'msg-1',
          kind: 'summary',
          payload: {
            resumeManifest: {
              approvalId: 'approval-1',
              fileChanges: [{ operation: 'create', path: 'output/playwright/governance-review.js', content: 'const review = true;\n', requiresApproval: true }],
              commands: ['node --check output/playwright/governance-review.js'],
              workEvidenceCommands: ['git status --porcelain=v1'],
            },
          },
        }],
      }]]),
    });

    expect(summary.ok).toBe(true);
    expect(summary.counts).toMatchObject({
      pendingApprovals: 1,
      openBudgetIncidents: 2,
      queuedDelegations: 1,
      failedDelegations: 1,
      queuedAutopilotJobs: 1,
      runningAutopilotJobs: 1,
      hardBlockers: 2,
      attention: 4,
      totalOpen: 7,
      governedAgentRuns: 1,
      recentActivityEvents: 1,
    });
    expect(summary.blockers.map((b) => b.id).slice(0, 3)).toEqual(['job-1', 'delegation-1', 'delegation-2']);
    expect(summary.blockers.find((b) => b.id === 'approval-1')).toMatchObject({
      kind: 'approval',
      title: 'Approve file write',
      severity: 'info',
    });
    expect(summary.nextActions.map((a) => a.type)).toEqual([
      'review_pending_approvals',
      'resolve_budget_hard_stop',
      'inspect_failed_delegation',
      'inspect_running_autopilot',
      'inspect_deferred_agent_run',
    ]);
    expect(summary.sections.approvals[0]).toMatchObject({
      id: 'approval-1',
      action: 'file.write',
      agentRunId: 'agent-run-1',
      resumeRunId: 'agent-run-1',
      canApproveResume: true,
    });
    expect(summary.sections.approvals[0].resumeReview).toMatchObject({
      approvalId: 'approval-1',
      safeToResume: true,
      gate: {
        id: expect.stringMatching(/^review-/),
        required: true,
        safeToResume: true,
      },
      fileChangeCount: 1,
      commandCount: 1,
      workEvidenceCommandCount: 1,
    });
    expect(summary.sections.approvals[0].resumeReviewGateAudit).toMatchObject({
      id: summary.sections.approvals[0].resumeReview.gate.id,
      status: 'previewed',
      counts: { fileChanges: 1, commands: 1, workEvidenceCommands: 1, risks: 0 },
    });
    expect(summary.sections.approvals[0].resumeReview.fileChanges[0]).toMatchObject({
      operation: 'create',
      path: 'output/playwright/governance-review.js',
      ok: true,
    });
    expect(summary.sections.approvals[0].resumeReview.fileChanges[0].previewLines.join('\n')).toContain('+const review = true;');
    expect(summary.sections.approvals[0].resumeReview.stagedDiffReview).toMatchObject({
      id: expect.stringMatching(/^staged-diff-/),
      summary: { fileCount: 1, totalAdditions: 1, totalRemovals: 0, newFileCount: 1, verificationCoveredFileCount: 1, uncoveredFileCount: 0 },
    });
    expect(summary.sections.approvals[0].resumeReview.fileChanges[0]).toMatchObject({
      coverageStatus: 'verified',
      commandCoverage: { status: 'verified', verificationCommandCount: 1 },
    });
    expect(summary.sections.agentRuns[0]).toMatchObject({ id: 'agent-run-1', deferReason: 'approval_pending' });
    expect(summary.sections.activityEvents[0]).toMatchObject({ action: 'agent.run.created', agentRunId: 'agent-run-1' });
  });

  it('exposes the summary through the owner-gated API route', async () => {
    const { app, routes } = makeApp();
    registerGovernanceRoutes(app, {
      approvalStore: {
        listApprovals(query) {
          expect(query.status).toBe('pending');
          return [{ id: 'approval-1', type: 'manual', status: 'pending', payload: { title: 'Confirm release', action: 'file.write', agentRunId: 'agent-run-1' }, createdAt: 10 }];
        },
      },
      budgetStore: {
        listIncidents(query) {
          expect(query.status).toBe('open');
          return [{ id: 'incident-1', scopeType: 'project', scopeId: '/tmp/app', thresholdType: 'warning', status: 'open', createdAt: 20 }];
        },
      },
      delegationStore: {
        list(query) {
          if (query.status === 'queued') return [{ id: 'delegation-1', title: 'Split task', status: 'queued', createdAt: 30 }];
          if (query.status === 'failed') return [];
          return [];
        },
      },
      autopilotStore: {
        listJobs(query) {
          if (query.status === 'queued') return [{ id: 'job-1', action: 'heartbeat', status: 'queued', createdAt: 40 }];
          if (query.status === 'running') return [];
          return [];
        },
      },
      agentRunStore: {
        list(query) {
          expect(query.hasGovernance).toBe(true);
          return [{ id: 'agent-run-1', status: 'deferred', taskId: 'task-1', sourceType: 'idea_to_archive', approvalId: 'approval-1', deferReason: 'approval_pending', updatedAt: 50 }];
        },
        getTimeline(id) {
          expect(id).toBe('agent-run-1');
          return {
            run: { id, status: 'deferred', sourceType: 'idea_to_archive', approvalId: 'approval-1' },
            messages: [{
              id: 'msg-resume',
              payload: {
                resumeManifest: {
                  approvalId: 'approval-1',
                  fileChanges: [{ operation: 'create', path: 'output/playwright/governance-route-review.js', content: 'const routeReview = true;\n', requiresApproval: true }],
                  commands: ['node --check output/playwright/governance-route-review.js'],
                },
              },
            }],
          };
        },
      },
      activityLog: {
        list(query) {
          expect(query.limit).toBe(200);
          return [{ id: 1, action: 'permission.decision', entityType: 'agent_run', entityId: 'agent-run-1', severity: 'warn', ts: 60, details: { agentRunId: 'agent-run-1' } }];
        },
      },
    });

    const route = routes.find((r) => r.method === 'get' && r.path === '/api/governance/summary');
    const res = makeRes();
    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.counts).toMatchObject({
      pendingApprovals: 1,
      openBudgetIncidents: 1,
      queuedDelegations: 1,
      queuedAutopilotJobs: 1,
      totalOpen: 4,
      governedAgentRuns: 1,
      recentActivityEvents: 1,
    });
    expect(res.payload.blockers.map((b) => b.kind)).toEqual(['autopilot_job', 'delegation', 'budget', 'approval']);
    expect(res.payload.nextActions[0]).toMatchObject({ type: 'review_pending_approvals', targetKind: 'approval' });
    expect(res.payload.sections.approvals[0]).toMatchObject({ canApproveResume: true, resumeRunId: 'agent-run-1' });
    expect(res.payload.sections.approvals[0].resumeReview.gate).toMatchObject({
      id: expect.stringMatching(/^review-/),
      required: true,
    });
    expect(res.payload.sections.approvals[0].resumeReviewGateAudit).toMatchObject({ status: 'previewed' });
    expect(res.payload.sections.approvals[0].resumeReview.fileChanges[0].path).toBe('output/playwright/governance-route-review.js');
    expect(res.payload.sections.approvals[0].resumeReview.stagedDiffReview.summary).toMatchObject({
      fileCount: 1,
      totalAdditions: 1,
      newFileCount: 1,
      verificationCoveredFileCount: 1,
      uncoveredFileCount: 0,
    });
    expect(res.payload.sections.agentRuns[0].id).toBe('agent-run-1');
  });

  it('derives a work queue from summary blockers and transitions item state', () => {
    const { app, routes } = makeApp();
    const synced = [];
    const transitions = [];
    const queueStore = {
      syncFromBlockers: (b) => { synced.push(...(b || [])); return { upserted: (b || []).length }; },
      grouped: () => ({ pending_review: [{ id: 'q1', sourceKind: 'approval' }], pending_verify: [], pending_archive: [], pending_fix: [], done: [] }),
      list: () => [{ id: 'q1' }],
      setState: (id, state) => { transitions.push({ id, state }); return id === 'q1'; },
    };
    const base = { listApprovals: () => [], listIncidents: () => [], list: () => [], listJobs: () => [], getTimeline: () => null };
    const approvalStore = { ...base, listApprovals: () => [{ id: 'approval-1', type: 'manual', status: 'pending', payload: { title: 'Approve X', action: 'file.write' }, createdAt: 1 }] };
    registerGovernanceRoutes(app, {
      approvalStore,
      budgetStore: base,
      delegationStore: base,
      autopilotStore: base,
      agentRunStore: base,
      activityLog: { list: () => [] },
      governanceQueueStore: queueStore,
    });

    const queueGet = routes.find((r) => r.method === 'get' && r.path === '/api/governance/queue');
    const res = makeRes();
    queueGet.handlers[1]({ query: {} }, res);
    expect(res.payload.ok).toBe(true);
    expect(res.payload.queue.pending_review[0].id).toBe('q1');
    expect(synced.length).toBeGreaterThan(0); // 从 summary 阻塞项派生

    const statePost = routes.find((r) => r.method === 'post' && r.path === '/api/governance/queue/:id/state');
    const res2 = makeRes();
    statePost.handlers[1]({ params: { id: 'q1' }, body: { state: 'done' } }, res2);
    expect(res2.payload.ok).toBe(true);
    expect(transitions).toContainEqual({ id: 'q1', state: 'done' });

    const res3 = makeRes();
    statePost.handlers[1]({ params: { id: 'missing' }, body: { state: 'done' } }, res3);
    expect(res3.statusCode).toBe(404);
  });
});
