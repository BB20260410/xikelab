import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifySignature } from '../../../src/server/routes/payment-webhooks.js';

const SECRET = 'test-secret-32-chars-1234567890ab';
const PAYLOAD = JSON.stringify({ event: 'order_created', data: { id: 1 } });

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifySignature', () => {
  it('正例 - 正确签名通过', () => {
    expect(verifySignature(PAYLOAD, sign(PAYLOAD, SECRET), SECRET)).toBe(true);
  });

  it('正例 - sha256= 前缀也通过', () => {
    expect(verifySignature(PAYLOAD, 'sha256=' + sign(PAYLOAD, SECRET), SECRET)).toBe(true);
  });

  it('反例 - 错误 secret 拒绝', () => {
    expect(verifySignature(PAYLOAD, sign(PAYLOAD, SECRET), 'wrong-secret')).toBe(false);
  });

  it('反例 - 篡改 payload 拒绝', () => {
    expect(verifySignature(PAYLOAD + 'x', sign(PAYLOAD, SECRET), SECRET)).toBe(false);
  });

  it('反例 - 长度不一致拒绝（防 timingSafeEqual 抛错）', () => {
    expect(verifySignature(PAYLOAD, 'aabb', SECRET)).toBe(false);
  });

  it('反例 - 非 hex 签名拒绝', () => {
    expect(verifySignature(PAYLOAD, 'not-hex-at-all', SECRET)).toBe(false);
  });

  it('反例 - 空签名拒绝', () => {
    expect(verifySignature(PAYLOAD, '', SECRET)).toBe(false);
  });

  it('反例 - 空 secret 拒绝', () => {
    expect(verifySignature(PAYLOAD, sign(PAYLOAD, SECRET), '')).toBe(false);
  });

  it('反例 - null 签名/secret 拒绝', () => {
    expect(verifySignature(PAYLOAD, null, SECRET)).toBe(false);
    expect(verifySignature(PAYLOAD, sign(PAYLOAD, SECRET), null)).toBe(false);
  });
});
