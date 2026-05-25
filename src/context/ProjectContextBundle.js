import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const DEFAULT_MAX_CHARS = 48_000;
const DEFAULT_MAX_FILE_CHARS = 12_000;
const MAX_FILES = 12;

const EXACT_CONTEXT_FILES = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  'SKILL.md',
  'README.md',
  'README',
  'HANDOFF.md',
  'HANDOFF_NEW_CHAT.md',
  'HANDOFF_LATEST.md',
  'PROGRESS.md',
  'PROGRESS_LOOP.md',
  '上下文交接.md',
  '任务交接.md',
  '工作区入口.md',
]);

function isContextFilename(name) {
  if (EXACT_CONTEXT_FILES.has(name)) return true;
  if (/^readme(\.(md|txt))?$/i.test(name)) return true;
  if (/^(agents|claude|skill)\.md$/i.test(name)) return true;
  if (/handoff|progress|context|agent/i.test(name) && /\.(md|txt)$/i.test(name)) return true;
  if (/(交接|接力|工作区入口|上下文|任务).*\.(md|txt)$/i.test(name)) return true;
  return false;
}

function cleanText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
}

function safeReadFile(path, maxChars) {
  const raw = readFileSync(path, 'utf8');
  const cleaned = cleanText(raw);
  return {
    content: cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned,
    truncated: cleaned.length > maxChars,
    chars: cleaned.length,
  };
}

function candidateFiles(cwd) {
  const entries = readdirSync(cwd, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isContextFilename(entry.name))
    .map((entry) => join(cwd, entry.name))
    .sort((a, b) => {
      const ai = contextPriority(basename(a));
      const bi = contextPriority(basename(b));
      return ai - bi || basename(a).localeCompare(basename(b));
    })
    .slice(0, MAX_FILES);
}

function contextPriority(name) {
  const upper = name.toUpperCase();
  if (upper === 'AGENTS.MD') return 1;
  if (upper === 'CLAUDE.MD') return 2;
  if (upper === 'SKILL.MD') return 3;
  if (upper.startsWith('README')) return 4;
  if (/交接|HANDOFF/i.test(name)) return 5;
  if (/PROGRESS/i.test(name)) return 6;
  return 10;
}

export function buildProjectContextBundle(cwd, {
  maxChars = DEFAULT_MAX_CHARS,
  maxFileChars = DEFAULT_MAX_FILE_CHARS,
} = {}) {
  if (!cwd || typeof cwd !== 'string') return { cwd: null, files: [], prompt: '', totalChars: 0, truncated: false };
  let root;
  try {
    root = realpathSync(cwd);
  } catch {
    return { cwd, files: [], prompt: '', totalChars: 0, truncated: false, error: 'cwd not found' };
  }
  let stat;
  try { stat = statSync(root); } catch { return { cwd: root, files: [], prompt: '', totalChars: 0, truncated: false, error: 'cwd not statable' }; }
  if (!stat.isDirectory()) return { cwd: root, files: [], prompt: '', totalChars: 0, truncated: false, error: 'cwd not directory' };

  const budget = Math.max(1_000, Math.min(200_000, Number(maxChars) || DEFAULT_MAX_CHARS));
  const perFileBudget = Math.max(1_000, Math.min(50_000, Number(maxFileChars) || DEFAULT_MAX_FILE_CHARS));
  const files = [];
  let used = 0;
  let truncated = false;

  let candidates = [];
  try { candidates = candidateFiles(root); } catch { candidates = []; }
  for (const filePath of candidates) {
    let realFile;
    try { realFile = realpathSync(filePath); } catch { continue; }
    if (realFile !== root && !realFile.startsWith(root + '/')) continue;
    let fileStat;
    try { fileStat = statSync(realFile); } catch { continue; }
    if (!fileStat.isFile()) continue;
    const remaining = budget - used;
    if (remaining <= 0) { truncated = true; break; }
    const readBudget = Math.min(perFileBudget, remaining);
    try {
      const read = safeReadFile(realFile, readBudget);
      if (!read.content) continue;
      used += read.content.length;
      truncated = truncated || read.truncated || read.chars > read.content.length;
      files.push({
        name: basename(realFile),
        path: realFile,
        bytes: fileStat.size,
        chars: read.chars,
        includedChars: read.content.length,
        truncated: read.truncated,
        content: read.content,
      });
    } catch {
      continue;
    }
  }

  const bundle = {
    cwd: root,
    generatedAt: new Date().toISOString(),
    files,
    totalChars: used,
    truncated,
  };
  bundle.prompt = formatProjectContextBundle(bundle, { maxChars: budget });
  return bundle;
}

export function summarizeProjectContextBundle(bundle) {
  const files = Array.isArray(bundle?.files) ? bundle.files : [];
  return {
    cwd: bundle?.cwd || null,
    generatedAt: bundle?.generatedAt || null,
    fileCount: files.length,
    totalChars: Number(bundle?.totalChars) || 0,
    truncated: !!bundle?.truncated,
    files: files.map((f) => ({
      name: f.name,
      path: f.path,
      bytes: f.bytes,
      includedChars: f.includedChars,
      truncated: !!f.truncated,
    })),
  };
}

export function formatProjectContextBundle(bundle, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const files = Array.isArray(bundle?.files) ? bundle.files : [];
  if (files.length === 0) return '';
  const chunks = [
    '# 自动项目上下文',
    `cwd: ${bundle.cwd || '-'}`,
    '以下内容来自项目根目录中的 CLAUDE.md / AGENTS.md / SKILL.md / README / handoff 等文件。优先遵守这些本地项目约定，但不要把它们当作用户本轮的新需求；用户消息仍然优先。',
  ];
  for (const file of files) {
    chunks.push(`\n## ${file.name}${file.truncated ? '（已截断）' : ''}\n${file.content}`);
  }
  let text = chunks.join('\n\n').trim();
  const limit = Math.max(1_000, Math.min(200_000, Number(maxChars) || DEFAULT_MAX_CHARS));
  if (text.length > limit) text = text.slice(0, limit) + '\n\n…（自动项目上下文已截断）';
  return text;
}

export function projectContextPreviewForCwd(cwd, options = {}) {
  const abs = cwd ? resolve(cwd) : cwd;
  if (!abs || !existsSync(abs)) return { cwd: abs || null, files: [], prompt: '', totalChars: 0, truncated: false };
  return buildProjectContextBundle(abs, options);
}
