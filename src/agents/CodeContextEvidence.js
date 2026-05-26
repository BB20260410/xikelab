import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { defaultParserRegistry } from './parsers/ParserRegistry.js';

const MAX_EVIDENCE_FILES = 24;
const MAX_FILE_BYTES = 500_000;
const MAX_SYMBOLS_PER_FILE = 16;
const MAX_IMPORTS_PER_FILE = 18;
const MAX_EXPORTS_PER_FILE = 18;
const MAX_ANCHORS_PER_FILE = 18;
const MAX_SNIPPETS_PER_FILE = 10;
const MAX_REFERENCES_PER_FILE = 120;
const MAX_DIAGNOSTICS_PER_FILE = 5;
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.scss', '.ts', '.tsx', '.txt',
]);

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function compactPath(value) {
  let text = safeString(value, 300);
  if (!text) return '';
  text = text.replace(/^[ MADRCU?!]{1,3}\s+/, '').trim();
  if (text.includes(' -> ')) text = text.split(' -> ').pop().trim();
  return text.replace(/\\/g, '/').replace(/^\/+/, '');
}

function extensionOf(path = '') {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx).toLowerCase() : '';
}

function detectLanguage(path = '') {
  const ext = extensionOf(path);
  if (['.js', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (['.ts', '.tsx'].includes(ext)) return 'typescript';
  if (ext === '.jsx') return 'javascript';
  if (ext === '.css' || ext === '.scss') return 'css';
  if (ext === '.html') return 'html';
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (ext === '.json') return 'json';
  return ext ? ext.slice(1) : 'text';
}

function isTextLike(path = '') {
  const ext = extensionOf(path);
  return TEXT_EXTENSIONS.has(ext) || /(^|\/)(Dockerfile|LICENSE|README)$/i.test(path);
}

function safeProjectFile(cwd, inputPath) {
  const displayPath = compactPath(inputPath);
  if (!cwd || !displayPath || !isTextLike(displayPath)) return null;
  const root = resolve(cwd);
  const abs = resolve(root, displayPath);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || rel.includes('\0') || rel.startsWith('/')) return null;
  return { abs, rel: rel.replace(/\\/g, '/') };
}

function pushLimited(list, item, limit, keyFn = null) {
  if (!item || list.length >= limit) return;
  if (keyFn) {
    const key = keyFn(item);
    if (key && list.some((existing) => keyFn(existing) === key)) return;
  }
  list.push(item);
}

function cleanSnippet(line = '') {
  return line.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function addSnippet(snippets, line, lineNumber, reason) {
  const text = cleanSnippet(line);
  if (!text || text.length < 4) return;
  pushLimited(snippets, { line: lineNumber, reason, text }, MAX_SNIPPETS_PER_FILE, (item) => `${item.line}:${item.reason}`);
}

function extractJsLike(lines) {
  const symbols = [];
  const imports = [];
  const exports = [];
  const anchors = [];
  const snippets = [];

  const symbolPatterns = [
    { type: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/ },
    { type: 'class', re: /^\s*(?:export\s+default\s+)?class\s+([A-Za-z_$][\w$]*)\b/ },
    { type: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { type: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
  ];

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;
    for (const pattern of symbolPatterns) {
      const match = line.match(pattern.re);
      if (!match) continue;
      pushLimited(symbols, {
        name: match[1],
        type: pattern.type,
        line: lineNumber,
        exported: /\bexport\b/.test(line),
      }, MAX_SYMBOLS_PER_FILE, (item) => `${item.type}:${item.name}`);
      if (/\bexport\b/.test(line)) {
        pushLimited(exports, {
          name: match[1],
          local: match[1],
          kind: 'named',
          line: lineNumber,
        }, MAX_EXPORTS_PER_FILE, (item) => `${item.kind}:${item.name}:${item.local}:${item.line}`);
      }
      addSnippet(snippets, line, lineNumber, 'symbol');
      break;
    }

    const dynamicImportMatch = line.match(/\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/);
    if (dynamicImportMatch) {
      pushLimited(imports, {
        source: dynamicImportMatch[1],
        line: lineNumber,
        kind: 'dynamic-import',
        specifiers: [{ imported: '*', local: 'import', kind: 'dynamic' }],
      }, MAX_IMPORTS_PER_FILE, (item) => `${item.kind || 'import'}:${item.source}`);
      addSnippet(snippets, line, lineNumber, 'dynamic-import');
    }

    const importMatch = line.match(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/) ||
      line.match(/^\s*export\s+.+?\s+from\s+['"]([^'"]+)['"]/) ||
      line.match(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/);
    if (importMatch) {
      pushLimited(imports, { source: importMatch[1], line: lineNumber }, MAX_IMPORTS_PER_FILE, (item) => item.source);
      addSnippet(snippets, line, lineNumber, 'import');
    }

    const exportFromMatch = line.match(/^\s*export\s+(?:\{([^}]+)\}|\*)\s+from\s+['"]([^'"]+)['"]/);
    if (exportFromMatch) {
      const source = exportFromMatch[2];
      const names = exportFromMatch[1]
        ? exportFromMatch[1].split(',').map((part) => part.trim()).filter(Boolean)
        : ['*'];
      for (const part of names) {
        const aliasMatch = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        const local = aliasMatch ? aliasMatch[1] : part;
        const name = aliasMatch?.[2] || local;
        pushLimited(exports, {
          name,
          local,
          source,
          kind: part === '*' ? 'all' : 're-export',
          line: lineNumber,
        }, MAX_EXPORTS_PER_FILE, (item) => `${item.kind}:${item.name}:${item.local}:${item.source}:${item.line}`);
      }
    }

    const routeMatch = line.match(/\bapp\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/);
    if (routeMatch) {
      pushLimited(anchors, { kind: 'route', name: `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`, line: lineNumber }, MAX_ANCHORS_PER_FILE, (item) => `${item.kind}:${item.name}`);
      addSnippet(snippets, line, lineNumber, 'route');
    }

    const testMatch = line.match(/\b(describe|it|test)\(\s*['"`]([^'"`]+)['"`]/);
    if (testMatch) {
      pushLimited(anchors, { kind: testMatch[1], name: testMatch[2].slice(0, 120), line: lineNumber }, MAX_ANCHORS_PER_FILE, (item) => `${item.kind}:${item.name}`);
      addSnippet(snippets, line, lineNumber, 'test');
    }

    const apiMatch = line.match(/['"`](\/api\/[^'"`\s)]+)['"`]/);
    if (apiMatch) {
      pushLimited(anchors, { kind: 'api', name: apiMatch[1], line: lineNumber }, MAX_ANCHORS_PER_FILE, (item) => `${item.kind}:${item.name}`);
    }
  });

  return { parser: 'regex', diagnostics: [], symbols, imports, exports, anchors, snippets, references: [] };
}

function extractCss(lines) {
  const anchors = [];
  const snippets = [];
  lines.forEach((line, idx) => {
    const match = line.match(/^\s*([.#][A-Za-z0-9_-][^{,\s]*)\s*[{,]/);
    if (!match) return;
    pushLimited(anchors, { kind: 'selector', name: match[1], line: idx + 1 }, MAX_ANCHORS_PER_FILE, (item) => item.name);
    addSnippet(snippets, line, idx + 1, 'selector');
  });
  return { symbols: [], imports: [], anchors, snippets };
}

function extractHtml(lines) {
  const anchors = [];
  const snippets = [];
  lines.forEach((line, idx) => {
    const idMatch = line.match(/\bid=["']([^"']+)["']/);
    if (!idMatch) return;
    pushLimited(anchors, { kind: 'dom-id', name: `#${idMatch[1]}`, line: idx + 1 }, MAX_ANCHORS_PER_FILE, (item) => item.name);
    addSnippet(snippets, line, idx + 1, 'dom-id');
  });
  return { symbols: [], imports: [], anchors, snippets };
}

function extractMarkdown(lines) {
  const anchors = [];
  const snippets = [];
  lines.forEach((line, idx) => {
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (!match) return;
    pushLimited(anchors, { kind: 'heading', name: match[2].slice(0, 140), line: idx + 1 }, MAX_ANCHORS_PER_FILE, (item) => item.name);
    addSnippet(snippets, line, idx + 1, 'heading');
  });
  return { symbols: [], imports: [], anchors, snippets };
}

function extractEvidence(path, text) {
  const language = detectLanguage(path);
  const lines = String(text || '').split(/\r?\n/);
  const ext = extensionOf(path);
  const astAdapter = defaultParserRegistry.getAdapter(ext);
  if (['javascript', 'typescript'].includes(language) && astAdapter) {
    const ast = astAdapter.parse({ path, text });
    if (ast.ok) return { language, ...ast };
    return { language, ...extractJsLike(lines), diagnostics: ast.diagnostics || [] };
  }
  if (['javascript', 'typescript'].includes(language)) return { language, ...extractJsLike(lines) };
  if (language === 'css') return { language, parser: 'selector-regex', diagnostics: [], references: [], ...extractCss(lines) };
  if (language === 'html') return { language, parser: 'dom-regex', diagnostics: [], references: [], ...extractHtml(lines) };
  if (language === 'markdown') return { language, parser: 'heading-regex', diagnostics: [], references: [], ...extractMarkdown(lines) };
  return { language, parser: 'none', diagnostics: [], symbols: [], imports: [], anchors: [], snippets: [], references: [] };
}

function sanitizeEvidenceFile(input = {}) {
  const path = compactPath(input.path || input.file || input.relativePath);
  if (!path) return null;
  return {
    path,
    language: safeString(input.language || detectLanguage(path), 40),
    parser: safeString(input.parser, 40) || 'unknown',
    exists: input.exists !== false,
    bytes: Math.max(0, Number(input.bytes) || 0),
    lineCount: Math.max(0, Number(input.lineCount) || 0),
    diagnostics: Array.isArray(input.diagnostics) ? input.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE).map((item) => ({
      code: safeString(item.code, 80) || 'diagnostic',
      message: safeString(item.message, 240),
      line: Math.max(1, Number(item.line) || 1),
      column: Math.max(0, Number(item.column) || 0),
    })).filter((item) => item.message || item.code) : [],
    symbols: Array.isArray(input.symbols) ? input.symbols.slice(0, MAX_SYMBOLS_PER_FILE).map((item) => ({
      name: safeString(item.name, 120),
      type: safeString(item.type, 40) || 'symbol',
      line: Math.max(1, Number(item.line) || 1),
      exported: !!item.exported,
      owner: safeString(item.owner, 120),
      ownerType: safeString(item.ownerType, 40),
    })).filter((item) => item.name) : [],
    imports: Array.isArray(input.imports) ? input.imports.slice(0, MAX_IMPORTS_PER_FILE).map((item) => ({
      source: safeString(item.source, 160),
      line: Math.max(1, Number(item.line) || 1),
      kind: safeString(item.kind, 40) || 'import',
      specifiers: Array.isArray(item.specifiers) ? item.specifiers.slice(0, 12).map((specifier) => ({
        imported: safeString(specifier.imported, 120),
        local: safeString(specifier.local, 120),
        kind: safeString(specifier.kind, 40) || 'named',
      })).filter((specifier) => specifier.imported || specifier.local) : [],
    })).filter((item) => item.source) : [],
    exports: Array.isArray(input.exports) ? input.exports.slice(0, MAX_EXPORTS_PER_FILE).map((item) => ({
      name: safeString(item.name, 120),
      local: safeString(item.local || item.name, 120),
      source: safeString(item.source, 160),
      kind: safeString(item.kind, 40) || 'named',
      line: Math.max(1, Number(item.line) || 1),
    })).filter((item) => item.name) : [],
    anchors: Array.isArray(input.anchors) ? input.anchors.slice(0, MAX_ANCHORS_PER_FILE).map((item) => ({
      kind: safeString(item.kind, 40) || 'anchor',
      name: safeString(item.name, 180),
      line: Math.max(1, Number(item.line) || 1),
    })).filter((item) => item.name) : [],
    snippets: Array.isArray(input.snippets) ? input.snippets.slice(0, MAX_SNIPPETS_PER_FILE).map((item) => ({
      line: Math.max(1, Number(item.line) || 1),
      reason: safeString(item.reason, 40) || 'evidence',
      text: safeString(item.text, 240),
    })).filter((item) => item.text) : [],
    references: Array.isArray(input.references) ? input.references.slice(0, MAX_REFERENCES_PER_FILE).map((item) => ({
      name: safeString(item.name || item.symbol, 120),
      kind: safeString(item.kind, 40) || 'reference',
      line: Math.max(1, Number(item.line) || 1),
      text: safeString(item.text, 240),
    })).filter((item) => item.name) : [],
  };
}

export function normalizeCodeContextEvidence(input = {}) {
  const source = input && typeof input === 'object'
    ? (input.codeContextEvidence || input.evidence || input.files || input)
    : input;
  const list = Array.isArray(source) ? source : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const file = sanitizeEvidenceFile(item);
    if (!file || seen.has(file.path.toLowerCase())) continue;
    seen.add(file.path.toLowerCase());
    out.push(file);
    if (out.length >= MAX_EVIDENCE_FILES) break;
  }
  return out;
}

export function buildCodeContextEvidenceFile({ cwd, file, fsApi = {}, text: providedText = null, meta: providedMeta = null } = {}) {
  const itemPath = typeof file === 'string' ? file : file?.path;
  const resolved = safeProjectFile(cwd, itemPath);
  if (!resolved) return null;
  const exists = fsApi.existsSync || existsSync;
  const stat = fsApi.statSync || statSync;
  const read = fsApi.readFileSync || readFileSync;
  const base = {
    path: resolved.rel,
    language: detectLanguage(resolved.rel),
    exists: false,
    bytes: 0,
    lineCount: 0,
    parser: 'unknown',
    diagnostics: [],
    symbols: [],
    imports: [],
    exports: [],
    anchors: [],
    snippets: [],
    references: [],
  };

  try {
    if (!exists(resolved.abs)) return normalizeCodeContextEvidence([{ ...base }])[0] || base;
    const meta = providedMeta || stat(resolved.abs);
    if (!meta.isFile() || meta.size > MAX_FILE_BYTES) {
      return normalizeCodeContextEvidence([{ ...base, exists: meta.isFile(), bytes: meta.size }])[0] || base;
    }
    const text = providedText === null || providedText === undefined ? read(resolved.abs, 'utf8') : providedText;
    const extracted = extractEvidence(resolved.rel, text);
    return normalizeCodeContextEvidence([{
      ...base,
      ...extracted,
      exists: true,
      bytes: meta.size,
      lineCount: String(text || '').split(/\r?\n/).length,
    }])[0] || base;
  } catch (e) {
    return normalizeCodeContextEvidence([{
      ...base,
      error: safeString(e?.message || String(e), 200),
    }])[0] || base;
  }
}

export function buildCodeContextEvidence({ cwd, files = [], fsApi = {} } = {}) {
  const evidence = [];
  const seen = new Set();
  for (const file of files || []) {
    const itemPath = typeof file === 'string' ? file : file?.path;
    const resolved = safeProjectFile(cwd, itemPath);
    if (!resolved || seen.has(resolved.rel.toLowerCase())) continue;
    seen.add(resolved.rel.toLowerCase());
    const fileEvidence = buildCodeContextEvidenceFile({ cwd, file: resolved.rel, fsApi });
    if (fileEvidence) evidence.push(fileEvidence);

    if (evidence.length >= MAX_EVIDENCE_FILES) break;
  }

  return normalizeCodeContextEvidence(evidence);
}

export function summarizeCodeContextEvidence(input = {}) {
  const evidence = normalizeCodeContextEvidence(input);
  const symbols = [];
  const anchors = [];
  const imports = [];
  const exports = [];
  const references = [];
  const parsers = new Map();
  for (const file of evidence) {
    for (const symbol of file.symbols || []) symbols.push({ ...symbol, path: file.path });
    for (const anchor of file.anchors || []) anchors.push({ ...anchor, path: file.path });
    for (const dep of file.imports || []) imports.push({ ...dep, path: file.path });
    for (const item of file.exports || []) exports.push({ ...item, path: file.path });
    for (const ref of file.references || []) references.push({ ...ref, path: file.path });
    const parser = file.parser || 'unknown';
    parsers.set(parser, (parsers.get(parser) || 0) + 1);
  }
  return {
    fileCount: evidence.length,
    symbolCount: symbols.length,
    anchorCount: anchors.length,
    importCount: imports.length,
    exportCount: exports.length,
    referenceCount: references.length,
    parserCounts: Object.fromEntries(parsers.entries()),
    topSymbols: symbols.slice(0, 12),
    topAnchors: anchors.slice(0, 12),
    topImports: imports.slice(0, 12),
    topExports: exports.slice(0, 12),
    topReferences: references.slice(0, 12),
  };
}
