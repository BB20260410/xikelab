import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const PANEL = 'http://localhost:51735';

function curlCode(url) {
  try { return execSync(`curl -s -o /dev/null -w "%{http_code}" "${url}"`, { encoding: 'utf8', timeout: 3000 }); }
  catch { return '0'; }
}

describe('沙箱 fuzz - 攻击 path 应被 reject', () => {
  const attackPaths = [
    '/etc/passwd',
    '../../etc/passwd',
    '~/.ssh/id_rsa',
    '~/.aws/credentials',
  ];
  for (const p of attackPaths) {
    it(`reject ${p.slice(0,30)}`, () => {
      const code = curlCode(`${PANEL}/api/file?path=${encodeURIComponent(p)}`);
      expect(['400', '403', '404', '500']).toContain(code);
    });
  }
});

describe('secrets masking', () => {
  it('GET /api/room-adapters 返回 apiKey 应掩码', () => {
    const out = execSync(`curl -s "${PANEL}/api/room-adapters"`, { encoding: 'utf8', timeout: 3000 });
    if (out.includes('apiKey')) {
      // 真 apiKey 不应明文出现（找形如 "apiKey":"xxxxxxxxxxxxxxxxxxxxxx"）
      const match = out.match(/"apiKey":"([^"]+)"/);
      if (match && match[1]) {
        // 掩码应该是 4...4 或全 * 或空
        const v = match[1];
        const masked = v.includes('*') || v === '' || (v.length < 20 && v.includes('...'));
        expect(masked).toBe(true);
      }
    }
  });
});
