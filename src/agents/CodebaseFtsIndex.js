import Database from 'better-sqlite3';
import { tokenizeCodebaseQuery } from './CodebaseQueryEngine.js';

const MAX_FTS_ROWS = 2500;
const MAX_BODY_CHARS = 1200;
const MAX_QUERY_TOKENS = 24;

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function uniq(list) {
  return [...new Set((list || []).filter(Boolean))];
}

function escapeFtsToken(token = '') {
  return safeString(token, 80).replace(/"/g, '""');
}

function buildMatchQuery(query = '') {
  const tokens = tokenizeCodebaseQuery(query)
    .map((token) => token.toLowerCase())
    .filter((token) => /^[a-z0-9_$\u4e00-\u9fff-]{2,80}$/u.test(token))
    .slice(0, MAX_QUERY_TOKENS);
  if (!tokens.length) return '';
  return uniq(tokens).map((token) => `"${escapeFtsToken(token)}"*`).join(' OR ');
}

function compactBody(parts = []) {
  return parts
    .map((part) => safeString(part, 400))
    .filter(Boolean)
    .join('\n')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_BODY_CHARS);
}

function symbolsJson(symbols = []) {
  return JSON.stringify((symbols || []).slice(0, 8).map((item) => ({
    name: safeString(item.name, 120),
    type: safeString(item.type, 40),
    line: Math.max(1, Number(item.line) || 1),
    exported: !!item.exported,
  })).filter((item) => item.name));
}

function routesJson(routes = []) {
  return JSON.stringify((routes || []).slice(0, 8).map((item) => ({
    kind: safeString(item.kind, 40),
    name: safeString(item.name, 180),
    line: Math.max(1, Number(item.line) || 1),
  })).filter((item) => item.name));
}

function normalizeRankScore(rank, index) {
  const rankMagnitude = Math.abs(Number(rank) || 0);
  const rankScore = Math.max(1, 36 - Math.min(24, Math.floor(rankMagnitude * 1_000_000)));
  return Math.max(1, rankScore - Math.min(16, index));
}

function insertRow(insert, row) {
  insert.run(
    safeString(row.path, 500),
    Math.max(1, Number(row.line) || 1),
    safeString(row.kind, 80) || 'text',
    safeString(row.anchor, 240),
    safeString(row.parser, 80) || 'unknown',
    safeString(row.body, MAX_BODY_CHARS),
    row.symbols || '[]',
    row.routes || '[]',
    safeString(row.reason, 240),
  );
}

function addEvidenceRows(insert, evidence) {
  let rowCount = 0;
  const add = (row) => {
    if (rowCount >= MAX_FTS_ROWS) return;
    insertRow(insert, row);
    rowCount += 1;
  };

  for (const file of evidence || []) {
    const routeAnchors = (file.anchors || []).filter((anchor) => anchor.kind === 'route' || anchor.kind === 'api');
    add({
      path: file.path,
      line: 1,
      kind: 'file',
      anchor: file.path,
      parser: file.parser,
      body: compactBody([
        file.path,
        file.language,
        file.parser,
        ...(file.symbols || []).map((symbol) => `${symbol.type} ${symbol.name}`),
        ...(file.imports || []).map((item) => `import ${item.source} ${(item.specifiers || []).map((specifier) => `${specifier.imported}:${specifier.local}`).join(' ')}`),
        ...(file.exports || []).map((item) => `export ${item.name} ${item.local} ${item.source || ''}`),
        ...(file.anchors || []).map((anchor) => `${anchor.kind} ${anchor.name}`),
        ...(file.snippets || []).map((snippet) => snippet.text),
        ...(file.references || []).map((ref) => `${ref.kind} ${ref.name} ${ref.text}`),
      ]),
      symbols: symbolsJson(file.symbols),
      routes: routesJson(routeAnchors),
      reason: 'fts:file',
    });

    for (const symbol of file.symbols || []) {
      add({
        path: file.path,
        line: symbol.line,
        kind: `symbol:${symbol.type}`,
        anchor: symbol.name,
        parser: file.parser,
        body: compactBody([file.path, symbol.type, symbol.name, symbol.exported ? 'exported' : 'local']),
        symbols: symbolsJson([symbol]),
        routes: '[]',
        reason: 'fts:symbol',
      });
    }

    for (const anchor of file.anchors || []) {
      const isRoute = anchor.kind === 'route' || anchor.kind === 'api';
      add({
        path: file.path,
        line: anchor.line,
        kind: `anchor:${anchor.kind}`,
        anchor: anchor.name,
        parser: file.parser,
        body: compactBody([file.path, anchor.kind, anchor.name]),
        symbols: symbolsJson(file.symbols || []),
        routes: routesJson(isRoute ? [anchor] : []),
        reason: isRoute ? 'fts:route' : `fts:anchor:${anchor.kind}`,
      });
    }

    for (const snippet of file.snippets || []) {
      add({
        path: file.path,
        line: snippet.line,
        kind: 'text',
        anchor: snippet.reason,
        parser: file.parser,
        body: compactBody([file.path, snippet.reason, snippet.text]),
        symbols: symbolsJson(file.symbols || []),
        routes: '[]',
        reason: `fts:text:${snippet.reason || 'snippet'}`,
      });
    }

    for (const ref of file.references || []) {
      add({
        path: file.path,
        line: ref.line,
        kind: `reference:${ref.kind}`,
        anchor: ref.name,
        parser: file.parser,
        body: compactBody([file.path, ref.kind, ref.name, ref.text]),
        symbols: symbolsJson(file.symbols || []),
        routes: '[]',
        reason: `fts:reference:${ref.kind || 'reference'}`,
      });
    }
  }

  return rowCount;
}

export function buildCodebaseFtsIndex(map = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE VIRTUAL TABLE codebase_fts USING fts5(
      path UNINDEXED,
      line UNINDEXED,
      kind UNINDEXED,
      anchor UNINDEXED,
      parser UNINDEXED,
      body,
      symbols UNINDEXED,
      routes UNINDEXED,
      reason UNINDEXED
    );
  `);
  const insert = db.prepare(`
    INSERT INTO codebase_fts(path, line, kind, anchor, parser, body, symbols, routes, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rowCount = db.transaction(() => addEvidenceRows(insert, map.evidence || []))();
  const fileCount = (map.evidence || []).length;

  return {
    summary: {
      enabled: true,
      engine: 'sqlite-fts5',
      ranking: 'bm25',
      fileCount,
      rowCount,
      maxRows: MAX_FTS_ROWS,
    },
    query(query, { maxResults = 20 } = {}) {
      const match = buildMatchQuery(query);
      if (!match || rowCount === 0) return [];
      const limit = Math.max(1, Math.min(100, Number(maxResults) || 20));
      let rows = [];
      try {
        rows = db.prepare(`
          SELECT path, line, kind, anchor, parser, body, symbols, routes, reason, bm25(codebase_fts) AS rank
          FROM codebase_fts
          WHERE codebase_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(match, limit);
      } catch {
        return [];
      }
      return rows.map((row, index) => ({
        path: row.path,
        line: Math.max(1, Number(row.line) || 1),
        kind: row.kind || 'text',
        anchor: row.anchor || null,
        parser: row.parser || 'unknown',
        text: safeString(row.body, 260),
        score: normalizeRankScore(row.rank, index),
        bm25Rank: Number(row.rank) || 0,
        reason: uniq(['fts5', 'bm25', row.reason]).filter(Boolean),
        symbols: JSON.parse(row.symbols || '[]'),
        routes: JSON.parse(row.routes || '[]'),
      }));
    },
    close() {
      db.close();
    },
  };
}
