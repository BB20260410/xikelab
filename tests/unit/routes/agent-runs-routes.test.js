import { describe, expect, it } from 'vitest';
import { registerAgentRunRoutes } from '../../../src/server/routes/agentRuns.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) {
    app[method] = (path, ...handlers) => {
      routes.push({ method, path, handlers });
    };
  }
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
    setHeader(name, value) { this.headers = { ...(this.headers || {}), [name]: value }; return this; },
    send(body) { this.payload = body; return this; },
  };
}

describe('agent run routes', () => {
  it('registers run list, create, timeline, message, tool result, and transition endpoints', () => {
    const run = { id: 'run-1', status: 'queued', roomId: 'room-1' };
    const message = { id: 'msg-1', runId: 'run-1', kind: 'summary' };
    const toolResult = { id: 'tool-1', runId: 'run-1', toolName: 'npm test' };
    const agentRunStore = {
      list(query) {
        expect(query).toMatchObject({
          roomId: 'room-1',
          agentProfileId: 'xike-builder',
          approvalId: 'approval-1',
        });
        return [run];
      },
      create(input) {
        expect(input).toMatchObject({ roomId: 'room-1', agentProfileId: 'xike-builder', actorType: 'user' });
        return run;
      },
      getTimeline(id) {
        expect(id).toBe('run-1');
        return { run, messages: [message], toolResults: [toolResult] };
      },
      exportRun(id, options) {
        expect(id).toBe('run-1');
        if (options.format === 'markdown') return '# Agent Run run-1';
        return { run, messages: [message], toolResults: [toolResult], activityEvents: [] };
      },
      appendMessage(id, input) {
        expect(id).toBe('run-1');
        expect(input.kind).toBe('summary');
        return message;
      },
      appendToolResult(id, input) {
        expect(id).toBe('run-1');
        expect(input.toolName).toBe('npm test');
        return toolResult;
      },
      transition(id, status, details) {
        expect(id).toBe('run-1');
        expect(status).toBe('succeeded');
        expect(details).toMatchObject({ verified: true });
        return { ...run, status };
      },
    };
    const { app, routes } = makeApp();
    registerAgentRunRoutes(app, { agentRunStore });

    const listRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs')
      .handlers[1]({ query: { roomId: 'room-1', agentProfileId: 'xike-builder', approvalId: 'approval-1' } }, listRes);
    expect(listRes.payload).toEqual({ ok: true, runs: [run] });

    const createRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs')
      .handlers[1]({ body: { roomId: 'room-1', agentProfileId: 'xike-builder' } }, createRes);
    expect(createRes.statusCode).toBe(201);
    expect(createRes.payload.run).toBe(run);

    const getRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/:id')
      .handlers[1]({ params: { id: 'run-1' } }, getRes);
    expect(getRes.payload).toMatchObject({ ok: true, run, messages: [message], toolResults: [toolResult] });

    const exportJsonRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/:id/export')
      .handlers[1]({ params: { id: 'run-1' }, query: { format: 'json' } }, exportJsonRes);
    expect(exportJsonRes.payload).toMatchObject({ ok: true, export: { run } });

    const exportMarkdownRes = makeRes();
    routes.find((route) => route.method === 'get' && route.path === '/api/agent-runs/:id/export')
      .handlers[1]({ params: { id: 'run-1' }, query: { format: 'markdown' } }, exportMarkdownRes);
    expect(exportMarkdownRes.headers['Content-Type']).toBe('text/markdown; charset=utf-8');
    expect(exportMarkdownRes.payload).toBe('# Agent Run run-1');

    const msgRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/messages')
      .handlers[1]({ params: { id: 'run-1' }, body: { kind: 'summary' } }, msgRes);
    expect(msgRes.statusCode).toBe(201);
    expect(msgRes.payload.message).toBe(message);

    const toolRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/tool-results')
      .handlers[1]({ params: { id: 'run-1' }, body: { toolName: 'npm test' } }, toolRes);
    expect(toolRes.statusCode).toBe(201);
    expect(toolRes.payload.toolResult).toBe(toolResult);

    const transitionRes = makeRes();
    routes.find((route) => route.method === 'post' && route.path === '/api/agent-runs/:id/transition')
      .handlers[1]({ params: { id: 'run-1' }, body: { status: 'succeeded', details: { verified: true } } }, transitionRes);
    expect(transitionRes.payload.run).toMatchObject({ status: 'succeeded' });
  });
});
