import { requireOwnerToken } from '../auth/owner-token.js';
import { approvalStore as defaultApprovalStore } from '../../approval/ApprovalStore.js';

function limitFromQuery(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 500;
  return Math.max(1, Math.min(1000, Math.trunc(n)));
}

function sendError(res, e) {
  const msg = e?.message || String(e);
  if (/required|invalid|must be/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
  return res.status(500).json({ ok: false, error: msg });
}

export function registerApprovalRoutes(app, { approvalStore = defaultApprovalStore } = {}) {
  app.get('/api/approvals', requireOwnerToken, async (req, res) => {
    try {
      const approvals = approvalStore.listApprovals({
        status: req.query.status || undefined,
        type: req.query.type || undefined,
        requesterType: req.query.requesterType || undefined,
        requesterId: req.query.requesterId || undefined,
        limit: limitFromQuery(req.query.limit),
      });
      res.json({ ok: true, count: approvals.length, approvals });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/approvals', requireOwnerToken, async (req, res) => {
    try {
      const approval = approvalStore.createApproval(req.body || {});
      res.status(201).json({ ok: true, approval });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/approvals/:id', requireOwnerToken, async (req, res) => {
    try {
      const approval = approvalStore.getApproval(req.params.id);
      if (!approval) return res.status(404).json({ ok: false, error: 'approval not found' });
      res.json({ ok: true, approval });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/approvals/:id/approve', requireOwnerToken, async (req, res) => {
    try {
      const approval = approvalStore.approve(req.params.id, {
        decisionBy: req.body?.decisionBy || 'owner',
        reason: req.body?.reason || '',
      });
      if (!approval) return res.status(404).json({ ok: false, error: 'approval not found' });
      res.json({ ok: true, approval });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/approvals/:id/reject', requireOwnerToken, async (req, res) => {
    try {
      const approval = approvalStore.reject(req.params.id, {
        decisionBy: req.body?.decisionBy || 'owner',
        reason: req.body?.reason || '',
      });
      if (!approval) return res.status(404).json({ ok: false, error: 'approval not found' });
      res.json({ ok: true, approval });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/approvals/:id/cancel', requireOwnerToken, async (req, res) => {
    try {
      const approval = approvalStore.cancel(req.params.id, {
        decisionBy: req.body?.decisionBy || 'owner',
        reason: req.body?.reason || '',
      });
      if (!approval) return res.status(404).json({ ok: false, error: 'approval not found' });
      res.json({ ok: true, approval });
    } catch (e) {
      sendError(res, e);
    }
  });
}
