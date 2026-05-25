import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { buildCodeContextEvidence, summarizeCodeContextEvidence } from './CodeContextEvidence.js';
import { inferCodeContextSignals } from './CodeContextSignals.js';
import { scorePathForCodebaseQuery, tokenizeCodebaseQuery } from './CodebaseQueryEngine.js';
import { buildSymbolGraph, summarizeSymbolGraph } from './SymbolGraph.js';

const MAX_SCAN_FILES = 260;
const MAX_FOCUS_FILES = 24;
const MAX_FILE_BYTES = 500_000;
const MAX_SNIPPET_CHARS = 220;
const MAX_SCAN_MS = 1200;
const IGNORED_DIRS = new Set([
  '.git',
  '.idea',
  '.vscode',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'output',
  'tmp',
]);
const IGNORED_PREFIXES = [
  'public/vendor/',
];
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.scss', '.ts', '.tsx', '.txt',
]);

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function extensionOf(path = '') {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx).toLowerCase() : '';
}

function isTextLike(path = '') {
  const ext = extensionOf(path);
  return TEXT_EXTENSIONS.has(ext) || /(^|\/)(Dockerfile|LICENSE|README)$/i.test(path);
}

function normalizeRel(path = '') {
  return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function isIgnoredPath(rel = '') {
  const normalized = normalizeRel(rel);
  if (!normalized) return true;
  if (IGNORED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  return normalized.split('/').some((part) => IGNORED_DIRS.has(part));
}

function withinRoot(root, abs) {
  const rel = relative(root, abs);
  return rel && !rel.startsWith('..') && !rel.includes('\0') && !rel.startsWith('/');
}

function collectCandidateFiles(cwd, { fsApi = {}, maxFiles = MAX_SCAN_FILES } = {}) {
  const exists = fsApi.existsSync || existsSync;
  const readDir = fsApi.readdirSync || readdirSync;
  const stat = fsApi.statSync || statSync;
  const root = resolve(cwd || '');
  if (!cwd || !exists(root)) return [];
  const out = [];
  const queue = [''];
  const deadline = Date.now() + MAX_SCAN_MS;

  while (queue.length > 0 && out.length < maxFiles && Date.now() < deadline) {
    const relDir = queue.shift();
    const absDir = resolve(root, relDir);
    let entries = [];
    try {
      entries = readDir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (Date.now() >= deadline) break;
      const rel = normalizeRel(join(relDir, entry.name));
      if (!rel || isIgnoredPath(rel)) continue;
      const abs = resolve(root, rel);
      if (!withinRoot(root, abs)) continue;
      if (entry.isDirectory()) {
        queue.push(rel);
        continue;
      }
      if (!entry.isFile() || !isTextLike(rel)) continue;
      try {
        const meta = stat(abs);
        if (!meta.isFile() || meta.size > MAX_FILE_BYTES) continue;
        out.push({ path: rel, abs, bytes: meta.size });
      } catch {
        continue;
      }
      if (out.length >= maxFiles) break;
    }
  }

  return out;
}

function priorityForPath(path = '') {
  const lower = path.toLowerCase();
  let score = 0;
  if (lower.startsWith('src/agents/')) score += 9;
  if (lower.startsWith('src/server/')) score += 7;
  if (lower.startsWith('src/room/')) score += 7;
  if (lower === 'server.js') score += 6;
  if (lower === 'public/app.js') score += 6;
  if (lower.startsWith('tests/')) score += 1;
  if (lower.startsWith('docs/')) score += 2;
  if (lower.endsWith('.test.js')) score += 1;
  return score;
}

function lineNumberAt(text, idx) {
  if (idx <= 0) return 1;
  return String(text).slice(0, idx).split(/\r?\n/).length;
}

function scoreFile(candidate, queryTokens, { fsApi = {} } = {}) {
  const read = fsApi.readFileSync || readFileSync;
  const lowerPath = candidate.path.toLowerCase();
  let score = priorityForPath(candidate.path);
  const reasons = [];
  const snippets = [];
  if (score > 0) reasons.push('project priority');

  let text = '';
  try {
    text = read(candidate.abs, 'utf8');
  } catch {
    text = '';
  }
  const lowerText = text.toLowerCase();
  const snippetLocations = [];
  const intent = scorePathForCodebaseQuery(candidate.path, queryTokens, text);
  if (intent.score !== 0) {
    score += intent.score;
    reasons.push(...intent.reasons);
  }

  for (const token of queryTokens) {
    if (lowerPath.includes(token)) {
      score += 18;
      reasons.push(`path:${token}`);
    }
    const idx = lowerText.indexOf(token);
    if (idx >= 0) {
      score += 6;
      reasons.push(`text:${token}`);
      const before = Math.max(0, idx - 80);
      const after = Math.min(text.length, idx + 140);
      const snippet = text.slice(before, after).replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET_CHARS);
      snippets.push(snippet);
      snippetLocations.push({ line: lineNumberAt(text, idx), reason: `text:${token}`, text: snippet });
    }
  }

  if (/\bexport\b|function\s+[A-Za-z_$]|class\s+[A-Za-z_$]|app\.(get|post|put|delete|patch)\(/.test(text)) {
    score += 3;
    reasons.push('source landmarks');
  }

  return {
    path: candidate.path,
    bytes: candidate.bytes,
    score,
    reasons: [...new Set(reasons)].slice(0, 8),
    snippets: [...new Set(snippets)].filter(Boolean).slice(0, 3),
    snippetLocations: snippetLocations
      .filter((item, idx, list) => item.text && list.findIndex((entry) => entry.line === item.line && entry.reason === item.reason) === idx)
      .slice(0, 6),
  };
}

function resolveImportTarget(fromPath, source, availablePaths) {
  if (!source || !source.startsWith('.')) return null;
  const base = normalizeRel(join(dirname(fromPath), source));
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.jsx`,
    `${base}/index.js`,
    `${base}/index.ts`,
  ].map(normalizeRel);
  return candidates.find((candidate) => availablePaths.has(candidate)) || null;
}

function buildImportGraph(evidence = []) {
  const availablePaths = new Set(evidence.map((file) => file.path));
  const nodes = evidence.map((file) => ({
    path: file.path,
    language: file.language,
    symbols: (file.symbols || []).length,
    anchors: (file.anchors || []).length,
    imports: (file.imports || []).length,
  }));
  const edges = [];
  for (const file of evidence) {
    for (const item of file.imports || []) {
      const target = resolveImportTarget(file.path, item.source, availablePaths);
      if (!target) continue;
      edges.push({
        from: file.path,
        to: target,
        source: item.source,
        line: item.line,
      });
      if (edges.length >= 120) break;
    }
    if (edges.length >= 120) break;
  }
  return { nodes, edges, nodeCount: nodes.length, edgeCount: edges.length };
}

export function buildCodebaseMap(cwd, { query = '', limit = MAX_FOCUS_FILES, fsApi = {} } = {}) {
  const safeLimit = Math.max(4, Math.min(MAX_FOCUS_FILES, Number(limit) || MAX_FOCUS_FILES));
  const candidates = collectCandidateFiles(cwd, { fsApi });
  const queryTokens = tokenizeCodebaseQuery(query);
  const scored = candidates
    .map((candidate) => scoreFile(candidate, queryTokens, { fsApi }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const focusFiles = scored.slice(0, safeLimit).filter((item) => item.score > 0 || queryTokens.length === 0);
  const evidence = buildCodeContextEvidence({ cwd, files: focusFiles });
  const evidenceSummary = summarizeCodeContextEvidence(evidence);
  const graph = buildImportGraph(evidence);
  const symbolGraph = buildSymbolGraph({ cwd, evidence, fsApi });
  const symbolGraphSummary = summarizeSymbolGraph(symbolGraph);
  const codeContextSignals = inferCodeContextSignals({ affectedFiles: focusFiles.map((file) => file.path), evidence });

  return {
    ok: true,
    cwd,
    query: safeString(query, 300),
    scannedFileCount: candidates.length,
    focusFileCount: focusFiles.length,
    focusFiles,
    evidence,
    evidenceSummary,
    graph,
    symbolGraph,
    symbolGraphSummary,
    codeContextSignals,
  };
}
