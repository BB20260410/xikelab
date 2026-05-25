import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodebaseIndexStore } from '../../src/agents/CodebaseIndexStore.js';

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
});
