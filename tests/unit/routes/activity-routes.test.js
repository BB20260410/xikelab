import { describe, expect, it } from 'vitest';
import { parseActivityQuery, registerActivityRoutes } from '../../../src/server/routes/activity.js';

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
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

describe('activity routes', () => {
  it('normalizes query aliases for activity filtering', () => {
    expect(parseActivityQuery({
      room: 'room-1',
      session: 'session-1',
      tag: 'metrics.recorded',
      agent: 'true',
      runId: 'agent-run-1',
      reviewGateId: 'review-route-1',
      reviewSha256: 'abc123',
      profile: 'xike-verifier',
      skill: 'qa',
      diagnostic: 'too_many_skills',
      limit: '5000',
      order: 'ASC',
    })).toMatchObject({
      roomId: 'room-1',
      sessionId: 'session-1',
      action: 'metrics.recorded',
      agentOnly: true,
      agentRunId: 'agent-run-1',
      approvalResumeGateId: 'review-route-1',
      approvalResumeGateSha256: 'abc123',
      agentProfileId: 'xike-verifier',
      skillName: 'qa',
      diagnosticCode: 'too_many_skills',
      limit: 1000,
      order: 'ASC',
    });
  });

  it('GET /api/activity returns listed audit events', async () => {
    let seenQuery;
    const activityLog = {
      list(query) {
        seenQuery = query;
        return [{ id: 1, action: 'room.created' }];
      },
    };
    const { app, routes } = makeApp();
    registerActivityRoutes(app, { activityLog });
    const route = routes.find((r) => r.method === 'get' && r.path === '/api/activity');
    const res = makeRes();

    await route.handlers[1]({ query: { roomId: 'room-1', action: 'room.created' } }, res);

    expect(seenQuery).toMatchObject({ roomId: 'room-1', action: 'room.created' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true, count: 1, events: [{ id: 1, action: 'room.created' }] });
  });

  it('POST /api/activity rejects missing action and records valid events', async () => {
    const activityLog = {
      record(input) {
        return { id: 2, ...input };
      },
    };
    const { app, routes } = makeApp();
    registerActivityRoutes(app, { activityLog });
    const route = routes.find((r) => r.method === 'post' && r.path === '/api/activity');

    const bad = makeRes();
    await route.handlers[1]({ body: {} }, bad);
    expect(bad.statusCode).toBe(400);

    const good = makeRes();
    await route.handlers[1]({ body: { action: 'manual.note', entityType: 'note' } }, good);
    expect(good.statusCode).toBe(200);
    expect(good.payload.event).toMatchObject({ id: 2, action: 'manual.note', actorType: 'user' });
  });
});
