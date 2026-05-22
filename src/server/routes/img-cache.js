// B-005 v0.9 真做：AI markdown 图片本地缓存（学自 Cherry Studio issue #6972）
//
// 工作方式：
// - 前端 markdown 渲染后扫 img.src 是 http/https 的，改成 /api/img-cache?url=<原 url>
// - 本 endpoint 下载到 ~/.claude-panel/img-cache/<sha1>.<ext>，0o600 权限
// - 后续访问直接返本地文件（避免外链失效）
// - 同 url 复用 hash → 不重复下载
// - 上限：单文件 ≤ 8MB，总目录 ≤ 200MB（超了 LRU 删旧的）

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { promises as dns } from 'node:dns';
import net from 'node:net';

const CACHE_DIR = join(homedir(), '.claude-panel', 'img-cache');
const MAX_FILE_SIZE = 8 * 1024 * 1024;       // 8MB / image
const MAX_DIR_SIZE = 200 * 1024 * 1024;      // 200MB 总
const FETCH_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;

// SSRF 防护：拒 loopback / 私网 / 链路本地 / 多播 / 元数据服务
// IPv4：127/8 10/8 172.16/12 192.168/16 169.254/16 100.64/10 0.0.0.0 224/4
// IPv6：::1 fc00::/7 fe80::/10 ::ffff:私网（v4-mapped）
export function isPrivateIp(ip) {
  if (!ip) return true;
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(n => parseInt(n, 10));
    if (p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
    if (p[0] === 127) return true;
    if (p[0] === 10) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] === 0) return true;
    if (p[0] >= 224) return true;          // 多播 + 保留
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
    if (lower.startsWith('ff')) return true;  // 多播
    // v4-mapped IPv6：dotted 形式 ::ffff:a.b.c.d
    const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    // v4-mapped IPv6：hex 压缩形式 ::ffff:hhhh:hhhh（URL.hostname 压缩 ::ffff:127.0.0.1 → ::ffff:7f00:1）
    const m2 = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (m2) {
      const h1 = parseInt(m2[1], 16);
      const h2 = parseInt(m2[2], 16);
      const v4 = `${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`;
      return isPrivateIp(v4);
    }
    return false;
  }
  return true;
}

// 解析 url → 拒非 http(s) / 拒非默认端口（避免扫内网服务）/ DNS lookup → 拒私网
export async function assertPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('invalid url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol not allowed');
  // 端口白名单：80/443 + 默认空（避开 22/3306/6379/Redis/Postgres 等内网服务）
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (!['80', '443', '8080', '8443'].includes(port)) throw new Error(`port ${port} not allowed`);
  // IPv6 literal 的 URL.hostname 带方括号（如 "[::1]"），net.isIP 不识别，得 strip 再判
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
  // 直接 IP literal：直接判
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('private ip blocked');
    return;
  }
  // 域名：DNS 反查 — 拒任何指向私网的解析（防 DNS rebinding 的第一关）
  let addrs;
  try { addrs = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error('dns lookup failed'); }
  if (!addrs.length) throw new Error('dns no addrs');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`dns resolved to private ip ${a.address}`);
  }
}

function ensureDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  }
}

function urlToKey(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 24);
}

