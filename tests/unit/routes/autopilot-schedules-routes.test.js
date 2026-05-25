import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutopilotScheduleStore } from '../../../src/autopilot/AutopilotScheduleStore.js';
import { registerAutopilotRoutes } from '../../../src/server/routes/autopilot.js';
import { close, initSqlite } from '../../../src/storage/SqliteStore.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
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

const autopilotStore = {
  getConfig() { return { enabled: true, rules: [] }; },
  setEnabled() {},
  isEnabled() { return true; },
  setMaxHops() {},
  upsertRule(rule) { return rule; },
  deleteRule() { return true; },
  recentLogs() { return []; },
};

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-autopilot-routes-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('autopilot schedule routes', () => {
  it('creates, lists, updates, queues, and cancels persistent jobs', async () => {
    const scheduleStore = new AutopilotScheduleStore({ logger: null });
    const { app, routes } = makeApp();
    registerAutopilotRoutes(app, { autopilotStore, scheduleStore });

    const postSchedule = routes.find((r) => r.method === 'post' && r.path === '/api/autopilot/schedules');
    const createRes = makeRes();
    await postSchedule.handlers[1]({
      body: {
        name: 'Route schedule',
        action: 'notify',
        intervalMs: 60_000,
        payload: { message: 'hello' },
      },
    }, createRes);
    expect(createRes.statusCode).toBe(201);
    expect(createRes.payload.schedule.name).toBe('Route schedule');

    const listSchedules = routes.find((r) => r.method === 'get' && r.path === '/api/autopilot/schedules');
    const listRes = makeRes();
    await listSchedules.handlers[0]({ query: {} }, listRes);
    expect(listRes.payload.count).toBe(1);

    const patchSchedule = routes.find((r) => r.method === 'patch' && r.path === '/api/autopilot/schedules/:id');
    const patchRes = makeRes();
    await patchSchedule.handlers[1]({
      params: { id: createRes.payload.schedule.id },
      body: { status: 'paused' },
    }, patchRes);
    expect(patchRes.payload.schedule.status).toBe('paused');

    const queueRoute = routes.find((r) => r.method === 'post' && r.path === '/api/autopilot/schedules/:id/queue');
    const queueRes = makeRes();
    await queueRoute.handlers[1]({
      params: { id: createRes.payload.schedule.id },
      body: { dedupeKey: 'route-job' },
    }, queueRes);
    expect(queueRes.statusCode).toBe(201);
    expect(queueRes.payload.job.scheduleId).toBe(createRes.payload.schedule.id);

    const cancelRoute = routes.find((r) => r.method === 'post' && r.path === '/api/autopilot/jobs/:id/cancel');
    const cancelRes = makeRes();
    await cancelRoute.handlers[1]({
      params: { id: queueRes.payload.job.id },
      body: { reason: 'test cleanup' },
    }, cancelRes);
    expect(cancelRes.payload.job.status).toBe('cancelled');
  });

  it('exposes scheduler tick results', async () => {
    const scheduleStore = new AutopilotScheduleStore({ logger: null });
    const scheduler = {
      async tick(input) {
        return { ok: true, input, enqueued: [{ id: 'job-1' }], executed: [] };
      },
    };
    const { app, routes } = makeApp();
    registerAutopilotRoutes(app, { autopilotStore, scheduleStore, scheduler });

    const tickRoute = routes.find((r) => r.method === 'post' && r.path === '/api/autopilot/tick');
    const res = makeRes();
    await tickRoute.handlers[1]({ body: { limit: 1, force: true } }, res);

    expect(res.payload).toMatchObject({
      ok: true,
      input: { limit: 1, force: true },
      enqueued: [{ id: 'job-1' }],
    });
  });
});
