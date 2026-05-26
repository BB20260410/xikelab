import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { agentRunStore as defaultAgentRunStore } from './AgentRunStore.js';
import { permissionGovernance as defaultPermissionGovernance } from '../permissions/PermissionGovernance.js';

const SAFE_NPM_RUN_SCRIPTS = new Set(['lint', 'test:e2e', 'perf-check', 'lint:baseline']);
const SAFE_NODE_SCRIPT_COMMANDS = new Set([
  'scripts/perf-check.mjs',
  'scripts/eslint-baseline-check.js',
  'tests/e2e/panel-ui-walkthrough.mjs',
]);
const SAFE_WORK_EVIDENCE_COMMANDS = new Set([
  'git status --short',
  'git status --porcelain=v1',
  'git diff --name-only',
  'git diff --stat',
  'git branch --show-current',
  'git rev-parse --show-toplevel',
  'git ls-files --modified --others --exclude-standard',
]);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 4_000;
const MAX_FILE_CHANGE_BYTES = 64 * 1024;
const SAFE_FILE_CHANGE_ROOTS = [
  'src/',
  'public/',
  'tests/',
  'docs/',
  'scripts/',
  'output/playwright/',
  '任务交接.md',
  '上下文交接.md',
];
const SAFE_FILE_CHANGE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
  '.md',
  '.css',
  '.html',
  '.txt',
  '.yml',
  '.yaml',
  '.toml',
]);

function safeString(value, max = 1000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function safeContent(value, max = MAX_FILE_CHANGE_BYTES) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20);
}

function clipOutput(text, max = MAX_OUTPUT_CHARS) {
  const value = safeString(text, max * 2);
  if (value.length <= max) return value;
  return `${value.slice(0, max - 120)}\n...output truncated...`;
}

export function parseCommandLine(command) {
  const text = safeString(command, 4000);
  const args = [];
  let current = '';
  let quote = '';
  let escaping = false;
  for (const char of text) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += '\\';
  if (quote) throw new Error('unterminated quote in verification command');
  if (current) args.push(current);
  return args;
}

