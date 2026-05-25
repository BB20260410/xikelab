import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MetricsStore } from '../../src/metrics/MetricsStore.js';

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'xike-metrics-diagnostics-'));
  const auditEvents = [];
  const budgetRows = [];
  const store = new MetricsStore({
    dir,
    logger: { warn() {} },
    audit: { recordSafe(input) { auditEvents.push(input); return input; } },
    budgetStore: { recordMetric(input) { budgetRows.push(input); } },
  });
  return {
    store,
    auditEvents,
    budgetRows,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('MetricsStore agent skill diagnostics', () => {
  it('persists diagnostics and emits a dedicated audit event', () => {
    const { store, auditEvents, budgetRows, cleanup } = makeStore();
    try {
      const row = store.record({
        roomId: 'room-1',
        roomMode: 'chat',
        roomName: 'Agent Diagnostics',
        projectId: '/tmp/xikelab',
        sessionId: 'session-1',
        taskId: 'task-1',
        turn: 'chat_reply',
        adapter: 'stub',
        model: 'test-model',
        latencyMs: 42,
        tokensIn: 10,
        tokensOut: 20,
        success: true,
        agentProfileId: 'xike-verifier',
        agentProfileTitle: 'Xike Verifier',
        agentDispatchTags: ['verification'],
        agentSkillNames: ['qa', 'browse'],
        agentSkillBindings: [
          { name: 'qa', sources: ['profile', 'dispatch:verification'], bodyLen: 10 },
          { name: 'browse', sources: ['profile'], bodyLen: 20 },
        ],
        agentSkillDiagnostics: [{
          code: 'too_many_skills',
          severity: 'warn',
          message: 'This turn has 9 installed skills; consider narrowing room-level bindings.',
          count: 9,
          limit: 8,
        }],
        agentCodeContextSignals: {
          fileCount: 2,
          signalFileCount: 2,
          tags: [{ tag: 'verification', score: 5, reasons: ['test surface'], paths: ['tests/unit/foo.test.js'] }],
        },
        agentCodeContextEvidence: [{
          path: 'tests/unit/foo.test.js',
          language: 'javascript',
          symbols: [],
          anchors: [{ kind: 'it', name: 'verifies diagnostics', line: 12 }],
          imports: [{ source: 'vitest', line: 1 }],
        }],
        agentGovernance: { budgetScope: 'agent_profile', budgetTier: 'standard' },
      });

      expect(row.agentSkillDiagnostics).toHaveLength(1);
      expect(row.agentCodeContextSignals.tags[0]).toMatchObject({ tag: 'verification', score: 5 });
      expect(row.agentCodeContextEvidence[0].anchors[0]).toMatchObject({ kind: 'it', name: 'verifies diagnostics' });
      expect(store.query({ roomId: 'room-1' })[0].agentSkillBindings[0]).toMatchObject({
        name: 'qa',
        sources: ['profile', 'dispatch:verification'],
      });
      expect(budgetRows[0].agentSkillDiagnostics[0].code).toBe('too_many_skills');

      const recorded = auditEvents.find((event) => event.action === 'metrics.recorded');
      expect(recorded).toMatchObject({ sessionId: 'session-1', taskId: 'task-1' });
      expect(recorded.details).toMatchObject({ sessionId: 'session-1', taskId: 'task-1' });
      expect(recorded.details.agentSkillDiagnostics[0].code).toBe('too_many_skills');
      expect(recorded.details.agentCodeContextSignals.tags[0].tag).toBe('verification');
      expect(recorded.details.agentCodeContextEvidence[0].imports[0].source).toBe('vitest');
      expect(recorded.details.agentSkillBindings[0].name).toBe('qa');

      const diagnostic = auditEvents.find((event) => event.action === 'agent.skill_diagnostics');
      expect(diagnostic).toMatchObject({
        roomId: 'room-1',
        sessionId: 'session-1',
        taskId: 'task-1',
        entityType: 'agent_profile',
        entityId: 'xike-verifier',
        severity: 'warn',
      });
      expect(diagnostic.details.diagnostics[0].code).toBe('too_many_skills');
    } finally {
      cleanup();
    }
  });
});
