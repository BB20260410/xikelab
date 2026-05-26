import { codebaseIndexStore as defaultCodebaseIndexStore } from '../../agents/CodebaseIndexStore.js';
import { requireOwnerToken } from '../auth/owner-token.js';

function safeString(value, max = 1000) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).slice(0, max).trim();
}

function resolveRouteCwd(req, safeResolveFsPath) {
  const explicit = safeString(req.body?.cwd || req.query?.cwd, 2000);
  if (!explicit) return process.cwd();
  const resolved = safeResolveFsPath ? safeResolveFsPath(explicit) : explicit;
  if (!resolved) throw new Error('invalid cwd');
  return resolved;
}

function intInRange(value, fallback, min, max) {
  const n = Number(value);
  const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

function boolFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function registerCodebaseIndexRoutes(app, {
  codebaseIndexStore = defaultCodebaseIndexStore,
  safeResolveFsPath = null,
} = {}) {
  app.post('/api/codebase-index/rebuild', requireOwnerToken, (req, res) => {
    try {
      const cwd = resolveRouteCwd(req, safeResolveFsPath);
      const query = safeString(req.body?.query || '', 500);
      const focusLimit = intInRange(req.body?.focusLimit || req.body?.limit, 24, 4, 24);
      const result = codebaseIndexStore.rebuild(cwd, { query, focusLimit });
      res.json({ ok: true, status: result.status, map: result.map });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/codebase-index/status', requireOwnerToken, (req, res) => {
    try {
      const cwd = resolveRouteCwd(req, safeResolveFsPath);
      res.json({ ok: true, status: codebaseIndexStore.status(cwd) });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/codebase-index/query', requireOwnerToken, (req, res) => {
    try {
      const cwd = resolveRouteCwd(req, safeResolveFsPath);
      const query = safeString(req.body?.query || req.body?.q || '', 500);
      const maxResults = intInRange(req.body?.maxResults || req.body?.limit, 20, 1, 100);
      const focusLimit = intInRange(req.body?.focusLimit, 24, 4, 24);
      const useSnapshot = boolFlag(req.body?.useSnapshot || req.query?.useSnapshot);
      const result = codebaseIndexStore.query(cwd, { query, maxResults, focusLimit, useSnapshot });
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/codebase-index/question', requireOwnerToken, (req, res) => {
    try {
      const cwd = resolveRouteCwd(req, safeResolveFsPath);
      const question = safeString(req.body?.question || req.body?.query || req.body?.q || '', 500);
      const maxResults = intInRange(req.body?.maxResults || req.body?.limit, 8, 1, 20);
      const focusLimit = intInRange(req.body?.focusLimit, 24, 4, 24);
      const useSnapshot = boolFlag(req.body?.useSnapshot || req.query?.useSnapshot);
      const result = codebaseIndexStore.question(cwd, { question, maxResults, focusLimit, useSnapshot });
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });
}
