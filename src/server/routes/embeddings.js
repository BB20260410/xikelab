// panel v2.0 Task 4.2 — 向量索引 REST API
//
// Round 4 P1：embeddings 索引会消耗 LLM API 配额（每次 upsert 算一次 embedding 调用），
//   写端点必须 owner-token 防本机其他 UID 进程刷配额

import { requireOwnerToken } from '../auth/owner-token.js';

export function registerEmbeddingsRoutes(app) {
  app.post('/api/embeddings/index', requireOwnerToken, async (req, res) => {
    try {
      const { kind, refId, text, provider } = req.body || {};
      if (!kind || !refId || !text) return res.status(400).json({ error: 'kind/refId/text required' });
      const m = await import('../../embeddings/VectorIndex.js');
      const r = await m.upsertEmbedding({ kind, refId, text, provider });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Round 5 7M：search 触发 query embedding 调用（烧配额），list 暴露索引内容 → 全部 owner-token
  app.post('/api/embeddings/search', requireOwnerToken, async (req, res) => {
    try {
      const { query, kind, limit, provider, minScore } = req.body || {};
      if (!query) return res.status(400).json({ error: 'query required' });
      const m = await import('../../embeddings/VectorIndex.js');
      const items = await m.semanticSearch(query, { kind, limit, provider, minScore });
      res.json({ ok: true, count: items.length, items });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.delete('/api/embeddings/:kind/:refId', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../embeddings/VectorIndex.js');
      const changes = m.deleteEmbedding({ kind: req.params.kind, refId: req.params.refId });
      res.json({ ok: true, changes });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/embeddings/list', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../embeddings/VectorIndex.js');
      const items = m.listEmbeddings({ kind: req.query.kind, limit: req.query.limit ? parseInt(req.query.limit, 10) : 100 });
      res.json({ ok: true, count: items.length, items });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
