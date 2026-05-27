import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { EvidenceKnowledgeStore, redactSecrets } from '../../src/knowledge/EvidenceKnowledgeStore.js';

function freshStore() {
  return new EvidenceKnowledgeStore({ db: new Database(':memory:') });
}

describe('EvidenceKnowledgeStore', () => {
  it('indexes evidence and searches by bm25 across kinds', () => {
    const store = freshStore();
    const res = store.indexItems([
      { refKind: 'agent_run', refId: 'r1', content: 'implemented local budget policy enforcement' },
      { refKind: 'tool_result', refId: 't1', content: 'ran npm test for budget gate' },
      { refKind: 'activity', refId: 'a1', content: 'archived webhook delivery report' },
    ]);
    expect(res).toEqual({ indexed: 3, skipped: 0 });

    const hits = store.search('budget');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.some((h) => h.refId === 'r1')).toBe(true);

    const onlyTools = store.search('budget', { kind: 'tool_result' });
    expect(onlyTools.every((h) => h.refKind === 'tool_result')).toBe(true);
    expect(onlyTools.some((h) => h.refId === 't1')).toBe(true);
  });

  it('dedupes by ref on incremental re-index', () => {
    const store = freshStore();
    store.indexItems([{ refKind: 'agent_run', refId: 'r1', content: 'first' }]);
    const again = store.indexItems([
      { refKind: 'agent_run', refId: 'r1', content: 'changed but same ref' },
      { refKind: 'agent_run', refId: 'r2', content: 'new run evidence' },
    ]);
    expect(again).toEqual({ indexed: 1, skipped: 1 });
    expect(store.stats().indexed).toBe(2);
  });

  it('redacts obvious secrets before indexing', () => {
    const store = freshStore();
    store.indexItems([{ refKind: 'msg', refId: 'm1', content: 'using token sk-abcdefghijklmnop1234567890 to call api' }]);
    const hits = store.search('token');
    expect(hits.length).toBe(1);
    expect(hits[0].snippet).not.toContain('sk-abcdefghijklmnop');
    expect(redactSecrets('ghp_aaaaaaaaaaaaaaaaaaaaaaaa')).toBe('[redacted]');
  });

  it('returns empty for blank or syntactically tricky queries (no FTS5 crash)', () => {
    const store = freshStore();
    store.indexItems([{ refKind: 'agent_run', refId: 'r1', content: 'evidence body' }]);
    expect(store.search('')).toEqual([]);
    expect(store.search('  ')).toEqual([]);
    expect(Array.isArray(store.search('"unterminated ('))).toBe(true);
    expect(store.search('evidence').length).toBe(1);
  });

  it('ignores items without ref or content', () => {
    const store = freshStore();
    expect(store.indexItems([{ refKind: 'x' }, { refId: 'y' }, { refKind: 'x', refId: 'z', content: '' }])).toEqual({ indexed: 0, skipped: 0 });
  });

  it('derives and indexes evidence from agent run + activity stores', () => {
    const store = freshStore();
    const agentRunStore = {
      list: () => [{ id: 'r1', roomId: 'room1', sessionId: 's1' }],
      getTimeline: () => ({
        messages: [{ id: 'm1', summary: 'applied budget policy enforcement' }],
        toolResults: [{ id: 't1', toolName: 'npm', outputSummary: 'budget gate test passed' }],
      }),
    };
    const activityLog = { list: () => [{ id: 'e1', action: 'webhook.delivered', summary: 'archived report' }] };
    const res = store.indexFromStores({ agentRunStore, activityLog });
    expect(res.indexed).toBe(3);
    const budgetHit = store.search('budget').find((h) => h.refId === 'm1');
    expect(budgetHit).toBeTruthy();
    expect(budgetHit.runId).toBe('r1'); // F1：agent 证据命中带 runId，供前端开对应 Agent Run
    expect(store.search('archived').some((h) => h.refKind === 'activity')).toBe(true);
    // activity 命中无 runId
    expect(store.search('archived').find((h) => h.refKind === 'activity').runId).toBe('');
    // 再次派生应被 ref dedupe 跳过
    expect(store.indexFromStores({ agentRunStore, activityLog }).indexed).toBe(0);
  });

  it('survives stores that throw without aborting indexing', () => {
    const store = freshStore();
    const badRunStore = { list: () => { throw new Error('boom'); } };
    const activityLog = { list: () => [{ id: 'e1', summary: 'still indexed' }] };
    const res = store.indexFromStores({ agentRunStore: badRunStore, activityLog });
    expect(res.indexed).toBe(1);
  });

  it('indexRunTimeline indexes a single run and is idempotent by ref (A3 hook)', () => {
    const store = freshStore();
    const run = { id: 'r9', roomId: 'room9', sessionId: 's9' };
    const timeline = {
      messages: [{ id: 'm9', summary: 'archived run with budget enforcement' }],
      toolResults: [{ id: 't9', toolName: 'npm', outputSummary: 'budget gate passed' }],
    };
    expect(store.indexRunTimeline(run, timeline)).toEqual({ indexed: 2, skipped: 0 });
    const m9 = store.search('budget').find((h) => h.refId === 'm9');
    expect(m9).toBeTruthy();
    expect(m9.runId).toBe('r9'); // F1：命中带 runId
    // 同一 run 再次索引（如重复归档）应被 ref dedupe 跳过
    expect(store.indexRunTimeline(run, timeline)).toEqual({ indexed: 0, skipped: 2 });
  });

  it('indexRunTimeline tolerates empty / missing timeline', () => {
    const store = freshStore();
    expect(store.indexRunTimeline(null, null)).toEqual({ indexed: 0, skipped: 0 });
    expect(store.indexRunTimeline({ id: 'r0' }, { messages: [], toolResults: [] })).toEqual({ indexed: 0, skipped: 0 });
  });

  it('redacts secrets before truncation so trailing keys never enter the index (W5 边界)', () => {
    const store = freshStore();
    // 长内容(~4200 字符)末尾带密钥(超出 4000 截断点)：redact 在 slice 之前跑 → 密钥不进可搜库
    const long = 'alpha '.repeat(700);
    store.indexItems([{ refKind: 'msg', refId: 'long1', content: `${long} sk-DEADBEEFdeadbeef12345678 ghp_aaaaaaaaaaaaaaaaaaaaaaaa` }]);
    expect(store.search('alpha').length).toBe(1); // 长内容正常可命中
    expect(store.search('DEADBEEFdeadbeef12345678').length).toBe(0); // 末尾 sk- 密钥已脱敏，不可搜
    expect(store.search('aaaaaaaaaaaaaaaaaaaaaaaa').length).toBe(0); // ghp_ 密钥已脱敏，不可搜
  });

  it('caps over-long ref/run field lengths without crashing (W5 边界)', () => {
    const store = freshStore();
    const res = store.indexItems([{ refKind: 'k'.repeat(200), refId: 'i'.repeat(500), content: 'capped body', runId: 'r'.repeat(500), roomId: 'm'.repeat(400), sessionId: 's'.repeat(400) }]);
    expect(res.indexed).toBe(1); // 超长字段被 slice 后仍索引成功
    const hits = store.search('capped');
    expect(hits.length).toBe(1);
    expect(hits[0].refKind.length).toBeLessThanOrEqual(80);
    expect(hits[0].refId.length).toBeLessThanOrEqual(200);
  });
});
