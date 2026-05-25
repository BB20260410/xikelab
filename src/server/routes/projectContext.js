import { statSync } from 'node:fs';
import { requireOwnerToken } from '../auth/owner-token.js';
import { buildProjectContextBundle, summarizeProjectContextBundle } from '../../context/ProjectContextBundle.js';

export function registerProjectContextRoutes(app, { safeResolveFsPath } = {}) {
  app.get('/api/project-context', requireOwnerToken, (req, res) => {
    try {
      const rawCwd = typeof req.query.cwd === 'string' && req.query.cwd.trim() ? req.query.cwd.trim() : process.cwd();
      const cwd = safeResolveFsPath ? safeResolveFsPath(rawCwd) : rawCwd;
      if (!cwd) return res.status(403).json({ ok: false, error: 'cwd 越权或敏感目录' });
      const st = statSync(cwd);
      if (!st.isDirectory()) return res.status(400).json({ ok: false, error: 'cwd 不是目录' });
      const includeContent = req.query.includeContent === '1' || req.query.includeContent === 'true';
      const bundle = buildProjectContextBundle(cwd, {
        maxChars: req.query.maxChars,
        maxFileChars: req.query.maxFileChars,
      });
      res.json({
        ok: true,
        bundle: includeContent ? bundle : summarizeProjectContextBundle(bundle),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
