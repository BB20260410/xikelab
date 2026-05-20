// Claude Panel — Knowledge routes (S18-2g)
// v0.55 Sprint 13-B — 知识库（KB）API
// 从 server.js 3772-3823 提取

export function registerKnowledgeRoutes(app, deps) {
  const { knowledgeStore } = deps;

  app.get('/api/knowledge', (req, res) => {
    try { res.json({ ok: true, kbs: knowledgeStore.list() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/knowledge/:name', (req, res) => {
    try {
      const kb = knowledgeStore.get(req.params.name);
      if (!kb) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true, kb });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/knowledge', (req, res) => {
    try {
      const { name, description } = req.body || {};
      const kb = knowledgeStore.create({ name, description });
      res.json({ ok: true, kb });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/knowledge/:name', (req, res) => {
    try {
      const ok = knowledgeStore.delete(req.params.name);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/knowledge/:name/documents', async (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 4 * 1024 * 1024) return res.status(413).json({ error: 'body 过大（> 4MB）' });
      const doc = await knowledgeStore.addDocument(req.params.name, body);
      res.json({ ok: true, document: doc });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/knowledge/:name/documents/:docId', (req, res) => {
    try {
      const ok = knowledgeStore.removeDocument(req.params.name, req.params.docId);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/knowledge/:name/search', async (req, res) => {
    try {
      const { query, topK } = req.body || {};
      const hits = await knowledgeStore.search({ name: req.params.name, query, topK });
      res.json({ ok: true, hits });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
}
