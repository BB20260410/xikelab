// 路径沙箱 + 密钥掩码 fuzz —— in-process 单测
//
// 历史：原版本用 curl 打本机 :51735 做 e2e 探针，CI 上 server 不在跑 → describe.skipIf 全跳过 = 假绿。
// 现在改成直接 import 纯函数验证沙箱核心逻辑，CI 一定真跑。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, symlinkSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { safeResolveFsPath, FORBIDDEN_HOME_SUBPATHS } from '../../../src/server/services/path-sandbox.js';
import { maskedConfig } from '../../../src/watcher/WatcherConfig.js';

describe('safeResolveFsPath - 攻击路径必须拒绝', () => {
  it('reject 系统敏感路径 /etc/passwd', () => {
    expect(safeResolveFsPath('/etc/passwd')).toBeNull();
  });

  it('reject 相对路径越权 ../../etc/passwd', () => {
    expect(safeResolveFsPath('../../etc/passwd')).toBeNull();
  });

  it('reject home 下的 .ssh 私钥目录', () => {
    expect(safeResolveFsPath('~/.ssh/id_rsa')).toBeNull();
    expect(safeResolveFsPath(join(homedir(), '.ssh', 'id_rsa'))).toBeNull();
  });

  it('reject home 下的 .aws 凭据目录', () => {
    expect(safeResolveFsPath('~/.aws/credentials')).toBeNull();
  });

  it.each(FORBIDDEN_HOME_SUBPATHS)('reject 敏感子目录 %s', (sub) => {
    const p = join(homedir(), sub, 'somefile');
    expect(safeResolveFsPath(p)).toBeNull();
  });

  it('reject 非字符串 / null / undefined / 数字', () => {
    expect(safeResolveFsPath(null)).toBeNull();
    expect(safeResolveFsPath(undefined)).toBeNull();
    expect(safeResolveFsPath(123)).toBeNull();
    expect(safeResolveFsPath('')).toBeNull();
  });

  it('reject 不存在的路径（realpath 失败）', () => {
    expect(safeResolveFsPath('/nonexistent-xyz-' + Date.now())).toBeNull();
  });
});

describe('safeResolveFsPath - 合法路径放行', () => {
  let TMP;
  beforeEach(() => {
    // 显式用 /tmp（不是 os.tmpdir() — macOS 上后者是 /var/folders/...，
    // 不属于 sandbox allowedRoots，会被正确拒绝，但我们要测的是"合法放行"分支）
    TMP = mkdtempSync('/tmp/xikelab-sandbox-fuzz-');
  });
  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  it('放行 /tmp 子路径下的普通文件', () => {
    const f = join(TMP, 'ok.txt');
    writeFileSync(f, 'hello');
    expect(safeResolveFsPath(f)).toBeTruthy();
  });

  it('放行 /tmp 子路径下的目录', () => {
    const f = join(TMP, 'subdir');
    mkdirSync(f);
    const out = safeResolveFsPath(f);
    expect(out).toBeTruthy();
    expect(out.includes('subdir')).toBe(true);
  });

  it('symlink 指向 /etc/passwd 应被 realpath 解析后拒绝', () => {
    const link = join(TMP, 'evil-link');
    try {
      symlinkSync('/etc/passwd', link);
    } catch {
      // CI 可能不允许某些 symlink；本 case 跳过
      return;
    }
    expect(safeResolveFsPath(link)).toBeNull();
  });
});

describe('maskedConfig - apiKey 必须脱敏', () => {
  it('长 apiKey 用前 4...后 4 掩码', () => {
    const c = maskedConfig({ apiKey: 'sk-abcdefghij1234567890zzzz' });
    expect(c.apiKey).toBe('sk-a...zzzz');
    expect(c.apiKey.includes('efghij')).toBe(false);
  });

  it('短 apiKey 用 *** 全掩', () => {
    const c = maskedConfig({ apiKey: 'short' });
    expect(c.apiKey).toBe('***');
  });

  it('无 apiKey 字段不报错', () => {
    const c = maskedConfig({ baseUrl: 'http://x' });
    expect(c.apiKey).toBeUndefined();
  });

  it('原对象不被修改（不可变契约）', () => {
    const orig = { apiKey: 'sk-abcdefghij1234567890zzzz', other: 1 };
    const c = maskedConfig(orig);
    expect(orig.apiKey).toBe('sk-abcdefghij1234567890zzzz');
    expect(c.other).toBe(1);
  });
});
