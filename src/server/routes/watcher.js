import { requireOwnerToken } from '../auth/owner-token.js';

const ALLOWED_PROVIDERS = new Set(['minimax', 'gemini', 'openai', 'ollama', 'custom']);

export function registerWatcherRoutes(app, deps) {
  const {
    getWatcherConfig,
    setWatcherConfig,
    getWatcherAdapter,
    getWatcherAdapterPool,
    saveWatcherConfig,
    maskedConfig,
    rebuildAdapter,
    rebuildDispatcher,
    send500,
  } = deps;

  app.get('/api/watcher/config', requireOwnerToken, (req, res) => {
    res.json({ ok: true, config: maskedConfig(getWatcherConfig()) });
  });

  app.get('/api/watcher/providers', requireOwnerToken, (req, res) => {
    const config = getWatcherConfig();
    const providers = [];
    const labels = {
      claude: '🟣 Claude（spawn CLI，零增量）',
      codex: '🟢 GPT (Codex)（spawn CLI，零增量）',
      ollama: '🔵 Ollama 本地（零成本，私有）',
      minimax: '🟡 MiniMax API（按 token 计费）',
    };
    for (const id of getWatcherAdapterPool().keys()) {
      providers.push({ id, displayName: labels[id] || id });
    }
    res.json({ ok: true, providers, defaultId: config.provider || 'ollama' });
  });

  app.put('/api/watcher/config', requireOwnerToken, (req, res) => {
    const current = getWatcherConfig();
    const incoming = req.body || {};
    if (typeof incoming.apiKey === 'string' && incoming.apiKey.includes('...')) {
      delete incoming.apiKey;
    }

    const clean = {};
    if (typeof incoming.enabled === 'boolean') clean.enabled = incoming.enabled;
    if (typeof incoming.autoMode === 'boolean') clean.autoMode = incoming.autoMode;
    if (typeof incoming.perSessionDefault === 'boolean') clean.perSessionDefault = incoming.perSessionDefault;
    if (typeof incoming.provider === 'string' && ALLOWED_PROVIDERS.has(incoming.provider)) clean.provider = incoming.provider;
    if (typeof incoming.apiKey === 'string') {
      if (incoming.apiKey.length > 2048) return res.status(400).json({ error: 'apiKey 过长（>2048）' });
      clean.apiKey = incoming.apiKey;
    }
    if (typeof incoming.model === 'string') {
      if (incoming.model.length > 200) return res.status(400).json({ error: 'model 过长' });
      clean.model = incoming.model;
    }
    if (typeof incoming.baseUrl === 'string') {
      if (incoming.baseUrl.length > 500) return res.status(400).json({ error: 'baseUrl 过长' });
      if (incoming.baseUrl && !/^https?:\/\//i.test(incoming.baseUrl)) {
        return res.status(400).json({ error: 'baseUrl 必须 http(s)://' });
      }
      clean.baseUrl = incoming.baseUrl;
    }

    if (incoming.rateLimit && typeof incoming.rateLimit === 'object') {
      clean.rateLimit = { ...current.rateLimit };
      if (Number.isFinite(incoming.rateLimit.perSessionPerHour)) clean.rateLimit.perSessionPerHour = Math.max(0, Math.min(1000, incoming.rateLimit.perSessionPerHour | 0));
      if (Number.isFinite(incoming.rateLimit.globalPerHour)) clean.rateLimit.globalPerHour = Math.max(0, Math.min(10000, incoming.rateLimit.globalPerHour | 0));
    }
    if (incoming.triggers && typeof incoming.triggers === 'object') {
      clean.triggers = { ...current.triggers };
      if (Number.isFinite(incoming.triggers.minIntervalSec)) clean.triggers.minIntervalSec = Math.max(0, Math.min(3600, incoming.triggers.minIntervalSec | 0));
      if (Number.isFinite(incoming.triggers.requireIdleSec)) clean.triggers.requireIdleSec = Math.max(0, Math.min(3600, incoming.triggers.requireIdleSec | 0));
      if (typeof incoming.triggers.onlyOnResultSuccess === 'boolean') clean.triggers.onlyOnResultSuccess = incoming.triggers.onlyOnResultSuccess;
    }
    if (incoming.safety && typeof incoming.safety === 'object') {
      clean.safety = { ...current.safety };
      if (typeof incoming.safety.dangerScanNextAction === 'boolean') clean.safety.dangerScanNextAction = incoming.safety.dangerScanNextAction;
      if (typeof incoming.safety.blockOnDrift === 'boolean') clean.safety.blockOnDrift = incoming.safety.blockOnDrift;
      if (Number.isFinite(incoming.safety.maxAutoPromptsPerSession)) clean.safety.maxAutoPromptsPerSession = Math.max(0, Math.min(1000, incoming.safety.maxAutoPromptsPerSession | 0));
    }

    const nextConfig = { ...current, ...clean };
    const r = saveWatcherConfig(nextConfig);
    if (!r.ok) return send500(res, new Error(r.error));
    setWatcherConfig(nextConfig);
    rebuildAdapter();
    rebuildDispatcher();
    res.json({ ok: true, config: maskedConfig(getWatcherConfig()), adapterActive: !!getWatcherAdapter() });
  });

  app.post('/api/watcher/test', requireOwnerToken, async (req, res) => {
    const adapter = getWatcherAdapter();
    if (!adapter) return res.json({ ok: false, error: '监视者未启用或未配置 API key' });
    try {
      const verdict = await adapter.judge({
        id: 'test',
        name: '连通性测试',
        cwd: '/tmp',
        mainGoal: '测试 watcher 是否可达',
        messages: [
          { role: 'user', content: '请帮我写一个 hello world Python 脚本', ts: new Date().toISOString() },
          { role: 'assistant', content: '好的：\n```python\nprint("Hello, World!")\n```\n已完成。', ts: new Date().toISOString() },
        ],
        runState: 'completed',
      });
      res.json({ ok: true, verdict });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });
}
