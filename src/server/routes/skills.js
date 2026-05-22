// Xike Lab — Skills routes (S18-2f)
// v0.55 Sprint 13-C — Skills 系统
// 从 server.js 3825-3867 提取
//
// Round 4 P1：skills 内容会被 LLM 当 prompt 加载（影响 AI 决策） → 写入必须 owner-token

import { requireOwnerToken } from '../auth/owner-token.js';

export function registerSkillsRoutes(app, deps) {
  const { skillStore } = deps;

  app.get('/api/skills', (req, res) => {
    try { res.json({ ok: true, skills: skillStore.list() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/skills/:name', (req, res) => {
    try {
      const s = skillStore.get(req.params.name);
      if (!s) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true, skill: s });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/skills', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 256 * 1024) return res.status(413).json({ error: 'body 过大' });
      const r = skillStore.upsert(body);
      res.json({ ok: true, skill: r });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.put('/api/skills/:name', requireOwnerToken, (req, res) => {
    try {
      const body = { ...(req.body || {}), name: req.params.name };
      if (JSON.stringify(body).length > 256 * 1024) return res.status(413).json({ error: 'body 过大' });
      const r = skillStore.upsert(body);
      res.json({ ok: true, skill: r });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/skills/:name', requireOwnerToken, (req, res) => {
    try {
      const ok = skillStore.delete(req.params.name);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/skills/reload', requireOwnerToken, (req, res) => {
    try { skillStore.reload(); res.json({ ok: true, count: skillStore.list().length }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}
