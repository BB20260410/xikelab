import { describe, expect, it } from 'vitest';
import { inferCodeContextSignals } from '../../src/agents/CodeContextSignals.js';

describe('CodeContextSignals', () => {
  it('infers dispatch tags from affected project files', () => {
    const signals = inferCodeContextSignals({
      affectedFiles: [
        'src/agents/AgentSkillRegistry.js',
        'src/server/routes/activity.js',
        'public/style.css',
        'tests/e2e/panel-ui-walkthrough.mjs',
        'docs/xikelab-agent-skill-registry.md',
      ],
    });

    expect(signals.fileCount).toBe(5);
    expect(signals.signalFileCount).toBe(5);
    expect(signals.tags.map((tag) => tag.tag)).toEqual(expect.arrayContaining([
      'architecture',
      'implementation',
      'verification',
      'design',
      'planning',
    ]));
    expect(signals.tags.find((tag) => tag.tag === 'architecture').paths).toContain('src/agents/AgentSkillRegistry.js');
    expect(signals.tags.find((tag) => tag.tag === 'verification').reasons).toContain('test surface');
  });

  it('normalizes git-status style paths without leaking huge snippets', () => {
    const signals = inferCodeContextSignals({
      affectedFiles: [
        ' M src/audit/ActivityLog.js',
        { path: '?? tests/unit/activity-log.test.js', content: 'verify '.repeat(1000) },
      ],
    });

    expect(signals.files.map((file) => file.path)).toEqual([
      'src/audit/ActivityLog.js',
      'tests/unit/activity-log.test.js',
    ]);
    expect(signals.tags.map((tag) => tag.tag)).toContain('verification');
  });
});
