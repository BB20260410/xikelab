// Codebase Index 扫描上限集中配置（P6 刀1）：把原先散落的硬编码上限集中于此，
// 并支持从 ~/.claude-panel/codebase-limits.json 覆盖（缺省用默认值），便于大库调参而不改代码。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const CODEBASE_LIMIT_DEFAULTS = Object.freeze({
  maxScanFiles: 260,
  maxFocusFiles: 24,
  maxFileBytes: 500_000,
  maxSnippetChars: 220,
  maxScanMs: 1200,
  // FTS / vector / snapshot 索引容量上限（P6 刀2：从各 index 文件集中至此，可经 override 调参）
  maxFtsRows: 2500,
  maxVectorRows: 1200,
  maxSnapshotsPerCwd: 48,
});

export function loadCodebaseLimitOverrides(path = join(homedir(), '.claude-panel', 'codebase-limits.json')) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const out = {};
    for (const key of Object.keys(CODEBASE_LIMIT_DEFAULTS)) {
      const v = raw?.[key];
      if (Number.isFinite(v) && v > 0) out[key] = Math.trunc(v);
    }
    return out;
  } catch {
    return {};
  }
}

export function getCodebaseLimits(overrides) {
  return { ...CODEBASE_LIMIT_DEFAULTS, ...(overrides || loadCodebaseLimitOverrides()) };
}

// 模块加载时解析一次（运行时配置快照）
export const CODEBASE_LIMITS = getCodebaseLimits();
