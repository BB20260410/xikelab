import { describe, expect, it } from 'vitest';
import { injectSkillsToMessages } from '../../src/room/skillInjector.js';

describe('project context injection', () => {
  it('appends room project context to the first system message', () => {
    const messages = [
      { role: 'system', content: 'base system' },
      { role: 'user', content: 'do work' },
    ];
    const out = injectSkillsToMessages(messages, {
      projectContext: { prompt: '# 自动项目上下文\nUse AGENTS.md' },
      skills: [],
    });

    expect(out[0].content).toContain('base system');
    expect(out[0].content).toContain('Use AGENTS.md');
    expect(messages[0].content).toBe('base system');
  });
});
