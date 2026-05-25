import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodeContextEvidence } from '../../src/agents/CodeContextEvidence.js';
import { buildSymbolGraph, summarizeSymbolGraph } from '../../src/agents/SymbolGraph.js';

function tempProject() {
  const dir = join(tmpdir(), `xike-symbol-graph-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('SymbolGraph', () => {
  it('links definitions to references, calls, and API route usages', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/server/routes'), { recursive: true });
      mkdirSync(join(dir, 'public'), { recursive: true });
      writeFileSync(join(dir, 'src/server/routes/planner.js'), [
        'export function buildPlannerContext(input) {',
        '  return input;',
        '}',
        'export function registerPlannerRoutes(app) {',
        "  app.post('/api/planner/context', (req, res) => res.json(buildPlannerContext(req.body)));",
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'public/app.js'), [
        "import { buildPlannerContext } from '../src/server/routes/planner.js';",
        'function renderPlanner() {',
        '  return buildPlannerContext({ ok: true });',
        '}',
        '// buildPlannerContext inside a comment should not become an AST reference.',
        "const label = 'buildPlannerContext inside a string';",
        "fetch('/api/planner/context');",
      ].join('\n'));

      const evidence = buildCodeContextEvidence({
        cwd: dir,
        files: ['src/server/routes/planner.js', 'public/app.js'],
      });
      const graph = buildSymbolGraph({ cwd: dir, evidence });
      const summary = summarizeSymbolGraph(graph);
      const planner = graph.definitions.find((item) => item.name === 'buildPlannerContext');
      const route = graph.routes.find((item) => item.route === '/api/planner/context');

      expect(evidence.every((file) => file.parser === 'acorn')).toBe(true);
      expect(planner.referenceCount).toBeGreaterThanOrEqual(2);
      expect(planner.callCount).toBeGreaterThanOrEqual(2);
      expect(graph.references).toEqual(expect.arrayContaining([
        expect.objectContaining({
          symbol: 'buildPlannerContext',
          fromPath: 'public/app.js',
          kind: 'call',
        }),
      ]));
      expect(graph.references.find((item) => item.text.includes('should not become'))).toBeUndefined();
      expect(graph.references.find((item) => item.text.includes('inside a string'))).toBeUndefined();
      expect(route.usageCount).toBeGreaterThanOrEqual(1);
      expect(graph.routeUsages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          route: '/api/planner/context',
          fromPath: 'public/app.js',
        }),
      ]));
      expect(summary.callCount).toBeGreaterThanOrEqual(2);
      expect(summary.routeUsageCount).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });
});
