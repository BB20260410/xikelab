import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRunStore } from '../../src/agents/AgentRunStore.js';
import { close, getStats, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-agent-runs-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('AgentRunStore', () => {
  it('creates a run, appends messages and tool results, then exports the timeline', () => {
    const store = new AgentRunStore({ logger: null });
    const run = store.create({
      roomId: 'room-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      agentProfileId: 'xike-builder',
      agentProfileTitle: 'Xike Builder',
      adapterId: 'codex',
      modelId: 'gpt-5.4',
      skills: ['codex', 'review'],
      dispatchTags: ['implementation'],
      governance: { budgetTier: 'medium' },
      approvalId: 'approval-1',
      delegationId: 'delegation-1',
      status: 'running',
    });

    expect(run).toMatchObject({
      status: 'running',
      roomId: 'room-1',
      agentProfileId: 'xike-builder',
      approvalId: 'approval-1',
      delegationId: 'delegation-1',
      skills: ['codex', 'review'],
      dispatchTags: ['implementation'],
    });

    const message = store.appendMessage(run.id, {
      kind: 'decision',
      role: 'agent',
      summary: 'Implement scoped backend route.',
      payload: { evidence: ['src/server/routes/agentRuns.js'] },
    });
    const toolResult = store.appendToolResult(run.id, {
      toolName: 'npm test',
      status: 'passed',
      inputSummary: 'targeted tests',
      outputSummary: '2 tests passed',
      costUsd: 0,
    });
    const deferred = store.transition(run.id, 'deferred', {
      deferReason: 'approval_pending',
      relatedActivityIds: [99],
    });
    expect(deferred).toMatchObject({ status: 'deferred', deferReason: 'approval_pending' });
    expect(deferred.relatedActivityIds).toContain(99);

    const done = store.transition(run.id, 'succeeded', { reason: 'verified' });
    store.audit.recordSafe({
      action: 'approval.created',
      entityType: 'approval',
      entityId: 'approval-1',
      status: 'pending',
      details: { agentRunId: run.id, approvalId: 'approval-1' },
    });
    store.audit.recordSafe({
      action: 'delegation.agent_run_attached',
      entityType: 'delegation',
      entityId: 'delegation-1',
      status: 'queued',
      details: { agentRunId: run.id, delegationId: 'delegation-1' },
    });
    const timeline = store.getTimeline(run.id);
    const exported = store.exportRun(run.id);
    const markdown = store.exportRun(run.id, { format: 'markdown' });

    expect(done.status).toBe('succeeded');
    expect(done.deferReason).toBe('approval_pending');
    expect(timeline.messages).toEqual([expect.objectContaining({ id: message.id, kind: 'decision' })]);
    expect(timeline.toolResults).toEqual([expect.objectContaining({ id: toolResult.id, toolName: 'npm test' })]);
    expect(exported).toMatchObject({
      run: { id: run.id, approvalId: 'approval-1', delegationId: 'delegation-1' },
      messages: [expect.objectContaining({ id: message.id })],
      toolResults: [expect.objectContaining({ id: toolResult.id })],
    });
    expect(exported.activityEvents.map((event) => event.action)).toEqual(expect.arrayContaining([
      'agent.run.created',
      'agent.run.transitioned',
      'agent.run.message_appended',
      'agent.tool_result.recorded',
      'approval.created',
      'delegation.agent_run_attached',
    ]));
    expect(markdown).toContain(`# Agent Run ${run.id}`);
    expect(markdown).toContain('Approval: approval-1');
    expect(store.list({ roomId: 'room-1', agentProfileId: 'xike-builder' })).toHaveLength(1);
    expect(store.list({ approvalId: 'approval-1', delegationId: 'delegation-1' })).toHaveLength(1);
    expect(getStats().counts.agent_runs).toBe(1);
    expect(getStats().counts.agent_messages).toBe(1);
    expect(getStats().counts.agent_tool_results).toBe(1);
  });

  it('maps a metrics turn into a finished agent run with a metric message', () => {
    const store = new AgentRunStore({ logger: null });
    const run = store.recordMetricTurn({
      ts: '2026-05-25T12:00:00.000Z',
      roomId: 'room-metrics',
      sessionId: 'session-metrics',
      taskId: 'task-metrics',
      turn: 'turn-1',
      adapter: 'codex',
      model: 'gpt-5.4',
      success: true,
      latencyMs: 1234,
      tokensIn: 100,
      tokensOut: 40,
      estCostUSD: 0.01,
      agentProfileId: 'xike-verifier',
      agentProfileTitle: 'Xike Verifier',
      agentDispatchTags: ['verification'],
      agentSkillNames: ['qa'],
      agentGovernance: { budgetScope: 'agent_profile' },
    });

    expect(run).toMatchObject({
      status: 'succeeded',
      sourceType: 'metric_turn',
      agentProfileId: 'xike-verifier',
      adapterId: 'codex',
    });
    const timeline = store.getTimeline(run.id);
    expect(timeline.messages).toHaveLength(1);
    expect(timeline.messages[0]).toMatchObject({
      kind: 'metric',
      status: 'succeeded',
      payload: { tokensIn: 100, tokensOut: 40, estCostUSD: 0.01 },
    });
  });
});
