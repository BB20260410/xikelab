// panel v1.5 — license REST API
//
// Round 4 P1：activate/deactivate 写 license 文件（决定付费功能可用性），
//   本机其他 UID 进程不能任意切换 license tier，必须 owner-token

import { requireOwnerToken } from '../auth/owner-token.js';

export function registerLicenseRoutes(app) {
  // Round 5 7M：status/features/check 含 email/tier（隐私），verify 暴露公钥验证 → 全部 owner-token
  app.get('/api/license/status', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../license/LicenseManager.js');
      res.json({ ok: true, ...m.getStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/license/activate', requireOwnerToken, async (req, res) => {
    try {
      const licenseStr = (req.body?.license || '').trim();
      if (!licenseStr) return res.status(400).json({ ok: false, error: 'license body required' });
      const m = await import('../../license/LicenseManager.js');
      const v = m.saveLicense(licenseStr);
      if (!v.valid) return res.status(400).json({ ok: false, error: v.error, payload: v.payload });
      res.json({ ok: true, tier: v.payload.tier, email: v.payload.email });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/license/deactivate', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../license/LicenseManager.js');
      m.clearLicense();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/license/features', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../license/LicenseManager.js');
      const l = m.loadLicense({ force: true });
      res.json({ ok: true, tier: l.tier, features: l.features });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/license/check/:feature', requireOwnerToken, async (req, res) => {
    try {
      const m = await import('../../license/LicenseManager.js');
      const has = m.hasFeature(req.params.feature);
      res.json({ ok: true, feature: req.params.feature, has, tier: m.getCurrentTier() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/license/verify', requireOwnerToken, async (req, res) => {
    try {
      const licenseStr = (req.body?.license || '').trim();
      if (!licenseStr) return res.status(400).json({ ok: false, error: 'license body required' });
      const m = await import('../../license/LicenseManager.js');
      const v = m.verifyLicense(licenseStr);
      res.json({ ok: true, ...v });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