function commandInsideCwd(cwd, maybePath) {
  const value = safeString(maybePath, 2000);
  if (!value || value.startsWith('-')) return true;
  const target = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const rel = relative(resolve(cwd), target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeCommandFile(cwd, maybePath, allowedExtensions = SAFE_FILE_CHANGE_EXTENSIONS) {
  const value = safeString(maybePath, 2000);
  if (!value || value.startsWith('-')) return false;
  const relPath = normalizedRelativePath(cwd, value);
  if (!relPath || isSensitiveRelativePath(relPath)) return false;
  if (!allowedExtensions.has(extname(relPath))) return false;
  return commandInsideCwd(cwd, value);
}

function normalizedRelativePath(cwd, maybePath) {
  const value = safeString(maybePath, 2000);
  if (!value) return '';
  const target = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const rel = relative(resolve(cwd), target).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return '';
  return rel;
}

function isSensitiveRelativePath(relPath) {
  return /(^|\/)(\.git|node_modules|dist|out)(\/|$)/.test(relPath)
    || /(^|\/)(\.ssh|\.aws|\.gnupg|\.docker|\.kube)(\/|$)/.test(relPath)
    || /(^|\/)\.env(\.|$|\/)?/.test(relPath)
    || /(^|\/)[^/]*(private-key|token|secret|credential)[^/]*$/i.test(relPath);
}

function isAllowedFileChangePath(relPath) {
  if (!relPath || isSensitiveRelativePath(relPath)) return false;
  const ext = extname(relPath);
  if (!SAFE_FILE_CHANGE_EXTENSIONS.has(ext)) return false;
  return SAFE_FILE_CHANGE_ROOTS.some((root) => {
    if (root.endsWith('/')) return relPath.startsWith(root);
    return relPath === root;
  });
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function fileSnapshot(filePath) {
  if (!existsSync(filePath)) return { exists: false, size: 0, sha256: null };
  const content = readFileSync(filePath);
  return {
    exists: true,
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function hasGitMetadata(cwd) {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(resolve(current, '.git'))) return true;
    const parent = resolve(current, '..');
    if (parent === current) return false;
    current = parent;
  }
}

function normalizeFileChangeInput(value) {
  if (!value || typeof value !== 'object') return null;
  const operation = safeString(value.operation || value.action || 'update', 40).toLowerCase();
  const nextOperation = ['create', 'update', 'append'].includes(operation) ? operation : 'update';
  return {
    operation: nextOperation,
    path: safeString(value.path || value.filePath || value.file, 2000),
    content: safeContent(value.content ?? value.text ?? ''),
    summary: safeString(value.summary || value.reason || '', 500),
    approvalId: safeString(value.approvalId || value.permissionApprovalId || value.resumeApprovalId, 160),
    requiresApproval: Boolean(value.requiresApproval || value.approvalRequired || value.requireApproval),
    overwrite: Boolean(value.overwrite),
  };
}

function normalizeFileChanges(input = {}) {
  const source = Array.isArray(input.fileChanges) ? input.fileChanges
    : Array.isArray(input.workFileChanges) ? input.workFileChanges
      : Array.isArray(input.changes) ? input.changes
        : [];
  return source.map(normalizeFileChangeInput).filter(Boolean).slice(0, 8);
}

export function validateFileChange(change, { cwd = process.cwd() } = {}) {
  const item = normalizeFileChangeInput(change);
  if (!item) return { ok: false, reason: 'file change is empty', safeToAutoExecute: false };
  const relPath = normalizedRelativePath(cwd, item.path);
  const targetPath = relPath ? resolve(cwd, relPath) : '';
  const deny = (reason) => ({
    ok: false,
    reason,
    operation: item.operation,
    path: item.path,
    relativePath: relPath,
    targetPath,
    safeToAutoExecute: false,
  });
  if (!relPath || !commandInsideCwd(cwd, item.path)) return deny('file change path must stay inside cwd');
  if (!isAllowedFileChangePath(relPath)) return deny('file change path is outside the safe project file allowlist');
  if (!item.content && item.operation !== 'append') return deny('file change content is empty');
  if (Buffer.byteLength(item.content, 'utf8') > MAX_FILE_CHANGE_BYTES) return deny('file change content exceeds the safe size limit');
  const exists = existsSync(targetPath);
  if (item.operation === 'create' && exists && !item.overwrite) return deny('create would overwrite an existing file');
  return {
    ok: true,
    reason: 'safe project-local file change allowed',
    operation: item.operation,
    path: item.path,
    relativePath: relPath,
    targetPath,
    content: item.content,
    summary: item.summary,
    approvalId: item.approvalId,
    requiresApproval: item.requiresApproval,
    overwrite: item.overwrite,
    safeToAutoExecute: true,
  };
}

function normalizeEvidenceArtifacts(input = {}, { cwd = process.cwd() } = {}) {
  const source = [
    ...(Array.isArray(input.evidenceArtifacts) ? input.evidenceArtifacts : []),
    ...(Array.isArray(input.screenshotEvidence) ? input.screenshotEvidence : []),
  ];
  return source.map((item) => {
    if (typeof item === 'string') item = { path: item };
    if (!item || typeof item !== 'object') return null;
    const relPath = normalizedRelativePath(cwd, item.path || item.filePath || item.file);
    if (!relPath || isSensitiveRelativePath(relPath)) return null;
    const targetPath = resolve(cwd, relPath);
    let meta = { exists: false, size: 0 };
    try {
      if (existsSync(targetPath)) {
        const stat = statSync(targetPath);
        meta = { exists: true, size: stat.size };
      }
    } catch {}
    return {
      kind: safeString(item.kind || item.type || 'artifact', 80) || 'artifact',
      label: safeString(item.label || item.title || relPath, 200),
      path: relPath,
      ...meta,
    };
  }).filter(Boolean).slice(0, 12);
}

function buildApprovalResumeManifest(input = {}, { cwd = process.cwd(), approvalId = '' } = {}) {
  const manifest = {
    approvalId: safeString(approvalId || input.approvalId || input.permissionApprovalId || input.resumeApprovalId, 160),
    fileChanges: normalizeFileChanges(input),
    workEvidenceCommands: workEvidenceCommands({}, input, cwd).map((item) => item.command),
    commands: verificationCommands({}, input, cwd).map((item) => item.command),
    evidenceArtifacts: normalizeEvidenceArtifacts(input, { cwd }),
  };
  if (safeString(input.cwd, 2000)) manifest.cwd = safeString(input.cwd, 2000);
  return manifest;
}

export function validateVerificationCommand(command, { cwd = process.cwd() } = {}) {
  const parts = parseCommandLine(command);
  if (!parts.length) return { ok: false, reason: 'verification command is empty', safeToAutoExecute: false };
  const [bin, ...args] = parts;
  const normalized = [bin, ...args].join(' ');
  const deny = (reason) => ({ ok: false, reason, bin, args, normalized, safeToAutoExecute: false });
  const allow = () => ({ ok: true, reason: 'safe local verification command allowed', bin, args, normalized, safeToAutoExecute: true });

  if (bin === 'npm') {
    if (args[0] === 'test') {
      const fileArgs = args.slice(1).filter((arg) => arg !== '--');
      if (fileArgs.some((arg) => /(^|\/)\.env(\.|$|\/)?/.test(arg) || !commandInsideCwd(cwd, arg))) {
        return deny('npm test file arguments must stay inside cwd and avoid sensitive files');
      }
      return allow();
    }
    if (args[0] === 'run' && SAFE_NPM_RUN_SCRIPTS.has(args[1])) {
      if (args.length !== 2) {
        return deny('npm run verification scripts must be exact allowlisted commands');
      }
      return allow();
    }
    return deny('only npm test and selected npm run verification scripts are auto-executable');
  }

  if (bin === 'node') {
    if (args[0] === '--check') {
      const files = args.slice(1);
      if (!files.length) return deny('node --check requires a project-local file');
      if (files.some((file) => !safeCommandFile(cwd, file))) {
        return deny('node --check files must stay inside cwd and avoid sensitive files');
      }
      return allow();
    }
    if (args[0] === '--test') {
      const files = args.slice(1);
      if (!files.length) return deny('node --test requires explicit project-local test files');
      if (files.some((file) => !safeCommandFile(cwd, file, new Set(['.js', '.mjs', '.cjs'])))) {
        return deny('node --test files must stay inside cwd, use JS extensions, and avoid sensitive files');
      }
      return allow();
    }
    if (args.length === 1 && SAFE_NODE_SCRIPT_COMMANDS.has(args[0])) {
      if (!safeCommandFile(cwd, args[0], new Set(['.js', '.mjs', '.cjs']))) {
        return deny('node script must stay inside cwd and avoid sensitive files');
      }
      return allow();
    }
    return deny('node auto verification only supports --check, --test, and selected project scripts');
  }

  if (bin === 'git') {
    if (args.length === 2 && args[0] === 'diff' && args[1] === '--check') return allow();
    return deny('git auto verification only supports git diff --check');
  }

  return deny(`command "${bin}" is not in the local verification allowlist`);
}

export function validateWorkEvidenceCommand(command, { cwd = process.cwd() } = {}) {
  const parts = parseCommandLine(command);
  if (!parts.length) return { ok: false, reason: 'work evidence command is empty', safeToAutoExecute: false };
  const [bin, ...args] = parts;
  const normalized = [bin, ...args].join(' ');
  const deny = (reason) => ({ ok: false, reason, bin, args, normalized, safeToAutoExecute: false });
  const allow = () => ({ ok: true, reason: 'safe local work evidence command allowed', bin, args, normalized, safeToAutoExecute: true });
  if (bin !== 'git') return deny(`command "${bin}" is not in the local work evidence allowlist`);
  if (!hasGitMetadata(cwd)) return deny('git work evidence requires a git worktree');
  if (!SAFE_WORK_EVIDENCE_COMMANDS.has(normalized)) {
    return deny('only read-only git status/diff evidence commands are auto-executable');
  }
  return allow();
}

function normalizeCommandInput(value) {
  if (typeof value === 'string') return { command: value };
  if (!value || typeof value !== 'object') return null;
  return {
    command: safeString(value.command || value.cmd, 4000),
    timeoutMs: Number(value.timeoutMs || value.timeout || 0) || undefined,
  };
}

function defaultVerificationCommands(timeline = {}, cwd = process.cwd()) {
  const run = timeline.run || {};
  const files = normalizeArray(run.details?.affectedFiles || []);
  const commands = hasGitMetadata(cwd) ? ['git diff --check'] : [];
  if (files.includes('public/app.js')) commands.push('node --check public/app.js');
  if (files.some((file) => file.startsWith('src/agents/') || file.includes('AgentRunStore') || file.includes('agentRuns'))) {
    commands.push('npm test -- tests/unit/agent-run-store.test.js tests/unit/routes/agent-runs-routes.test.js');
  }
  if (!commands.length || (commands.length === 1 && commands[0] === 'git diff --check')) {
    commands.push('npm test -- tests/unit/agent-run-store.test.js tests/unit/routes/agent-runs-routes.test.js');
  }
  return [...new Set(commands)].slice(0, 4);
}

function verificationCommands(timeline, input = {}, cwd = process.cwd()) {
  const provided = (Array.isArray(input.commands) ? input.commands : [])
    .map(normalizeCommandInput)
    .filter((item) => item?.command);
  const commands = provided.length
    ? provided
    : defaultVerificationCommands(timeline, cwd).map((command) => ({ command }));
  return commands.slice(0, 6);
}

function workEvidenceCommands(timeline, input = {}, cwd = process.cwd()) {
  const provided = (Array.isArray(input.workEvidenceCommands) ? input.workEvidenceCommands : [])
    .map(normalizeCommandInput)
    .filter((item) => item?.command);
  if (provided.length) return provided.slice(0, 6);
  if (!hasGitMetadata(cwd)) return [];
  return ['git status --short', 'git diff --name-only'].map((command) => ({ command }));
}

function buildIdeaWorkPlan(timeline = {}, { cwd, workCommands = [], verificationCommands: verifyCommands = [], fileChanges = [], evidenceArtifacts = [] } = {}) {
  const run = timeline.run || {};
  const details = run.details || {};
  const affectedFiles = normalizeArray(details.affectedFiles || []);
  return {
    id: `idea-work-plan-${Date.now().toString(36)}`,
    stage: 'idea_work_execution',
    title: `Work plan: ${safeString(details.idea || run.taskId || run.id, 160) || 'Idea Run'}`,
    executionMode: 'local_manifest_then_evidence_then_verification',
    safeToAutoExecute: false,
    cwd,
    affectedFiles,
    dispatchTags: normalizeArray(run.dispatchTags || []),
    skills: normalizeArray(run.skills || []),
    steps: [
      { type: 'scope', title: 'Confirm idea scope and affected files', status: 'recorded' },
      { type: 'file_changes', title: 'Apply governed local file changes from manifest', status: fileChanges.length ? 'ready' : 'skipped' },
      { type: 'work_evidence', title: 'Collect local worktree evidence before archive', status: workCommands.length ? 'ready' : 'skipped' },
      { type: 'verification', title: 'Run allowlisted local verification commands', status: verifyCommands.length ? 'ready' : 'skipped' },
      { type: 'artifacts', title: 'Attach screenshot and verification artifacts', status: evidenceArtifacts.length ? 'ready' : 'skipped' },
      { type: 'archive', title: 'Archive work evidence, verification results, and governance lineage', status: 'pending' },
    ],
    fileChanges: fileChanges.map((item) => ({
      operation: item.operation,
      path: item.path,
      summary: item.summary || '',
      requiresApproval: Boolean(item.requiresApproval),
    })),
    evidenceArtifacts,
    commands: {
      workEvidence: workCommands.map((item) => item.command),
      verification: verifyCommands.map((item) => item.command),
    },
  };
}

function spawnCommand({ bin, args, cwd, timeoutMs }) {
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(bin, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const timeout = setTimeout(() => {
      if (!settled) child.kill('SIGTERM');
    }, Math.max(1_000, Math.min(MAX_TIMEOUT_MS, timeoutMs || DEFAULT_TIMEOUT_MS)));
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        status: 'failed',
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: stderr || error.message,
      });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        status: code === 0 ? 'passed' : 'failed',
        exitCode: code,
        signal: signal || null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    });
  });
}

