import { describe, expect, it } from 'vitest';
import { analyzeJavaScriptAst } from '../../src/agents/JavaScriptAstAnalyzer.js';

describe('JavaScriptAstAnalyzer', () => {
  it('extracts module symbols, imports, routes, tests, and call references', () => {
    const result = analyzeJavaScriptAst({
      path: 'src/server/routes/planner.js',
      text: [
        "import express from 'express';",
        "import { buildCodeContextEvidence } from '../../agents/CodeContextEvidence.js';",
        'export function buildPlannerContext(input) {',
        '  return input;',
        '}',
        "export async function loadPlannerPlugin() { return import('../plugins/planner-plugin.js'); }",
        'export function registerPlannerRoutes(app) {',
        "  app.post('/api/planner/context', (req, res) => res.json(buildPlannerContext(req.body)));",
        '}',
        "describe('planner routes', () => {});",
      ].join('\n'),
    });

    expect(result.ok).toBe(true);
    expect(result.parser).toBe('acorn');
    expect(result.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'buildPlannerContext', type: 'function', exported: true }),
      expect.objectContaining({ name: 'registerPlannerRoutes', type: 'function', exported: true }),
    ]));
    expect(result.imports.map((item) => item.source)).toEqual(expect.arrayContaining([
      'express',
      '../../agents/CodeContextEvidence.js',
      '../plugins/planner-plugin.js',
    ]));
    expect(result.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: '../plugins/planner-plugin.js', kind: 'dynamic-import' }),
    ]));
    expect(result.anchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'route', name: 'POST /api/planner/context' }),
      expect.objectContaining({ kind: 'api', name: '/api/planner/context' }),
      expect.objectContaining({ kind: 'describe', name: 'planner routes' }),
    ]));
    expect(result.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'buildCodeContextEvidence', kind: 'import' }),
      expect.objectContaining({ name: 'buildPlannerContext', kind: 'call' }),
      expect.objectContaining({ name: '../plugins/planner-plugin.js', kind: 'dynamic-import' }),
    ]));
  });

  it('reports parse diagnostics so callers can fall back to regex extraction', () => {
    const result = analyzeJavaScriptAst({
      path: 'src/broken.js',
      text: 'export function broken( {',
    });

    expect(result.ok).toBe(false);
    expect(result.parser).toBe('regex');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ast_parse_failed' }),
    ]));
  });

  it('parses TypeScript and JSX with imports, exports, type symbols, and runtime calls', () => {
    const result = analyzeJavaScriptAst({
      path: 'src/ui/ScoreCard.tsx',
      text: [
        "import React from 'react';",
        "import type { ScoreInput } from '../types';",
        "import { buildScore as createScore } from '../core/score';",
        'export interface ScoreCardProps {',
        '  value: number;',
        '}',
        'type LocalMode = "compact" | "full";',
        'export function ScoreCard({ value }: ScoreCardProps) {',
        '  const score: number = createScore(value);',
        "  return <section data-mode={'compact' as LocalMode}>{score}</section>;",
        '}',
        'export default ScoreCard;',
      ].join('\n'),
    });

    expect(result.ok).toBe(true);
    expect(result.parser).toBe('babel');
    expect(result.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ScoreCardProps', type: 'interface', exported: true }),
      expect.objectContaining({ name: 'LocalMode', type: 'type', exported: false }),
      expect.objectContaining({ name: 'ScoreCard', type: 'function', exported: true }),
    ]));
    expect(result.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: '../core/score',
        specifiers: expect.arrayContaining([
          expect.objectContaining({ imported: 'buildScore', local: 'createScore' }),
        ]),
      }),
      expect.objectContaining({
        source: '../types',
        kind: 'type',
      }),
    ]));
    expect(result.exports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ScoreCard', local: 'ScoreCard', kind: 'named' }),
      expect.objectContaining({ name: 'default', local: 'ScoreCard', kind: 'default' }),
    ]));
    expect(result.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'createScore', kind: 'call' }),
      expect.objectContaining({ name: 'ScoreInput', kind: 'type-import' }),
      expect.objectContaining({ name: 'ScoreCardProps', kind: 'type-reference' }),
      expect.objectContaining({ name: 'LocalMode', kind: 'type-assertion' }),
    ]));
  });

  it('extracts TypeScript heritage, implements, aliases, annotations, and generic constraints', () => {
    const result = analyzeJavaScriptAst({
      path: 'src/ui/Widget.ts',
      text: [
        "import type { ExternalShape, Disposable } from './types';",
        'interface BaseProps { id: string }',
        'export interface WidgetProps extends BaseProps {',
        '  item: ExternalShape;',
        '}',
        'type WidgetState = ExternalShape & { ready: boolean };',
        'export class WidgetController implements Disposable<WidgetState> {',
        '  update<T extends WidgetState>(input: T): WidgetState {',
        '    return input;',
        '  }',
        '}',
      ].join('\n'),
    });

    expect(result.ok).toBe(true);
    expect(result.parser).toBe('babel');
    expect(result.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'BaseProps', type: 'interface' }),
      expect.objectContaining({ name: 'WidgetProps', type: 'interface', exported: true }),
      expect.objectContaining({ name: 'WidgetState', type: 'type' }),
      expect.objectContaining({ name: 'WidgetController', type: 'class', exported: true }),
    ]));
    expect(result.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ExternalShape', kind: 'type-import' }),
      expect.objectContaining({ name: 'Disposable', kind: 'type-import' }),
      expect.objectContaining({ name: 'BaseProps', kind: 'type-extends' }),
      expect.objectContaining({ name: 'ExternalShape', kind: 'type-reference' }),
      expect.objectContaining({ name: 'Disposable', kind: 'type-implements' }),
      expect.objectContaining({ name: 'WidgetState', kind: 'type-reference' }),
      expect.objectContaining({ name: 'WidgetState', kind: 'type-constraint' }),
    ]));
  });

  it('extracts assertion, satisfies, instantiation, and member semantic references', () => {
    const result = analyzeJavaScriptAst({
      path: 'src/ui/WidgetController.ts',
      text: [
        "import type { Renderable, WidgetState } from './types';",
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
      ].join('\n'),
    });

    expect(result.ok).toBe(true);
    expect(result.parser).toBe('babel');
    expect(result.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'WidgetController', type: 'class' }),
      expect.objectContaining({ name: 'dispose', type: 'method' }),
      expect.objectContaining({ name: 'render', type: 'method' }),
      expect.objectContaining({ name: 'makeStore', type: 'function' }),
    ]));
    expect(result.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'dispose', type: 'method', owner: 'WidgetController', ownerType: 'class' }),
      expect.objectContaining({ name: 'render', type: 'method', owner: 'WidgetController', ownerType: 'class' }),
    ]));
    expect(result.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Renderable', kind: 'type-implements' }),
      expect.objectContaining({ name: 'WidgetState', kind: 'type-reference' }),
      expect.objectContaining({ name: 'WidgetState', kind: 'type-assertion' }),
      expect.objectContaining({ name: 'WidgetState', kind: 'type-instantiation' }),
      expect.objectContaining({ name: 'Renderable', kind: 'type-satisfies' }),
      expect.objectContaining({ name: 'dispose', kind: 'member-call' }),
      expect.objectContaining({ name: 'render', kind: 'member-call' }),
      expect.objectContaining({ name: 'ready', kind: 'member-reference' }),
    ]));
  });

  it('captures callback registration and object property flow references', () => {
    const out = analyzeJavaScriptAst({
      path: 'wire.js',
      text: [
        "emitter.on('done', handleDone);",
        'app.use(authMiddleware);',
        "el.addEventListener('click', () => run());",
        'const cfg = { handler: doWork, onError: () => {}, label: "x" };',
      ].join('\n'),
    });
    expect(out.ok).toBe(true);
    const refs = out.references;
    const cb = refs.filter((r) => r.kind === 'callback-registration').map((r) => r.name);
    expect(cb).toContain('on:done');
    expect(cb).toContain('use');
    expect(cb).toContain('addEventListener:click');
    const flow = refs.filter((r) => r.kind === 'object-property-flow').map((r) => r.name);
    expect(flow).toContain('handler');
    expect(flow).toContain('onError');
    // 非函数属性值不应记为数据流绑定
    expect(flow).not.toContain('label');
  });
});
