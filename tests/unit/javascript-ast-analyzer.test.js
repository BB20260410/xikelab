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
    ]));
    expect(result.anchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'route', name: 'POST /api/planner/context' }),
      expect.objectContaining({ kind: 'api', name: '/api/planner/context' }),
      expect.objectContaining({ kind: 'describe', name: 'planner routes' }),
    ]));
    expect(result.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'buildCodeContextEvidence', kind: 'import' }),
      expect.objectContaining({ name: 'buildPlannerContext', kind: 'call' }),
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
});
