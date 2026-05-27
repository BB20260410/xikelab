import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CODEBASE_LIMIT_DEFAULTS, getCodebaseLimits, loadCodebaseLimitOverrides } from '../../src/agents/codebaseLimits.js';

describe('codebaseLimits', () => {
  it('returns defaults when there are no overrides', () => {
    expect(getCodebaseLimits({})).toEqual(CODEBASE_LIMIT_DEFAULTS);
  });

  it('applies positive integer overrides and ignores invalid/unknown keys', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xikelab-limits-'));
    const f = join(tmp, 'codebase-limits.json');
    writeFileSync(f, JSON.stringify({ maxScanFiles: 500, maxFileBytes: -1, maxFocusFiles: 'x', bogus: 9 }));
    try {
      const ov = loadCodebaseLimitOverrides(f);
      expect(ov).toEqual({ maxScanFiles: 500 });
      const limits = getCodebaseLimits(ov);
      expect(limits.maxScanFiles).toBe(500);
      expect(limits.maxFocusFiles).toBe(CODEBASE_LIMIT_DEFAULTS.maxFocusFiles);
      expect(limits.maxFileBytes).toBe(CODEBASE_LIMIT_DEFAULTS.maxFileBytes);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty overrides when the config file is missing', () => {
    expect(loadCodebaseLimitOverrides('/nonexistent/path/codebase-limits.json')).toEqual({});
  });

  it('centralizes FTS / vector / snapshot capacity caps with defaults (P6 刀2)', () => {
    expect(CODEBASE_LIMIT_DEFAULTS.maxFtsRows).toBe(2500);
    expect(CODEBASE_LIMIT_DEFAULTS.maxVectorRows).toBe(1200);
    expect(CODEBASE_LIMIT_DEFAULTS.maxSnapshotsPerCwd).toBe(48);
  });

  it('applies overrides to the centralized cache caps', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xikelab-limits-cache-'));
    const f = join(tmp, 'codebase-limits.json');
    writeFileSync(f, JSON.stringify({ maxFtsRows: 5000, maxVectorRows: 2400, maxSnapshotsPerCwd: 96 }));
    try {
      const ov = loadCodebaseLimitOverrides(f);
      expect(ov).toEqual({ maxFtsRows: 5000, maxVectorRows: 2400, maxSnapshotsPerCwd: 96 });
      const limits = getCodebaseLimits(ov);
      expect(limits.maxFtsRows).toBe(5000);
      expect(limits.maxVectorRows).toBe(2400);
      expect(limits.maxSnapshotsPerCwd).toBe(96);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
