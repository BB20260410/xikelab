// 可选的出站上传 domain allowlist（P9 刀2）。
//
// 威胁：webhook / 网络上传可指向任意公网 host，即使过了 SSRF（私网）防护，
// 仍可能把数据发到非预期的公网服务。本机制让用户可选地把出站目标限制到白名单。
//
// 配置文件：~/.claude-panel/upload-allowlist.json
//   { "hosts": ["discord.com", "hooks.slack.com", "*.example.com"] }
// 行为：
//   - 文件不存在 / hosts 为空 → 放行任意公网 host（默认，向后兼容）。
//   - 配置了 hosts → 仅放行精确匹配或 *.domain 通配匹配的 host，其余拒绝。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ALLOWLIST_PATH = join(homedir(), '.claude-panel', 'upload-allowlist.json');

export function loadUploadAllowlist(path = ALLOWLIST_PATH) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const hosts = Array.isArray(raw?.hosts)
      ? raw.hosts.map((h) => String(h || '').trim().toLowerCase()).filter(Boolean)
      : [];
    return { hosts };
  } catch {
    return { hosts: [] };
  }
}

function hostMatches(host, pattern) {
  const h = String(host || '').toLowerCase();
  const p = String(pattern || '').toLowerCase();
  if (!p) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return h === p.slice(2) || h.endsWith(suffix);
  }
  return h === p;
}

// 无配置（空列表）→ 放行；有配置 → 必须命中白名单。
export function isUploadHostAllowed(host, allowlist = loadUploadAllowlist()) {
  const hosts = allowlist?.hosts || [];
  if (!hosts.length) return true;
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return hosts.some((p) => hostMatches(h, p));
}