export class AgentRunVerificationExecutor {
  constructor({
    agentRunStore = defaultAgentRunStore,
    permissionGovernance = defaultPermissionGovernance,
    cwd = process.cwd(),
    logger = console,
  } = {}) {
    this.agentRunStore = agentRunStore;
    this.permissionGovernance = permissionGovernance;
    this.cwd = cwd;
    this.logger = logger;
  }

  async runGovernedCommand(id, timeline, item, { cwd, stage, toolName, validateCommand, actorType = 'system', actorId = 'idea-auto-executor' }) {
    const validation = validateCommand(item.command, { cwd });
    const command = validation.normalized || item.command;
    if (!validation.ok) {
      return {
        command,
        status: 'blocked',
        reason: validation.reason,
        toolResult: {
          name: command,
          toolName: command,
          status: 'blocked',
          inputSummary: command,
          outputSummary: validation.reason,
          payload: { validation, safeToAutoExecute: false, stage },
        },
        evidence: { command, status: 'blocked', reason: validation.reason, stage },
      };
    }
    const permission = this.permissionGovernance?.evaluatePermission?.({
      actorType,
      actorId,
      agentRunId: id,
      roomId: timeline.run.roomId,
      sessionId: timeline.run.sessionId,
      taskId: timeline.run.taskId,
      cwd,
      action: 'shell.exec',
      target: {
        toolName,
        command,
        guardLevel: 'standard',
      },
      risk: 'low',
      details: { stage },
    });
    if (permission && permission.decision !== 'allow') {
      const status = permission.decision === 'deny' ? 'blocked' : 'approval_required';
      return {
        command,
        status,
        reason: permission.reason,
        approvalId: permission.approval?.id || null,
        toolResult: {
          name: command,
          toolName: command,
          status,
          inputSummary: command,
          outputSummary: permission.reason,
          approvalId: permission.approval?.id || null,
          payload: { permissionDecisionId: permission.id, safeToAutoExecute: false, stage },
        },
        evidence: {
          command,
          status,
          reason: permission.reason,
          approvalId: permission.approval?.id || null,
          stage,
        },
      };
    }
    const result = await spawnCommand({
      bin: validation.bin,
      args: validation.args,
      cwd,
      timeoutMs: item.timeoutMs,
    });
    const output = clipOutput([result.stdout, result.stderr].filter(Boolean).join('\n').trim() || `exit ${result.exitCode ?? 'unknown'}`);
    return {
      command,
      status: result.status,
      output,
      toolResult: {
        name: command,
        toolName: command,
        status: result.status,
        inputSummary: command,
        outputSummary: output,
        payload: {
          cwd,
          exitCode: result.exitCode,
          signal: result.signal || null,
          durationMs: result.durationMs,
          safeToAutoExecute: true,
          stage,
        },
      },
      evidence: {
        command,
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stage,
      },
    };
  }

