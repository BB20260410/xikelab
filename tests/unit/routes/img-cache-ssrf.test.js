import { describe, it, expect } from 'vitest';
import { isPrivateIp, assertPublicUrl } from '../../../src/server/routes/img-cache.js';

describe('isPrivateIp', () => {
  it('IPv4 loopback', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('127.255.255.255')).toBe(true);
  });
  it('IPv4 私网 RFC1918', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });
  it('IPv4 链路本地 + 云元数据', () => {
    expect(isPrivateIp('169.254.0.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true); // AWS / GCP metadata
  });
  it('IPv4 CGNAT', () => {
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('100.127.255.255')).toBe(true);
  });
  it('IPv4 多播 + 保留 + 0.0.0.0', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true);
    expect(isPrivateIp('224.0.0.1')).toBe(true);
    expect(isPrivateIp('255.255.255.255')).toBe(true);
  });
  it('IPv4 公网放行', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('172.15.0.1')).toBe(false); // 172.16 之外
    expect(isPrivateIp('172.32.0.1')).toBe(false);
    expect(isPrivateIp('100.63.255.255')).toBe(false); // 100.64 之外
  });
  it('IPv6 loopback / 私网 / 链路本地', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12:3456::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('ff00::1')).toBe(true);
  });
  it('IPv6 v4-mapped 私网拒', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:169.254.169.254')).toBe(true);
  });
  it('IPv6 公网放行', () => {
    expect(isPrivateIp('2001:4860:4860::8888')).toBe(false); // Google DNS v6
  });
  it('非 IP / 空值视为不安全', () => {
    expect(isPrivateIp('')).toBe(true);
    expect(isPrivateIp(null)).toBe(true);
    expect(isPrivateIp('not-an-ip')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  it('拒非 http/https 协议', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertPublicUrl('javascript:alert(1)')).rejects.toThrow();
    await expect(assertPublicUrl('data:text/html,xxx')).rejects.toThrow();
    await expect(assertPublicUrl('gopher://x.com/')).rejects.toThrow();
  });
  it('拒非常规端口', async () => {
    await expect(assertPublicUrl('http://example.com:22/')).rejects.toThrow();
    await expect(assertPublicUrl('http://example.com:6379/')).rejects.toThrow();
    await expect(assertPublicUrl('http://example.com:51735/')).rejects.toThrow();
  });
  it('拒直接 IP literal 私网', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow();
    await expect(assertPublicUrl('http://10.0.0.1/')).rejects.toThrow();
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
  });
  it('拒非法 url', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow();
  });
});
