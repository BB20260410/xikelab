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
      getApproval(id) {
        return approvals.find(a => a.id === id) || null;
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

  it('asks before explicitly approval-gated project-local file writes', () => {
    const { governance, approvals } = makeGovernance();

    const decision = governance.evaluatePermission({
      action: 'file.write',
      cwd: '/tmp/project',
      target: {
        path: '/tmp/project/output/playwright/generated.js',
        relativePath: 'output/playwright/generated.js',
        operation: 'create',
        contentSha256: 'abc123',
        requiresApproval: true,
      },
    });

    expect(decision).toMatchObject({
      decision: 'ask',
      reason: 'file operation requested explicit approval',
      approval: { id: 'approval-1', status: 'pending' },
    });
    approvals[0].status = 'approved';
    expect(governance.evaluatePermission({
      action: 'file.write',
      approvalId: 'approval-1',
      cwd: '/tmp/project',
      target: {
        operation: 'create',
        requiresApproval: true,
        contentSha256: 'abc123',
        relativePath: 'output/playwright/generated.js',
        path: '/tmp/project/output/playwright/generated.js',
      },
    })).toMatchObject({
      decision: 'allow',
      reason: 'approved permission resumed',
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

  it('allows an approved permission to resume only the same action and target', () => {
    const { governance, approvals } = makeGovernance();

    const first = governance.evaluatePermission({
      action: 'network.upload',
      target: { url: 'https://example.com/webhook' },
    });
    expect(first).toMatchObject({ decision: 'ask', approval: { id: 'approval-1' } });
    approvals[0].status = 'approved';

    const resumed = governance.evaluatePermission({
      action: 'network.upload',
      approvalId: 'approval-1',
      target: { url: 'https://example.com/webhook' },
    });

    expect(resumed).toMatchObject({
      decision: 'allow',
      reason: 'approved permission resumed',
      approval: { id: 'approval-1', status: 'approved' },
      details: { resumed: true, resumeApprovalId: 'approval-1' },
    });
    expect(approvals).toHaveLength(1);

    const mismatch = governance.evaluatePermission({
      action: 'network.upload',
      approvalId: 'approval-1',
      target: { url: 'https://evil.example/webhook' },
    });
    expect(mismatch).toMatchObject({
      decision: 'deny',
      reason: 'approval does not match permission action/target',
    });
  });

  it('does not create duplicate approvals when a pending approval id is retried', () => {
    const { governance, approvals } = makeGovernance();

    governance.evaluatePermission({
      action: 'skill.plugin.execute',
      target: { pluginId: 'demo', commandId: 'run' },
    });

    const retry = governance.evaluatePermission({
      action: 'skill.plugin.execute',
      approvalId: 'approval-1',
      target: { commandId: 'run', pluginId: 'demo' },
    });

    expect(retry).toMatchObject({
      decision: 'ask',
      reason: 'approval is still pending',
      approval: { id: 'approval-1', status: 'pending' },
    });
    expect(approvals).toHaveLength(1);
  });

  it('denies rejected approval resume attempts', () => {
    const { governance, approvals } = makeGovernance();

    governance.evaluatePermission({
      action: 'provider.model_config.write',
      target: { section: 'watcher', provider: 'openai' },
    });
    approvals[0].status = 'rejected';

    expect(governance.evaluatePermission({
      action: 'provider.model_config.write',
      approvalId: 'approval-1',
      target: { provider: 'openai', section: 'watcher' },
    })).toMatchObject({
      decision: 'deny',
      reason: 'approval rejected; permission resume denied',
    });
  });
});
