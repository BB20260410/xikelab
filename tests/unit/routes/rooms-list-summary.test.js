import { describe, it, expect } from 'vitest';
import { registerRoomsRoutes, summarizeRoom } from '../../../src/server/routes/rooms.js';

function makeRoom(overrides = {}) {
  return {
    id: 'room-1',
    name: 'Heavy room',
    mode: 'squad',
    status: 'done',
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:10:00.000Z',
    cwd: '/tmp/project',
    members: [
      { adapterId: 'claude', displayName: 'Claude', model: 'sonnet', role: 'pm', agentProfileId: 'xike-chief', enabled: true, token: 'drop-me' },
      { adapterId: 'codex', displayName: 'Codex', enabled: false },
    ],
    topic: 'important topic',
    debateRounds: 2,
    qaStrictness: 'standard',
    currentRound: -1,
    currentMacroRound: 2,
    finalConsensus: 'large final consensus should not be listed',
    userInterventions: [{ at: '2026-05-24T00:05:00.000Z', content: 'note' }],
    rounds: [
      { kind: 'r1_propose', turns: [{ speaker: 'claude', content: 'SECRET_TURN_CONTENT' }] },
      { kind: 'r2_critique', turns: [{ speaker: 'codex', content: 'MORE_SECRET_TURN_CONTENT' }] },
    ],
    taskList: [{ id: 't1', title: 'Task', attempts: [{ content: 'SECRET_ATTEMPT_CONTENT' }] }],
    conversation: [{ from: 'user', content: 'SECRET_CHAT_CONTENT' }],
    archived: false,
    archivedAt: null,
    objective: {
      id: 'obj-1',
      title: 'Ship ActivityLog',
      description: 'Make activity auditable',
      acceptanceCriteria: ['events are searchable'],
      status: 'active',
    },
    lineage: {
      projectId: '/tmp/project',
      parentRoomId: 'room-parent',
      parentTaskId: 'task-parent',
      taskId: 'task-1',
      objectiveId: 'obj-1',
      source: 'manual',
    },
    roleCards: [
      { memberId: 'claude', displayName: 'Claude', role: 'pm', title: 'PM', reportTo: null, scope: ['task_split'] },
      { memberId: 'codex', displayName: 'Codex', role: 'dev', title: 'DEV', reportTo: 'pm', scope: ['implementation'] },
    ],
    projectContextSummary: {
      fileCount: 1,
      totalChars: 42,
      truncated: false,
      files: [{ name: 'AGENTS.md', path: '/tmp/project/AGENTS.md', includedChars: 42, truncated: false }],
    },
    ...overrides,
  };
}

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'delete', 'patch']) {
    app[method] = (path, ...handlers) => {
      routes.push({ method, path, handlers });
    };
  }
  return { app, routes };
}

function makeDeps(roomStore) {
  const noopDispatcher = { abort() {} };
  return {
    roomStore,
    safeResolveFsPath: () => '/tmp/project',
    safeSlice: (value, limit) => String(value).slice(0, limit),
    roomAdapterPool: { has: () => true, get: () => null },
    debateDispatcher: noopDispatcher,
    squadDispatcher: noopDispatcher,
    arenaDispatcher: noopDispatcher,
    soloChatDispatcher: noopDispatcher,
    roomWsClients: new Map(),
    skillStore: {
      list: () => [
        { name: 'qa', enabled: true },
        { name: 'browse', enabled: true },
        { name: 'disabled-skill', enabled: false },
      ],
    },
    MAX_ROOMS: 500,
  };
}

function runFirstJsonHandler(route, query = {}) {
  let statusCode = 200;
  let payload;
  const req = { query, params: {}, body: {} };
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
  };
  route.handlers[0](req, res);
  return { statusCode, payload };
}

