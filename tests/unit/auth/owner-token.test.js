import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getOrCreateOwnerToken, requireOwnerToken, verifyOwnerTokenString } from '../../../src/server/auth/owner-token.js';

const TOKEN_PATH = path.join(os.homedir(), '.claude-panel', 'owner-token.txt');

function mockRes() {
  const calls = { status: null, json: null, nextCalled: false };
  const res = {
    status(code) { calls.status = code; return this; },
    json(obj) { calls.json = obj; return this; },
  };
  const next = () => { calls.nextCalled = true; };
  return { res, next, calls };
}

function makeReq(headers = {}) {
  return {
    get(name) {
      const lower = name.toLowerCase();
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === lower) return headers[k];
      }
      return undefined;
    },
  };
}

describe('getOrCreateOwnerToken', () => {
  it('返回 32 字节 hex（64 字符）且文件 0o600', () => {
    const t = getOrCreateOwnerToken();
    expect(t).toBeTruthy();
    expect(t.length).toBeGreaterThanOrEqual(32);
    expect(fs.existsSync(TOKEN_PATH)).toBe(true);
    const st = fs.statSync(TOKEN_PATH);
    // mode 低 9 位仅 owner rw（0o600）
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('幂等：第二次读相同值', () => {
    const t1 = getOrCreateOwnerToken();
    const t2 = getOrCreateOwnerToken();
    expect(t1).toBe(t2);
  });
});

describe('requireOwnerToken middleware', () => {
  let token;
  beforeAll(() => { token = getOrCreateOwnerToken(); });

  it('缺 header → 401', () => {
    const { res, next, calls } = mockRes();
    requireOwnerToken(makeReq({}), res, next);
    expect(calls.nextCalled).toBe(false);
    expect(calls.status).toBe(401);
    expect(calls.json.error).toMatch(/owner token required/);
  });

  it('错误 token → 401', () => {
    const { res, next, calls } = mockRes();
    const bad = 'x'.repeat(token.length); // 长度匹配但内容错
    requireOwnerToken(makeReq({ 'X-Panel-Owner-Token': bad }), res, next);
    expect(calls.nextCalled).toBe(false);
    expect(calls.status).toBe(401);
    expect(calls.json.error).toMatch(/mismatch/);
  });

  it('长度不一致 → 401（防 timingSafeEqual 抛错）', () => {
    const { res, next, calls } = mockRes();
    requireOwnerToken(makeReq({ 'X-Panel-Owner-Token': 'short' }), res, next);
    expect(calls.nextCalled).toBe(false);
    expect(calls.status).toBe(401);
  });

  it('空字符串 → 401', () => {
    const { res, next, calls } = mockRes();
    requireOwnerToken(makeReq({ 'X-Panel-Owner-Token': '' }), res, next);
    expect(calls.nextCalled).toBe(false);
    expect(calls.status).toBe(401);
  });

  it('正确 token → next() 被调用', () => {
    const { res, next, calls } = mockRes();
    requireOwnerToken(makeReq({ 'X-Panel-Owner-Token': token }), res, next);
    expect(calls.nextCalled).toBe(true);
    expect(calls.status).toBe(null);
  });

  it('token 前后空格被 trim', () => {
    const { res, next, calls } = mockRes();
    requireOwnerToken(makeReq({ 'X-Panel-Owner-Token': '  ' + token + '  ' }), res, next);
    expect(calls.nextCalled).toBe(true);
  });
});

describe('verifyOwnerTokenString (WS upgrade 用)', () => {
  let token;
  beforeAll(() => { token = getOrCreateOwnerToken(); });

  it('正确 token → true', () => {
    expect(verifyOwnerTokenString(token)).toBe(true);
  });
  it('错误 token（同长度）→ false', () => {
    expect(verifyOwnerTokenString('x'.repeat(token.length))).toBe(false);
  });
  it('长度不一致 → false（防 timingSafeEqual 抛错）', () => {
    expect(verifyOwnerTokenString('short')).toBe(false);
  });
  it('空字符串 / null / undefined → false', () => {
    expect(verifyOwnerTokenString('')).toBe(false);
    expect(verifyOwnerTokenString(null)).toBe(false);
    expect(verifyOwnerTokenString(undefined)).toBe(false);
  });
  it('前后空格被 trim', () => {
    expect(verifyOwnerTokenString('  ' + token + '  ')).toBe(true);
  });
});