  fileChangePermissionTarget(validation) {
    return {
      path: validation.targetPath,
      filePath: validation.targetPath,
      relativePath: validation.relativePath,
      operation: validation.operation,
      contentSha256: sha256Text(validation.content),
      ...(validation.requiresApproval ? { requiresApproval: true } : {}),
    };
  }

  evaluateGovernedFileChange(id, timeline, change, { cwd, actorType = 'system', actorId = 'idea-auto-executor', approvalId = '' } = {}) {
    const validation = validateFileChange(change, { cwd });
    const toolName = validation.relativePath ? `file.write ${validation.relativePath}` : `file.write ${safeString(change?.path || 'unknown', 160)}`;
    if (!validation.ok) {
      return {
        status: 'blocked',
        toolResult: {
          name: toolName,
          toolName,
          status: 'blocked',
          inputSummary: validation.path || safeString(change?.path || '', 2000),
          outputSummary: validation.reason,
          payload: { validation, safeToAutoExecute: false, stage: 'idea_file_change' },
        },
        evidence: {
          operation: validation.operation || change?.operation || 'update',
          path: validation.relativePath || validation.path || change?.path || '',
          status: 'blocked',
          reason: validation.reason,
          stage: 'idea_file_change',
        },
      };
    }
    const target = this.fileChangePermissionTarget(validation);
    const permission = this.permissionGovernance?.evaluatePermission?.({
      actorType,
      actorId,
      agentRunId: id,
      roomId: timeline.run.roomId,
      sessionId: timeline.run.sessionId,
      taskId: timeline.run.taskId,
      cwd,
      approvalId: validation.approvalId || approvalId,
      action: 'file.write',
      target,
      risk: validation.requiresApproval ? 'high' : 'medium',
      details: {
        stage: 'idea_file_change',
        operation: validation.operation,
        relativePath: validation.relativePath,
        contentSha256: target.contentSha256,
        requiresApproval: validation.requiresApproval,
      },
    });
    if (permission && permission.decision !== 'allow') {
      const status = permission.decision === 'deny' ? 'blocked' : 'approval_required';
      return {
        status,
        approvalId: permission.approval?.id || null,
        toolResult: {
          name: toolName,
          toolName,
          status,
          inputSummary: validation.relativePath,
          outputSummary: permission.reason,
          approvalId: permission.approval?.id || null,
          payload: { permissionDecisionId: permission.id, safeToAutoExecute: false, stage: 'idea_file_change' },
        },
        evidence: {
          operation: validation.operation,
          path: validation.relativePath,
          status,
          reason: permission.reason,
          approvalId: permission.approval?.id || null,
          stage: 'idea_file_change',
        },
      };
    }
    return {
      status: 'allowed',
      validation,
      permission,
      toolName,
    };
  }

