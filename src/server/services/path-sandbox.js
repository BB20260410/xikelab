// v0.49 B-02 fix: 文件 API 路径沙箱
// 允许：用户 home（不含敏感子目录）/ /tmp。其它一律 403。
//
// 拆出自 server.js:459-482，便于 in-process 单测（不需要起 HTTP server）。

import { realpathSync } from 'fs';
import { homedir } from 'os';

export const FORBIDDEN_HOME_SUBPATHS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
  '.kube',
  'Library/Keychains',
  'Library/Application Support/com.apple.TCC',
  '.password-store',
];

export function safeResolveFsPath(p) {
  if (!p || typeof p !== 'string') return null;
  if (p.startsWith('~')) p = p.replace(/^~/, homedir());
  let real;
  try { real = realpathSync(p); }
  catch { return null; }
  const allowedRoots = [];
  try { allowedRoots.push(realpathSync(homedir())); } catch {}
  try { allowedRoots.push(realpathSync('/tmp')); } catch { allowedRoots.push('/tmp'); }
  const inRoot = allowedRoots.some(root => real === root || real.startsWith(root + '/'));
  if (!inRoot) return null;
  // 在 home 子树里禁止敏感目录
  const HOME = (() => { try { return realpathSync(homedir()); } catch { return homedir(); } })();
  if (real === HOME || real.startsWith(HOME + '/')) {
    const rel = real === HOME ? '' : real.slice(HOME.length + 1);
    for (const f of FORBIDDEN_HOME_SUBPATHS) {
      if (rel === f || rel.startsWith(f + '/')) return null;
    }
  }
  return real;
}
