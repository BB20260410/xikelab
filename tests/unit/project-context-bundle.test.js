import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProjectContextBundle, formatProjectContextBundle, summarizeProjectContextBundle } from '../../src/context/ProjectContextBundle.js';

let tmp;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function makeProject() {
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-project-context-'));
  writeFileSync(join(tmp, 'AGENTS.md'), '# Agents\nUse local tools first.\n');
  writeFileSync(join(tmp, 'README.md'), '# Demo\nThis project ships the panel.\n');
  writeFileSync(join(tmp, 'notes.txt'), 'ignored');
  return tmp;
}

describe('ProjectContextBundle', () => {
  it('builds a bounded context bundle from known project files only', () => {
    const cwd = makeProject();
    const bundle = buildProjectContextBundle(cwd, { maxChars: 2000, maxFileChars: 1000 });

    expect(bundle.cwd).toBe(realpathSync(cwd));
    expect(bundle.files.map(f => f.name)).toEqual(['AGENTS.md', 'README.md']);
    expect(bundle.prompt).toContain('自动项目上下文');
    expect(bundle.prompt).toContain('Use local tools first');
    expect(bundle.prompt).not.toContain('ignored');

    const summary = summarizeProjectContextBundle(bundle);
    expect(summary).toMatchObject({ fileCount: 2, truncated: false });
    expect(summary.files[0].content).toBeUndefined();
  });

  it('truncates large files and formats the prompt safely', () => {
    tmp = mkdtempSync(join(tmpdir(), 'xikelab-project-context-big-'));
    writeFileSync(join(tmp, 'CLAUDE.md'), 'A'.repeat(5000));

    const bundle = buildProjectContextBundle(tmp, { maxChars: 1500, maxFileChars: 1200 });
    expect(bundle.files[0].truncated).toBe(true);
    expect(bundle.truncated).toBe(true);
    expect(formatProjectContextBundle(bundle, { maxChars: 1000 }).length).toBeLessThanOrEqual(1020);
  });
});