  writeGovernedFileChange(plan, { cwd } = {}) {
    const { validation, permission, toolName } = plan;
    const before = fileSnapshot(validation.targetPath);
    const nextContent = validation.operation === 'append' && before.exists
      ? `${readFileSync(validation.targetPath, 'utf8')}${validation.content}`
      : validation.content;
    mkdirSync(dirname(validation.targetPath), { recursive: true });
    writeFileSync(validation.targetPath, nextContent, 'utf8');
    const after = fileSnapshot(validation.targetPath);
    return {
      status: 'passed',
      toolResult: {
        name: toolName,
        toolName,
        status: 'passed',
        inputSummary: `${validation.operation} ${validation.relativePath}`,
        outputSummary: `${validation.operation} ${validation.relativePath} (${before.sha256 || 'new'} -> ${after.sha256})`,
        payload: {
          stage: 'idea_file_change',
          cwd,
          operation: validation.operation,
          path: validation.relativePath,
          before,
          after,
          contentSha256: sha256Text(validation.content),
          permissionDecisionId: permission?.id || null,
          resumeApprovalId: permission?.approval?.id || validation.approvalId || null,
          safeToAutoExecute: true,
        },
      },
      evidence: {
        operation: validation.operation,
        path: validation.relativePath,
        status: 'passed',
        before,
        after,
        contentSha256: sha256Text(validation.content),
        permissionDecisionId: permission?.id || null,
        resumeApprovalId: permission?.approval?.id || validation.approvalId || null,
        stage: 'idea_file_change',
      },
    };
  }

