import { describe, it, expect, beforeEach } from 'vitest';
import { DebateDispatcher } from '../../../src/room/DebateDispatcher.js';
import { SoloChatDispatcher } from '../../../src/room/SoloChatDispatcher.js';
import { ArenaDispatcher } from '../../../src/room/ArenaDispatcher.js';
import { CollaborationDispatcher } from '../../../src/room/CollaborationDispatcher.js';

// 极简 stub
const stubAdapter = {
  id: 'stub',
  displayName: '🧪 Stub',
  async chat(messages) { return { reply: 'stub-reply', tokensIn: 1, tokensOut: 1 }; },
};
const stubAdapters = new Map([['stub', stubAdapter]]);
const stubStore = {
  _rooms: new Map(),
  get(id) { return this._rooms.get(id); },
  update(id, patch) {
    const r = this._rooms.get(id);
    if (r) Object.assign(r, patch);
    return r;
  },
  save() {},
};
const stubMetrics = {
  recordTurn() {},
};
const broadcasts = [];
const stubBroadcast = (id, msg) => broadcasts.push({ id, msg });

beforeEach(() => {
  stubStore._rooms.clear();
  broadcasts.length = 0;
});

describe('4 dispatcher 实例化', () => {
  it('DebateDispatcher 可 new + 含 start/abort', () => {
    const d = new DebateDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    expect(typeof d.start).toBe('function');
    expect(typeof d.abort).toBe('function');
  });
  it('SoloChatDispatcher 可 new + 含 sendMessage', () => {
    const d = new SoloChatDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    expect(typeof d.sendMessage).toBe('function');
    expect(typeof d.abort).toBe('function');
  });
  it('ArenaDispatcher 可 new', () => {
    const d = new ArenaDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    expect(typeof d.start).toBe('function');
  });
  it('CollaborationDispatcher 可 new', () => {
    const d = new CollaborationDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    expect(typeof d.start).toBe('function');
  });
});

describe('dispatcher 错误处理（无 room）', () => {
  const d = new DebateDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
  it('start 不存在 room → 抛错', async () => {
    await expect(d.start('nonexistent', 'topic')).rejects.toThrow();
  });
  it('abort 不存在 room → 不抛（noop）', () => {
    expect(() => d.abort('nonexistent')).not.toThrow();
  });
});

describe('dispatcher resume 错误', () => {
  const d = new DebateDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
  it('resume 不存在 room', async () => {
    await expect(d.resume('nonexistent')).rejects.toThrow('room not found');
  });
  it('resume 已 running room', async () => {
    stubStore._rooms.set('r1', { id: 'r1', status: 'running', topic: 'x' });
    await expect(d.resume('r1')).rejects.toThrow('already running');
  });
  it('resume 无 topic room', async () => {
    stubStore._rooms.set('r2', { id: 'r2', status: 'idle', topic: '' });
    await expect(d.resume('r2')).rejects.toThrow('尚未启动过');
  });
});

describe('learned helper 直接调用', () => {
  it('historyTrimmer 跑通', async () => {
    const { trimHistoryByTokens } = await import('../../../src/room/historyTrimmer.js');
    const r = trimHistoryByTokens({ messages: [{ role: 'user', content: 'q' }], maxContextTokens: 10000 });
    expect(r.context.length).toBe(1);
  });
  it('consensus 跑通', async () => {
    const { detectConsensus } = await import('../../../src/room/learned/consensus-detector.js');
    const r = detectConsensus([{ speaker: 'A', content: '我同意' }, { speaker: 'B', content: '达成共识' }]);
    expect(r.consensus).toBe(true);
  });
});
