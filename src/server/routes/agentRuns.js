import { agentRunStore as defaultAgentRunStore } from '../../agents/AgentRunStore.js';
import { AgentRunVerificationExecutor } from '../../agents/AgentRunVerificationExecutor.js';
import {
  buildApprovalResumeReview,
  buildApprovalResumeGateAudit,
  latestApprovalResumeManifest,
  verifyApprovalResumeReviewGate,
} from '../../agents/AgentRunApprovalResumeReview.js';
import { approvalStore as defaultApprovalStore } from '../../approval/ApprovalStore.js';
import { requireOwnerToken } from '../auth/owner-token.js';

function safeString(value, max = 512) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).slice(0, max).trim();
}

function clip(value, max = 2000) {
  return safeString(value, max);
}

function truthyQuery(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function artifactErrorStatus(error) {
  const message = error?.message || String(error || '');
  if (/agent run not found/.test(message)) return 404;
  if (/file not found|not a file/.test(message)) return 404;
  if (/digest mismatch/.test(message)) return 409;
  if (/not recorded|not allowed|escapes/.test(message)) return 403;
  return 400;
}

function downloadFilename(value) {
  return safeString(value || 'agent-run-artifact.md', 240).replace(/[^\w.-]+/g, '_') || 'agent-run-artifact.md';
}

function extractJsonObject(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try { return JSON.parse(value); } catch {}
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(value.slice(start, end + 1)); } catch {}
  }
  return null;
}

function buildPatchPrompt(timeline = {}) {
  const run = timeline.run || {};
  const details = run.details || {};
  const codeQuestion = details.codebaseQuestionAnswer && typeof details.codebaseQuestionAnswer === 'object'
    ? details.codebaseQuestionAnswer
    : null;
  const codeQuestionCitations = Array.isArray(codeQuestion?.citations)
    ? codeQuestion.citations.slice(0, 4).map((item) => `${safeString(item.id || '', 20) || 'C'}:${safeString(item.label || item.path || '', 340)}`).filter(Boolean)
    : [];
  return [
    'You generate a JSON manifest for a local-first Xike Lab idea_to_archive Agent Run.',
    'Return only JSON. Do not include markdown.',
    'Schema: {"fileChanges":[{"operation":"append|create|update","path":"src/...|public/...|tests/...|docs/...","content":"...","summary":"..."}],"commands":["git diff --check"],"notes":"..."}',
    'Constraints:',
    '- Do not remove budget, approval, audit, delegation, Autopilot, Agent Run, Codebase Index, or Agent/Skill Registry behavior.',
    '- Do not modify authentication, payment, login, encryption, DRM, or secrets.',
    '- Prefer the smallest project-local source patch.',
    '- Generated manifest is a draft only; execution is governed elsewhere.',
    '',
    `Run: ${run.id || '-'}`,
    `Idea: ${details.idea || run.taskId || '-'}`,
    `Agent Profile: ${run.agentProfileId || '-'}`,
    `Dispatch Tags: ${(run.dispatchTags || []).join(', ') || '-'}`,
    `Skills: ${(run.skills || []).join(', ') || '-'}`,
    `Affected Files: ${(details.affectedFiles || []).join(', ') || '-'}`,
    codeQuestion ? `Code Question Answer: ${safeString(codeQuestion.question || '-', 500)} | ${safeString(codeQuestion.answer || '-', 500)} | citations ${codeQuestionCitations.join(', ') || '-'}` : null,
  ].filter((line) => line !== null).join('\n');
}