function guessExt(url, contentType = '') {
  const m = url.match(/\.([a-z0-9]{2,5})(?:[?#].*)?$/i);
  if (m) return m[1].toLowerCase().slice(0, 5);
  if (/png/i.test(contentType)) return 'png';
  if (/jpe?g/i.test(contentType)) return 'jpg';
  if (/gif/i.test(contentType)) return 'gif';
  if (/webp/i.test(contentType)) return 'webp';
  if (/svg/i.test(contentType)) return 'svg';
  return 'bin';
}

// 简易 LRU：按 atime 排序删旧的，超过 MAX_DIR_SIZE 时
function evictIfNeeded() {
  try {
    if (!existsSync(CACHE_DIR)) return;
    const files = readdirSync(CACHE_DIR).map(f => {
      const fp = join(CACHE_DIR, f);
      const s = statSync(fp);
      return { fp, size: s.size, atime: s.atimeMs };
    }).sort((a, b) => a.atime - b.atime);
    let total = files.reduce((s, f) => s + f.size, 0);
    while (total > MAX_DIR_SIZE && files.length > 0) {
      const oldest = files.shift();
      try { unlinkSync(oldest.fp); } catch {}
      total -= oldest.size;
    }
  } catch {}
}

export function registerImgCacheRoutes(app) {
  app.get('/api/img-cache', async (req, res) => {
    const url = String(req.query.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url required' });
    if (url.length > 2048) return res.status(400).json({ error: 'url too long' });
    // 协议 / 端口 / 私网 IP 校验在 assertPublicUrl 内统一做

    ensureDir();
    const key = urlToKey(url);
    const candidates = readdirSync(CACHE_DIR).filter(f => f.startsWith(key + '.'));

    if (candidates.length > 0) {
      // 命中 cache，返本地
      const fp = join(CACHE_DIR, candidates[0]);
      const buf = readFileSync(fp);
      const ext = candidates[0].split('.').pop();
      const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' })[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Img-Cache', 'HIT');
      return res.end(buf);
    }

    // miss，下载（手动跟 redirect，每跳一次重做 SSRF 校验）
    try {
      let curUrl = url;
      let resp;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          try { await assertPublicUrl(curUrl); }
          catch (e) { clearTimeout(timer); return res.status(400).json({ error: `url blocked: ${e.message}` }); }
          resp = await fetch(curUrl, { signal: ac.signal, redirect: 'manual' });
          if (resp.status >= 300 && resp.status < 400) {
            const loc = resp.headers.get('location');
            if (!loc) return res.status(502).json({ error: 'redirect without Location' });
            try { curUrl = new URL(loc, curUrl).toString(); }
            catch { return res.status(502).json({ error: 'invalid redirect target' }); }
            continue;
          }
          break;
        }
      } finally { clearTimeout(timer); }
      if (!resp) return res.status(502).json({ error: 'no response' });
      if (resp.status >= 300 && resp.status < 400) return res.status(502).json({ error: 'too many redirects' });
      if (!resp.ok) return res.status(502).json({ error: `upstream ${resp.status}` });
      // B-005 安全：只允许 image mime（防被 LLM 误传 css/html/exe 做 proxy）
      const mime = resp.headers.get('content-type') || '';
      if (!/^image\//i.test(mime)) return res.status(415).json({ error: `not an image (${mime})` });
      const len = parseInt(resp.headers.get('content-length') || '0', 10);
      if (len > MAX_FILE_SIZE) return res.status(413).json({ error: `image too large (${len} > ${MAX_FILE_SIZE})` });
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_FILE_SIZE) return res.status(413).json({ error: 'image too large after download' });

      const ext = guessExt(url, mime);
      const fp = join(CACHE_DIR, `${key}.${ext}`);
      writeFileSync(fp, buf, { mode: 0o600 });
      try { chmodSync(fp, 0o600); } catch {}
      evictIfNeeded();

      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Img-Cache', 'MISS-DL');
      res.end(buf);
    } catch (e) {
      res.status(502).json({ error: 'fetch failed: ' + e.message });
    }
  });

  // 状态查询
  app.get('/api/img-cache/stats', (_, res) => {
    try {
      ensureDir();
      const files = readdirSync(CACHE_DIR);
      const totalSize = files.reduce((s, f) => {
        try { return s + statSync(join(CACHE_DIR, f)).size; } catch { return s; }
      }, 0);
      res.json({ ok: true, count: files.length, totalBytes: totalSize, totalMB: (totalSize / 1024 / 1024).toFixed(2), maxMB: MAX_DIR_SIZE / 1024 / 1024 });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return { CACHE_DIR };
}
