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
});
