import { describe, expect, it } from 'vitest';
import { makeDelegationAutostartHandler } from '../../src/autopilot/DelegationAutostart.js';

function makeDelegation() {
  return {
    id: 'delegation-1',
    status: 'queued',
    sourceRoomId: 'room-source',
    sourceTaskId: 'task-source',
    targetMode: 'debate',
    title: 'Autostart target',
    instructions: 'Run this delegated task',
    objectiveId: 'obj-1',
    payload: {},
  };
}

describe('Delegation Autostart handler', () => {
  it('defers while approval is pending', async () => {
    const delegation = makeDelegation();
    const handler = makeDelegationAutostartHandler({
      delegationStore: { get: () => delegation },
      approvalStore: {
        getApproval: () => ({ id: 'approval-1', status: 'pending' }),
      },
      budgetStore: { preflight: () => ({ ok: true }) },
      roomStore: { get: () => ({ id: 'room-source', name: 'Source room', cwd: '/tmp/project' }) },
      roomAdapterPool: { has: () => true },
      safeResolveFsPath: (p) => p,
      startRoom: async () => ({ started: true }),
      agentRunStore: {
        transition(id, status, details) {
          expect(id).toBe('agent-run-1');
          expect(status).toBe('deferred');
          expect(details).toMatchObject({
            deferReason: 'approval_pending',
            approvalId: 'approval-1',
            delegationId: 'delegation-1',
            jobId: 'job-1',
          });
        },
      },
      now: () => 1_000,
      gatePollMs: 5_000,
    });

    const result = await handler({
      id: 'job-1',
      targetId: 'delegation-1',
      payload: { approvalId: 'approval-1', agentRunId: 'agent-run-1' },
    });

    expect(result).toMatchObject({
      __defer: true,
      runAfter: 6_000,
      reason: 'approval_pending',
      result: { approvalId: 'approval-1' },
    });
  });

  it('executes the delegation and starts the target room after approval and budget gates pass', async () => {
    const delegation = makeDelegation();
    const rooms = new Map([
      ['room-source', { id: 'room-source', name: 'Source room', cwd: '/tmp/project', objective: { title: 'Source goal' }, topic: 'Source topic' }],
    ]);
    const delegations = new Map([[delegation.id, delegation]]);
    const started = [];
    const runTransitions = [];
    const handler = makeDelegationAutostartHandler({
      delegationStore: {
        get: (id) => delegations.get(id),
        markCreated: (id, { targetRoomId }) => {
          const next = { ...delegations.get(id), status: 'created', targetRoomId };
          delegations.set(id, next);
          return next;
        },
      },
      approvalStore: {
        getApproval: () => ({ id: 'approval-1', status: 'approved' }),
      },
      budgetStore: { preflight: () => ({ ok: true }) },
      roomStore: {
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
      },
      roomAdapterPool: { has: () => true },
      safeResolveFsPath: (p) => p,
      startRoom: async ({ room, job }) => {
        started.push({ roomId: room.id, jobId: job.id });
        return { started: true, roomId: room.id };
      },
      agentRunStore: {
        transition(id, status, details) {
          runTransitions.push({ id, status, details });
        },
      },
    });

    const result = await handler({
      id: 'job-1',
      targetId: 'delegation-1',
      taskId: 'task-source',
      payload: { approvalId: 'approval-1', agentRunId: 'agent-run-1', autoStart: true, budgetEstimate: { estimateCalls: 1 } },
    });

    expect(result.ok).toBe(true);
    expect(result.started).toBe(true);
    expect(result.agentRunId).toBe('agent-run-1');
    expect(result.delegation).toMatchObject({ status: 'created', targetRoomId: 'room-target' });
    expect(rooms.get('room-target').lineage).toMatchObject({
      parentRoomId: 'room-source',
      parentTaskId: 'task-source',
      source: 'delegation',
    });
    expect(started).toEqual([{ roomId: 'room-target', jobId: 'job-1' }]);
    expect(runTransitions).toEqual([expect.objectContaining({
      id: 'agent-run-1',
      status: 'succeeded',
      details: expect.objectContaining({
        approvalId: 'approval-1',
        delegationId: 'delegation-1',
        jobId: 'job-1',
        targetRoomId: 'room-target',
        started: true,
      }),
    })]);
  });
});
