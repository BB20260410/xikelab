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

  it('builds route-to-test citation chains and unresolved reference summaries', () => {
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
        "  it('calls the planner API', async () => {",
        "    expect('/api/planner/items').toContain('/api/planner/items');",
        '  });',
        '});',
      ].join('\n'));

      const evidence = buildCodeContextEvidence({
        cwd: dir,
        files: [
          'src/services/plannerService.js',
          'src/server/routes/planner.js',
          'tests/unit/planner-routes.test.js',
        ],
      });
      const graph = buildSymbolGraph({ cwd: dir, evidence });
      const summary = summarizeSymbolGraph(graph);

      expect(graph.references).toEqual(expect.arrayContaining([
        expect.objectContaining({
          symbol: 'planService',
          fromPath: 'src/server/routes/planner.js',
          toPath: 'src/services/plannerService.js',
          kind: 'call',
        }),
      ]));
      expect(graph.routeTestChains).toEqual(expect.arrayContaining([
        expect.objectContaining({
          route: '/api/planner/items',
          routePath: 'src/server/routes/planner.js',
          testPath: 'tests/unit/planner-routes.test.js',
          handlerSymbols: expect.arrayContaining([
            expect.objectContaining({ symbol: 'planService' }),
          ]),
        }),
      ]));
      expect(graph.unresolvedReferences).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'missingRuntime',
          fromPath: 'src/server/routes/planner.js',
          kind: 'call',
        }),
      ]));
      expect(summary.routeToTestChainCount).toBeGreaterThanOrEqual(1);
      expect(summary.unresolvedReferenceCount).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it('resolves TypeScript import aliases, default exports, and barrel re-exports', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/core'), { recursive: true });
      mkdirSync(join(dir, 'src/app'), { recursive: true });
      writeFileSync(join(dir, 'src/core/math.ts'), [
        'export function buildScore(input: number): number {',
        '  return input + 1;',
        '}',
        'export default function normalizeScore(input: number): number {',
        '  return buildScore(input);',
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'src/core/index.ts'), [
        "export { buildScore as createScore } from './math';",
        "export { default as normalizeScore } from './math';",
      ].join('\n'));
      writeFileSync(join(dir, 'src/app/Dashboard.tsx'), [
        "import React from 'react';",
        "import { createScore, normalizeScore as normalize } from '../core';",
        'export function ScoreCard({ value }: { value: number }) {',
        '  const score = createScore(value);',
        '  return <section>{normalize(score)}</section>;',
        '}',
      ].join('\n'));

      const evidence = buildCodeContextEvidence({
        cwd: dir,
        files: ['src/core/math.ts', 'src/core/index.ts', 'src/app/Dashboard.tsx'],
      });
      const graph = buildSymbolGraph({ cwd: dir, evidence });
      const buildScore = graph.definitions.find((item) => item.name === 'buildScore');
      const normalizeScore = graph.definitions.find((item) => item.name === 'normalizeScore');

      expect(evidence.every((file) => file.parser === 'babel')).toBe(true);
      expect(buildScore.exportNames).toEqual(expect.arrayContaining(['buildScore']));
      expect(normalizeScore.exportNames).toEqual(expect.arrayContaining(['default']));
      expect(graph.references).toEqual(expect.arrayContaining([
        expect.objectContaining({
          symbol: 'buildScore',
          fromPath: 'src/app/Dashboard.tsx',
          toPath: 'src/core/math.ts',
          kind: 'call',
        }),
        expect.objectContaining({
          symbol: 'normalizeScore',
          fromPath: 'src/app/Dashboard.tsx',
          toPath: 'src/core/math.ts',
          kind: 'call',
        }),
      ]));
    } finally {
      cleanup();
    }
  });

  it('links TypeScript type-only imports and heritage references to definitions', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/app'), { recursive: true });
      writeFileSync(join(dir, 'src/types.ts'), [
        'export interface BaseProps {',
        '  id: string;',
        '}',
        'export interface ExternalShape extends BaseProps {',
        '  value: number;',
        '}',
        'export interface Disposable<T> {',
        '  dispose(input: T): void;',
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'src/app/Widget.ts'), [
        "import type { ExternalShape, Disposable } from '../types';",
        'export interface WidgetProps extends ExternalShape {',
        '  label: string;',
        '}',
        'export class WidgetController implements Disposable<WidgetProps> {',
        '  dispose(input: WidgetProps): void {',
        '    input.label;',
        '  }',
        '}',
      ].join('\n'));

      const evidence = buildCodeContextEvidence({
        cwd: dir,
        files: ['src/types.ts', 'src/app/Widget.ts'],
      });
      const graph = buildSymbolGraph({ cwd: dir, evidence });

      expect(evidence.every((file) => file.parser === 'babel')).toBe(true);
      expect(graph.references).toEqual(expect.arrayContaining([
        expect.objectContaining({
          symbol: 'ExternalShape',
          fromPath: 'src/app/Widget.ts',
          toPath: 'src/types.ts',
          kind: 'type-extends',
        }),
        expect.objectContaining({
          symbol: 'Disposable',
          fromPath: 'src/app/Widget.ts',
          toPath: 'src/types.ts',
          kind: 'type-implements',
        }),
        expect.objectContaining({
          symbol: 'WidgetProps',
          fromPath: 'src/app/Widget.ts',
          toPath: 'src/app/Widget.ts',
          kind: 'type-reference',
        }),
      ]));
    } finally {
      cleanup();
    }
  });

  it('links member calls and assertion/satisfies type references', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/app'), { recursive: true });
      writeFileSync(join(dir, 'src/types.ts'), [
        'export interface Renderable {',
        '  render(): string;',
        '}',
        'export type WidgetState = {',
        '  ready: boolean;',
        '};',
      ].join('\n'));
      writeFileSync(join(dir, 'src/app/WidgetController.ts'), [
        "import type { Renderable, WidgetState } from '../types';",
        'export class WidgetController implements Renderable {',
        '  dispose(input: WidgetState): void {',
        '    input.ready;',
        '  }',
        '  render(): string {',
        '    this.dispose({ ready: true } as WidgetState);',
        "    return 'ok';",
        '  }',
        '}',
        'function makeStore<T>(): T {',
        '  return {} as T;',
        '}',
        'const controller = new WidgetController();',
        'controller.render();',
        'controller.dispose(makeStore<WidgetState>());',
        'const narrowed = controller satisfies Renderable;',
      ].join('\n'));

      const evidence = buildCodeContextEvidence({
        cwd: dir,
        files: ['src/types.ts', 'src/app/WidgetController.ts'],
      });
      const graph = buildSymbolGraph({ cwd: dir, evidence });

      expect(evidence.every((file) => file.parser === 'babel')).toBe(true);
      expect(graph.definitions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'dispose',
          type: 'method',
          path: 'src/app/WidgetController.ts',
          owner: 'WidgetController',
          ownerType: 'class',
        }),
        expect.objectContaining({
          name: 'render',
          type: 'method',
          path: 'src/app/WidgetController.ts',
          owner: 'WidgetController',
          ownerType: 'class',
        }),
        expect.objectContaining({
          name: 'render',
          type: 'type-method',
          path: 'src/types.ts',
          owner: 'Renderable',
          ownerType: 'interface',
        }),
      ]));
      expect(graph.references).toEqual(expect.arrayContaining([
        expect.objectContaining({
          symbol: 'dispose',
          fromPath: 'src/app/WidgetController.ts',
          toPath: 'src/app/WidgetController.ts',
          kind: 'member-call',
        }),
        expect.objectContaining({
          symbol: 'render',
          fromPath: 'src/app/WidgetController.ts',
          toPath: 'src/app/WidgetController.ts',
          kind: 'member-call',
        }),
        expect.objectContaining({
          symbol: 'WidgetState',
          fromPath: 'src/app/WidgetController.ts',
          toPath: 'src/types.ts',
          kind: 'type-assertion',
        }),
        expect.objectContaining({
          symbol: 'WidgetState',
          fromPath: 'src/app/WidgetController.ts',
          toPath: 'src/types.ts',
          kind: 'type-instantiation',
        }),
        expect.objectContaining({
          symbol: 'Renderable',
          fromPath: 'src/app/WidgetController.ts',
          toPath: 'src/types.ts',
          kind: 'type-satisfies',
        }),
        expect.objectContaining({
          symbol: 'render',
          fromPath: 'src/app/WidgetController.ts',
          toPath: 'src/types.ts',
          kind: 'type-implementation',
          text: 'WidgetController.render implements Renderable.render',
        }),
      ]));
      expect(summarizeSymbolGraph(graph).typeImplementationCount).toBe(1);
    } finally {
      cleanup();
    }
  });
});
