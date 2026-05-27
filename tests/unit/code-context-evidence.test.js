import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodeContextEvidence, buildCodeContextEvidenceFile, normalizeCodeContextEvidence, summarizeCodeContextEvidence } from '../../src/agents/CodeContextEvidence.js';
import { CODEBASE_LIMITS } from '../../src/agents/codebaseLimits.js';

function tempProject() {
  const dir = join(tmpdir(), `xike-code-evidence-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('CodeContextEvidence', () => {
  it('bounds per-file parsing by codebaseLimits.maxFileBytes (C3 续)', () => {
    const { dir, cleanup } = tempProject();
    try {
      writeFileSync(join(dir, 'big.js'), 'export const a = 1;\n');
      // 超过 maxFileBytes → 跳过解析（不产符号），但记录 bytes
      const skipped = buildCodeContextEvidenceFile({
        cwd: dir, file: 'big.js',
        meta: { isFile: () => true, size: CODEBASE_LIMITS.maxFileBytes + 1 },
      });
      expect(skipped.bytes).toBe(CODEBASE_LIMITS.maxFileBytes + 1);
      expect(skipped.symbols).toEqual([]);
      // 界内 → 正常解析出符号
      const parsed = buildCodeContextEvidenceFile({
        cwd: dir, file: 'big.js',
        meta: { isFile: () => true, size: CODEBASE_LIMITS.maxFileBytes - 1 },
        text: 'export const a = 1;\n',
      });
      expect(parsed.symbols.some((s) => s.name === 'a')).toBe(true);
    } finally { cleanup(); }
  });

  it('extracts symbols, imports, routes, and tests from changed files', () => {
    const { dir, cleanup } = tempProject();
    try {
      mkdirSync(join(dir, 'src/server/routes'), { recursive: true });
      mkdirSync(join(dir, 'tests/unit'), { recursive: true });
      writeFileSync(join(dir, 'src/server/routes/agentRegistry.js'), [
        "import express from 'express';",
        "import { buildCodeContextEvidence } from '../../agents/CodeContextEvidence.js';",
        "const plugin = () => import('../../plugins/agent-registry-plugin.js');",
        'export function registerAgentRegistryRoutes(app) {',
        "  app.get('/api/agent-registry/changed-files', (req, res) => res.json({ ok: true }));",
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'tests/unit/code-context-evidence.test.js'), [
        "import { describe, it } from 'vitest';",
        "describe('code evidence', () => {",
        "  it('finds tests', () => {});",
        '});',
      ].join('\n'));

      const evidence = buildCodeContextEvidence({
        cwd: dir,
        files: [
          { path: 'src/server/routes/agentRegistry.js' },
          { path: 'tests/unit/code-context-evidence.test.js' },
        ],
      });

      expect(evidence).toHaveLength(2);
      expect(evidence[0]).toEqual(expect.objectContaining({
        language: 'javascript',
        parser: 'acorn',
      }));
      expect(evidence[0].symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'registerAgentRegistryRoutes', type: 'function', exported: true }),
      ]));
      expect(evidence[0].imports.map((item) => item.source)).toContain('express');
      expect(evidence[0].imports).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: '../../plugins/agent-registry-plugin.js', kind: 'dynamic-import' }),
      ]));
      expect(evidence[0].anchors).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'route', name: 'GET /api/agent-registry/changed-files' }),
      ]));
      expect(evidence[0].references).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'buildCodeContextEvidence', kind: 'import' }),
      ]));
      expect(evidence[1].anchors).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'describe', name: 'code evidence' }),
        expect.objectContaining({ kind: 'it', name: 'finds tests' }),
      ]));

      const summary = summarizeCodeContextEvidence(evidence);
      expect(summary.symbolCount).toBeGreaterThanOrEqual(1);
      expect(summary.anchorCount).toBeGreaterThanOrEqual(3);
      expect(summary.importCount).toBeGreaterThanOrEqual(2);
      expect(summary.referenceCount).toBeGreaterThanOrEqual(1);
      expect(summary.parserCounts.acorn).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('skips paths outside the project and normalizes supplied evidence', () => {
    const { dir, cleanup } = tempProject();
    try {
      writeFileSync(join(dir, 'README.md'), '# Xike\n\n## Agent Context\n');
      const evidence = buildCodeContextEvidence({
        cwd: dir,
        files: ['README.md', '../secret.txt', '/etc/passwd'],
      });

      expect(evidence.map((file) => file.path)).toEqual(['README.md']);
      expect(evidence[0].anchors).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'heading', name: 'Xike' }),
        expect.objectContaining({ kind: 'heading', name: 'Agent Context' }),
      ]));

      const normalized = normalizeCodeContextEvidence({
        evidence: [{
          path: 'src/app.js',
          symbols: [{ name: 'main', type: 'function', line: 3 }],
          anchors: [{ kind: 'api', name: '/api/test', line: 4 }],
        }],
      });
      expect(normalized).toEqual([
        expect.objectContaining({
          path: 'src/app.js',
          symbols: [expect.objectContaining({ name: 'main' })],
          anchors: [expect.objectContaining({ name: '/api/test' })],
        }),
      ]);
    } finally {
      cleanup();
    }
  });
});
