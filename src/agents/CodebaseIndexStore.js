import { buildCodebaseMap } from './CodebaseMap.js';
import { buildCodebaseFtsIndex } from './CodebaseFtsIndex.js';
import { buildCodebaseVectorIndex } from './CodebaseVectorIndex.js';
import { attachCodebaseCitations, summarizeCodebaseCitations } from './CodebaseCitationChain.js';
import { buildCodebaseQuestionAnswer } from './CodebaseQuestionAnswer.js';
import { codebasePersistentIndex as defaultPersistentIndex } from './CodebasePersistentIndex.js';
import { scoreCodebaseEvidence } from './CodebaseQueryEngine.js';

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_FOCUS_LIMIT = 24;
const MAX_QUERY_CHARS = 500;
const MAX_CACHE_ENTRIES = 12;

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function fileKey(cwd, query) {
  return `${safeString(cwd, 1000)}\u001f${safeString(query, MAX_QUERY_CHARS).toLowerCase()}`;
}

export class CodebaseIndexStore {
  constructor({ logger = console, persistentIndex = null } = {}) {
    this.logger = logger;
    this.persistentIndex = persistentIndex;
    this.cache = new Map();
    this.statusByCwd = new Map();
    this.evidenceCacheByCwd = new Map();
  }

  evidenceCacheFor(cwd) {
    const key = safeString(cwd, 1000);
    if (!this.evidenceCacheByCwd.has(key)) this.evidenceCacheByCwd.set(key, new Map());
    return this.evidenceCacheByCwd.get(key);
  }

