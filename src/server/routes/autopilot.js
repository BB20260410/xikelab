// Xike Lab — Autopilot routes (S18-2d)
// v0.56 Sprint 15-R4 — Autopilot 控制 API
// 从 server.js 3733-3774 提取，行为完全一致
//
// Round 4 P1：autopilot 规则 = 自动触发动作（forward/abort/重试...）的配置；
//   本机其他 UID 进程能写入恶意规则 → 拿用户付费配额跑垃圾任务，必须 owner-token

import { requireOwnerToken } from '../auth/owner-token.js';
import { autopilotScheduleStore as defaultScheduleStore } from '../../autopilot/AutopilotScheduleStore.js';

export function registerAutopilotRoutes(app, deps) {
  const { autopilotStore } = deps;
  const scheduleStore = deps.scheduleStore || defaultScheduleStore;
  const scheduler = deps.scheduler || null;

  app.get('/api/autopilot/config', (req, res) => {
    try { res.json({ ok: true, config: autopilotStore.getConfig() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/autopilot/toggle', requireOwnerToken, (req, res) => {
    try {
      const { enabled } = req.body || {};
      autopilotStore.setEnabled(!!enabled);
      res.json({ ok: true, enabled: autopilotStore.isEnabled() });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.put('/api/autopilot/config', requireOwnerToken, (req, res) => {
    try {
      const { maxHopsDefault } = req.body || {};
      if (maxHopsDefault !== undefined) autopilotStore.setMaxHops(maxHopsDefault);
      res.json({ ok: true, config: autopilotStore.getConfig() });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.post('/api/autopilot/rules', requireOwnerToken, (req, res) => {
    try {
      const r = autopilotStore.upsertRule(req.body || {});
      res.json({ ok: true, rule: r });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/autopilot/rules/:id', requireOwnerToken, (req, res) => {
    try {
      const ok = autopilotStore.deleteRule(req.params.id);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found or builtin (cannot delete; disable instead)' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/autopilot/log', (req, res) => {
    try {
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 100));
      res.json({ ok: true, logs: autopilotStore.recentLogs(limit) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/autopilot/schedules', (req, res) => {
    try {
      const schedules = scheduleStore.listSchedules({
        status: req.query.status,
        targetType: req.query.targetType,
        targetId: req.query.targetId,
        roomId: req.query.roomId,
        limit: req.query.limit,
      });
      res.json({ ok: true, count: schedules.length, schedules });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/autopilot/schedules', requireOwnerToken, (req, res) => {
    try {
      const schedule = scheduleStore.createSchedule(req.body || {});
      res.status(201).json({ ok: true, schedule });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.patch('/api/autopilot/schedules/:id', requireOwnerToken, (req, res) => {
    try {
      const schedule = scheduleStore.updateSchedule(req.params.id, req.body || {});
      res.json({ ok: true, schedule });
    } catch (e) { res.status(/not found/i.test(e.message) ? 404 : 400).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/autopilot/schedules/:id', requireOwnerToken, (req, res) => {
    try {
      const ok = scheduleStore.deleteSchedule(req.params.id);
      if (!ok) return res.status(404).json({ ok: false, error: 'schedule not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/autopilot/schedules/:id/queue', requireOwnerToken, (req, res) => {
    try {
      const schedule = scheduleStore.getSchedule(req.params.id);
      if (!schedule) return res.status(404).json({ ok: false, error: 'schedule not found' });
      const job = scheduleStore.enqueueJob({
        scheduleId: schedule.id,
        action: req.body?.action || schedule.action,
        runAfter: req.body?.runAfter || Date.now(),
        priority: req.body?.priority,
        payload: req.body?.payload || schedule.payload,
        dedupeKey: req.body?.dedupeKey,
      });
      res.status(201).json({ ok: true, job });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.get('/api/autopilot/jobs', (req, res) => {
    try {
      const jobs = scheduleStore.listJobs({
        status: req.query.status,
        scheduleId: req.query.scheduleId,
        roomId: req.query.roomId,
        limit: req.query.limit,
      });
      res.json({ ok: true, count: jobs.length, jobs });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/autopilot/jobs', requireOwnerToken, (req, res) => {
    try {
      const job = scheduleStore.enqueueJob(req.body || {});
      res.status(201).json({ ok: true, job });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.post('/api/autopilot/jobs/:id/cancel', requireOwnerToken, (req, res) => {
    try {
      const job = scheduleStore.cancelJob(req.params.id, { reason: req.body?.reason });
      res.json({ ok: true, job });
    } catch (e) { res.status(/not found/i.test(e.message) ? 404 : 400).json({ ok: false, error: e.message }); }
  });

  app.get('/api/autopilot/runs', (req, res) => {
    try {
      const runs = scheduleStore.listRuns({
        status: req.query.status,
        jobId: req.query.jobId,
        scheduleId: req.query.scheduleId,
        limit: req.query.limit,
      });
      res.json({ ok: true, count: runs.length, runs });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/autopilot/tick', requireOwnerToken, async (req, res) => {
    try {
      const result = scheduler
        ? await scheduler.tick({ limit: req.body?.limit, force: !!req.body?.force })
        : { ok: true, enqueued: scheduleStore.enqueueDueSchedules({ limit: req.body?.limit }) };
      res.json(result);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // v0.70 W9 集成：autopilot 规则 dry-run（学自 Flowise/Langflow/n8n）
  // POST /api/autopilot/dry-run { event: { type, sourceRoomId, ... } }
  // 不真触发，返回哪些规则会匹配 + 会做什么 action
  app.post('/api/autopilot/dry-run', async (req, res) => {
    try {
      const event = (req.body || {}).event;
      if (!event || typeof event !== 'object') {
        return res.status(400).json({ ok: false, error: 'event object required' });
      }
      const { dryRun } = await import('../../autopilot/learned/rule-dry-run.js');
      const rules = autopilotStore.getConfig().rules || [];
      const result = dryRun(rules, event);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
