import { describe, expect, it } from 'vitest';
import { isUploadHostAllowed, loadUploadAllowlist } from '../../src/security/uploadAllowlist.js';
import { isPrivateIp } from '../../src/server/routes/img-cache.js';

describe('uploadAllowlist', () => {
  it('allows any public host when allowlist is empty (default, backward compatible)', () => {
    const empty = { hosts: [] };
    expect(isUploadHostAllowed('discord.com', empty)).toBe(true);
    expect(isUploadHostAllowed('evil.example', empty)).toBe(true);
  });

  it('only allows listed hosts when configured', () => {
    const list = { hosts: ['discord.com', 'hooks.slack.com'] };
    expect(isUploadHostAllowed('discord.com', list)).toBe(true);
    expect(isUploadHostAllowed('hooks.slack.com', list)).toBe(true);
    expect(isUploadHostAllowed('evil.example', list)).toBe(false);
    expect(isUploadHostAllowed('', list)).toBe(false);
  });

  it('supports *.domain wildcard matching', () => {
    const list = { hosts: ['*.example.com'] };
    expect(isUploadHostAllowed('api.example.com', list)).toBe(true);
    expect(isUploadHostAllowed('example.com', list)).toBe(true);
    expect(isUploadHostAllowed('example.org', list)).toBe(false);
    expect(isUploadHostAllowed('notexample.com', list)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isUploadHostAllowed('Discord.COM', { hosts: ['discord.com'] })).toBe(true);
  });

  it('loadUploadAllowlist returns empty hosts when file is missing', () => {
    expect(loadUploadAllowlist('/nonexistent/path/upload-allowlist.json')).toEqual({ hosts: [] });
  });
});

describe('isPrivateIp IPv4-compatible IPv6', () => {
  it('blocks deprecated IPv4-compatible IPv6 pointing at private IPs', () => {
    expect(isPrivateIp('::127.0.0.1')).toBe(true);
    expect(isPrivateIp('::10.0.0.1')).toBe(true);
    expect(isPrivateIp('::192.168.1.1')).toBe(true);
  });

  it('still blocks v4-mapped and loopback forms', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('169.254.0.1')).toBe(true);
  });
});
