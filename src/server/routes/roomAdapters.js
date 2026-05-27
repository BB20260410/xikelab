import { requireOwnerToken } from '../auth/owner-token.js';
import { getCurrentTier, hasFeature } from '../../license/LicenseManager.js';
import { permissionApprovalIdFromRequest, permissionHttpBody, permissionHttpStatus } from '../../permissions/PermissionGovernance.js';

export function registerRoomAdaptersRoutes(app, deps) {
  const {
    getRoomAdaptersConfig,
    setRoomAdaptersConfig,
    cleanRoomAdaptersConfig,
    maskRoomAdaptersConfig,
    saveRoomAdaptersConfig,
    rebuildRoomAdapters,
    roomAdapterPool,
    hasGeminiCli,
    permissionGovernance,
    send500,
  } = deps;

  app.get('/api/room-adapters', requireOwnerToken, (req, res) => {
    try {
      res.json({
        ok: true,
        config: maskRoomAdaptersConfig(getRoomAdaptersConfig()),
        geminiCliAvailable: hasGeminiCli,
      });
    } catch (e) { send500(res, e, 'room-adapters get'); }
  });

  app.put('/api/room-adapters', requireOwnerToken, (req, res) => {
   try {
    const r = cleanRoomAdaptersConfig(req.body || {}, getRoomAdaptersConfig());
    if (!r.ok) return res.status(422).json({ error: r.error });

    if (!hasFeature('adapters-unlimited')) {
      const enabledCount = Object.values(r.config || {}).filter(c => c && c.apiKey && c.apiKey.trim()).length;
      if (enabledCount > 3) {
        return res.status(402).json({
          error: `Free 层最多 3 个 adapter（当前 ${enabledCount}）`,
          tier: getCurrentTier(),
          feature: 'adapters-unlimited',
          upgradeUrl: 'https://panel.app/pricing',
        });
      }
    }

    const permission = permissionGovernance?.evaluatePermission?.({
      actorType: 'owner',
      actorId: 'local-owner',
      approvalId: permissionApprovalIdFromRequest(req),
      action: 'provider.model_config.write',
      cwd: process.cwd(),
      risk: 'high',
      target: {
        section: 'room-adapters',
        providerIds: Object.keys(r.config || {}),
        enabledProviders: Object.entries(r.config || {}).filter(([, c]) => c?.apiKey?.trim()).map(([id]) => id),
        hasApiKeys: Object.values(r.config || {}).some(c => typeof c?.apiKey === 'string' && c.apiKey.trim()),
        hasCustomBaseUrls: Object.values(r.config || {}).some(c => typeof c?.baseUrl === 'string' && c.baseUrl.trim()),
      },
    });
    if (permission && permission.decision !== 'allow') {
      return res.status(permissionHttpStatus(permission)).json(permissionHttpBody(permission));
    }

    const save = saveRoomAdaptersConfig(r.config);
    if (!save.ok) return send500(res, new Error(save.error));
    setRoomAdaptersConfig(r.config);
    rebuildRoomAdapters();
    res.json({
      ok: true,
      config: maskRoomAdaptersConfig(getRoomAdaptersConfig()),
      geminiCliAvailable: hasGeminiCli,
      activeProviders: [...roomAdapterPool.keys()],
    });
   } catch (e) { send500(res, e, 'room-adapters put'); }
  });

  app.get('/api/room-adapters/providers', requireOwnerToken, (req, res) => {
    try {
      const providers = [];
      for (const [id, adapter] of roomAdapterPool.entries()) {
        providers.push({ id, displayName: adapter.displayName || id });
      }
      res.json({ ok: true, providers });
    } catch (e) { send500(res, e, 'room-adapters providers'); }
  });
}
