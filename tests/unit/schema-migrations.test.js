import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, SCHEMA_MIGRATIONS } from '../../src/storage/SqliteStore.js';

let tmp;
const LATEST = SCHEMA_MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

function schemaVersion(db) {
  const row = db.prepare("SELECT v FROM kv WHERE k = 'schema_version'").get();
  return row ? Number(row.v) : 0;
}
function hasIndex(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?").get(name));
}

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-migrate-'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('schema migrations (P8/D3)', () => {
  it('brings a fresh database to the latest version without producing a backup', () => {
    const dbPath = join(tmp, 'panel.db');
    const db = initSqlite(dbPath);
    expect(schemaVersion(db)).toBe(LATEST);
    expect(hasIndex(db, 'idx_agent_runs_status_updated')).toBe(true);
    // 全新空库不应产生 .bak
    expect(existsSync(`${dbPath}.bak`)).toBe(false);
  });

  it('migrates an existing unversioned database with data and backs it up once', () => {
    const dbPath = join(tmp, 'panel.db');
    let db = initSqlite(dbPath);
    // 模拟旧库：有数据、无 schema_version、缺迁移索引
    db.prepare('INSERT INTO events(ts, kind, payload) VALUES (?, ?, ?)').run(Date.now(), 'activity', '{}');
    db.exec("DELETE FROM kv WHERE k = 'schema_version'");
    db.exec('DROP INDEX IF EXISTS idx_agent_runs_status_updated');
    expect(hasIndex(db, 'idx_agent_runs_status_updated')).toBe(false);
    close();

    // 重新初始化 → 触发迁移 + 一次性备份
    db = initSqlite(dbPath);
    expect(existsSync(`${dbPath}.bak`)).toBe(true);
    expect(hasIndex(db, 'idx_agent_runs_status_updated')).toBe(true);
    expect(schemaVersion(db)).toBe(LATEST);
  });

  it('is idempotent: re-init at latest version does not re-run or re-backup', () => {
    const dbPath = join(tmp, 'panel.db');
    let db = initSqlite(dbPath);
    db.prepare('INSERT INTO events(ts, kind, payload) VALUES (?, ?, ?)').run(Date.now(), 'activity', '{}');
    expect(schemaVersion(db)).toBe(LATEST);
    close();

    // 已是最新版本：无 pending → 不应产生 .bak
    db = initSqlite(dbPath);
    expect(existsSync(`${dbPath}.bak`)).toBe(false);
    expect(schemaVersion(db)).toBe(LATEST);
  });
});
