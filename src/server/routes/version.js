import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function registerVersionRoutes(app, deps) {
  const { rootDir } = deps;

  app.get('/api/version', (req, res) => {
    let version = 'unknown';
    let buildVersion = '';
    let appName = 'Xike Lab';
    try {
      const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
      version = pkg.version || version;
      appName = pkg.productName || pkg.name || appName;
    } catch {}
    for (const file of ['HANDOFF_NEW_CHAT.md', 'HANDOFF.md']) {
      try {
        const md = readFileSync(join(rootDir, file), 'utf-8');
        const m = md.match(/v(0\.\d+)\b/);
        if (m) { buildVersion = m[1]; break; }
      } catch {}
    }
    res.json({ ok: true, version, buildVersion, appName });
  });
}
