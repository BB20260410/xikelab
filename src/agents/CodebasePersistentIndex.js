import { createHash } from 'node:crypto';
import { getDb } from '../storage/SqliteStore.js';
import { CODEBASE_LIMITS } from './codebaseLimits.js';

const SNAPSHOT_VERSION = 1;
const DEFAULT_MAX_SNAPSHOTS_PER_CWD = CODEBASE_LIMITS.maxSnapshotsPerCwd;

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function jsonString(value) {
  return JSON.stringify(value || {});
}

function parseJson(value, fallback = null) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function snapshotId(cwd, query) {
  return createHash('sha256')
    .update(`${safeString(cwd, 2000)}\0${safeString(query, 500).toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

function mapStorageSummary(map = {}) {
  return {
    focusFileCount: (map.focusFiles || []).length,
    evidenceFileCount: (map.evidence || []).length,
    symbolCount: map.evidenceSummary?.symbolCount || 0,
    referenceCount: map.evidenceSummary?.referenceCount || 0,
    graphReferenceCount: map.symbolGraphSummary?.referenceCount || 0,
    typeImplementationCount: map.symbolGraphSummary?.typeImplementationCount || 0,
    routeUsageCount: map.symbolGraphSummary?.routeUsageCount || 0,
  };
}

function rowToSnapshot(row) {
  if (!row) return null;
  const status = parseJson(row.status_json, {});
  const map = parseJson(row.map_json, {});
  return {
    id: row.id,
    version: row.version,
    cwd: row.cwd,
    query: row.query,
    indexedAt: row.indexed_at,
    updatedAt: row.updated_at,
    status,
    map,
    summary: {
      enabled: true,
      engine: 'sqlite',
      snapshotId: row.id,
      version: row.version,
      indexedAt: row.indexed_at,
      updatedAt: row.updated_at,
      mapBytes: row.map_json?.length || 0,
      statusBytes: row.status_json?.length || 0,
      storage: parseJson(row.storage_summary_json, {}),
      loadedFromSnapshot: true,
    },
  };
}

export class CodebasePersistentIndex {
  constructor({ db = null, logger = console, maxSnapshotsPerCwd = DEFAULT_MAX_SNAPSHOTS_PER_CWD } = {}) {
    this.db = db;
    this.logger = logger;
    this.maxSnapshotsPerCwd = Math.max(1, Number(maxSnapshotsPerCwd) || DEFAULT_MAX_SNAPSHOTS_PER_CWD);
    this.ready = false;
  }

  getDb() {
    return this.db || getDb();
  }

  ensureSchema() {
    if (this.ready) return;
    const db = this.getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS codebase_index_snapshots (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        query TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        status_json TEXT NOT NULL,
        map_json TEXT NOT NULL,
        storage_summary_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_codebase_index_snapshots_cwd_query
        ON codebase_index_snapshots(cwd, query);
      CREATE INDEX IF NOT EXISTS idx_codebase_index_snapshots_cwd_updated
        ON codebase_index_snapshots(cwd, updated_at);
    `);
    this.ready = true;
  }

  pruneSnapshots(cwd) {
    const safeCwd = safeString(cwd, 2000);
    if (!safeCwd) return 0;
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT id FROM codebase_index_snapshots
      WHERE cwd = ?
      ORDER BY updated_at DESC, indexed_at DESC, id DESC
    `).all(safeCwd);
    const staleIds = rows.slice(this.maxSnapshotsPerCwd).map((row) => row.id);
    if (!staleIds.length) return 0;
    const remove = db.prepare('DELETE FROM codebase_index_snapshots WHERE id = ?');
    const tx = db.transaction((ids) => {
      for (const id of ids) remove.run(id);
    });
    tx(staleIds);
    return staleIds.length;
  }

  writeSnapshot({ cwd, query = '', status = {}, map = {} } = {}) {
    const safeCwd = safeString(cwd || map.cwd, 2000);
    if (!safeCwd) return null;
    const safeQuery = safeString(query || map.query || status.query, 500);
    const id = snapshotId(safeCwd, safeQuery);
    const now = Date.now();
    const storage = mapStorageSummary(map);
    const statusForStorage = {
      ...status,
      persistentSummary: undefined,
    };
    this.ensureSchema();
    this.getDb().prepare(`
      INSERT INTO codebase_index_snapshots(
        id, version, cwd, query, indexed_at, status_json, map_json, storage_summary_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        indexed_at = excluded.indexed_at,
        status_json = excluded.status_json,
        map_json = excluded.map_json,
        storage_summary_json = excluded.storage_summary_json,
        updated_at = excluded.updated_at
    `).run(
      id,
      SNAPSHOT_VERSION,
      safeCwd,
      safeQuery,
      Number(status.indexedAt) || now,
      jsonString(statusForStorage),
      jsonString(map),
      jsonString(storage),
      now,
      now,
    );
    const prunedSnapshots = this.pruneSnapshots(safeCwd);
    return {
      enabled: true,
      engine: 'sqlite',
      snapshotId: id,
      version: SNAPSHOT_VERSION,
      indexedAt: Number(status.indexedAt) || now,
      updatedAt: now,
      snapshotCountLimit: this.maxSnapshotsPerCwd,
      prunedSnapshots,
      storage,
      loadedFromSnapshot: false,
    };
  }

  readSnapshot(cwd, query = '') {
    const safeCwd = safeString(cwd, 2000);
    const safeQuery = safeString(query, 500);
    if (!safeCwd) return null;
    this.ensureSchema();
    const row = this.getDb().prepare(`
      SELECT * FROM codebase_index_snapshots
      WHERE cwd = ? AND query = ?
      LIMIT 1
    `).get(safeCwd, safeQuery);
    return rowToSnapshot(row);
  }

  latestSnapshot(cwd) {
    const safeCwd = safeString(cwd, 2000);
    if (!safeCwd) return null;
    this.ensureSchema();
    const row = this.getDb().prepare(`
      SELECT * FROM codebase_index_snapshots
      WHERE cwd = ?
      ORDER BY updated_at DESC, indexed_at DESC, id DESC
      LIMIT 1
    `).get(safeCwd);
    return rowToSnapshot(row);
  }
}

export const codebasePersistentIndex = new CodebasePersistentIndex();