async function maybeGenerateModelManifest({ id, timeline, body = {}, getRoomAdapterPool }) {
  if (!body.useModel) {
    return { generation: { mode: 'local_fallback', error: 'model adapter not requested' }, modelManifest: null };
  }
  const pool = typeof getRoomAdapterPool === 'function' ? getRoomAdapterPool() : null;
  const adapterId = safeString(body.adapterId || timeline.run?.adapterId || 'codex', 160);
  const adapter = pool?.get?.(adapterId);
  if (!adapter) {
    return { generation: { mode: 'local_fallback', adapterId, error: 'adapter unavailable' }, modelManifest: null };
  }
  try {
    const result = await adapter.chat([
      { role: 'system', content: 'You are a careful local code patch manifest generator.' },
      { role: 'user', content: buildPatchPrompt(timeline) },
    ], {
      cwd: process.cwd(),
      model: safeString(body.modelId || body.model, 160) || undefined,
      agentRunLifecycle: false,
      agentRunId: id,
      budgetContext: {
        roomId: timeline.run?.roomId || null,
        sessionId: timeline.run?.sessionId || null,
        taskId: timeline.run?.taskId || null,
        agentProfileId: timeline.run?.agentProfileId || null,
      },
    });
    const raw = result?.reply || result?.content || result?.text || '';
    const parsed = extractJsonObject(raw);
    return {
      generation: {
        mode: parsed ? 'model_adapter' : 'local_fallback',
        adapterId,
        modelId: safeString(body.modelId || body.model || adapter.model, 160),
        rawSummary: clip(raw, 1000),
        error: parsed ? '' : 'model response did not contain parseable JSON',
      },
      modelManifest: parsed,
    };
  } catch (e) {
    return {
      generation: {
        mode: 'local_fallback',
        adapterId,
        modelId: safeString(body.modelId || body.model || adapter.model, 160),
        error: clip(e.message || String(e), 1000),
      },
      modelManifest: null,
    };
  }
}

function parseListQuery(query = {}) {
  return {
    status: query.status || undefined,
    roomId: query.roomId || query.room || undefined,
    sessionId: query.sessionId || query.session || undefined,
    taskId: query.taskId || query.task || undefined,
    agentProfileId: query.agentProfileId || query.agentProfile || query.profile || undefined,
    sourceType: query.sourceType || undefined,
    sourceId: query.sourceId || undefined,
    approvalId: query.approvalId || undefined,
    budgetIncidentId: query.budgetIncidentId || undefined,
    delegationId: query.delegationId || undefined,
    deferReason: query.deferReason || undefined,
    approvalResumeGateId: query.approvalResumeGateId || query.reviewGateId || undefined,
    approvalResumeGateSha256: query.approvalResumeGateSha256 || query.reviewSha256 || undefined,
    hasGovernance: query.hasGovernance || undefined,
    limit: query.limit,
  };
}

