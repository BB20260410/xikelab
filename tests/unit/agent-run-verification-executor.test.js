import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { AgentRunStore } from '../../src/agents/AgentRunStore.js';
import {
  AgentRunVerificationExecutor,
  parseCommandLine,
  validateFileChange,
  validateVerificationCommand,
  validateWorkEvidenceCommand,
} from '../../src/agents/AgentRunVerificationExecutor.js';
import { ApprovalStore } from '../../src/approval/ApprovalStore.js';
import { PermissionGovernance } from '../../src/permissions/PermissionGovernance.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-agent-verifier-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('AgentRunVerificationExecutor', () => {
  it('parses and validates only low-risk local verification commands', () => {
    expect(parseCommandLine('node --check "sample file.js"')).toEqual(['node', '--check', 'sample file.js']);
    expect(validateVerificationCommand('node --check sample.js', { cwd: tmp })).toMatchObject({ ok: true, safeToAutoExecute: true });
    expect(validateVerificationCommand('node --test tests/unit/generated-policy.test.mjs', { cwd: tmp })).toMatchObject({ ok: true });
    expect(validateVerificationCommand('node scripts/perf-check.mjs', { cwd: tmp })).toMatchObject({ ok: true });
    expect(validateVerificationCommand('npm test -- tests/unit/foo.test.js', { cwd: tmp })).toMatchObject({ ok: true });
    expect(validateVerificationCommand('npm run lint', { cwd: tmp })).toMatchObject({ ok: true });
    expect(validateVerificationCommand('npm run test:e2e', { cwd: tmp })).toMatchObject({ ok: true });
    expect(validateVerificationCommand('git diff --check', { cwd: tmp })).toMatchObject({ ok: true });
    expect(validateVerificationCommand('npm run lint -- --fix', { cwd: tmp })).toMatchObject({ ok: false });
    expect(validateVerificationCommand('npm install left-pad', { cwd: tmp })).toMatchObject({ ok: false });
    expect(validateVerificationCommand('node --test ../outside.test.mjs', { cwd: tmp })).toMatchObject({ ok: false });
    expect(validateVerificationCommand('node scripts/unknown.mjs', { cwd: tmp })).toMatchObject({ ok: false });
    expect(validateVerificationCommand('node script.js', { cwd: tmp })).toMatchObject({ ok: false });
    expect(validateVerificationCommand('rm -rf /', { cwd: tmp })).toMatchObject({ ok: false });
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    expect(validateWorkEvidenceCommand('git status --short', { cwd: tmp })).toMatchObject({ ok: true, safeToAutoExecute: true });
    expect(validateWorkEvidenceCommand('git status --porcelain=v1', { cwd: tmp })).toMatchObject({ ok: true });
    expect(validateWorkEvidenceCommand('git diff --name-only', { cwd: tmp })).toMatchObject({ ok: true });
    expect(validateWorkEvidenceCommand('git diff --stat', { cwd: tmp })).toMatchObject({ ok: true });
    expect(validateWorkEvidenceCommand('git add .', { cwd: tmp })).toMatchObject({ ok: false });
    expect(validateWorkEvidenceCommand('git show --stat', { cwd: tmp })).toMatchObject({ ok: false });
    expect(validateFileChange({ path: 'output/playwright/generated.js', content: 'const ok = true;\n' }, { cwd: tmp })).toMatchObject({ ok: true });
    expect(validateFileChange({ path: '../outside.js', content: 'x' }, { cwd: tmp })).toMatchObject({ ok: false });
    expect(validateFileChange({ path: '.env', content: 'SECRET=1' }, { cwd: tmp })).toMatchObject({ ok: false });
  });

  it('auto-runs safe verification commands and archives the idea run', async () => {
    writeFileSync(join(tmp, 'sample.js'), 'const ok = true;\n');
    const permissions = [];
    const store = new AgentRunStore({ logger: null });
    const draft = store.createIdeaRun({
      actorType: 'user',
      requestedBy: 'owner',
      idea: 'Verify a generated JavaScript file',
      classification: {
        profile: { id: 'xike-verifier', title: 'Xike Verifier' },
        matches: [{ tag: 'verification', agentId: 'xike-verifier', score: 5 }],
        installedSkillNames: ['qa'],
      },
    });
    const executor = new AgentRunVerificationExecutor({
      agentRunStore: store,
      cwd: tmp,
      permissionGovernance: {
        evaluatePermission(input) {
          permissions.push(input);
          return { id: 'permission-allow-1', decision: 'allow', reason: 'allowed' };
        },
      },
      logger: null,
    });

    const result = await executor.executeIdeaRun(draft.run.id, {
      actorType: 'user',
      requestedBy: 'owner',
      commands: ['node --check sample.js'],
    });

    expect(result.run.status).toBe('succeeded');
    expect(result.execution).toMatchObject({
      finalStatus: 'succeeded',
      safeToAutoExecute: false,
    });
    expect(result.toolResults).toEqual([
      expect.objectContaining({
        toolName: 'node --check sample.js',
        status: 'passed',
      }),
    ]);
    expect(result.archive).toMatchObject({
      status: 'succeeded',
      evidence: {
        external: {
          stage: 'idea_final_archive',
        },
      },
    });
    expect(permissions).toEqual([
      expect.objectContaining({
        action: 'shell.exec',
        agentRunId: draft.run.id,
        target: expect.objectContaining({ command: 'node --check sample.js' }),
      }),
    ]);
  });

  it('collects governed work evidence before verification and includes it in the archive', async () => {
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    writeFileSync(join(tmp, 'sample.js'), 'const ok = true;\n');
    const permissions = [];
    const store = new AgentRunStore({ logger: null });
    const draft = store.createIdeaRun({
      actorType: 'user',
      requestedBy: 'owner',
      idea: 'Collect work evidence for an idea run',
      affectedFiles: ['sample.js'],
      classification: {
        profile: { id: 'xike-builder', title: 'Xike Builder' },
        matches: [
          { tag: 'implementation', agentId: 'xike-builder', score: 5 },
          { tag: 'verification', agentId: 'xike-verifier', score: 4 },
        ],
        installedSkillNames: ['qa'],
      },
    });
    const executor = new AgentRunVerificationExecutor({
      agentRunStore: store,
      cwd: tmp,
      permissionGovernance: {
        evaluatePermission(input) {
          permissions.push(input);
          return { id: `permission-${permissions.length}`, decision: 'allow', reason: 'allowed' };
        },
      },
      logger: null,
    });

    const result = await executor.executeIdeaRun(draft.run.id, {
      actorType: 'user',
      requestedBy: 'owner',
      workEvidenceCommands: ['git status --short', 'git diff --name-only'],
      commands: ['node --check sample.js'],
    });
    const timeline = store.getTimeline(draft.run.id);

    expect(result.run.status).toBe('succeeded');
    expect(timeline.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'work_plan',
        summary: expect.stringContaining('Idea work plan prepared'),
      }),
    ]));
    expect(timeline.toolResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: 'git status --short',
        status: 'passed',
        payload: expect.objectContaining({ stage: 'idea_work_evidence' }),
      }),
      expect.objectContaining({
        toolName: 'node --check sample.js',
        status: 'passed',
        payload: expect.objectContaining({ stage: 'verification' }),
      }),
    ]));
    expect(result.archive.evidence.external).toMatchObject({
      stage: 'idea_final_archive',
      workPlan: {
        executionMode: 'local_manifest_then_evidence_then_verification',
        commands: {
          workEvidence: ['git status --short', 'git diff --name-only'],
          verification: ['node --check sample.js'],
        },
      },
      workEvidence: [
        expect.objectContaining({ command: 'git status --short', status: 'passed' }),
        expect.objectContaining({ command: 'git diff --name-only', status: 'passed' }),
      ],
    });
    expect(permissions.map((item) => item.target.toolName)).toEqual([
      'idea_work_evidence_command',
      'idea_work_evidence_command',
      'idea_verification_command',
    ]);
    expect(permissions.every((item) => item.actorType === 'user' && item.actorId === 'owner')).toBe(true);
  });

  it('applies governed project-local file changes and attaches artifacts before final archive', async () => {
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    writeFileSync(join(tmp, 'artifact.png'), 'fake image');
    const permissions = [];
    const store = new AgentRunStore({ logger: null });
    const draft = store.createIdeaRun({
      actorType: 'user',
      requestedBy: 'owner',
      idea: 'Apply a governed generated file',
      classification: {
        profile: { id: 'xike-builder', title: 'Xike Builder' },
        matches: [{ tag: 'implementation', agentId: 'xike-builder', score: 5 }],
      },
    });
    const executor = new AgentRunVerificationExecutor({
      agentRunStore: store,
      cwd: tmp,
      permissionGovernance: {
        evaluatePermission(input) {
          permissions.push(input);
          return { id: `permission-${permissions.length}`, decision: 'allow', reason: 'allowed' };
        },
      },
      logger: null,
    });

    const result = await executor.executeIdeaRun(draft.run.id, {
      actorType: 'user',
      requestedBy: 'owner',
      fileChanges: [{
        operation: 'create',
        path: 'output/playwright/generated-idea-work.js',
        content: 'const generatedIdeaWork = true;\n',
      }],
      commands: ['node --check output/playwright/generated-idea-work.js'],
      evidenceArtifacts: [{ kind: 'screenshot', path: 'artifact.png', label: 'Work evidence screenshot' }],
    });
    const generatedPath = join(tmp, 'output', 'playwright', 'generated-idea-work.js');

    expect(existsSync(generatedPath)).toBe(true);
    expect(readFileSync(generatedPath, 'utf8')).toContain('generatedIdeaWork');
    expect(result.run.status).toBe('succeeded');
    expect(result.toolResults).toEqual([
      expect.objectContaining({
        toolName: 'node --check output/playwright/generated-idea-work.js',
        status: 'passed',
      }),
    ]);
    const timeline = store.getTimeline(draft.run.id);
    expect(timeline.toolResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: 'file.write output/playwright/generated-idea-work.js',
        status: 'passed',
        payload: expect.objectContaining({
          stage: 'idea_file_change',
          operation: 'create',
          path: 'output/playwright/generated-idea-work.js',
          safeToAutoExecute: true,
        }),
      }),
    ]));
    expect(result.archive.evidence.external).toMatchObject({
      fileChanges: [
        expect.objectContaining({
          operation: 'create',
          path: 'output/playwright/generated-idea-work.js',
          status: 'passed',
          before: expect.objectContaining({ exists: false }),
          after: expect.objectContaining({ exists: true }),
        }),
      ],
      evidenceArtifacts: [
        expect.objectContaining({
          kind: 'screenshot',
          label: 'Work evidence screenshot',
          path: 'artifact.png',
          exists: true,
        }),
      ],
    });
    expect(permissions.map((item) => item.action)).toEqual(expect.arrayContaining(['file.write', 'shell.exec']));
  });

  it('defers explicit approval-gated file changes and resumes them after approval', async () => {
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    const store = new AgentRunStore({ logger: null });
    const approvals = new ApprovalStore({ audit: { recordSafe() {} } });
    const governance = new PermissionGovernance({
      approvalStore: approvals,
      audit: { recordSafe() {} },
      agentRuns: store,
    });
    const draft = store.createIdeaRun({
      actorType: 'user',
      requestedBy: 'owner',
      idea: 'Resume an approval-gated generated file',
      classification: {
        profile: { id: 'xike-builder', title: 'Xike Builder' },
        matches: [{ tag: 'implementation', agentId: 'xike-builder', score: 5 }],
      },
    });
    const executor = new AgentRunVerificationExecutor({
      agentRunStore: store,
      cwd: tmp,
      permissionGovernance: governance,
      logger: null,
    });
    const fileChange = {
      operation: 'create',
      path: 'output/playwright/approval-resume.js',
      content: 'const approvalResume = true;\n',
      requiresApproval: true,
    };
    const generatedPath = join(tmp, 'output', 'playwright', 'approval-resume.js');

    const deferred = await executor.executeIdeaRun(draft.run.id, {
      actorType: 'user',
      requestedBy: 'owner',
      fileChanges: [fileChange],
      commands: ['node --check output/playwright/approval-resume.js'],
    });

    expect(deferred.run.status).toBe('deferred');
    expect(deferred.status).toBe('approval_required');
    expect(deferred.approvalId).toMatch(/^approval-/);
    expect(existsSync(generatedPath)).toBe(false);
    const deferredTimeline = store.getTimeline(draft.run.id);
    expect(deferredTimeline.toolResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: 'file.write output/playwright/approval-resume.js',
        status: 'approval_required',
        approvalId: deferred.approvalId,
      }),
    ]));
    expect(deferredTimeline.run.details.pendingResumeManifest).toMatchObject({
      approvalId: deferred.approvalId,
      fileChanges: [expect.objectContaining({
        path: 'output/playwright/approval-resume.js',
        content: 'const approvalResume = true;\n',
        requiresApproval: true,
      })],
      commands: ['node --check output/playwright/approval-resume.js'],
    });
    expect(deferredTimeline.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'summary',
        status: 'approval_required',
        payload: expect.objectContaining({
          resumeManifest: expect.objectContaining({
            approvalId: deferred.approvalId,
            fileChanges: [expect.objectContaining({
              content: 'const approvalResume = true;\n',
            })],
          }),
        }),
      }),
    ]));

    approvals.approve(deferred.approvalId, { decisionBy: 'owner', reason: 'test approval resume' });
    const resumed = await executor.executeIdeaRun(draft.run.id, {
      actorType: 'user',
      requestedBy: 'owner',
      approvalId: deferred.approvalId,
      fileChanges: [fileChange],
      commands: ['node --check output/playwright/approval-resume.js'],
    });

    expect(resumed.run.status).toBe('succeeded');
    expect(readFileSync(generatedPath, 'utf8')).toContain('approvalResume');
    expect(resumed.archive.evidence.external).toMatchObject({
      fileChanges: [
        expect.objectContaining({
          path: 'output/playwright/approval-resume.js',
          status: 'passed',
          resumeApprovalId: deferred.approvalId,
        }),
      ],
    });
    expect(store.getTimeline(draft.run.id).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'summary',
        status: 'approval_required',
        summary: expect.stringContaining('requires approval'),
      }),
    ]));
  });

  it('runs generated node:test manifests under the expanded command policy', async () => {
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    const permissions = [];
    const store = new AgentRunStore({ logger: null });
    const draft = store.createIdeaRun({
      actorType: 'user',
      requestedBy: 'owner',
      idea: 'Execute a generated node:test verification file',
      classification: {
        profile: { id: 'xike-verifier', title: 'Xike Verifier' },
        matches: [{ tag: 'verification', agentId: 'xike-verifier', score: 5 }],
        installedSkillNames: ['qa'],
      },
    });
    const executor = new AgentRunVerificationExecutor({
      agentRunStore: store,
      cwd: tmp,
      permissionGovernance: {
        evaluatePermission(input) {
          permissions.push(input);
          return { id: `permission-${permissions.length}`, decision: 'allow', reason: 'allowed' };
        },
      },
      logger: null,
    });
    const generatedTestRel = 'output/playwright/generated-policy.test.mjs';
    const generatedTestContent = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      '',
      "test('generated policy check', () => {",
      '  assert.equal(2 + 2, 4);',
      '});',
      '',
    ].join('\n');

    const result = await executor.executeIdeaRun(draft.run.id, {
      actorType: 'user',
      requestedBy: 'owner',
      fileChanges: [{
        operation: 'create',
        path: generatedTestRel,
        content: generatedTestContent,
      }],
      workEvidenceCommands: ['git status --porcelain=v1', 'git diff --stat'],
      commands: [`node --test ${generatedTestRel}`],
    });
    const timeline = store.getTimeline(draft.run.id);

    expect(result.run.status).toBe('succeeded');
    expect(readFileSync(join(tmp, generatedTestRel), 'utf8')).toContain('generated policy check');
    expect(timeline.toolResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: `file.write ${generatedTestRel}`,
        status: 'passed',
      }),
      expect.objectContaining({
        toolName: 'git status --porcelain=v1',
        status: 'passed',
      }),
      expect.objectContaining({
        toolName: 'git diff --stat',
        status: 'passed',
      }),
      expect.objectContaining({
        toolName: `node --test ${generatedTestRel}`,
        status: 'passed',
      }),
    ]));
    expect(result.archive.evidence.external).toMatchObject({
      fileChanges: [expect.objectContaining({ path: generatedTestRel, status: 'passed' })],
      workEvidence: [
        expect.objectContaining({ command: 'git status --porcelain=v1', status: 'passed' }),
        expect.objectContaining({ command: 'git diff --stat', status: 'passed' }),
      ],
      commands: [expect.objectContaining({ command: `node --test ${generatedTestRel}`, status: 'passed' })],
    });
    expect(permissions.map((item) => item.action)).toEqual([
      'file.write',
      'shell.exec',
      'shell.exec',
      'shell.exec',
    ]);
    expect(permissions.slice(1).map((item) => item.target.toolName)).toEqual([
      'idea_work_evidence_command',
      'idea_work_evidence_command',
      'idea_verification_command',
    ]);
  });

  it('records blocked commands as failed verification evidence without executing them', async () => {
    const store = new AgentRunStore({ logger: null });
    const draft = store.createIdeaRun({
      actorType: 'user',
      requestedBy: 'owner',
      idea: 'Try unsafe auto command',
      classification: {
        profile: { id: 'xike-verifier', title: 'Xike Verifier' },
        matches: [{ tag: 'verification', agentId: 'xike-verifier', score: 5 }],
      },
    });
    const executor = new AgentRunVerificationExecutor({
      agentRunStore: store,
      cwd: tmp,
      permissionGovernance: {
        evaluatePermission() {
          throw new Error('permission should not be evaluated for non-allowlisted commands');
        },
      },
      logger: null,
    });

    const result = await executor.executeIdeaRun(draft.run.id, {
      actorType: 'user',
      requestedBy: 'owner',
      commands: ['rm -rf /'],
    });

    expect(result.run.status).toBe('failed');
    expect(result.toolResults).toEqual([
      expect.objectContaining({
        toolName: 'rm -rf /',
        status: 'blocked',
      }),
    ]);
    expect(result.archive).toMatchObject({
      status: 'failed',
      verification: {
        toolStatusCounts: { blocked: 1 },
      },
    });
  });
});
