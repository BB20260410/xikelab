import { agentRunStore as defaultAgentRunStore } from '../../agents/AgentRunStore.js';
import { requireOwnerToken } from '../auth/owner-token.js';

function safeString(value, max = 512) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).slice(0, max).trim();
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
    limit: query.limit,
  };
}

export function registerAgentRunRoutes(app, { agentRunStore = defaultAgentRunStore } = {}) {
  app.get('/api/agent-runs', requireOwnerToken, (req, res) => {
    try {
      res.json({ ok: true, runs: agentRunStore.list(parseListQuery(req.query || {})) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/agent-runs/:id', requireOwnerToken, (req, res) => {
    try {
      const timeline = agentRunStore.getTimeline(req.params.id);
      if (!timeline) return res.status(404).json({ ok: false, error: 'agent run not found' });
      res.json({ ok: true, ...timeline });
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
}

export { parseListQuery };
