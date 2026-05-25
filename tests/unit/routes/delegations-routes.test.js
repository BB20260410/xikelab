import { describe, expect, it } from 'vitest';
import { buildDelegatedTopic, registerDelegationRoutes } from '../../../src/server/routes/delegations.js';

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
  };
}

describe('delegation routes', () => {
  it('builds a delegated topic with source lineage context', () => {
    const topic = buildDelegatedTopic({
      delegation: {
        title: 'Implement budget UI',
        sourceRoomId: 'room-1',
        sourceTaskId: 'task-1',
        instructions: 'Add the UI and tests',
      },
      sourceRoom: {
        id: 'room-1',
        name: 'Source room',
        objective: { title: 'Ship budget controls' },
        topic: 'Original task',
      },
    });

    expect(topic).toContain('Implement budget UI');
    expect(topic).toContain('room-1');
    expect(topic).toContain('task-1');
    expect(topic).toContain('Original task');
  });

  it('creates and executes a delegation into a target room', () => {
    const sourceRoom = {
      id: 'room-1',
      name: 'Source room',
      cwd: '/tmp/project',
      objective: { title: 'Source objective', acceptanceCriteria: ['done'] },
      lineage: { taskId: 'source-task' },
      topic: 'Source topic',
    };
    const rooms = new Map([[sourceRoom.id, sourceRoom]]);
    const roomStore = {
      get: (id) => rooms.get(id),
      create: (input) => {
        const room = { id: 'room-target', ...input };
        rooms.set(room.id, room);
        return room;
      },
      update: (id, patch) => {
        const next = { ...rooms.get(id), ...patch };
        rooms.set(id, next);
        return next;
      },
    };
    const delegations = new Map();
    const delegationStore = {
      list: () => [...delegations.values()],
      create: (input) => {
        const item = {
          id: 'delegation-1',
          status: 'queued',
          objectiveId: 'obj-delegation',
          targetMode: input.targetMode,
          title: input.title,
          instructions: input.instructions,
          sourceRoomId: input.sourceRoomId,
          sourceTaskId: input.sourceTaskId,
          payload: input.payload || {},
        };
        delegations.set(item.id, item);
        return item;
      },
      get: (id) => delegations.get(id),
      markCreated: (id, { targetRoomId }) => {
        const item = { ...delegations.get(id), status: 'created', targetRoomId };
        delegations.set(id, item);
        return item;
      },
      markFailed: (id, error) => {
        const item = { ...delegations.get(id), status: 'failed', error };
        delegations.set(id, item);
        return item;
      },
      cancel: (id) => {
        const item = { ...delegations.get(id), status: 'cancelled' };
        delegations.set(id, item);
        return item;
      },
    };
    const { app, routes } = makeApp();
    registerDelegationRoutes(app, {
      delegationStore,
      roomStore,
      roomAdapterPool: { has: () => true },
      safeResolveFsPath: (p) => p,
    });

    const createRoute = routes.find(r => r.method === 'post' && r.path === '/api/delegations');
    const createRes = makeRes();
    createRoute.handlers[1]({
      body: {
        sourceRoomId: 'room-1',
        targetMode: 'debate',
        title: 'Delegated implementation',
        instructions: 'Build it',
      },
    }, createRes);

    expect(createRes.statusCode).toBe(200);
    expect(createRes.payload.delegation.id).toBe('delegation-1');

    const executeRoute = routes.find(r => r.method === 'post' && r.path === '/api/delegations/:id/execute');
    const executeRes = makeRes();
    executeRoute.handlers[1]({ params: { id: 'delegation-1' }, body: {} }, executeRes);

    expect(executeRes.statusCode).toBe(200);
    expect(executeRes.payload.delegation).toMatchObject({ status: 'created', targetRoomId: 'room-target' });
    expect(executeRes.payload.room.lineage).toMatchObject({
      parentRoomId: 'room-1',
      parentTaskId: 'source-task',
      source: 'delegation',
    });
    expect(executeRes.payload.room.topic).toContain('Build it');
  });

  it('queues a delegation autostart job with a manual approval gate', () => {
    const sourceRoom = {
      id: 'room-1',
      name: 'Source room',
      cwd: '/tmp/project',
      objective: { title: 'Source objective' },
      lineage: { taskId: 'source-task' },
    };
    const rooms = new Map([[sourceRoom.id, sourceRoom]]);
    const roomStore = { get: (id) => rooms.get(id) };
    const delegation = {
      id: 'delegation-1',
      status: 'queued',
      sourceRoomId: 'room-1',
      sourceTaskId: 'source-task',
      targetMode: 'debate',
      title: 'Autostart me',
      instructions: 'Run through gates',
    };
    const approval = { id: 'approval-1', status: 'pending' };
    const job = { id: 'job-1', action: 'start_delegation', targetId: 'delegation-1' };
    const agentRun = { id: 'agent-run-delegation-delegation-1', status: 'queued' };
    const delegationStore = {
      get: () => delegation,
      list: () => [delegation],
      attachAgentRun(id, patch) {
        expect(id).toBe('delegation-1');
        expect(patch).toMatchObject({
          agentRunId: 'agent-run-delegation-delegation-1',
          approvalId: 'approval-1',
          jobId: 'job-1',
        });
        return { ...delegation, payload: patch };
      },
    };
    const approvalStore = {
      createApproval(input) {
        expect(input.dedupeKey).toBe('delegation-autostart-approval:delegation-1');
        expect(input.payload.delegationId).toBe('delegation-1');
        expect(input.payload.agentRunId).toBe('agent-run-delegation-delegation-1');
        return approval;
      },
    };
    const scheduleStore = {
      enqueueJob(input) {
        expect(input.action).toBe('start_delegation');
        expect(input.dedupeKey).toBe('delegation-autostart:delegation-1');
        expect(input.payload).toMatchObject({
          delegationId: 'delegation-1',
          agentRunId: 'agent-run-delegation-delegation-1',
          approvalId: 'approval-1',
          requireApproval: true,
          autoStart: true,
        });
        return job;
      },
    };
    const agentRunStore = {
      create(input) {
        expect(input).toMatchObject({
          id: 'agent-run-delegation-delegation-1',
          status: 'queued',
          roomId: 'room-1',
          taskId: 'source-task',
          approvalId: 'approval-1',
          delegationId: 'delegation-1',
          agentProfileId: 'xike-chief',
          sourceType: 'delegation_autostart',
          sourceId: 'delegation-1',
          dispatchTags: ['governance'],
        });
        expect(input.details).toMatchObject({ approvalId: 'approval-1', jobId: 'job-1' });
        return agentRun;
      },
    };
    const { app, routes } = makeApp();
    registerDelegationRoutes(app, { delegationStore, approvalStore, scheduleStore, agentRunStore, roomStore });

    const route = routes.find(r => r.method === 'post' && r.path === '/api/delegations/:id/autostart');
    const res = makeRes();
    route.handlers[1]({
      params: { id: 'delegation-1' },
      body: { budgetEstimate: { estimateCalls: 1 } },
    }, res);

    expect(res.statusCode).toBe(201);
    expect(res.payload).toEqual({ ok: true, job, approval, agentRun });
  });
});
