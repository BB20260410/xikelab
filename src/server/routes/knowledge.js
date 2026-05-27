// Xike Lab — Knowledge routes (S18-2g)
// v0.55 Sprint 13-B — 知识库（KB）API
// 从 server.js 3772-3823 提取
//
// Round 4 P1：知识库写入/删除 = 数据资产篡改，本机其他 UID 进程必须挡

import { requireOwnerToken } from '../auth/owner-token.js';

export function registerKnowledgeRoutes(app, deps) {
  const { knowledgeStore, evidenceKnowledgeStore, agentRunStore, activityLog } = deps;

  // Round 5 7M：KB 列表/详情含文档片段（数据泄漏），search/context 烧 LLM embedding 配额 → 全部 owner-token
  app.get('/api/knowledge', requireOwnerToken, (req, res) => {
    try { res.json({ ok: true, kbs: knowledgeStore.list() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/knowledge/:name', requireOwnerToken, (req, res) => {
    try {
      const kb = knowledgeStore.get(req.params.name);
      if (!kb) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true, kb });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/knowledge', requireOwnerToken, (req, res) => {
    try {
      const { name, description } = req.body || {};
      const kb = knowledgeStore.create({ name, description });
      res.json({ ok: true, kb });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/knowledge/:name', requireOwnerToken, (req, res) => {
    try {
      const ok = knowledgeStore.delete(req.params.name);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/knowledge/:name/documents', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 4 * 1024 * 1024) return res.status(413).json({ error: 'body 过大（> 4MB）' });
      const doc = await knowledgeStore.addDocument(req.params.name, body);
      res.json({ ok: true, document: doc });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/knowledge/:name/documents/:docId', requireOwnerToken, (req, res) => {
    try {
      const ok = knowledgeStore.removeDocument(req.params.name, req.params.docId);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/knowledge/:name/search', requireOwnerToken, async (req, res) => {
    try {
      const { query, topK } = req.body || {};
      // v0.70.3-t2: hybrid 可从 body 或 query 透传
      const hybrid = req.body?.hybrid === true || req.query?.hybrid === '1';
      const hits = await knowledgeStore.search({ name: req.params.name, query, topK, hybrid });
      res.json({ ok: true, hits, mode: hybrid ? 'hybrid' : 'auto' });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // v0.9.x B-020: 引文回链 — 给 query 返回 { context, citations[] }
  // citations 含 index / chunkId / docId / docTitle / sourceUrl / textSnippet
  // 前端可用 citations 把 AI reply 中 [N] 渲染成可点链接
  app.post('/api/knowledge/:name/context', requireOwnerToken, async (req, res) => {
    try {
      const { query, topK } = req.body || {};
      const hybrid = req.body?.hybrid === true || req.query?.hybrid === '1';
      const r = await knowledgeStore.buildContextFor({ name: req.params.name, query, topK, hybrid });
      res.json({ ok: true, context: r.context, citations: r.citations });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // ── 证据知识库（P4/A2）：跨 Agent Run / 工具结果 / 审计的本地 FTS 检索 ──
  // 与上面的文档型 KnowledgeStore 平行：用 3 段子路径 /api/knowledge/evidence/*
  // 避开 GET /api/knowledge/:name 的单段匹配。仅本地只读、owner-token；
  // 命中/统计含证据原文片段，reindex 派生真实 store 数据 → 全部 owner-token。
  if (evidenceKnowledgeStore) {
    app.get('/api/knowledge/evidence/search', requireOwnerToken, (req, res) => {
      try {
        const q = String(req.query?.q || '');
        const kind = req.query?.kind ? String(req.query.kind) : undefined;
        const limit = req.query?.limit ? Number(req.query.limit) : undefined;
        const hits = evidenceKnowledgeStore.search(q, { kind, limit });
        res.json({ ok: true, hits, indexed: evidenceKnowledgeStore.stats().indexed });
      } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    app.get('/api/knowledge/evidence/stats', requireOwnerToken, (req, res) => {
      try { res.json({ ok: true, ...evidenceKnowledgeStore.stats() }); }
      catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // 从 Agent Run / Activity store 增量派生并索引（复用 store 内 ref dedupe，失败不阻断主流程）
    app.post('/api/knowledge/evidence/reindex', requireOwnerToken, (req, res) => {
      try {
        const limit = req.body?.limit ? Number(req.body.limit) : undefined;
        const r = evidenceKnowledgeStore.indexFromStores({ agentRunStore, activityLog, limit });
        res.json({ ok: true, ...r, total: evidenceKnowledgeStore.stats().indexed });
      } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });
  }
}
