// owner-token 鉴权：保护 panel 本机写敏感配置（webhook secret 等）端点
//
// 威胁模型：panel 监听 127.0.0.1:51735，但本机其他用户进程也能 curl localhost。
// 任何能写 webhook secret / 支付集成 secret 的端点，必须验证调用者持有 owner token。
// owner token 落在 ~/.claude-panel/owner-token.txt（0600），首次访问自动生成 32 字节随机 hex。
// 浏览器内本面板调用时，前端先读 owner-token 拉到 sessionStorage 再带 X-Panel-Owner-Token。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OWNER_TOKEN_PATH = path.join(os.homedir(), '.claude-panel', 'owner-token.txt');

export function getOrCreateOwnerToken() {
  try {
    if (fs.existsSync(OWNER_TOKEN_PATH)) {
      const t = fs.readFileSync(OWNER_TOKEN_PATH, 'utf8').trim();
      if (t.length >= 32) return t;
    }
    const dir = path.dirname(OWNER_TOKEN_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const t = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(OWNER_TOKEN_PATH, t + '\n', { mode: 0o600 });
    return t;
  } catch {
    return null;
  }
}

export function requireOwnerToken(req, res, next) {
  const owner = getOrCreateOwnerToken();
  if (!owner) return res.status(500).json({ error: 'owner token unavailable' });
  const provided = (req.get('X-Panel-Owner-Token') || '').trim();
  if (!provided || provided.length !== owner.length) {
    return res.status(401).json({ error: 'owner token required (see ~/.claude-panel/owner-token.txt)' });
  }
  try {
    if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(owner))) {
      return res.status(401).json({ error: 'owner token mismatch' });
    }
  } catch {
    return res.status(401).json({ error: 'owner token compare failed' });
  }
  next();
}
