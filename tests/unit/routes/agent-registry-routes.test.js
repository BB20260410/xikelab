import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAgentClassification, buildAgentRegistrySnapshot, readGitChangedFiles, registerAgentRegistryRoutes } from '../../../src/server/routes/agentRegistry.js';
import { buildAgentSkillRegistry } from '../../../src/agents/AgentSkillRegistry.js';
import { AgentPolicyStore } from '../../../src/agents/AgentPolicyStore.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (path, ...handlers) => {
      routes.push({ method, path, handlers });
    };
  }
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

const fakeSkillStore = {
  list() {
    return [
      { name: 'qa', displayName: 'QA', enabled: true },
      { name: 'browse', displayName: 'Browse', enabled: true },
      { name: 'codex', displayName: 'Codex', enabled: false },
    ];
  },
  get(name) {
    return this.list().find((skill) => skill.name === name) || null;
  },
};

const noisySkillStore = {
  list() {
    return [
      { name: 'qa', displayName: 'QA', enabled: true },
      { name: 'browse', displayName: 'Browse', enabled: true },
      { name: 'room1', displayName: 'Room 1', enabled: true },
      { name: 'room2', displayName: 'Room 2', enabled: true },
      { name: 'room3', displayName: 'Room 3', enabled: true },
      { name: 'room4', displayName: 'Room 4', enabled: true },
      { name: 'room5', displayName: 'Room 5', enabled: true },
      { name: 'room6', displayName: 'Room 6', enabled: true },
      { name: 'room7', displayName: 'Room 7', enabled: true },
    ];
  },
  get(name) {
    const skill = this.list().find((item) => item.name === name);
    if (!skill) return null;
    return { ...skill, body: 'x'.repeat(10), extra: {} };
  },
};

