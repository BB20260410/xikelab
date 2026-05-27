// sessions-readonly.js — 从 server.js 拆出的 sessions 只读 endpoint（v0.81 真做）
// 仅迁纯读 endpoint，副作用 endpoint（kill/reset/interrupt）留 server.js（依赖闭包多）

export function registerSessionsReadonlyRoutes(app, deps) {
  const { sessions } = deps;
  if (!sessions) throw new Error('registerSessionsReadonlyRoutes: deps.sessions required');

  // GET /api/sessions/:id/cost-series?windowMin=30  → 成本时序
  app.get('/api/sessions/:id/cost-series', (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      const win = Math.max(5, Math.min(180, parseInt(req.query.windowMin || '30', 10)));
      const series = s.costTracker ? s.costTracker.seriesByMinute(win) : [];
      res.json({ ok: true, windowMin: win, series });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /api/sessions/:id/safety-history  → DangerDetector + LoopGuard + StateMachine 历史
  app.get('/api/sessions/:id/safety-history', (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      res.json({
        ok: true,
        danger: s.dangerHistory || [],
        loopGuard: s.loopGuardHistory || [],
        stateHistory: s.stateMachine ? s.stateMachine.transitions : [],
        currentState: s.stateMachine ? s.stateMachine.current : (s.runState || 'idle'),
        guardSnapshot: s.guard ? s.guard.snapshot() : null,
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  return { migrated: 2 };
}
