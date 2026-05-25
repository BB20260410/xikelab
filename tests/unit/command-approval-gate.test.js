import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalStore } from '../../src/approval/ApprovalStore.js';
import { TerminalApprovalGate, createDangerousCommandApproval } from '../../src/approval/CommandApprovalGate.js';
import { DangerousPatternDetector } from '../../src/safety/DangerousPatternDetector.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-command-gate-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('CommandApprovalGate', () => {
  it('creates approvals for commands that DangerousPatternDetector blocks', () => {
    const approvalStore = new ApprovalStore();
    const result = createDangerousCommandApproval({
      command: 'git push origin main',
      detector: new DangerousPatternDetector(),
      approvalStore,
      source: 'terminal',
      requesterType: 'terminal',
      requesterId: 'term-1',
    });

    expect(result.requiresApproval).toBe(true);
    expect(result.approval).toMatchObject({
      type: 'dangerous_command',
      status: 'pending',
      requesterType: 'terminal',
      requesterId: 'term-1',
    });
    expect(result.approval.payload.command).toBe('git push origin main');
  });

  it('blocks terminal enter and returns ctrl-c replacement for dangerous buffered command', () => {
    const approvalStore = new ApprovalStore();
    const gate = new TerminalApprovalGate({ approvalStore });
    const state = {};

    expect(gate.processInput(state, 'r', { requesterId: 'term-1' }).allowed).toBe(true);
    expect(gate.processInput(state, 'm -rf /', { requesterId: 'term-1' }).allowed).toBe(true);
    const blocked = gate.processInput(state, '\r', { requesterId: 'term-1', cwd: '/tmp/project' });

    expect(blocked.allowed).toBe(false);
    expect(blocked.data).toBe('\u0003');
    expect(blocked.command).toBe('rm -rf /');
    expect(blocked.approval.status).toBe('pending');
    expect(state.approvalInputBuffer).toBe('');
  });

  it('allows safe terminal commands', () => {
    const gate = new TerminalApprovalGate({ approvalStore: new ApprovalStore() });
    const state = {};
    expect(gate.processInput(state, 'ls -la', { requesterId: 'term-1' }).allowed).toBe(true);
    expect(gate.processInput(state, '\r', { requesterId: 'term-1' })).toMatchObject({
      allowed: true,
      command: 'ls -la',
    });
  });
});
