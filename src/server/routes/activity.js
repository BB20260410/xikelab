import { requireOwnerToken } from '../auth/owner-token.js';
import { activityLog as defaultActivityLog } from '../../audit/ActivityLog.js';

function parseLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 200;
  return Math.max(1, Math.min(1000, Math.trunc(n)));
}

function parseBooleanFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseActivityQuery(query = {}) {
  return {
    roomId: query.roomId || query.room || undefined,
    sessionId: query.sessionId || query.session || undefined,
    taskId: query.taskId || undefined,
    entityType: query.entityType || undefined,
    entityId: query.entityId || undefined,
    action: query.action || query.tag || undefined,
    actorType: query.actorType || undefined,
    severity: query.severity || undefined,
    status: query.status || undefined,
    agentOnly: parseBooleanFlag(query.agentOnly || query.agent || query.agentSkillOnly) || undefined,
    agentRunId: query.agentRunId || query.runId || query.agentRun || undefined,
    approvalResumeGateId: query.approvalResumeGateId || query.reviewGateId || query.resumeReviewGateId || undefined,
    approvalResumeGateSha256: query.approvalResumeGateSha256 || query.reviewSha256 || query.resumeReviewSha256 || undefined,
    agentProfileId: query.agentProfileId || query.agentProfile || query.profile || undefined,
    skillName: query.skillName || query.skill || undefined,
    diagnosticCode: query.diagnosticCode || query.diagnostic || undefined,
    since: query.since || query.sinceTs || undefined,
    until: query.until || query.untilTs || undefined,
    order: query.order === 'ASC' ? 'ASC' : 'DESC',
    limit: parseLimit(query.limit),
  };
}

export function registerActivityRoutes(app, { activityLog = defaultActivityLog } = {}) {
  app.get('/api/activity', requireOwnerToken, async (req, res) => {
    try {
      const events = activityLog.list(parseActivityQuery(req.query || {}));
      res.json({ ok: true, count: events.length, events });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/activity', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.action || typeof body.action !== 'string') {
        return res.status(400).json({ ok: false, error: 'action required' });
      }
      const event = activityLog.record({
        ...body,
        actorType: body.actorType || 'user',
      });
      res.json({ ok: true, event });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });
}

export { parseActivityQuery };
