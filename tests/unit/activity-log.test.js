import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { ActivityLog } from '../../src/audit/ActivityLog.js';
import { close, initSqlite, listEvents } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'xikelab-activity-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('ActivityLog', () => {
  it('records structured audit events with searchable room/session/entity/task fields', () => {
    const log = new ActivityLog({ logger: null });
    const recorded = log.record({
      action: 'tool.command.requested',
      actorType: 'user',
      actorId: 'local-owner',
      roomId: 'room-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      entityType: 'command',
      entityId: 'cmd-1',
      details: {
        command: 'npm test',
        token: 'must-not-leak',
        nested: { apiKey: 'must-not-leak-either' },
      },
    });

    expect(recorded.id).toBeGreaterThan(0);

    const byActivity = log.list({
      action: 'tool.command.requested',
      roomId: 'room-1',
      sessionId: 'session-1',
      entityType: 'command',
      entityId: 'cmd-1',
      taskId: 'task-1',
    });
    expect(byActivity).toHaveLength(1);
    expect(byActivity[0]).toMatchObject({
      action: 'tool.command.requested',
      actorType: 'user',
      roomId: 'room-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      entityType: 'command',
      entityId: 'cmd-1',
    });
    expect(byActivity[0].details.token).toBe('[REDACTED]');
    expect(byActivity[0].details.nested.apiKey).toBe('[REDACTED]');

    const raw = listEvents({ kind: 'activity', sessionId: 'session-1', taskId: 'task-1' });
    expect(raw).toHaveLength(1);
    expect(raw[0].session_id).toBe('session-1');
    expect(raw[0].entity_type).toBe('command');
  });

  it('keeps audit failures isolated via recordSafe', () => {
    const log = new ActivityLog({
      logger: null,
      storage: {
        appendEvent() { throw new Error('db down'); },
        listEvents() { return []; },
      },
    });
    expect(log.recordSafe({ action: 'room.created', entityType: 'room' })).toBeNull();
  });

  it('filters agent and skill diagnostics from event details', () => {
    const log = new ActivityLog({ logger: null });
    log.record({
      action: 'metrics.recorded',
      roomId: 'room-agent',
      sessionId: 'session-agent',
      taskId: 'task-agent',
      entityType: 'metric_turn',
      entityId: 'turn-1',
      details: {
        agentProfileId: 'xike-verifier',
        agentSkillNames: ['qa', 'browser'],
        agentSkillBindings: [{ name: 'qa', sources: ['profile'] }],
        agentSkillDiagnostics: [{ code: 'too_many_skills', severity: 'warn' }],
      },
    });
    log.record({
      action: 'room.created',
      roomId: 'room-agent',
      entityType: 'room',
      entityId: 'room-agent',
      details: { title: 'plain event' },
    });

    expect(log.list({ agentOnly: true }).map((event) => event.action)).toEqual(['metrics.recorded']);
    expect(log.list({ agentProfileId: 'xike-verifier' })).toHaveLength(1);
    expect(log.list({ skillName: 'qa' })).toHaveLength(1);
    expect(log.list({ diagnosticCode: 'too_many_skills' })).toHaveLength(1);
    expect(log.list({ skillName: 'not-installed' })).toHaveLength(0);
  });

  it('migrates the legacy events table before creating new activity indexes', () => {
    close();
    const dbPath = join(tmp, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        room_id TEXT,
        tag TEXT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
    `);
    legacy.close();

    initSqlite(dbPath);
    const log = new ActivityLog({ logger: null });
    log.record({
      action: 'legacy.migrated',
      sessionId: 'session-legacy',
      entityType: 'migration',
      entityId: 'legacy-db',
      taskId: 'task-legacy',
    });

    expect(listEvents({ kind: 'activity', sessionId: 'session-legacy', entityType: 'migration' })).toHaveLength(1);
  });
});
