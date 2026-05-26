import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildApprovalResumeGateAudit,
  buildApprovalResumeReview,
} from '../../src/agents/AgentRunApprovalResumeReview.js';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-resume-review-'));
  mkdirSync(join(tmp, 'src'), { recursive: true });
  mkdirSync(join(tmp, 'public'), { recursive: true });
  mkdirSync(join(tmp, 'docs'), { recursive: true });
  writeFileSync(join(tmp, 'src', 'existing.js'), 'const oldValue = true;\nfunction keep() {}\n');
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('AgentRunApprovalResumeReview', () => {
  it('builds a deterministic multi-file staged diff review and gates on it', () => {
    const manifest = {
      approvalId: 'approval-multi-diff',
      fileChanges: [
        {
          operation: 'update',
          path: 'src/existing.js',
          content: 'const nextValue = true;\nfunction keep() {}\n',
          requiresApproval: true,
        },
        {
          operation: 'create',
          path: 'public/generated-panel.js',
          content: 'const generatedPanel = true;\n',
        },
        {
          operation: 'create',
          path: 'docs/unsafe.exe',
          content: 'binary-like payload\n',
        },
      ],
      commands: ['node --check public/generated-panel.js'],
    };

    const review = buildApprovalResumeReview(manifest, { cwd: tmp, runId: 'agent-run-multi-diff' });

    expect(review.safeToResume).toBe(false);
    expect(review.stagedDiffReview).toMatchObject({
      id: expect.stringMatching(/^staged-diff-/),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      safeToResume: false,
      summary: {
        fileCount: 3,
        okFileCount: 2,
        blockedFileCount: 1,
        newFileCount: 2,
        existingFileCount: 1,
        totalAdditions: 3,
        totalRemovals: 1,
        totalNetLineChange: 2,
        verificationCoveredFileCount: 1,
        specificallyVerifiedFileCount: 1,
        uncoveredFileCount: 1,
        highRiskFileCount: 1,
        coverageExplanationCount: expect.any(Number),
        operationCounts: { create: 2, update: 1 },
        extensionCounts: { '.exe': 1, '.js': 2 },
        coverageStatusCounts: { blocked: 1, uncovered: 1, verified: 1 },
        riskLevelCounts: { blocked: 1, medium: 2 },
      },
    });
    expect(review.stagedDiffReview.summary.attentionFlagCounts).toMatchObject({
      approval_required: 1,
      blocked_file_change: 1,
      manual_review: 1,
      missing_verification: 1,
      new_file: 2,
      script_change: 2,
      ui_surface_change: 1,
    });
    expect(review.stagedDiffReview.summary.topRiskFiles[0]).toMatchObject({
      path: 'docs/unsafe.exe',
      riskRank: 1,
      riskLevel: 'blocked',
      coverageStatus: 'blocked',
    });
    expect(review.fileChanges[0]).toMatchObject({
      path: 'src/existing.js',
      diffStats: { additions: 1, removals: 1, beforeLines: 2, afterLines: 2, changed: true },
      coverageStatus: 'uncovered',
      riskRank: 2,
      commandCoverage: { status: 'uncovered', verificationCommandCount: 0 },
      coverageExplanations: expect.arrayContaining([
        expect.objectContaining({ kind: 'gap', status: 'uncovered', reason: 'no safe verification or work evidence command references this file' }),
      ]),
      riskReasons: expect.arrayContaining([
        expect.objectContaining({ reason: 'no matching verification command' }),
        expect.objectContaining({ reason: 'explicit approval required' }),
      ]),
      attentionFlags: expect.arrayContaining(['approval_required', 'script_change', 'missing_verification']),
    });
    expect(review.fileChanges[1]).toMatchObject({
      path: 'public/generated-panel.js',
      diffStats: { additions: 1, removals: 0, beforeLines: 0, afterLines: 1, changed: true },
      coverageStatus: 'verified',
      commandCoverage: { status: 'verified', verificationCommandCount: 1 },
      coverageExplanations: expect.arrayContaining([
        expect.objectContaining({ kind: 'verification', status: 'matched', command: 'node --check public/generated-panel.js' }),
      ]),
      riskReasons: expect.arrayContaining([
        expect.objectContaining({ reason: 'new file' }),
        expect.objectContaining({ reason: 'script/runtime file' }),
      ]),
      attentionFlags: expect.arrayContaining(['new_file', 'script_change', 'ui_surface_change']),
    });
    expect(review.fileChanges[2]).toMatchObject({
      path: 'docs/unsafe.exe',
      ok: false,
      diffStats: { additions: 1, removals: 0 },
      coverageStatus: 'blocked',
      riskRank: 1,
      riskLevel: 'blocked',
      attentionFlags: expect.arrayContaining(['blocked_file_change', 'manual_review']),
    });

    const saferReview = buildApprovalResumeReview({
      ...manifest,
      fileChanges: manifest.fileChanges.slice(0, 2),
    }, { cwd: tmp, runId: 'agent-run-multi-diff' });
    expect(saferReview.safeToResume).toBe(true);
    expect(saferReview.stagedDiffReview.summary.blockedFileCount).toBe(0);
    expect(saferReview.stagedDiffReview.summary).toMatchObject({
      verificationCoveredFileCount: 1,
      uncoveredFileCount: 1,
      coverageStatusCounts: { uncovered: 1, verified: 1 },
    });

    const changedReview = buildApprovalResumeReview({
      ...manifest,
      fileChanges: [
        manifest.fileChanges[0],
        {
          operation: 'create',
          path: 'public/generated-panel.js',
          content: 'const generatedPanel = true;\nconst secondLine = true;\n',
        },
      ],
    }, { cwd: tmp, runId: 'agent-run-multi-diff' });
    expect(changedReview.stagedDiffReview.sha256).not.toBe(saferReview.stagedDiffReview.sha256);
    expect(changedReview.gate.sha256).not.toBe(saferReview.gate.sha256);

    const coveredReview = buildApprovalResumeReview({
      ...manifest,
      fileChanges: manifest.fileChanges.slice(0, 2),
      commands: ['node --check public/generated-panel.js', 'node --check src/existing.js'],
    }, { cwd: tmp, runId: 'agent-run-multi-diff' });
    expect(coveredReview.stagedDiffReview.summary).toMatchObject({
      verificationCoveredFileCount: 2,
      uncoveredFileCount: 0,
      coverageStatusCounts: { verified: 2 },
    });
    expect(coveredReview.fileChanges[0].coverageExplanations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'verification', status: 'matched', command: 'node --check src/existing.js' }),
    ]));
    expect(coveredReview.stagedDiffReview.sha256).not.toBe(saferReview.stagedDiffReview.sha256);
    expect(coveredReview.gate.sha256).not.toBe(saferReview.gate.sha256);

    const audit = buildApprovalResumeGateAudit(saferReview, { status: 'previewed', recordedBy: 'unit-test' });
    expect(audit.stagedDiffReview).toMatchObject({
      id: saferReview.stagedDiffReview.id,
      summary: { fileCount: 2, totalAdditions: 2, totalRemovals: 1, uncoveredFileCount: 1 },
    });
  });
});