  applyGovernedFileChange(id, timeline, change, options = {}) {
    const plan = this.evaluateGovernedFileChange(id, timeline, change, options);
    if (plan.status !== 'allowed') return plan;
    return this.writeGovernedFileChange(plan, options);
  }

  async executeIdeaRun(id, input = {}) {
    const timeline = this.agentRunStore.getTimeline(id);
    if (!timeline) throw new Error('agent run not found');
    if (timeline.run.sourceType !== 'idea_to_archive') throw new Error('agent run is not an idea_to_archive draft');
    const cwd = resolve(safeString(input.cwd, 2000) || this.cwd || process.cwd());
    if (!existsSync(cwd)) throw new Error('verification cwd does not exist');
    const commands = verificationCommands(timeline, input, cwd);
    const workCommands = workEvidenceCommands(timeline, input, cwd);
    const fileChanges = normalizeFileChanges(input);
    const evidenceArtifacts = normalizeEvidenceArtifacts(input, { cwd });
    const workPlan = buildIdeaWorkPlan(timeline, { cwd, workCommands, verificationCommands: commands, fileChanges, evidenceArtifacts });
    const workPlanMessage = this.agentRunStore.appendMessage(id, {
      kind: 'work_plan',
      role: 'system',
      status: 'ready',
      summary: `Idea work plan prepared: ${fileChanges.length} file changes, ${workCommands.length} work evidence commands, ${commands.length} verification commands.`,
      payload: { workPlan },
    });
    const fileChangeEvidence = [];
    const fileChangePlans = [];
    for (const item of fileChanges) {
      const plan = this.evaluateGovernedFileChange(id, timeline, item, {
        cwd,
        actorType: input.actorType || 'system',
        actorId: input.requestedBy || 'idea-auto-executor',
        approvalId: input.approvalId || input.permissionApprovalId || input.resumeApprovalId,
      });
      if (plan.status === 'allowed') {
        fileChangePlans.push(plan);
        continue;
      }
      const toolResult = this.agentRunStore.appendToolResult(id, {
        ...plan.toolResult,
        payload: {
          ...(plan.toolResult.payload || {}),
          workPlanId: workPlan.id,
        },
      });
      fileChangeEvidence.push({ ...plan.evidence, toolResultId: toolResult.id });
    }
    const pendingApproval = fileChangeEvidence.find((item) => item.status === 'approval_required' && item.approvalId);
    if (pendingApproval) {
      const resumeManifest = buildApprovalResumeManifest(input, { cwd, approvalId: pendingApproval.approvalId });
      const deferred = this.agentRunStore.transition(id, 'deferred', {
        stage: 'idea_file_change_approval_pending',
        deferReason: 'approval_pending',
        approvalId: pendingApproval.approvalId,
        workPlanId: workPlan.id,
        workPlanMessageId: workPlanMessage.id,
        pendingFileChangePath: pendingApproval.path,
        fileChanges: fileChangeEvidence,
        pendingResumeManifest: resumeManifest,
        safeToAutoExecute: false,
      });
      this.agentRunStore.appendMessage(id, {
        kind: 'summary',
        role: 'system',
        status: 'approval_required',
        summary: `Idea file change requires approval before execution: ${pendingApproval.path}`,
        payload: {
          workPlanId: workPlan.id,
          approvalId: pendingApproval.approvalId,
          fileChanges: fileChangeEvidence,
          resumeManifest,
          resumeHint: 'Approve the permission, then retry idea-auto-execute with the same manifest and approvalId.',
        },
      });
      return {
        run: this.agentRunStore.get(id),
        deferred,
        workPlan,
        workPlanMessage,
        fileChanges: fileChangeEvidence,
        workEvidence: [],
        commandEvidence: [],
        evidenceArtifacts,
        approvalId: pendingApproval.approvalId,
        status: 'approval_required',
      };
    }
    const blockedFileChange = fileChangeEvidence.find((item) => item.status === 'blocked');
    if (blockedFileChange) {
      const summary = `Idea file change blocked before execution: ${blockedFileChange.path || blockedFileChange.reason}`;
      return this.agentRunStore.completeIdeaRun(id, {
        actorType: input.actorType || 'system',
        requestedBy: input.requestedBy || 'idea-auto-executor',
        status: 'failed',
        summary,
        archiveSummary: summary,
        affectedFiles: input.affectedFiles || timeline.run.details?.affectedFiles || [],
        verificationResults: [{
          name: blockedFileChange.path ? `file.write ${blockedFileChange.path}` : 'file.write',
          status: 'blocked',
          inputSummary: blockedFileChange.path || '',
          outputSummary: blockedFileChange.reason || 'file change blocked before execution',
          payload: {
            stage: 'idea_file_change',
            workPlanId: workPlan.id,
            safeToAutoExecute: false,
          },
        }],
        evidence: {
          stage: 'idea_file_change_blocked',
          cwd,
          workPlan,
          workPlanMessageId: workPlanMessage.id,
          fileChanges: fileChangeEvidence,
          workEvidence: [],
          commands: [],
          evidenceArtifacts,
          resumeReviewGate: input.resumeReviewGate || null,
          resumeReviewGateAudit: input.resumeReviewGateAudit || null,
        },
      });
    }
    for (const plan of fileChangePlans) {
      const outcome = this.writeGovernedFileChange(plan, { cwd });
      const toolResult = this.agentRunStore.appendToolResult(id, {
        ...outcome.toolResult,
        payload: {
          ...(outcome.toolResult.payload || {}),
          workPlanId: workPlan.id,
        },
      });
      fileChangeEvidence.push({ ...outcome.evidence, toolResultId: toolResult.id });
    }
    const workEvidence = [];
    for (const item of workCommands) {
      const outcome = await this.runGovernedCommand(id, timeline, item, {
        cwd,
        stage: 'idea_work_evidence',
        toolName: 'idea_work_evidence_command',
        validateCommand: validateWorkEvidenceCommand,
        actorType: input.actorType || 'system',
        actorId: input.requestedBy || 'idea-auto-executor',
      });
      const toolResult = this.agentRunStore.appendToolResult(id, {
        ...outcome.toolResult,
        payload: {
          ...(outcome.toolResult.payload || {}),
          workPlanId: workPlan.id,
        },
      });
      workEvidence.push({ ...outcome.evidence, toolResultId: toolResult.id });
    }
    const verificationResults = [];
    const commandEvidence = [];
    for (const item of commands) {
      const outcome = await this.runGovernedCommand(id, timeline, item, {
        cwd,
        stage: 'idea_auto_verification',
        toolName: 'idea_verification_command',
        validateCommand: validateVerificationCommand,
        actorType: input.actorType || 'system',
        actorId: input.requestedBy || 'idea-auto-executor',
      });
      verificationResults.push({
        ...outcome.toolResult,
        payload: {
          ...(outcome.toolResult.payload || {}),
          workPlanId: workPlan.id,
        },
      });
      commandEvidence.push(outcome.evidence);
    }
    const failed = [...fileChangeEvidence, ...workEvidence, ...commandEvidence].some((item) => item.status !== 'passed');
    const finalStatus = failed ? 'failed' : 'succeeded';
    const summary = safeString(input.summary || input.executionSummary, 2000)
      || (failed
        ? `Auto work or verification failed or blocked: ${[
          ...fileChangeEvidence.map((item) => item.path),
          ...workEvidence.map((item) => item.command),
          ...commandEvidence.map((item) => item.command),
        ].filter(Boolean).join(', ')}`
        : `Auto work applied ${fileChangeEvidence.length} file changes; verification passed: ${commandEvidence.map((item) => item.command).join(', ')}; work evidence collected: ${workEvidence.map((item) => item.command).join(', ') || 'none'}`);
    const affectedFiles = [
      ...(input.affectedFiles || timeline.run.details?.affectedFiles || []),
      ...fileChangeEvidence.map((item) => item.path),
    ].filter(Boolean);
    return this.agentRunStore.completeIdeaRun(id, {
      actorType: input.actorType || 'system',
      requestedBy: input.requestedBy || 'idea-auto-executor',
      status: finalStatus,
      summary,
      archiveSummary: summary,
      affectedFiles,
      verificationResults,
      evidence: {
        stage: 'idea_auto_verification',
        cwd,
        workPlan,
        workPlanMessageId: workPlanMessage.id,
        fileChanges: fileChangeEvidence,
        workEvidence,
        commands: commandEvidence,
        evidenceArtifacts,
        resumeReviewGate: input.resumeReviewGate || null,
        resumeReviewGateAudit: input.resumeReviewGateAudit || null,
      },
    });
  }
}
