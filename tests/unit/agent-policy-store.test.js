import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentPolicyStore, effectiveAgentRegistry } from '../../src/agents/AgentPolicyStore.js';

function makePolicyStore() {
  const dir = mkdtempSync(join(tmpdir(), 'xike-agent-policy-'));
  const filePath = join(dir, 'agent-policies.json');
  const store = new AgentPolicyStore({
    filePath,
    audit: { recordSafe() {} },
    logger: { warn() {} },
  });
  return {
    store,
    filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('AgentPolicyStore', () => {
  it('persists governance overrides and reloads them from disk', () => {
    const { store, filePath, cleanup } = makePolicyStore();
    try {
      const policy = store.upsert('xike-verifier', {
        budgetTier: 'restricted',
        commandGuard: 'strict',
        approvalPolicy: 'read_only',
        auditLevel: 'full',
      });

      expect(policy).toMatchObject({
        profileId: 'xike-verifier',
        governance: {
          budgetTier: 'restricted',
          commandGuard: 'strict',
          approvalPolicy: 'read_only',
          auditLevel: 'full',
          budgetScope: 'agent_profile',
        },
      });

      const reloaded = new AgentPolicyStore({
        filePath,
        audit: { recordSafe() {} },
        logger: { warn() {} },
      });
      expect(reloaded.get('xike-verifier')).toMatchObject(policy);
    } finally {
      cleanup();
    }
  });

  it('builds an effective registry with overridden profile governance', () => {
    const { store, cleanup } = makePolicyStore();
    try {
      store.upsert('xike-shipper', {
        budgetTier: 'low',
        commandGuard: 'strict',
        approvalPolicy: 'release_and_destructive_actions',
        auditLevel: 'full',
      });

      const registry = effectiveAgentRegistry({ policyStore: store });
      const profile = registry.profileById.get('xike-shipper');
      expect(profile.governanceOverridden).toBe(true);
      expect(profile.governance).toMatchObject({
        budgetTier: 'low',
        commandGuard: 'strict',
      });

      expect(store.delete('xike-shipper')).toBe(true);
      expect(effectiveAgentRegistry({ policyStore: store }).profileById.get('xike-shipper').governanceOverridden).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('rejects invalid profile ids', () => {
    const { store, cleanup } = makePolicyStore();
    try {
      expect(() => store.upsert('../bad', { budgetTier: 'low' })).toThrow(/invalid profile id/);
    } finally {
      cleanup();
    }
  });
});