export function registerAgentRunRoutes(app, {
  agentRunStore = defaultAgentRunStore,
  approvalStore = defaultApprovalStore,
  verificationExecutor = null,
  getRoomAdapterPool = null,
} = {}) {
  const ideaVerificationExecutor = verificationExecutor || new AgentRunVerificationExecutor({ agentRunStore });
  app.get('/api/agent-runs', requireOwnerToken, (req, res) => {
    try {
      res.json({ ok: true, runs: agentRunStore.list(parseListQuery(req.query || {})) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/agent-runs/session/:sessionId', requireOwnerToken, (req, res) => {
    try {
      const format = safeString(req.query?.format || 'json', 40).toLowerCase();
      if ((format === 'markdown' || format === 'md') && typeof agentRunStore.exportSession === 'function') {
        const exported = agentRunStore.exportSession(req.params.sessionId, {
          format,
          limit: req.query?.limit,
        });
        if (!exported) return res.status(404).json({ ok: false, error: 'agent run session not found' });
        res.setHeader?.('Content-Type', 'text/markdown; charset=utf-8');
        return res.send ? res.send(exported) : res.json({ ok: true, markdown: exported });
      }
      const sessionTimeline = agentRunStore.getSessionSnapshot(req.params.sessionId, {
        limit: req.query?.limit,
      });
      if (!sessionTimeline) return res.status(404).json({ ok: false, error: 'agent run session not found' });
      res.json({ ok: true, sessionTimeline });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/session/:sessionId/archive', requireOwnerToken, (req, res) => {
    try {
      if (typeof agentRunStore.recordSessionEvidenceArtifact !== 'function') {
        return res.status(501).json({ ok: false, error: 'session evidence archive not supported' });
      }
      const result = agentRunStore.recordSessionEvidenceArtifact(req.params.sessionId, {
        ...(req.body || {}),
        actorType: 'user',
        requestedBy: req.body?.requestedBy || 'owner',
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/agent-runs/:id/approval-resume-preview', requireOwnerToken, (req, res) => {
    try {
      const timeline = agentRunStore.getTimeline(req.params.id);
      if (!timeline) return res.status(404).json({ ok: false, error: 'agent run not found' });
      if (timeline.run?.sourceType !== 'idea_to_archive') {
        return res.status(400).json({ ok: false, error: 'agent run is not an idea_to_archive draft' });
      }
      const approvalId = safeString(req.query?.approvalId || timeline.run?.approvalId || timeline.run?.details?.approvalId, 160);
      const resumeManifest = latestApprovalResumeManifest(timeline, approvalId);
      if (!resumeManifest) return res.status(400).json({ ok: false, error: 'approval resume manifest not found' });
      const resumeReview = buildApprovalResumeReview(resumeManifest, { cwd: process.cwd(), runId: req.params.id });
      res.json({
        ok: true,
        approvalId: approvalId || resumeReview.approvalId,
        resumeReview,
        resumeReviewGate: resumeReview.gate,
        resumeReviewGateAudit: buildApprovalResumeGateAudit(resumeReview, { status: 'previewed', recordedBy: 'owner' }),
      });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/agent-runs/:id/artifacts', requireOwnerToken, (req, res) => {
    try {
      if (typeof agentRunStore.listArtifacts !== 'function') {
        return res.status(501).json({ ok: false, error: 'agent run artifact lookup not supported' });
      }
      const result = agentRunStore.listArtifacts(req.params.id, req.query || {});
      if (!result) return res.status(404).json({ ok: false, error: 'agent run not found' });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(artifactErrorStatus(e)).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/agent-runs/:id/artifacts/:artifactId/download', requireOwnerToken, (req, res) => {
    try {
      if (typeof agentRunStore.readArtifact !== 'function') {
        return res.status(501).json({ ok: false, error: 'agent run artifact download not supported' });
      }
      const result = agentRunStore.readArtifact(req.params.id, {
        artifactId: req.params.artifactId,
        cwd: process.cwd(),
      });
      res.setHeader?.('Content-Type', result.contentType || 'text/markdown; charset=utf-8');
      res.setHeader?.('Content-Disposition', `attachment; filename="${downloadFilename(result.filename)}"`);
      res.setHeader?.('X-Xike-Artifact-Path', result.artifact?.path || '');
      return res.send ? res.send(result.content) : res.json({ ok: true, artifact: result.artifact, content: result.content });
    } catch (e) {
      res.status(artifactErrorStatus(e)).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/agent-runs/:id', requireOwnerToken, (req, res) => {
    try {
      const timeline = agentRunStore.getTimeline(req.params.id);
      if (!timeline) return res.status(404).json({ ok: false, error: 'agent run not found' });
      const sessionTimeline = truthyQuery(req.query?.includeSession) && timeline.run?.sessionId
        ? agentRunStore.getSessionSnapshot(timeline.run.sessionId, { limit: req.query?.sessionLimit })
        : null;
      res.json({ ok: true, ...timeline, ...(sessionTimeline ? { sessionTimeline } : {}) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/agent-runs/:id/export', requireOwnerToken, (req, res) => {
    try {
      const format = safeString(req.query?.format || 'json', 40).toLowerCase();
      const exported = agentRunStore.exportRun(req.params.id, { format });
      if (!exported) return res.status(404).json({ ok: false, error: 'agent run not found' });
      if (format === 'markdown' || format === 'md') {
        res.setHeader?.('Content-Type', 'text/markdown; charset=utf-8');
        return res.send ? res.send(exported) : res.json({ ok: true, markdown: exported });
      }
      res.json({ ok: true, export: exported });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/agent-runs/:id/approval-resume-gate-audit', requireOwnerToken, (req, res) => {
    try {
      const format = safeString(req.query?.format || 'json', 40).toLowerCase();
      const report = typeof agentRunStore.getApprovalResumeGateAuditReport === 'function'
        ? agentRunStore.getApprovalResumeGateAuditReport(req.params.id, { format })
        : null;
      if (!report) return res.status(404).json({ ok: false, error: 'approval resume gate audit not found' });
      if (format === 'markdown' || format === 'md') {
        res.setHeader?.('Content-Type', 'text/markdown; charset=utf-8');
        return res.send ? res.send(report) : res.json({ ok: true, markdown: report });
      }
      res.json({ ok: true, report });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/approval-resume-gate-audit/archive', requireOwnerToken, (req, res) => {
    try {
      if (typeof agentRunStore.recordApprovalResumeGateAuditReportArtifact !== 'function') {
        return res.status(501).json({ ok: false, error: 'gate audit report archive not supported' });
      }
      const result = agentRunStore.recordApprovalResumeGateAuditReportArtifact(req.params.id, {
        ...(req.body || {}),
        actorType: 'user',
        requestedBy: req.body?.requestedBy || 'owner',
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const run = agentRunStore.create({
        ...body,
        roomId: safeString(body.roomId || body.room),
        sessionId: safeString(body.sessionId || body.session),
        taskId: safeString(body.taskId || body.task, 240),
        agentProfileId: safeString(body.agentProfileId || body.agentProfile || body.profile, 160),
        actorType: 'user',
      });
      res.status(201).json({ ok: true, run });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/idea', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const result = agentRunStore.createIdeaRun({
        ...body,
        roomId: safeString(body.roomId || body.room),
        sessionId: safeString(body.sessionId || body.session),
        taskId: safeString(body.taskId || body.task, 240),
        agentProfileId: safeString(body.agentProfileId || body.agentProfile || body.profile, 160),
        actorType: 'user',
        requestedBy: 'owner',
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/idea-execution', requireOwnerToken, (req, res) => {
    try {
      const result = agentRunStore.completeIdeaRun(req.params.id, {
        ...(req.body || {}),
        actorType: 'user',
        requestedBy: 'owner',
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/idea-auto-execute', requireOwnerToken, async (req, res) => {
    try {
      const result = await ideaVerificationExecutor.executeIdeaRun(req.params.id, {
        ...(req.body || {}),
        actorType: 'user',
        requestedBy: 'owner',
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/approval-resume', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      const timeline = agentRunStore.getTimeline(req.params.id);
      if (!timeline) return res.status(404).json({ ok: false, error: 'agent run not found' });
      if (timeline.run?.sourceType !== 'idea_to_archive') {
        return res.status(400).json({ ok: false, error: 'agent run is not an idea_to_archive draft' });
      }
      const approvalId = safeString(body.approvalId || body.permissionApprovalId || body.resumeApprovalId || timeline.run?.approvalId || timeline.run?.details?.approvalId, 160);
      if (!approvalId) return res.status(400).json({ ok: false, error: 'approvalId required' });
      const approval = approvalStore.getApproval?.(approvalId);
      if (!approval) return res.status(404).json({ ok: false, error: 'approval not found' });
      if (approval.status !== 'approved') {
        return res.status(409).json({ ok: false, error: 'approval is not approved', approval });
      }
      const resumeManifest = latestApprovalResumeManifest(timeline, approvalId);
      if (!resumeManifest) return res.status(400).json({ ok: false, error: 'approval resume manifest not found' });
      const resumeReview = buildApprovalResumeReview(resumeManifest, { cwd: process.cwd(), runId: req.params.id });
      const reviewGate = verifyApprovalResumeReviewGate(resumeReview, {
        reviewGateId: body.reviewGateId || body.resumeReviewGateId || body.approvalResumeReviewGateId,
        reviewSha256: body.reviewSha256 || body.resumeReviewSha256 || body.approvalResumeReviewSha256,
      });
      if (!reviewGate.ok) {
        const blockedAudit = buildApprovalResumeGateAudit(resumeReview, { status: 'blocked', recordedBy: body.requestedBy || 'owner' });
        return res.status(reviewGate.status).json({
          ok: false,
          error: reviewGate.error,
          resumeReview,
          resumeReviewGate: reviewGate.gate,
          resumeReviewGateAudit: blockedAudit,
        });
      }
      const resumeReviewGateAudit = buildApprovalResumeGateAudit(resumeReview, { status: 'accepted', recordedBy: body.requestedBy || 'owner' });
      const auditRecord = typeof agentRunStore.recordApprovalResumeGateAudit === 'function'
        ? agentRunStore.recordApprovalResumeGateAudit(req.params.id, {
          audit: resumeReviewGateAudit,
          actorType: 'user',
          status: 'accepted',
        })
        : null;
      const result = await ideaVerificationExecutor.executeIdeaRun(req.params.id, {
        ...resumeManifest,
        approvalId,
        permissionApprovalId: approvalId,
        resumeApprovalId: approvalId,
        resumeReviewGate: reviewGate.gate,
        resumeReviewGateAudit,
        actorType: 'user',
        requestedBy: body.requestedBy || 'owner',
      });
      res.status(201).json({
        ok: true,
        approval,
        resumeManifest,
        resumeReview,
        resumeReviewGate: reviewGate.gate,
        resumeReviewGateAudit,
        resumeReviewGateAuditMessage: auditRecord?.message || null,
        ...result,
      });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/idea-manifest-draft', requireOwnerToken, (req, res) => {
    try {
      const result = agentRunStore.recordIdeaManifestDraft(req.params.id, {
        ...(req.body || {}),
        actorType: 'user',
        requestedBy: 'owner',
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/idea-patch-manifest-draft', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      const timeline = agentRunStore.getTimeline(req.params.id);
      if (!timeline) return res.status(404).json({ ok: false, error: 'agent run not found' });
      const model = await maybeGenerateModelManifest({
        id: req.params.id,
        timeline,
        body,
        getRoomAdapterPool,
      });
      const result = agentRunStore.recordIdeaPatchManifestDraft(req.params.id, {
        ...body,
        modelManifest: model.modelManifest,
        generation: model.generation,
        actorType: 'user',
        requestedBy: 'owner',
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/messages', requireOwnerToken, (req, res) => {
    try {
      const message = agentRunStore.appendMessage(req.params.id, req.body || {});
      res.status(201).json({ ok: true, message });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/tool-results', requireOwnerToken, (req, res) => {
    try {
      const toolResult = agentRunStore.appendToolResult(req.params.id, req.body || {});
      res.status(201).json({ ok: true, toolResult });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/transition', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const run = agentRunStore.transition(req.params.id, body.status, body.details || {});
      res.json({ ok: true, run });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/replay-plan', requireOwnerToken, (req, res) => {
    try {
      const result = agentRunStore.recordReplayPlan(req.params.id, {
        ...(req.body || {}),
        actorType: 'user',
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/replay-result', requireOwnerToken, (req, res) => {
    try {
      const result = agentRunStore.recordReplayResult(req.params.id, {
        ...(req.body || {}),
        actorType: 'user',
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/archive', requireOwnerToken, (req, res) => {
    try {
      const result = agentRunStore.recordArchive(req.params.id, {
        ...(req.body || {}),
        actorType: 'user',
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });
}

export { parseListQuery };
