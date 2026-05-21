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

const CACHE_DIR = join(homedir(), '.claude-panel', 'img-cache');
const MAX_FILE_SIZE = 8 * 1024 * 1024;       // 8MB / image
const MAX_DIR_SIZE = 200 * 1024 * 1024;      // 200MB 总
const FETCH_TIMEOUT_MS = 12_000;

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
    // 仅 http/https 白名单（防 file:// / javascript: / data:）
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'only http/https url allowed' });
    if (url.length > 2048) return res.status(400).json({ error: 'url too long' });

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

    // miss，下载
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      let resp;
      try {
        resp = await fetch(url, { signal: ac.signal, redirect: 'follow' });
      } finally { clearTimeout(timer); }
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
