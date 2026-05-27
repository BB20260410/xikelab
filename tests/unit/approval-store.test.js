import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalStore } from '../../src/approval/ApprovalStore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-approval-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('ApprovalStore', () => {
  it('creates, dedupes, approves, and rejects dangerous command approvals', () => {
    const store = new ApprovalStore();
    const first = store.createDangerousCommandApproval({
      command: 'rm -rf /',
      source: 'terminal',
      cwd: '/tmp/project',
      requesterType: 'terminal',
      requesterId: 'term-1',
      hits: [{ severity: 'critical', category: '删除系统/家目录' }],
      worstSeverity: 'critical',
    });
    const second = store.createDangerousCommandApproval({
      command: 'rm -rf /',
      source: 'terminal',
      cwd: '/tmp/project',
      requesterType: 'terminal',
      requesterId: 'term-1',
    });
    expect(second.id).toBe(first.id);
    expect(store.listApprovals({ status: 'pending' })).toHaveLength(1);

    const approved = store.approve(first.id, { decisionBy: 'owner', reason: 'manual test' });
    expect(approved.status).toBe('approved');
    expect(approved.decisionBy).toBe('owner');

    const rejected = store.createDangerousCommandApproval({
      command: 'git push origin main',
      source: 'claude_bash',
      requesterType: 'session',
      requesterId: 'session-1',
    });
    expect(store.reject(rejected.id, { decisionBy: 'owner' }).status).toBe('rejected');
  });

  it('finds the latest approval by dedupe key after it is decided', () => {
    const store = new ApprovalStore();
    const approval = store.createApproval({
      type: 'manual',
      requesterType: 'autopilot',
      requesterId: 'job-1',
      dedupeKey: 'delegation-autostart-approval:delegation-1',
      payload: { title: 'Start delegation' },
    });
    store.approve(approval.id, { decisionBy: 'owner' });

    expect(store.getLatestByDedupeKey('delegation-autostart-approval:delegation-1')).toMatchObject({
      id: approval.id,
      status: 'approved',
    });
  });

  it('fires decisionHook on terminal decision and swallows hook errors (C2)', () => {
    const store = new ApprovalStore();
    const mk = (id) => store.createApproval({ type: 'manual', requesterType: 'session', requesterId: id, payload: { title: id } });

    const calls = [];
    store.setDecisionHook((id, payload) => { calls.push({ id, payload }); });
    const a1 = mk('c2-a1');
    const approved = store.approve(a1.id, { decisionBy: 'owner' });
    expect(approved.status).toBe('approved');
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe(a1.id);
    expect(calls[0].payload).toMatchObject({ status: 'approved' });
    expect(calls[0].payload.approval.id).toBe(a1.id);

    // 抛错的 hook 不应阻断决议
    store.setDecisionHook(() => { throw new Error('hook boom'); });
    const a2 = mk('c2-a2');
    expect(store.reject(a2.id, { decisionBy: 'owner' }).status).toBe('rejected');

    // 传 null 清除 hook
    store.setDecisionHook(null);
    const a3 = mk('c2-a3');
    expect(() => store.approve(a3.id, { decisionBy: 'owner' })).not.toThrow();
  });
});