function makePolicyStore() {
  const dir = mkdtempSync(join(tmpdir(), 'xike-agent-registry-route-'));
  const store = new AgentPolicyStore({
    filePath: join(dir, 'policies.json'),
    audit: { recordSafe() {} },
    logger: { warn() {} },
  });
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function gitOctalPath(octalParts, suffix = '') {
  return octalParts.map((part) => `\\${part}`).join('') + suffix;
}

describe('agent registry routes', () => {
  it('parses git changed files and returns code context signals', () => {
    const handoffPath = gitOctalPath(['344', '270', '212', '344', '270', '213', '346', '226', '207', '344', '272', '244', '346', '216', '245'], '.md');
    const result = readGitChangedFiles('/tmp/project', {
      gitStatusProvider() {
        return [
          ' M src/agents/AgentSkillRegistry.js',
          '?? tests/unit/code-context-signals.test.js',
          'R  old-name.js -> public/app.js',
          `?? "${handoffPath}"`,
        ].join('\n');
      },
    });

    expect(result.ok).toBe(true);
    expect(result.files).toEqual([
      { status: 'M', path: 'src/agents/AgentSkillRegistry.js' },
      { status: '??', path: 'tests/unit/code-context-signals.test.js' },
      { status: 'R', path: 'public/app.js' },
      { status: '??', path: '上下文交接.md' },
    ]);
    expect(result.codeContextSignals.tags.map((tag) => tag.tag)).toEqual(expect.arrayContaining([
      'architecture',
      'verification',
      'design',
    ]));
  });

  it('builds symbol evidence for changed code files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xike-agent-registry-evidence-'));
    try {
      mkdirSync(join(dir, 'src/server/routes'), { recursive: true });
      writeFileSync(join(dir, 'src/server/routes/agentRegistry.js'), [
        "import { buildCodeContextEvidence } from '../../agents/CodeContextEvidence.js';",
        'export function registerAgentRegistryRoutes(app) {',
        "  app.get('/api/agent-registry/changed-files', (req, res) => res.json({ ok: true }));",
        '}',
      ].join('\n'));

      const result = readGitChangedFiles(dir, {
        gitStatusProvider() {
          return ' M src/server/routes/agentRegistry.js\n';
        },
      });

      expect(result.ok).toBe(true);
      expect(result.codeContextEvidenceSummary.fileCount).toBe(1);
      expect(result.codeContextEvidenceSummary.symbolCount).toBe(1);
      expect(result.codeContextEvidenceSummary.anchorCount).toBeGreaterThanOrEqual(1);
      expect(result.codeContextEvidence[0].symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'registerAgentRegistryRoutes' }),
      ]));
      expect(result.codeContextEvidence[0].anchors).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'route', name: 'GET /api/agent-registry/changed-files' }),
      ]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summarizes profiles, dispatch rules, and bound-skill coverage', () => {
    const snapshot = buildAgentRegistrySnapshot({ skillStore: fakeSkillStore });

    expect(snapshot.ok).toBe(true);
    expect(snapshot.counts.profiles).toBeGreaterThanOrEqual(8);
    expect(snapshot.counts.rules).toBeGreaterThanOrEqual(8);
    expect(snapshot.profiles.find((profile) => profile.id === 'xike-verifier').skillCoverage).toEqual([
      { name: 'qa', installed: true, enabled: true, displayName: 'QA' },
      { name: 'qa-only', installed: false, enabled: false, displayName: 'qa-only' },
      { name: 'browse', installed: true, enabled: true, displayName: 'Browse' },
    ]);
    expect(snapshot.profiles.find((profile) => profile.id === 'xike-verifier').governance).toMatchObject({
      commandGuard: 'strict',
      budgetScope: 'agent_profile',
    });
    expect(snapshot.missingSkillNames).toContain('qa-only');
  });

  it('classifies task text and reports installed versus missing skills', () => {
    const result = buildAgentClassification({
      text: '请用浏览器测试预算治理和审批队列',
      codeContext: {
        affectedFiles: [
          'src/server/routes/approvals.js',
          'tests/e2e/panel-ui-walkthrough.mjs',
        ],
        codebaseQuestionAnswer: {
          question: '预算审批入口在哪里？',
          answer: 'Most relevant local evidence points to src/server/routes/approvals.js:1.',
          confidence: 'medium',
          citations: [
            { id: 'C1', path: 'src/server/routes/approvals.js', line: 1, label: 'src/server/routes/approvals.js:1' },
          ],
          coverage: { uniqueFileCount: 1, citedResultCount: 1 },
        },
      },
      member: { adapterId: 'codex', role: 'qa', displayName: 'Codex QA' },
      skillStore: fakeSkillStore,
    });

    expect(result.profile).toMatchObject({ id: 'xike-verifier' });
    expect(result.matches.map((match) => match.tag)).toEqual(expect.arrayContaining(['verification', 'governance']));
    expect(result.installedSkillNames).toEqual(['qa', 'browse']);
    expect(result.installedSkillBindings.find((binding) => binding.name === 'qa').sources).toEqual(expect.arrayContaining(['profile', 'dispatch:verification', 'dispatch:governance']));
    expect(result.missingSkillNames).toContain('qa-only');
    expect(result.governance).toMatchObject({ commandGuard: 'strict' });
    expect(result.codeContextSignals.tags.map((tag) => tag.tag)).toEqual(expect.arrayContaining(['verification', 'governance']));
    expect(result.matches.find((match) => match.tag === 'verification').codeScore).toBeGreaterThan(0);
    expect(result.promptPreview).toContain('Xike Agent Runtime Context');
    expect(result.promptPreview).toContain('Code context signals:');
    expect(result.promptPreview).toContain('Code question answer:');
    expect(result.codebaseQuestionAnswer.citations[0].id).toBe('C1');
    expect(result.promptPreview).toContain('qa [profile+');
  });

  it('reports skill diagnostics in classify output', () => {
    const result = buildAgentClassification({
      text: '请用浏览器测试预算治理和审批队列',
      member: { adapterId: 'codex', role: 'qa', displayName: 'Codex QA' },
      room: { skills: ['room1', 'room2', 'room3', 'room4', 'room5', 'room6', 'room7'] },
      skillStore: noisySkillStore,
    });

    expect(result.skillDiagnostics.map((item) => item.code)).toContain('too_many_skills');
    expect(result.promptPreview).toContain('Skill diagnostics: warn:too_many_skills');
  });

  it('registers owner-gated registry and classify endpoints', async () => {
    const { app, routes } = makeApp();
    const registry = buildAgentSkillRegistry({
      profiles: [{
        id: 'custom-auditor',
        roles: ['auditor'],
        title: 'Custom Auditor',
        mission: 'Audit local agent decisions.',
        boundaries: ['stay read-only'],
        skillBindings: ['qa'],
      }],
      roleFallback: { auditor: 'custom-auditor' },
    });
    const { store: policyStore, cleanup } = makePolicyStore();
    registerAgentRegistryRoutes(app, { registry, skillStore: fakeSkillStore, policyStore });

    try {
      const getRoute = routes.find((route) => route.method === 'get' && route.path === '/api/agent-registry');
      const getRes = makeRes();
      await getRoute.handlers[1]({ query: {} }, getRes);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.payload.profiles.some((profile) => profile.id === 'custom-auditor')).toBe(true);

      const putRoute = routes.find((route) => route.method === 'put' && route.path === '/api/agent-registry/profiles/:id/governance');
      const putRes = makeRes();
      await putRoute.handlers[1]({
        params: { id: 'custom-auditor' },
        body: {
          governance: {
            budgetTier: 'low',
            commandGuard: 'strict',
            approvalPolicy: 'read_only',
            auditLevel: 'full',
          },
        },
      }, putRes);
      expect(putRes.statusCode).toBe(200);
      expect(putRes.payload.profile).toMatchObject({
        id: 'custom-auditor',
        governanceOverridden: true,
        governance: { budgetTier: 'low', approvalPolicy: 'read_only' },
      });

      const postRoute = routes.find((route) => route.method === 'post' && route.path === '/api/agent-registry/classify');
      const postRes = makeRes();
      await postRoute.handlers[1]({
        body: {
          text: '审计审批策略',
          member: { adapterId: 'audit', role: 'auditor', displayName: 'Auditor' },
        },
      }, postRes);
      expect(postRes.statusCode).toBe(200);
      expect(postRes.payload.profile).toMatchObject({
        id: 'custom-auditor',
        governanceOverridden: true,
      });
      expect(postRes.payload.governance).toMatchObject({ budgetTier: 'low', approvalPolicy: 'read_only' });
      expect(postRes.payload.promptPreview).toContain('agent_profile:custom-auditor/low');
      expect(postRes.payload.installedSkillNames).toContain('qa');

      const deleteRoute = routes.find((route) => route.method === 'delete' && route.path === '/api/agent-registry/profiles/:id/governance');
      const deleteRes = makeRes();
      await deleteRoute.handlers[1]({ params: { id: 'custom-auditor' } }, deleteRes);
      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.payload.deleted).toBe(true);
      expect(deleteRes.payload.profile.governanceOverridden).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('registers an owner-gated changed-files endpoint with safe cwd resolution', async () => {
    const { app, routes } = makeApp();
    registerAgentRegistryRoutes(app, {
      skillStore: fakeSkillStore,
      safeResolveFsPath: (path) => (path === '/blocked' ? null : '/safe/project'),
      gitStatusProvider(cwd) {
        expect(cwd).toBe('/safe/project');
        return ' M src/server/routes/agentRegistry.js\n?? tests/unit/routes/agent-registry-routes.test.js\n';
      },
    });
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/agent-registry/changed-files');

    const res = makeRes();
    await route.handlers[1]({ query: { cwd: '/Users/hxx/project' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.payload.files.map((file) => file.path)).toEqual([
      'src/server/routes/agentRegistry.js',
      'tests/unit/routes/agent-registry-routes.test.js',
    ]);
    expect(res.payload.codeContextSignals.tags.map((tag) => tag.tag)).toContain('verification');

    const denied = makeRes();
    await route.handlers[1]({ query: { cwd: '/blocked' } }, denied);
    expect(denied.statusCode).toBe(403);
  });

  it('uses process cwd for changed-files when no user cwd is provided', async () => {
    const { app, routes } = makeApp();
    registerAgentRegistryRoutes(app, {
      skillStore: fakeSkillStore,
      safeResolveFsPath() {
        throw new Error('should not sandbox implicit process cwd');
      },
      gitStatusProvider(cwd) {
        expect(cwd).toBe(process.cwd());
        return ' M public/app.js\n';
      },
    });
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/agent-registry/changed-files');
    const res = makeRes();

    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.files).toEqual([{ status: 'M', path: 'public/app.js' }]);
  });

  it('registers an owner-gated codebase-map endpoint with safe cwd resolution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xike-agent-registry-map-'));
    try {
      mkdirSync(join(dir, 'src/agents'), { recursive: true });
      writeFileSync(join(dir, 'src/agents/Planner.js'), [
        'export function buildPlannerContext(input) {',
        '  return input;',
        '}',
      ].join('\n'));
      const { app, routes } = makeApp();
      registerAgentRegistryRoutes(app, {
        skillStore: fakeSkillStore,
        safeResolveFsPath: (path) => (path === '/blocked' ? null : dir),
      });
      const route = routes.find((item) => item.method === 'get' && item.path === '/api/agent-registry/codebase-map');

      const res = makeRes();
      await route.handlers[1]({ query: { cwd: '/Users/hxx/project', q: 'planner context', limit: '8' } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.focusFiles.map((file) => file.path)).toContain('src/agents/Planner.js');
      expect(res.payload.evidenceSummary.symbolCount).toBeGreaterThanOrEqual(1);

      const denied = makeRes();
      await route.handlers[1]({ query: { cwd: '/blocked' } }, denied);
      expect(denied.statusCode).toBe(403);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
