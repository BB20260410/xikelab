import { cosineSim, hashEmbed } from '../embeddings/EmbeddingProvider.js';
import { tokenizeCodebaseQuery } from './CodebaseQueryEngine.js';
import { CODEBASE_LIMITS } from './codebaseLimits.js';

const MAX_VECTOR_ROWS = CODEBASE_LIMITS.maxVectorRows;
const MAX_BODY_CHARS = 1800;
const MIN_VECTOR_SCORE = 0.14;

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function uniq(list) {
  return [...new Set((list || []).filter(Boolean))];
}

function compactBody(parts = []) {
  return parts
    .map((part) => safeString(part, 500))
    .filter(Boolean)
    .join('\n')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_BODY_CHARS);
}

function routesForFile(file = {}) {
  return (file.anchors || [])
    .filter((anchor) => anchor.kind === 'route' || anchor.kind === 'api')
    .slice(0, 8)
    .map((anchor) => ({
      kind: safeString(anchor.kind, 40),
      name: safeString(anchor.name, 180),
      line: Math.max(1, Number(anchor.line) || 1),
    }));
}

function symbolsForFile(file = {}) {
  return (file.symbols || []).slice(0, 8).map((symbol) => ({
    name: safeString(symbol.name, 120),
    type: safeString(symbol.type, 40),
    line: Math.max(1, Number(symbol.line) || 1),
    exported: !!symbol.exported,
  })).filter((symbol) => symbol.name);
}

function buildVectorText(file = {}) {
  return compactBody([
    file.path,
    file.language,
    file.parser,
    ...(file.symbols || []).map((symbol) => `${symbol.type} ${symbol.name} ${symbol.exported ? 'exported' : 'local'}`),
    ...(file.imports || []).map((item) => `import ${item.source} ${(item.specifiers || []).map((specifier) => `${specifier.imported}:${specifier.local}`).join(' ')}`),
    ...(file.exports || []).map((item) => `export ${item.name} ${item.local} ${item.source || ''}`),
    ...(file.anchors || []).map((anchor) => `${anchor.kind} ${anchor.name}`),
    ...(file.references || []).map((ref) => `${ref.kind} ${ref.name} ${ref.text}`),
    ...(file.snippets || []).map((snippet) => `${snippet.reason || 'snippet'} ${snippet.text}`),
  ]);
}

function lineForFile(file = {}) {
  const firstSymbol = (file.symbols || [])[0];
  const firstAnchor = (file.anchors || [])[0];
  const firstSnippet = (file.snippets || [])[0];
  return Math.max(1, Number(firstSymbol?.line || firstAnchor?.line || firstSnippet?.line) || 1);
}

function queryText(query = '') {
  const tokens = tokenizeCodebaseQuery(query);
  return compactBody([query, tokens.join(' ')]);
}

function normalizeVectorScore(score, index) {
  const clamped = Math.max(0, Math.min(1, Number(score) || 0));
  return Math.max(1, Math.round(clamped * 42) - Math.min(10, index));
}

export function buildCodebaseVectorIndex(map = {}) {
  const rows = [];
  for (const file of map.evidence || []) {
    if (rows.length >= MAX_VECTOR_ROWS) break;
    const text = buildVectorText(file);
    if (!text) continue;
    rows.push({
      path: file.path,
      line: lineForFile(file),
      kind: 'file-vector',
      anchor: file.path,
      parser: file.parser || 'unknown',
      text,
      symbols: symbolsForFile(file),
      routes: routesForFile(file),
      vector: hashEmbed(text),
    });
  }

  return {
    summary: {
      enabled: true,
      engine: 'local-hash-vector',
      provider: 'hash',
      model: 'hash-128',
      ranking: 'cosine',
      fileCount: (map.evidence || []).length,
      rowCount: rows.length,
      maxRows: MAX_VECTOR_ROWS,
      minScore: MIN_VECTOR_SCORE,
    },
    query(query, { maxResults = 20 } = {}) {
      if (!rows.length) return [];
      const vector = hashEmbed(queryText(query));
      const limit = Math.max(1, Math.min(100, Number(maxResults) || 20));
      return rows
        .map((row) => {
          const semanticScore = cosineSim(row.vector, vector);
          return {
            path: row.path,
            line: row.line,
            kind: row.kind,
            anchor: row.anchor,
            parser: row.parser,
            text: safeString(row.text, 260),
            score: semanticScore,
            semanticScore,
            reason: uniq(['local-hash-vector', 'cosine', 'semantic-vector']),
            symbols: row.symbols,
            routes: row.routes,
          };
        })
        .filter((row) => row.semanticScore >= MIN_VECTOR_SCORE)
        .sort((a, b) => b.semanticScore - a.semanticScore || a.path.localeCompare(b.path))
        .slice(0, limit)
        .map((row, index) => ({
          ...row,
          score: normalizeVectorScore(row.semanticScore, index),
        }));
    },
  };
}
