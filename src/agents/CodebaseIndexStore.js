import { buildCodebaseMap } from './CodebaseMap.js';
import { scoreCodebaseEvidence } from './CodebaseQueryEngine.js';

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_FOCUS_LIMIT = 24;
const MAX_QUERY_CHARS = 500;

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function fileKey(cwd, query) {
  return `${safeString(cwd, 1000)}\u001f${safeString(query, MAX_QUERY_CHARS).toLowerCase()}`;
}

export class CodebaseIndexStore {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.cache = new Map();
    this.statusByCwd = new Map();
  }

  rebuild(cwd, { query = '', focusLimit = DEFAULT_FOCUS_LIMIT, fsApi = {} } = {}) {
    const startedAt = Date.now();
    const map = buildCodebaseMap(cwd, { query, limit: focusLimit, fsApi });
    const status = {
      ok: true,
      cwd: map.cwd,
      query: map.query,
      indexedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      scannedFileCount: map.scannedFileCount,
      focusFileCount: map.focusFileCount,
      evidenceSummary: map.evidenceSummary,
      symbolGraphSummary: map.symbolGraphSummary,
      limits: {
        focusLimit: Math.max(4, Math.min(DEFAULT_FOCUS_LIMIT, Number(focusLimit) || DEFAULT_FOCUS_LIMIT)),
        maxResults: DEFAULT_MAX_RESULTS,
      },
    };
    this.cache.set(fileKey(cwd, query), { map, status });
    this.statusByCwd.set(safeString(cwd, 1000), status);
    return { status, map };
  }

  status(cwd) {
    return this.statusByCwd.get(safeString(cwd, 1000)) || {
      ok: true,
      cwd: safeString(cwd, 1000),
      indexedAt: null,
      scannedFileCount: 0,
      focusFileCount: 0,
      evidenceSummary: null,
      symbolGraphSummary: null,
      limits: { focusLimit: DEFAULT_FOCUS_LIMIT, maxResults: DEFAULT_MAX_RESULTS },
    };
  }

  query(cwd, { query = '', maxResults = DEFAULT_MAX_RESULTS, focusLimit = DEFAULT_FOCUS_LIMIT, fsApi = {} } = {}) {
    const safeQuery = safeString(query, MAX_QUERY_CHARS);
    const key = fileKey(cwd, safeQuery);
    let entry = this.cache.get(key);
    if (!entry) entry = this.rebuild(cwd, { query: safeQuery, focusLimit, fsApi });
    const results = scoreCodebaseEvidence(entry.map, safeQuery, { maxResults });
    return {
      ok: true,
      cwd: entry.map.cwd,
      query: safeQuery,
      resultCount: results.length,
      results,
      status: entry.status,
      evidenceSummary: entry.map.evidenceSummary,
      symbolGraphSummary: entry.map.symbolGraphSummary,
    };
  }
}

export const codebaseIndexStore = new CodebaseIndexStore();
