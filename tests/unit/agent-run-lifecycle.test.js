import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRunLifecycle } from '../../src/agents/AgentRunLifecycle.js';
import { AgentRunStore } from '../../src/agents/AgentRunStore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-agent-run-lifecycle-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('AgentRunLifecycle', () => {
  it('tracks start, decision, defer, finish, fail, and cancel transitions', () => {
    const store = new AgentRunStore({ logger: null });
    const lifecycle = new AgentRunLifecycle({ store, logger: null });
    const opts = {
      cwd: '/tmp/project',
      model: 'test-model',
      budgetContext: {
        roomId: 'room-1',
        sessionId: 'session-1',
        taskId: 'task-1',
        adapterId: 'codex',
        agentProfileId: 'xike-builder',
      },
    };
    const adapter = { id: 'codex', model: 'fallback', _countTokens: () => 42 };
    const run = lifecycle.startRun({ adapter, messages: [{ role: 'user', content: 'build' }], opts });

    expect(run).toMatchObject({
      status: 'running',
      roomId: 'room-1',
      agentProfileId: 'xike-builder',
      adapterId: 'codex',
      modelId: 'test-model',
    });
    expect(opts.agentRunId).toBe(run.id);

    lifecycle.appendDecision(run.id, { summary: 'Prepared prompt context.', reason: 'dispatch' });
    expect(store.getTimeline(run.id).messages[0]).toMatchObject({ kind: 'decision' });

    const deferred = lifecycle.deferRun(run.id, 'approval_pending', { approvalId: 'approval-1' });
    expect(deferred).toMatchObject({
      status: 'deferred',
      deferReason: 'approval_pending',
      approvalId: 'approval-1',
    });

    const finished = lifecycle.finishRun(run.id, { tokensIn: 10, tokensOut: 5, reply: 'ok' });
    expect(finished).toMatchObject({ status: 'succeeded' });
    expect(finished.details).toMatchObject({ tokensIn: 10, tokensOut: 5, replyLength: 2 });

    const failed = lifecycle.failRun(run.id, new Error('adapter failed'));
    expect(failed).toMatchObject({ status: 'failed', error: 'adapter failed' });

    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const cancelled = lifecycle.cancelRun(run.id, abortError);
    expect(cancelled).toMatchObject({ status: 'cancelled' });
  });
});