  setCacheEntry(key, entry) {
    const previous = this.cache.get(key);
    if (previous?.ftsIndex?.close) previous.ftsIndex.close();
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      const oldest = this.cache.get(oldestKey);
      if (oldest?.ftsIndex?.close) oldest.ftsIndex.close();
      this.cache.delete(oldestKey);
    }
  }

  persistSnapshot({ cwd, query, status, map } = {}) {
    if (!this.persistentIndex) {
      return {
        enabled: false,
        engine: 'none',
        reason: 'persistent-index-disabled',
      };
    }
    try {
      return this.persistentIndex.writeSnapshot({ cwd, query, status, map });
    } catch (e) {
      if (this.logger?.warn) this.logger.warn('[CodebaseIndexStore] persist snapshot failed', e);
      return {
        enabled: false,
        engine: 'sqlite',
        error: safeString(e?.message || String(e), 200),
      };
    }
  }

  snapshotFor(cwd, query = '') {
    if (!this.persistentIndex) return null;
    try {
      return query
        ? this.persistentIndex.readSnapshot(cwd, query)
        : this.persistentIndex.latestSnapshot(cwd);
    } catch (e) {
      if (this.logger?.warn) this.logger.warn('[CodebaseIndexStore] read snapshot failed', e);
      return null;
    }
  }

  entryFromSnapshot(snapshot) {
    if (!snapshot?.map) return null;
    const ftsIndex = buildCodebaseFtsIndex(snapshot.map);
    const vectorIndex = buildCodebaseVectorIndex(snapshot.map);
    const status = {
      ...snapshot.status,
      persistentSummary: snapshot.summary,
      ftsSummary: ftsIndex.summary,
      vectorSummary: vectorIndex.summary,
    };
    return { map: snapshot.map, status, ftsIndex, vectorIndex };
  }

  rebuild(cwd, { query = '', focusLimit = DEFAULT_FOCUS_LIMIT, fsApi = {} } = {}) {
    const startedAt = Date.now();
    const map = buildCodebaseMap(cwd, {
      query,
      limit: focusLimit,
      fsApi,
      evidenceCache: this.evidenceCacheFor(cwd),
    });
    const ftsIndex = buildCodebaseFtsIndex(map);
    const vectorIndex = buildCodebaseVectorIndex(map);
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
      cacheStats: map.indexCacheStats,
      ftsSummary: ftsIndex.summary,
      vectorSummary: vectorIndex.summary,
      persistentSummary: {
        enabled: false,
        engine: 'pending',
      },
      limits: {
        focusLimit: Math.max(4, Math.min(DEFAULT_FOCUS_LIMIT, Number(focusLimit) || DEFAULT_FOCUS_LIMIT)),
        maxResults: DEFAULT_MAX_RESULTS,
      },
    };
    status.persistentSummary = this.persistSnapshot({ cwd: map.cwd, query: map.query, status, map });
    const key = fileKey(cwd, query);
    this.setCacheEntry(key, { map, status, ftsIndex, vectorIndex });
    this.statusByCwd.set(safeString(cwd, 1000), status);
    return { status, map };
  }

  status(cwd) {
    const cached = this.statusByCwd.get(safeString(cwd, 1000));
    if (cached) return cached;
    const snapshot = this.snapshotFor(cwd);
    if (snapshot?.status) {
      return {
        ...snapshot.status,
        persistentSummary: snapshot.summary,
      };
    }
    return {
      ok: true,
      cwd: safeString(cwd, 1000),
      indexedAt: null,
      scannedFileCount: 0,
      focusFileCount: 0,
      evidenceSummary: null,
      symbolGraphSummary: null,
      cacheStats: {
        enabled: true,
        files: 0,
        hits: 0,
        misses: 0,
        stale: 0,
        cacheSize: 0,
      },
      ftsSummary: {
        enabled: true,
        engine: 'sqlite-fts5',
        ranking: 'bm25',
        fileCount: 0,
        rowCount: 0,
        maxRows: 0,
      },
      vectorSummary: {
        enabled: true,
        engine: 'local-hash-vector',
        provider: 'hash',
        model: 'hash-128',
        ranking: 'cosine',
        fileCount: 0,
        rowCount: 0,
        maxRows: 0,
      },
      persistentSummary: {
        enabled: !!this.persistentIndex,
        engine: this.persistentIndex ? 'sqlite' : 'none',
        snapshotId: null,
      },
      limits: { focusLimit: DEFAULT_FOCUS_LIMIT, maxResults: DEFAULT_MAX_RESULTS },
    };
  }

  query(cwd, { query = '', maxResults = DEFAULT_MAX_RESULTS, focusLimit = DEFAULT_FOCUS_LIMIT, fsApi = {}, useSnapshot = false } = {}) {
    const safeQuery = safeString(query, MAX_QUERY_CHARS);
    const key = fileKey(cwd, safeQuery);
    let entry = this.cache.get(key);
    if (!entry) {
      if (useSnapshot) {
        const snapshot = this.snapshotFor(cwd, safeQuery);
        entry = this.entryFromSnapshot(snapshot);
        if (entry) this.setCacheEntry(key, entry);
      }
      if (!entry) {
        this.rebuild(cwd, { query: safeQuery, focusLimit, fsApi });
        entry = this.cache.get(key);
      }
    } else {
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    const safeMaxResults = Math.max(1, Math.min(100, Number(maxResults) || DEFAULT_MAX_RESULTS));
    const ftsResults = entry.ftsIndex?.query(safeQuery, { maxResults: Math.max(DEFAULT_MAX_RESULTS, safeMaxResults * 2) }) || [];
    const vectorResults = entry.vectorIndex?.query(safeQuery, { maxResults: Math.max(DEFAULT_MAX_RESULTS, safeMaxResults * 2) }) || [];
    const results = attachCodebaseCitations(entry.map, scoreCodebaseEvidence(entry.map, safeQuery, { maxResults: safeMaxResults, ftsResults, vectorResults }));
    return {
      ok: true,
      cwd: entry.map.cwd,
      query: safeQuery,
      resultCount: results.length,
      results,
      citationSummary: summarizeCodebaseCitations(results),
      status: entry.status,
      evidenceSummary: entry.map.evidenceSummary,
      symbolGraphSummary: entry.map.symbolGraphSummary,
      ftsSummary: entry.status.ftsSummary,
      vectorSummary: entry.status.vectorSummary,
      persistentSummary: entry.status.persistentSummary,
    };
  }

  question(cwd, { question = '', query = '', maxResults = 8, focusLimit = DEFAULT_FOCUS_LIMIT, fsApi = {}, useSnapshot = false } = {}) {
    const text = safeString(question || query, MAX_QUERY_CHARS);
    const result = this.query(cwd, {
      query: text,
      maxResults: Math.max(1, Math.min(20, Number(maxResults) || 8)),
      focusLimit,
      fsApi,
      useSnapshot,
    });
    return {
      ...result,
      question: text,
      answer: buildCodebaseQuestionAnswer({ ...result, question: text }),
    };
  }
}

export const codebaseIndexStore = new CodebaseIndexStore({ persistentIndex: defaultPersistentIndex });
