import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodebaseMap } from '../../src/agents/CodebaseMap.js';

function tempProject() {
  const dir = join(tmpdir(), `xike-codebase-map-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('CodebaseMap', () => {
  it('builds a focused source map with evidence and import graph', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/agents'), { recursive: true });
      mkdirSync(join(dir, 'src/server/routes'), { recursive: true });
      mkdirSync(join(dir, 'node_modules/noise'), { recursive: true });
      writeFileSync(join(dir, 'src/agents/Planner.js'), [
        "import { helper } from './PlannerHelper.js';",
        'export function buildPlannerContext(input) {',
        '  return helper(input);',
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'src/agents/PlannerHelper.js'), [
        'export const helper = (input) => input;',
      ].join('\n'));
      writeFileSync(join(dir, 'src/server/routes/planner.js'), [
        'export function registerPlannerRoutes(app) {',
        "  app.post('/api/planner/context', (req, res) => res.json({ ok: true }));",
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'node_modules/noise/index.js'), 'export const ignored = true;\n');

      const map = buildCodebaseMap(dir, { query: 'planner context', limit: 8 });

      expect(map.ok).toBe(true);
      expect(map.scannedFileCount).toBe(3);
      expect(map.focusFiles.map((file) => file.path)).toEqual(expect.arrayContaining([
        'src/agents/Planner.js',
        'src/server/routes/planner.js',
      ]));
      expect(map.focusFiles.map((file) => file.path)).not.toContain('node_modules/noise/index.js');
      expect(map.evidenceSummary.symbolCount).toBeGreaterThanOrEqual(2);
      expect(map.evidenceSummary.anchorCount).toBeGreaterThanOrEqual(1);
      expect(map.graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          from: 'src/agents/Planner.js',
          to: 'src/agents/PlannerHelper.js',
        }),
      ]));
      expect(map.symbolGraphSummary.definitionCount).toBeGreaterThanOrEqual(2);
      expect(map.symbolGraphSummary.referenceCount).toBeGreaterThanOrEqual(1);
      expect(map.codeContextSignals.tags.map((tag) => tag.tag)).toEqual(expect.arrayContaining([
        'architecture',
        'implementation',
      ]));
    } finally {
      cleanup();
    }
  });
});
