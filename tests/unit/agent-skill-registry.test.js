import { describe, expect, it } from 'vitest';
import {
  buildAgentRuntimeContext,
  classifyTask,
  diagnoseAgentSkillBindings,
  mergeAgentGovernanceOverrides,
  resolveAgentProfile,
  resolveAgentSkillBindings,
  summarizeAgentRuntimeContext,
} from '../../src/agents/AgentSkillRegistry.js';
import { injectSkillsToMessages } from '../../src/room/skillInjector.js';

describe('AgentSkillRegistry', () => {
  it('classifies mixed work into explainable dispatch tags', () => {
    const matches = classifyTask('请重构多 Agent 架构，并跑浏览器测试验证预算治理和审批流程。');
    const tags = matches.map((match) => match.tag);

    expect(tags).toContain('architecture');
    expect(tags).toContain('verification');
    expect(tags).toContain('governance');
    expect(matches[0].score).toBeGreaterThan(0);
    expect(matches.flatMap((match) => match.matched)).toContain('架构');
  });

  it('uses code context signals as dispatch evidence when task text is vague', () => {
    const matches = classifyTask('继续推进这一块', undefined, {
      codeContext: {
        affectedFiles: [
          'src/agents/AgentSkillRegistry.js',
          'src/server/routes/activity.js',
          'tests/unit/routes/activity-routes.test.js',
        ],
      },
    });

    const architecture = matches.find((match) => match.tag === 'architecture');
    const verification = matches.find((match) => match.tag === 'verification');
    expect(architecture).toMatchObject({
      agentId: 'xike-architect',
      codeScore: expect.any(Number),
    });
    expect(architecture.contextPaths).toContain('src/agents/AgentSkillRegistry.js');
    expect(verification.contextReasons).toContain('test surface');
  });

  it('resolves room members to durable Xike agent profiles by role', () => {
    const dev = resolveAgentProfile({ adapterId: 'codex', role: 'dev', displayName: 'Codex Dev' });
    const qa = resolveAgentProfile({ adapterId: 'codex', role: 'qa', displayName: 'Codex QA' });

    expect(dev).toMatchObject({ id: 'xike-builder' });
    expect(qa).toMatchObject({ id: 'xike-verifier' });
  });

  it('lets a room member explicitly bind to a profile instead of role fallback', () => {
    const profile = resolveAgentProfile({
      adapterId: 'codex',
      role: 'dev',
      agentProfileId: 'xike-verifier',
      displayName: 'Codex Dev as QA',
    });

    expect(profile).toMatchObject({ id: 'xike-verifier' });
  });

  it('keeps only installed and enabled bound skills in runtime context', () => {
    const fakeSkillStore = {
      get(name) {
        if (name === 'qa') return { name, enabled: true };
        if (name === 'browse') return { name, enabled: true };
        return null;
      },
    };
    const ctx = buildAgentRuntimeContext({
      member: { adapterId: 'codex', role: 'qa', displayName: 'Codex QA' },
      objective: '用浏览器验证 UI 回归并输出 QA 结论',
      skillStore: fakeSkillStore,
    });

    expect(ctx.profile.id).toBe('xike-verifier');
    expect(ctx.governance).toMatchObject({ commandGuard: 'strict', budgetScope: 'agent_profile' });
    expect(ctx.skillNames).toEqual(['qa', 'browse']);
    expect(ctx.skillBindings.find((binding) => binding.name === 'qa').sources).toEqual(['profile', 'dispatch:verification']);
    expect(ctx.prompt).toContain('Xike Agent Runtime Context');
    expect(ctx.prompt).toContain('xike-verifier');
    expect(ctx.prompt).toContain('qa [profile+dispatch:verification]');
    expect(ctx.prompt).toContain('Governance:');
  });

  it('includes code context signals in runtime prompt and metrics summary', () => {
    const ctx = buildAgentRuntimeContext({
      member: { adapterId: 'codex', role: 'dev', displayName: 'Codex Dev' },
      objective: '继续',
      codeContext: {
        affectedFiles: ['public/app.js', 'tests/e2e/panel-ui-walkthrough.mjs'],
        evidence: [{
          path: 'public/app.js',
          language: 'javascript',
          symbols: [{ name: 'renderAgentClassification', type: 'function', line: 7020 }],
          anchors: [{ kind: 'api', name: '/api/agent-registry/classify', line: 6960 }],
        }],
        symbolGraph: {
          definitions: [{
            id: 'public/app.js:renderAgentClassification:7020',
            name: 'renderAgentClassification',
            type: 'function',
            path: 'public/app.js',
            line: 7020,
            referenceCount: 2,
            callCount: 1,
          }],
          references: [{
            symbolId: 'public/app.js:renderAgentClassification:7020',
            symbol: 'renderAgentClassification',
            fromPath: 'public/app.js',
            toPath: 'public/app.js',
            line: 7038,
            kind: 'call',
            text: 'root.innerHTML = renderAgentClassification(result);',
          }],
        },
      },
    });
    const summary = summarizeAgentRuntimeContext(ctx);

    expect(ctx.dispatchMatches.map((match) => match.tag)).toEqual(expect.arrayContaining(['design', 'verification']));
    expect(ctx.prompt).toContain('Code context signals:');
    expect(ctx.prompt).toContain('Code evidence:');
    expect(ctx.prompt).toContain('Symbol graph:');
    expect(ctx.prompt).toContain('renderAgentClassification@public/app.js:7020');
    expect(summary.agentCodeContextSignals.tags.map((tag) => tag.tag)).toContain('verification');
    expect(summary.agentCodeContextEvidence[0].symbols[0].name).toBe('renderAgentClassification');
    expect(summary.agentCodeContextGraph.definitions[0].referenceCount).toBe(2);
    expect(summary.agentDispatchMatches.some((match) => match.codeScore > 0)).toBe(true);
  });

  it('explains skill sources across profile, dispatch, and room bindings', () => {
    const profile = resolveAgentProfile({ role: 'qa' });
    const dispatchMatches = classifyTask('用浏览器测试回归');
    const bindings = resolveAgentSkillBindings({
      profile,
      dispatchMatches,
      room: { skills: ['qa', 'custom-room-skill'] },
    });

    expect(bindings.find((binding) => binding.name === 'qa').sources).toEqual(['profile', 'dispatch:verification', 'room']);
    expect(bindings.find((binding) => binding.name === 'custom-room-skill').sources).toEqual(['room']);
  });

  it('diagnoses excessive, conflicting, and large skill bindings', () => {
    const bindings = [
      { name: 'a', bodyLen: 80_000, conflictsWith: ['b'] },
      { name: 'b', bodyLen: 50_000 },
      { name: 'c', exclusiveGroup: 'mode' },
      { name: 'd', exclusiveGroup: 'mode' },
      { name: 'e' },
      { name: 'f' },
      { name: 'g' },
      { name: 'h' },
      { name: 'i' },
    ];
    const diagnostics = diagnoseAgentSkillBindings(bindings, { maxSkills: 8, maxBodyChars: 120_000 });

    expect(diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'too_many_skills',
      'skill_prompt_too_large',
      'exclusive_skill_group_conflict',
      'skill_conflict',
    ]));
  });

  it('merges local governance overrides into the runtime registry', () => {
    const registry = mergeAgentGovernanceOverrides(undefined, {
      'xike-verifier': {
        budgetTier: 'restricted',
        commandGuard: 'strict',
        approvalPolicy: 'read_only',
        auditLevel: 'full',
      },
    });
    const profile = resolveAgentProfile({ role: 'qa' }, {}, registry);
    const ctx = buildAgentRuntimeContext({
      member: { adapterId: 'codex', role: 'qa', displayName: 'Codex QA' },
      objective: '验证本地治理策略',
      registry,
    });

    expect(profile.governanceOverridden).toBe(true);
    expect(ctx.governance).toMatchObject({
      budgetTier: 'restricted',
      approvalPolicy: 'read_only',
      budgetScope: 'agent_profile',
    });
    expect(ctx.prompt).toContain('agent_profile:xike-verifier/restricted');
  });

  it('injects agent runtime context without mutating the original messages', () => {
    const messages = [
      { role: 'system', content: 'base system' },
      { role: 'user', content: '实现并测试' },
    ];
    const out = injectSkillsToMessages(messages, {
      name: 'Agent room',
      topic: '实现并测试一个功能',
      skills: [],
    }, {
      member: { adapterId: 'codex', role: 'dev', displayName: 'Codex Dev' },
      objective: '实现并测试一个功能',
    });

    expect(out[0].content).toContain('base system');
    expect(out[0].content).toContain('Xike Agent Runtime Context');
    expect(out[0].content).toContain('xike-builder');
    expect(messages[0].content).toBe('base system');
  });
});
