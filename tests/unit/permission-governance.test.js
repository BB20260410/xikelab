import { describe, expect, it } from 'vitest';
import { PermissionGovernance, evaluatePermission } from '../../src/permissions/PermissionGovernance.js';

function makeGovernance() {
  const approvals = [];
  const auditEvents = [];
  const runMessages = [];
  const governance = new PermissionGovernance({
    approvalStore: {
      createApproval(input) {
        const approval = { id: `approval-${approvals.length + 1}`, status: 'pending', ...input };
        approvals.push(approval);
        return approval;
      },
    },
    audit: {
      recordSafe(input) {
        auditEvents.push(input);
        return input;
      },
    },
    agentRuns: {
      appendMessage(runId, message) {
        runMessages.push({ runId, message });
        return { id: `message-${runMessages.length}`, ...message };
      },
    },
  });
  return { governance, approvals, auditEvents, runMessages };
}

describe('PermissionGovernance', () => {
  it('asks for approval on dangerous shell commands and records audit plus agent run evidence', () => {
    const { governance, approvals, auditEvents, runMessages } = makeGovernance();

    const decision = governance.evaluatePermission({
      actorType: 'session',
      actorId: 'session-1',
      agentRunId: 'run-1',
      sessionId: 'session-1',
      action: 'shell.exec',
      cwd: '/tmp/project',
      target: { toolName: 'Bash', command: 'rm -rf /', guardLevel: 'standard' },
      details: { source: 'claude_tool_use' },
    });

    expect(decision).toMatchObject({
      decision: 'ask',
      action: 'shell.exec',
      risk: 'critical',
      approval: { id: 'approval-1', type: 'manual', status: 'pending' },
    });
    expect(decision.approvalPayload.details.classification.hits[0].rule.category).toBe('删除系统/家目录');
    expect(approvals).toHaveLength(1);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: 'permission.decision',
        entityType: 'permission_decision',
        status: 'ask',
      }),
    ]);
    expect(runMessages).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        message: expect.objectContaining({
          kind: 'decision',
          status: 'ask',
          payload: expect.objectContaining({ approvalId: 'approval-1' }),
        }),
      }),
    ]);
  });

  it('asks before writing outside cwd and before sensitive file writes', () => {
    const { governance } = makeGovernance();

    expect(governance.evaluatePermission({
      action: 'file.write',
      cwd: '/tmp/project',
      target: { path: '../outside.txt' },
    })).toMatchObject({
      decision: 'ask',
      reason: 'external directory file write/delete requires approval',
    });

    expect(governance.evaluatePermission({
      action: 'file.write',
      cwd: '/tmp/project',
      target: { path: '.env.local' },
    })).toMatchObject({
      decision: 'ask',
      reason: 'sensitive file write/delete requires approval',
    });
  });

  it('denies sensitive external directories and private network uploads', () => {
    const { governance, approvals } = makeGovernance();

    expect(governance.evaluatePermission({
      action: 'external_directory.access',
      cwd: '/tmp/project',
      target: { path: '/Users/hxx/.ssh' },
    })).toMatchObject({
      decision: 'deny',
      risk: 'critical',
    });

    expect(governance.evaluatePermission({
      action: 'network.upload',
      target: { url: 'http://localhost:8080/hook' },
    })).toMatchObject({
      decision: 'deny',
      reason: 'network upload to private/loopback host denied',
    });
    expect(governance.evaluatePermission({
      action: 'external_directory.access',
      cwd: '/tmp/project',
      target: { path: '.env.local' },
    })).toMatchObject({
      decision: 'ask',
      reason: 'sensitive file access requires approval',
    });
    expect(approvals).toHaveLength(1);
  });

  it('requires approval for plugin execution, provider config writes, and public uploads', () => {
    const { governance, approvals } = makeGovernance();

    expect(governance.evaluatePermission({
      action: 'skill.plugin.execute',
      target: { pluginId: 'demo', commandId: 'run' },
    }).decision).toBe('ask');
    expect(governance.evaluatePermission({
      action: 'provider.model_config.write',
      target: { section: 'watcher' },
    }).decision).toBe('ask');
    expect(governance.evaluatePermission({
      action: 'network.upload',
      target: { url: 'https://example.com/webhook' },
    }).decision).toBe('ask');
    expect(approvals).toHaveLength(3);
  });

  it('allows low-risk auto-accept scope through the helper', () => {
    const decision = evaluatePermission({
      action: 'auto_accept.scope',
      risk: 'low',
      target: { scope: 'read_only' },
    }, {
      approvalStore: { createApproval() { throw new Error('approval should not be created'); } },
      audit: { recordSafe() {} },
      agentRuns: { appendMessage() {} },
    });

    expect(decision).toMatchObject({
      decision: 'allow',
      reason: 'low-risk auto-accept scope allowed',
    });
  });
});
