import { describe, it, expect } from 'vitest';
import { BUILTIN_COMMANDS, matchCommands, resolveAction } from '../../../public/src/web/cmdk-commands.js';

describe('cmdk BUILTIN_COMMANDS', () => {
  it('4 个内置命令', () => {
    expect(BUILTIN_COMMANDS.length).toBe(4);
  });
  it('含 new-session / toggle-theme', () => {
    const ids = BUILTIN_COMMANDS.map(c => c.id);
    expect(ids).toContain('new-session');
    expect(ids).toContain('toggle-theme');
  });
});

describe('matchCommands', () => {
  it('空 query 返全部', () => {
    expect(matchCommands('').length).toBe(4);
  });
  it('搜 "新建" 匹配', () => {
    const r = matchCommands('新建');
    expect(r.length).toBe(1);
    expect(r[0].id).toBe('new-session');
  });
  it('搜不存在', () => {
    expect(matchCommands('foobar123').length).toBe(0);
  });
});

describe('resolveAction', () => {
  it('dispatcher 命中', () => {
    const dispatcher = { openModal: () => 'open!' };
    const cmd = { actionRef: 'openModal' };
    const fn = resolveAction(cmd, dispatcher);
    expect(typeof fn).toBe('function');
    expect(fn()).toBe('open!');
  });
  it('dispatcher 不命中返 null', () => {
    expect(resolveAction({ actionRef: 'unknown' }, {})).toBe(null);
  });
});
