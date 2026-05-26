import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CodebaseIndexStore } from '../../src/agents/CodebaseIndexStore.js';
import { CodebasePersistentIndex } from '../../src/agents/CodebasePersistentIndex.js';

function tempProject() {
  const dir = join(tmpdir(), `xike-codebase-index-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('CodebaseIndexStore', () => {
  it('rebuilds status and returns explainable path/line/reason results', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/room'), { recursive: true });
      mkdirSync(join(dir, 'src/budget'), { recursive: true });
      mkdirSync(join(dir, 'tests/unit'), { recursive: true });
      mkdirSync(join(dir, 'node_modules/noise'), { recursive: true });
      writeFileSync(join(dir, 'src/room/RoomAdapter.js'), [
        "import { budgetPolicyStore } from '../budget/BudgetPolicyStore.js';",
        'export class RoomAdapter {',
        '  async chat(messages, opts = {}) {',
        '    budgetPolicyStore.preflight({ adapterId: opts.adapterId });',
        "    return { reply: 'ok' };",
        '  }',
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'src/budget/BudgetPolicyStore.js'), [
        'export class BudgetPolicyStore {',
        '  preflight(context) { return { ok: true, context }; }',
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'tests/unit/room-adapter-budget.test.js'), [
        "import { describe, it } from 'vitest';",
        "describe('RoomAdapter budget guard', () => {",
        "  it('blocks adapter calls by budget', () => {});",
        '});',
      ].join('\n'));
      writeFileSync(join(dir, 'node_modules/noise/index.js'), 'export const ignored = true;\n');

      const store = new CodebaseIndexStore({ logger: null });
      const rebuilt = store.rebuild(dir, { query: 'RoomAdapter budget preflight', focusLimit: 8 });
      expect(rebuilt.status.scannedFileCount).toBe(3);
      expect(rebuilt.status.focusFileCount).toBeGreaterThanOrEqual(2);
      expect(store.status(dir)).toMatchObject({
        cwd: dir,
        scannedFileCount: 3,
      });

      const result = store.query(dir, { query: 'RoomAdapter budget preflight', maxResults: 10, focusLimit: 8 });
      expect(result.ok).toBe(true);
      expect(result.results[0]).toEqual(expect.objectContaining({
        path: expect.any(String),
        line: expect.any(Number),
        score: expect.any(Number),
        reason: expect.any(Array),
        parser: expect.any(String),
      }));
      expect(result.results.map((item) => item.path)).toContain('src/room/RoomAdapter.js');
      expect(result.results.some((item) => item.reason.some((reason) => /symbol|text|path|import-graph/.test(reason)))).toBe(true);
      expect(result.results.map((item) => item.path)).not.toContain('node_modules/noise/index.js');
    } finally {
      cleanup();
    }
  });

  it('expands Chinese governance and UI queries toward source evidence', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'public'), { recursive: true });
      mkdirSync(join(dir, 'src/metrics'), { recursive: true });
      mkdirSync(join(dir, 'tests/unit'), { recursive: true });
      writeFileSync(join(dir, 'public/app.js'), [
        Array.from({ length: 26000 }, (_, idx) => `// filler ${idx}`).join('\n'),
        'function openAgentRegistryModal() {',
        "  document.querySelector('#agentRegistryModal').style.display = 'flex';",
        '}',
        "$('#btnAgentRegistry')?.addEventListener('click', openAgentRegistryModal);",
      ].join('\n'));
      writeFileSync(join(dir, 'src/metrics/MetricsStore.js'), [
        "import { activityLog } from '../audit/ActivityLog.js';",
        'export class MetricsStore {',
        '  record(turnSummary) {',
        '    activityLog.recordSafe({ action: "agent.skill_diagnostics", details: { diagnostics: turnSummary.agentSkillDiagnostics } });',
        '  }',
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'tests/unit/metrics-store-agent-diagnostics.test.js'), [
        "import { describe, it } from 'vitest';",
        "describe('Agent Skill diagnostics Activity', () => {",
        "  it('records diagnostic Activity', () => {});",
        '});',
      ].join('\n'));

      const store = new CodebaseIndexStore({ logger: null });
      const ui = store.query(dir, { query: 'Agent 图谱入口 DOM handler', maxResults: 5, focusLimit: 8 });
      expect(ui.results[0]).toEqual(expect.objectContaining({
        path: 'public/app.js',
      }));
      expect(ui.results[0].line).toBeGreaterThan(22000);
      expect(ui.results[0].reason).toContain('intent:agent-ui-handler');

      const diagnostics = store.query(dir, { query: 'Agent Skill 诊断哪里写入 Activity？', maxResults: 5, focusLimit: 8 });
      expect(diagnostics.results[0].path).toBe('src/metrics/MetricsStore.js');
      expect(diagnostics.results[0].reason).toContain('intent:diagnostics-activity-source');
      const paths = diagnostics.results.map((item) => item.path);
      const testIdx = paths.indexOf('tests/unit/metrics-store-agent-diagnostics.test.js');
      if (testIdx >= 0) expect(paths.indexOf('src/metrics/MetricsStore.js')).toBeLessThan(testIdx);
    } finally {
      cleanup();
    }
  });

  it('reuses unchanged file evidence across rebuilds and invalidates changed files', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/agents'), { recursive: true });
      writeFileSync(join(dir, 'src/agents/Alpha.js'), [
        'export function alphaBudget() {',
        "  return 'budget preflight';",
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'src/agents/Beta.js'), [
        'export function betaBudget() {',
        "  return 'budget incident';",
        '}',
      ].join('\n'));

      const store = new CodebaseIndexStore({ logger: null });
      const first = store.rebuild(dir, { query: 'budget', focusLimit: 8 });
      expect(first.status.cacheStats).toMatchObject({
        enabled: true,
        hits: 0,
      });
      expect(first.status.cacheStats.misses).toBeGreaterThanOrEqual(2);
      expect(first.status.cacheStats.cacheSize).toBeGreaterThanOrEqual(2);

      const second = store.rebuild(dir, { query: 'budget', focusLimit: 8 });
      expect(second.status.cacheStats.hits).toBeGreaterThanOrEqual(2);
      expect(second.status.cacheStats.misses).toBe(0);
      expect(second.status.cacheStats.stale).toBe(0);

      writeFileSync(join(dir, 'src/agents/Alpha.js'), [
        'export function alphaBudgetChanged() {',
        "  return 'budget preflight changed';",
        '}',
        'export const alphaCacheMarker = true;',
      ].join('\n'));

      const third = store.rebuild(dir, { query: 'budget', focusLimit: 8 });
      expect(third.status.cacheStats.hits).toBeGreaterThanOrEqual(1);
      expect(third.status.cacheStats.stale).toBeGreaterThanOrEqual(1);
      expect(third.map.evidence.find((file) => file.path === 'src/agents/Alpha.js').symbols.map((symbol) => symbol.name))
        .toContain('alphaBudgetChanged');
    } finally {
      cleanup();
    }
  });

  it('indexes focused evidence into SQLite FTS5 and merges BM25-ranked results', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/search'), { recursive: true });
      writeFileSync(join(dir, 'src/search/Needle.js'), [
        'export function rareNeedleTerm() {',
        "  return 'needleUnique budget preflight';",
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'src/search/Other.js'), [
        'export function otherFeature() {',
        "  return 'plain text';",
        '}',
      ].join('\n'));

      const store = new CodebaseIndexStore({ logger: null });
      const rebuilt = store.rebuild(dir, { query: 'rareNeedleTerm', focusLimit: 8 });
      expect(rebuilt.status.ftsSummary).toEqual(expect.objectContaining({
        enabled: true,
        engine: 'sqlite-fts5',
        ranking: 'bm25',
        fileCount: 2,
      }));
      expect(rebuilt.status.ftsSummary.rowCount).toBeGreaterThanOrEqual(2);

      const result = store.query(dir, { query: 'rareNeedleTerm', maxResults: 5, focusLimit: 8 });
      expect(result.ftsSummary).toMatchObject({
        engine: 'sqlite-fts5',
        ranking: 'bm25',
      });
      expect(result.results[0]).toEqual(expect.objectContaining({
        path: 'src/search/Needle.js',
        reason: expect.arrayContaining(['fts5', 'bm25', 'sqlite-fts']),
      }));
      expect(result.results[0].bm25Rank).toEqual(expect.any(Number));
      expect(result.results.map((item) => item.path)).not.toContain('src/search/Other.js');

      const coldStore = new CodebaseIndexStore({ logger: null });
      const coldResult = coldStore.query(dir, { query: 'rareNeedleTerm', maxResults: 5, focusLimit: 8 });
      expect(coldResult.results[0]).toEqual(expect.objectContaining({
        path: 'src/search/Needle.js',
        reason: expect.arrayContaining(['fts5', 'bm25', 'sqlite-fts']),
      }));
    } finally {
      cleanup();
    }
  });

  it('adds local hash-vector similarity as an explainable query signal', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/archive'), { recursive: true });
      writeFileSync(join(dir, 'src/archive/ReplayArchive.js'), [
        'export function archiveReplayOutcome() {',
        "  return 'execution archive outcome journal replay result';",
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'src/archive/Noise.js'), [
        'export function unrelatedNoise() {',
        "  return 'plain unrelated screen settings';",
        '}',
      ].join('\n'));

      const store = new CodebaseIndexStore({ logger: null });
      const rebuilt = store.rebuild(dir, { query: 'execution archive outcome journal', focusLimit: 8 });
      expect(rebuilt.status.vectorSummary).toEqual(expect.objectContaining({
        enabled: true,
        engine: 'local-hash-vector',
        ranking: 'cosine',
        rowCount: 2,
      }));

      const result = store.query(dir, { query: 'execution archive outcome journal', maxResults: 10, focusLimit: 8 });
      expect(result.vectorSummary).toMatchObject({
        engine: 'local-hash-vector',
        ranking: 'cosine',
      });
      const vectorHit = result.results.find((item) => item.path === 'src/archive/ReplayArchive.js'
        && item.reason.includes('vector-index'));
      expect(vectorHit).toEqual(expect.objectContaining({
        semanticScore: expect.any(Number),
        reason: expect.arrayContaining(['local-hash-vector', 'cosine', 'semantic-vector', 'vector-index']),
      }));
      expect(vectorHit.semanticScore).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('persists index snapshots and returns citation chains from cold snapshot queries', () => {
    const { dir, cleanup } = tempProject();
    const db = new Database(join(dir, 'codebase-index.db'));
    try {
      mkdirSync(join(dir, 'src/search'), { recursive: true });
      writeFileSync(join(dir, 'src/search/Needle.js'), [
        'export function persistentNeedleTerm() {',
        "  return 'persistent budget preflight';",
        '}',
      ].join('\n'));

      const persistentIndex = new CodebasePersistentIndex({ db, logger: null });
      const store = new CodebaseIndexStore({ logger: null, persistentIndex });
      const rebuilt = store.rebuild(dir, { query: 'persistentNeedleTerm', focusLimit: 8 });
      expect(rebuilt.status.persistentSummary).toEqual(expect.objectContaining({
        enabled: true,
        engine: 'sqlite',
        loadedFromSnapshot: false,
      }));
      expect(rebuilt.status.persistentSummary.snapshotId).toEqual(expect.any(String));

      const hotResult = store.query(dir, { query: 'persistentNeedleTerm', maxResults: 5, focusLimit: 8 });
      expect(hotResult.citationSummary).toEqual(expect.objectContaining({
        enabled: true,
        chainCount: hotResult.results.length,
      }));
      expect(hotResult.results[0].citation).toEqual(expect.objectContaining({
        path: 'src/search/Needle.js',
        evidence: expect.arrayContaining([
          expect.objectContaining({ kind: 'symbol', name: 'persistentNeedleTerm' }),
        ]),
      }));

      rmSync(join(dir, 'src'), { recursive: true, force: true });
      const coldStore = new CodebaseIndexStore({ logger: null, persistentIndex });
      const coldStatus = coldStore.status(dir);
      expect(coldStatus.persistentSummary).toEqual(expect.objectContaining({
        loadedFromSnapshot: true,
      }));
      const coldResult = coldStore.query(dir, {
        query: 'persistentNeedleTerm',
        maxResults: 5,
        focusLimit: 8,
        useSnapshot: true,
      });
      expect(coldResult.persistentSummary).toEqual(expect.objectContaining({
        loadedFromSnapshot: true,
      }));
      expect(coldResult.results[0]).toEqual(expect.objectContaining({
        path: 'src/search/Needle.js',
        citation: expect.objectContaining({
          evidence: expect.arrayContaining([
            expect.objectContaining({ kind: 'symbol', name: 'persistentNeedleTerm' }),
          ]),
        }),
      }));
    } finally {
      db.close();
      cleanup();
    }
  });

  it('answers code questions with deterministic citations', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/room'), { recursive: true });
      mkdirSync(join(dir, 'src/budget'), { recursive: true });
      writeFileSync(join(dir, 'src/room/RoomAdapter.js'), [
        "import { budgetPolicyStore } from '../budget/BudgetPolicyStore.js';",
        'export class RoomAdapter {',
        '  async chat(messages, opts = {}) {',
        '    return budgetPolicyStore.preflight({ adapterId: opts.adapterId });',
        '  }',
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'src/budget/BudgetPolicyStore.js'), [
        'export class BudgetPolicyStore {',
        '  preflight(context) { return { ok: true, context }; }',
        '}',
      ].join('\n'));

      const store = new CodebaseIndexStore({ logger: null });
      const result = store.question(dir, {
        question: 'RoomAdapter 在哪里处理预算 preflight？',
        maxResults: 5,
        focusLimit: 8,
      });
      expect(result.ok).toBe(true);
      expect(result.answer).toEqual(expect.objectContaining({
        mode: 'local-codebase-question',
        generatedBy: 'CodebaseIndexStore',
        confidence: expect.stringMatching(/high|medium|low/),
      }));
      expect(result.answer.answer).toContain('src/room/RoomAdapter.js');
      expect(result.answer.citations).toEqual(expect.arrayContaining([expect.objectContaining({
        path: 'src/room/RoomAdapter.js',
        label: expect.stringMatching(/^src\/room\/RoomAdapter\.js:\d+/),
        reasons: expect.arrayContaining(['intent:budget-source']),
      })]));
      expect(result.answer.coverage.uniqueFileCount).toBeGreaterThan(0);
      expect(result.answer.limitations).toContain('No model inference');
    } finally {
      cleanup();
    }
  });

  it('carries TypeScript implementation evidence into question citations', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/app'), { recursive: true });
      writeFileSync(join(dir, 'src/types.ts'), [
        'export interface Renderable {',
        '  render(): string;',
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'src/app/WidgetController.ts'), [
        "import type { Renderable } from '../types';",
        'export class WidgetController implements Renderable {',
        '  render(): string {',
        "    return 'ok';",
        '  }',
        '}',
      ].join('\n'));

      const store = new CodebaseIndexStore({ logger: null });
      const result = store.question(dir, {
        question: 'WidgetController implements Renderable render 方法在哪里？',
        maxResults: 8,
        focusLimit: 8,
      });
      const widgetCitation = result.results
        .map((item) => item.citation)
        .find((citation) => citation?.path === 'src/app/WidgetController.ts');

      expect(result.answer.coverage.graphReferenceCount).toBeGreaterThan(0);
      expect(result.answer.coverage.typeImplementationCount).toBeGreaterThan(0);
      expect(widgetCitation?.graph.references).toEqual(expect.arrayContaining([
        expect.objectContaining({
          symbol: 'render',
          fromPath: 'src/app/WidgetController.ts',
          toPath: 'src/types.ts',
          kind: 'type-implementation',
        }),
      ]));
    } finally {
      cleanup();
    }
  });

  it('answers route questions with route-to-test chains and unresolved evidence limits', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/server/routes'), { recursive: true });
      mkdirSync(join(dir, 'src/services'), { recursive: true });
      mkdirSync(join(dir, 'tests/unit'), { recursive: true });
      writeFileSync(join(dir, 'src/services/plannerService.js'), [
        'export function planService(input) {',
        '  return { ok: true, input };',
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'src/server/routes/planner.js'), [
        "import { planService } from '../../services/plannerService.js';",
        'export function registerPlannerRoutes(app) {',
        "  app.get('/api/planner/items', (req, res) => res.json(planService(missingRuntime(req.query))));",
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'tests/unit/planner-routes.test.js'), [
        "import { describe, it, expect } from 'vitest';",
        "describe('planner route', () => {",
        "  it('covers /api/planner/items', () => {",
        "    expect('/api/planner/items').toContain('/api/planner/items');",
        '  });',
        '});',
      ].join('\n'));

      const store = new CodebaseIndexStore({ logger: null });
      const result = store.question(dir, {
        question: 'missingRuntime app.get planService /api/planner/items',
        maxResults: 8,
        focusLimit: 8,
      });
      const chainedCitation = result.results
        .map((item) => item.citation)
        .find((citation) => (citation?.graph?.routeTestChains || []).length > 0);
      const routeCitation = result.results
        .map((item) => item.citation)
        .find((citation) => citation?.path === 'src/server/routes/planner.js');

      expect(result.answer.coverage.routeToTestChainCount).toBeGreaterThan(0);
      expect(result.answer.coverage.unresolvedReferenceCount).toBeGreaterThan(0);
      expect(result.answer.answerLines.join('\n')).toContain('route-test chains');
      expect(result.answer.limitations.join('\n')).toContain('unresolved');
      expect(chainedCitation?.paths).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'route-to-test',
          route: '/api/planner/items',
        }),
      ]));
      expect(routeCitation?.graph.unresolvedReferences).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'missingRuntime' }),
      ]));
    } finally {
      cleanup();
    }
  });

  it('prunes old persistent snapshots per cwd', () => {
    const { dir, cleanup } = tempProject();
    const db = new Database(join(dir, 'codebase-index.db'));
    try {
      const persistentIndex = new CodebasePersistentIndex({ db, logger: null, maxSnapshotsPerCwd: 2 });
      let lastSummary = null;
      for (let index = 0; index < 5; index += 1) {
        lastSummary = persistentIndex.writeSnapshot({
          cwd: dir,
          query: `needle ${index}`,
          status: { ok: true, cwd: dir, query: `needle ${index}`, indexedAt: index + 1 },
          map: { cwd: dir, query: `needle ${index}`, focusFiles: [], evidence: [] },
        });
      }

      expect(lastSummary).toMatchObject({
        snapshotCountLimit: 2,
      });
      expect(lastSummary.prunedSnapshots).toBeGreaterThan(0);
      const rows = db.prepare('SELECT id FROM codebase_index_snapshots WHERE cwd = ?').all(dir);
      expect(rows).toHaveLength(2);
      expect(persistentIndex.latestSnapshot(dir).query).toBe('needle 4');
      expect(persistentIndex.readSnapshot(dir, 'needle 0')).toBeNull();
    } finally {
      db.close();
      cleanup();
    }
  });

  it('bounds cached query indexes so in-memory FTS handles do not grow without limit', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/search'), { recursive: true });
      writeFileSync(join(dir, 'src/search/Needle.js'), [
        'export function cacheBoundNeedle() {',
        "  return 'cache budget preflight registry route';",
        '}',
      ].join('\n'));

      const store = new CodebaseIndexStore({ logger: null });
      for (let index = 0; index < 16; index += 1) {
        store.rebuild(dir, { query: `cacheBoundNeedle ${index}`, focusLimit: 8 });
      }

      expect(store.cache.size).toBeLessThanOrEqual(12);
      const cachedQueries = Array.from(store.cache.values()).map((entry) => entry.status.query);
      expect(cachedQueries).not.toContain('cacheBoundNeedle 0');
      expect(cachedQueries).toContain('cacheBoundNeedle 15');
    } finally {
      cleanup();
    }
  });
});
