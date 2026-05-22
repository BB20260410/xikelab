// Xike Lab v2.0 — 密码自动填充代理 endpoint
//
// 设计目的：让 panel 帮 LLM 自动填密码到 Chrome，密码全程不进 LLM 对话
//   1. 密码存在 macOS Keychain（用户一次性 setup）
//   2. panel 后端用 `security` 命令读密码（panel 进程内）
//   3. panel 用 osascript 把密码 type 到 Chrome 当前活跃密码框
//   4. 返回 LLM 只有 { ok: true, filled: <长度> }，永不含密码字符串
//
// 安全模型：
//   - panel 仅本地监听 127.0.0.1:51735（不对外）
//   - 仅 macOS Keychain 已存的 site 能查
//   - 验证 Chrome 当前 URL 与请求的 site 匹配（防填错网站）
//   - 所有调用记 audit log（不含密码）

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { requireOwnerToken } from '../auth/owner-token.js';

const AUDIT_LOG = path.join(os.homedir(), '.claude-panel', 'auto-fill-audit.jsonl');

function appendAudit(record) {
  try {
    const dir = path.dirname(AUDIT_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ...record, ts: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } catch {
    // 不阻塞 — audit 失败也要继续
  }
}

// 从 Keychain 读密码（不返回给 LLM）
function readKeychainPassword(site) {
  try {
    const r = spawnSync('/usr/bin/security', ['find-internet-password', '-s', site, '-w'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

// 列 Keychain 已存的 site（仅元信息，不返回密码）
function listKeychainSites() {
  try {
    const r = spawnSync('/usr/bin/security', ['dump-keychain'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    if (r.status !== 0) return [];
    // 粗解析 dump-keychain 输出，提取 srvr=<site>
    const matches = r.stdout.match(/"srvr"<blob>="([^"]+)"/g) || [];
    return [...new Set(matches.map(m => m.match(/="([^"]+)"/)[1]).filter(s => s && !s.includes('.icloud.')))];
  } catch {
    return [];
  }
}

// 读 Chrome 当前活跃 tab URL
function getChromeActiveUrl() {
  try {
    const r = spawnSync('/usr/bin/osascript', ['-e', 'tell application "Google Chrome" to return URL of active tab of front window'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

// 用 osascript System Events 把字符串 type 到当前焦点框
// 关键：密码不能进 argv（macOS 进程列表可见），改用 stdin 传入。
// osascript 用 `read input` 从 stdin 读单行，再 keystroke。
function typeStringIntoChrome(s) {
  // 1. 确保 Chrome 在前台
  spawnSync('/usr/bin/osascript', ['-e', 'tell application "Google Chrome" to activate'], { timeout: 3000 });
  // 等 0.3 秒
  spawnSync('/bin/sleep', ['0.3']);
  // 2. 从 stdin 读字符串后 keystroke（避免 argv / env / shell 展开 leak）
  const script = `set inputStr to do shell script "cat"
tell application "System Events" to keystroke inputStr`;
  return new Promise(resolve => {
    let done = false;
    const proc = spawn('/usr/bin/osascript', ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { proc.kill('SIGKILL'); } catch {}
      resolve(false);
    }, 5000);
    proc.on('error', () => {
      if (done) return; done = true; clearTimeout(timer); resolve(false);
    });
    proc.on('exit', code => {
      if (done) return; done = true; clearTimeout(timer); resolve(code === 0);
    });
    // `cat` 读到 EOF 后返回原文；写完密码立刻关 stdin
    try { proc.stdin.end(s); } catch { /* exit handler 会兜底 */ }
  });
}

export function registerAutoFillRoutes(app) {
  // GET /api/auto-fill/status — 列已存 site，不含密码
  // Round 5 7M：sites 列表暴露 Keychain 里存了哪些登录站点 + chromeUrl 暴露当前活动 tab → owner-token
  app.get('/api/auto-fill/status', requireOwnerToken, (req, res) => {
    try {
      const sites = listKeychainSites();
      res.json({
        ok: true,
        chromeUrl: getChromeActiveUrl(),
        sitesCount: sites.length,
        sites: sites.slice(0, 50),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/auto-fill/password — 填密码到 Chrome 当前焦点框
  // body: { site: "github.com" }
  // 改：owner-token 保护 — 防本机其他 UID 进程 curl 触发把密码 type 到 Chrome 焦点框
  app.post('/api/auto-fill/password', requireOwnerToken, async (req, res) => {
    const { site } = req.body || {};
    if (!site || typeof site !== 'string') {
      return res.status(400).json({ ok: false, error: 'site required' });
    }
    // 防注入：site 必须是 domain 格式
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(site)) {
      return res.status(400).json({ ok: false, error: 'invalid site format' });
    }

    // 1. 验证 Chrome 当前 URL 与 site 匹配
    const url = getChromeActiveUrl();
    if (!url) {
      appendAudit({ action: 'fill', site, status: 'no-chrome-url' });
      return res.status(503).json({ ok: false, error: 'Chrome 未打开或无 active tab' });
    }
    if (!url.includes(site)) {
      appendAudit({ action: 'fill', site, status: 'url-mismatch', actualUrl: url });
      return res.status(403).json({
        ok: false,
        error: `Chrome 当前 URL (${url.slice(0, 60)}) 与请求 site (${site}) 不匹配，拒绝填密码`,
      });
    }

    // 2. 从 Keychain 读密码
    const password = readKeychainPassword(site);
    if (!password) {
      appendAudit({ action: 'fill', site, status: 'no-keychain' });
      return res.status(404).json({
        ok: false,
        error: `Keychain 里没存 ${site} 的密码。先跑 scripts/setup-keychain-passwords.sh`,
      });
    }

    // 3. type 到 Chrome（密码全程在 panel 进程内，不出口到外部）
    const ok = await typeStringIntoChrome(password);
    appendAudit({
      action: 'fill',
      site,
      status: ok ? 'success' : 'type-failed',
      length: password.length,
      url: url.slice(0, 100),
    });

    res.json({
      ok,
      site,
      filled: ok ? password.length : 0,
      message: ok ? `已填 ${password.length} 字符到 Chrome 焦点框` : 'osascript type 失败',
    });
  });

  // POST /api/auto-fill/type — 通用 type 任意文本（非密码用，如邮箱/用户名）
  // 这个允许 LLM 通过对话传字符串（不敏感的）
  // 改：owner-token 保护 — type 端点也能把任意文本 keystroke 到当前焦点，必须本机 owner
  app.post('/api/auto-fill/type', requireOwnerToken, async (req, res) => {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || text.length > 200) {
      return res.status(400).json({ ok: false, error: 'text required (max 200 chars)' });
    }
    const ok = await typeStringIntoChrome(text);
    appendAudit({ action: 'type', length: text.length, status: ok ? 'success' : 'failed' });
    res.json({ ok, typed: text.length });
  });

  // GET /api/auto-fill/audit — 查最近 100 条操作
  // Round 5 7M：audit 含 site + URL 历史 + 状态 → owner-token
  app.get('/api/auto-fill/audit', requireOwnerToken, (req, res) => {
    try {
      if (!fs.existsSync(AUDIT_LOG)) return res.json({ ok: true, items: [] });
      const lines = fs.readFileSync(AUDIT_LOG, 'utf8').trim().split('\n').filter(Boolean);
      const items = lines.slice(-100).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
      res.json({ ok: true, count: items.length, items });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