describe('rooms list summary', () => {
  it('summarizeRoom keeps list metadata and strips heavy room bodies', () => {
    const summary = summarizeRoom(makeRoom());
    expect(summary.id).toBe('room-1');
    expect(summary.members).toEqual([
      { adapterId: 'claude', displayName: 'Claude', model: 'sonnet', role: 'pm', agentProfileId: 'xike-chief', enabled: true },
      { adapterId: 'codex', displayName: 'Codex', model: '', role: undefined, enabled: false },
    ]);
    expect(summary.roundCount).toBe(2);
    expect(summary.turnCount).toBe(2);
    expect(summary.taskCount).toBe(1);
    expect(summary.conversationCount).toBe(1);
    expect(summary.userInterventionCount).toBe(1);
    expect(summary.hasFinalConsensus).toBe(true);
    expect(summary.objective).toEqual({ id: 'obj-1', title: 'Ship ActivityLog', status: 'active', acceptanceCount: 1 });
    expect(summary.lineage).toMatchObject({ projectId: '/tmp/project', parentRoomId: 'room-parent', taskId: 'task-1', objectiveId: 'obj-1' });
    expect(summary.roleCards).toHaveLength(2);
    expect(summary.roleCards[1]).toMatchObject({ memberId: 'codex', role: 'dev', reportTo: 'pm' });
    expect(summary.projectContext).toMatchObject({ fileCount: 1, totalChars: 42 });
    const json = JSON.stringify(summary);
    expect(json).not.toContain('SECRET_TURN_CONTENT');
    expect(json).not.toContain('SECRET_CHAT_CONTENT');
    expect(json).not.toContain('SECRET_ATTEMPT_CONTENT');
    expect(json).not.toContain('large final consensus');
    expect(json).not.toContain('drop-me');
  });

  it('GET /api/rooms defaults to compact summaries', () => {
    const activeRoom = makeRoom();
    const archivedRoom = makeRoom({ id: 'room-archived', archived: true, archivedAt: '2026-05-24T01:00:00.000Z' });
    const roomStore = {
      list: () => [activeRoom],
      listArchived: () => [archivedRoom],
      get: () => null,
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));

    const listRoute = routes.find((route) => route.method === 'get' && route.path === '/api/rooms');
    const { statusCode, payload } = runFirstJsonHandler(listRoute);

    expect(statusCode).toBe(200);
    expect(payload.compact).toBe(true);
    expect(payload.rooms).toHaveLength(1);
    expect(payload.rooms[0].rounds).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('SECRET_TURN_CONTENT');
  });

  it('GET /api/rooms?full=1 preserves the legacy full payload path', () => {
    const activeRoom = makeRoom();
    const roomStore = {
      list: () => [activeRoom],
      listArchived: () => [],
      get: () => null,
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));

    const listRoute = routes.find((route) => route.method === 'get' && route.path === '/api/rooms');
    const { payload } = runFirstJsonHandler(listRoute, { full: '1' });

    expect(payload.compact).toBe(false);
    expect(payload.rooms[0].rounds[0].turns[0].content).toBe('SECRET_TURN_CONTENT');
  });

  it('/api/rooms/search is registered before /api/rooms/:id', () => {
    const roomStore = {
      list: () => [],
      listArchived: () => [],
      get: () => null,
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));

    const paths = routes.filter((route) => route.method === 'get').map((route) => route.path);
    expect(paths.indexOf('/api/rooms/search')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/api/rooms/search')).toBeLessThan(paths.indexOf('/api/rooms/:id'));
  });

  it('/api/rooms/search finds objective metadata', () => {
    const roomStore = {
      list: () => [makeRoom()],
      listArchived: () => [],
      get: () => null,
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));

    const searchRoute = routes.find((route) => route.method === 'get' && route.path === '/api/rooms/search');
    const { statusCode, payload } = runFirstJsonHandler({ ...searchRoute, handlers: [searchRoute.handlers[1]] }, { q: 'ActivityLog' });

    expect(statusCode).toBe(200);
    expect(payload.count).toBe(1);
    expect(payload.hits[0].where).toBe('objective:title');
  });

  it('PATCH /api/rooms/:id keeps lineage objectiveId aligned with updated objective', () => {
    const room = makeRoom();
    let updated;
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: (_id, patch) => {
        updated = { ...room, ...patch };
        return updated;
      },
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));
    const patchRoute = routes.find((route) => route.method === 'patch' && route.path === '/api/rooms/:id');
    const req = { params: { id: 'room-1' }, body: { objective: { title: 'New target' } } };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; return this; },
    };

    patchRoute.handlers[1](req, res);

    expect(res.statusCode).toBe(200);
    expect(updated.objective.title).toBe('New target');
    expect(updated.lineage.objectiveId).toBe(updated.objective.id);
  });

  it('PATCH /api/rooms/:id preserves valid member agent profile bindings', () => {
    const room = makeRoom({ mode: 'squad' });
    let updated;
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: (_id, patch) => {
        updated = { ...room, ...patch };
        return updated;
      },
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));
    const patchRoute = routes.find((route) => route.method === 'patch' && route.path === '/api/rooms/:id');
    const req = {
      params: { id: 'room-1' },
      body: {
        members: [
          { adapterId: 'claude', displayName: 'Claude PM', role: 'pm', agentProfileId: 'xike-architect', enabled: true },
          { adapterId: 'codex', displayName: 'Codex QA', role: 'qa', agentProfileId: '', enabled: true },
        ],
      },
    };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; return this; },
    };

    patchRoute.handlers[1](req, res);

    expect(res.statusCode).toBe(200);
    expect(updated.members[0]).toMatchObject({ role: 'pm', agentProfileId: 'xike-architect' });
    expect(updated.members[1].agentProfileId).toBeUndefined();
    expect(updated.roleCards).toHaveLength(2);
  });

  it('PATCH /api/rooms/:id rejects unknown member agent profile ids', () => {
    const room = makeRoom({ mode: 'squad' });
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: () => { throw new Error('should not update'); },
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));
    const patchRoute = routes.find((route) => route.method === 'patch' && route.path === '/api/rooms/:id');
    const req = {
      params: { id: 'room-1' },
      body: {
        members: [
          { adapterId: 'claude', displayName: 'Claude PM', role: 'pm', agentProfileId: 'not-real-profile', enabled: true },
        ],
      },
    };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; return this; },
    };

    patchRoute.handlers[1](req, res);

    expect(res.statusCode).toBe(422);
    expect(res.payload.error).toContain('agentProfileId');
  });

  it('PATCH /api/rooms/:id saves only installed enabled room skills', () => {
    const room = makeRoom();
    let updated;
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: (_id, patch) => {
        updated = { ...room, ...patch };
        return updated;
      },
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));
    const patchRoute = routes.find((route) => route.method === 'patch' && route.path === '/api/rooms/:id');
    const req = { params: { id: 'room-1' }, body: { skills: ['qa', 'browse', 'qa'] } };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; return this; },
    };

    patchRoute.handlers[1](req, res);

    expect(res.statusCode).toBe(200);
    expect(updated.skills).toEqual(['qa', 'browse']);
    expect(res.payload.room.skills).toEqual(['qa', 'browse']);
  });

  it('PATCH /api/rooms/:id rejects unknown or disabled room skills', () => {
    const room = makeRoom();
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: () => { throw new Error('should not update'); },
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));
    const patchRoute = routes.find((route) => route.method === 'patch' && route.path === '/api/rooms/:id');
    const req = { params: { id: 'room-1' }, body: { skills: ['qa', 'disabled-skill'] } };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; return this; },
    };

    patchRoute.handlers[1](req, res);

    expect(res.statusCode).toBe(422);
    expect(res.payload.error).toContain('skills');
  });
});
