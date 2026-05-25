import { agentRunStore } from './AgentRunStore.js';

function safeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error || 'error'),
    code: error?.code || null,
  };
}

export class AgentRunLifecycle {
  constructor({ store = agentRunStore, logger = console } = {}) {
    this.store = store;
    this.logger = logger;
  }

  startRun({ adapter, messages = [], opts = {} } = {}) {
    if (!this.store || opts.skipAgentRun) return null;
    const budget = opts.budgetContext || {};
    const run = this.store.create({
      id: opts.agentRunId,
      status: 'running',
      roomId: budget.roomId,
      sessionId: budget.sessionId,
      taskId: budget.taskId,
      agentProfileId: budget.agentProfileId,
      adapterId: budget.adapterId || adapter?.id,
      modelId: opts.model || adapter?.model,
      sourceType: 'adapter_chat',
      sourceId: `${budget.roomId || 'room'}:${budget.taskId || opts.model || adapter?.id || 'turn'}`,
      details: {
        cwd: opts.cwd || null,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        estimateTokens: typeof adapter?._countTokens === 'function' ? adapter._countTokens(messages) : 0,
      },
    });
    opts.agentRunId = run.id;
    return run;
  }

  appendDecision(runId, payload = {}) {
    if (!runId || !this.store) return null;
    return this.store.appendMessage(runId, {
      kind: 'decision',
      role: 'system',
      summary: payload.summary || 'Agent run context prepared.',
      payload,
    });
  }

  deferRun(runId, reason, payload = {}) {
    if (!runId || !this.store) return null;
    return this.store.transition(runId, 'deferred', { deferReason: reason, reason, ...payload });
  }

  finishRun(runId, result = {}) {
    if (!runId || !this.store) return null;
    return this.store.transition(runId, 'succeeded', {
      tokensIn: result?.tokensIn || 0,
      tokensOut: result?.tokensOut || 0,
      replyLength: typeof result?.reply === 'string' ? result.reply.length : 0,
    });
  }

  failRun(runId, error, payload = {}) {
    if (!runId || !this.store) return null;
    return this.store.transition(runId, 'failed', { ...safeError(error), ...payload });
  }

  cancelRun(runId, error, payload = {}) {
    if (!runId || !this.store) return null;
    return this.store.transition(runId, 'cancelled', { ...safeError(error), ...payload });
  }
}

export const agentRunLifecycle = new AgentRunLifecycle();
