#!/usr/bin/env node
// v0.85 minimum 性能 audit 脚本（学自 W3 LibreChat 等测试文化）
// 用法：node scripts/perf-check.mjs
// 输出：核心 endpoint TTFB / panel 静态资源体积 / 主要 jsonl 文件大小

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PANEL = process.env.PANEL_URL || 'http://localhost:51735';
const PANEL_URL = new URL(PANEL);
const PANEL_PORT = PANEL_URL.port || (PANEL_URL.protocol === 'https:' ? '443' : '80');

function readOwnerToken() {
  try {
    const token = readFileSync(join(homedir(), '.claude-panel', 'owner-token.txt'), 'utf8').trim();
    return token.length >= 32 ? token : '';
  } catch {
    return '';
  }
}

const OWNER_TOKEN = readOwnerToken();

function curlTime(url) {
  try {
    const args = ['-s', '-o', '/dev/null', '-w', '%{http_code}|%{time_total}|%{size_download}'];
    if (OWNER_TOKEN) args.push('-H', `X-Panel-Owner-Token: ${OWNER_TOKEN}`);
    args.push(url);
    const r = execFileSync('curl', args, { encoding: 'utf8', timeout: 5000 });
    const [code, time, size] = r.split('|');
    return { code, ms: Math.round(parseFloat(time) * 1000), bytes: parseInt(size, 10) };
  } catch { return { code: 'ERR', ms: 0, bytes: 0 }; }
}

function statusFlag(r) {
  if (!/^[23]/.test(r.code)) return '🔴';
  if (r.ms > 500) return '🔴';
  if (r.bytes > 5 * 1024 * 1024) return '🟡';
  if (r.ms > 100) return '🟡';
  return '🟢';
}

function lineCount(file) {
  const txt = readFileSync(file, 'utf8');
  return txt.length === 0 ? 0 : txt.split('\n').length;
}

console.log('🚀 Panel 性能 audit @ ' + new Date().toISOString());
console.log(`Panel: ${PANEL}${OWNER_TOKEN ? ' (owner-token loaded)' : ' (owner-token missing: protected APIs will 401)'}`);
console.log('');

// 1. 核心 endpoint 响应时间
console.log('## endpoint TTFB');
const endpoints = [
  '/',
  '/app.js',
  '/style.css',
  '/api/sessions',
  '/api/rooms',
  '/api/room-adapters',
  '/api/autopilot/config',
  '/api/mcp/servers',
];
for (const ep of endpoints) {
  const r = curlTime(`${PANEL}${ep}`);
  const flag = statusFlag(r);
  console.log(`  ${flag} ${ep.padEnd(30)} ${r.code} ${String(r.ms).padStart(5)}ms ${(r.bytes / 1024).toFixed(1)}K`);
}
console.log('');

// 2. 静态资源体积
console.log('## 静态资源 wc -l');
const staticFiles = ['public/app.js', 'public/style.css', 'public/index.html', 'server.js'];
for (const f of staticFiles) {
  try {
    const lines = lineCount(f);
    const bytes = statSync(f).size;
    const flag = bytes > 200000 ? '🔴' : bytes > 100000 ? '🟡' : '🟢';
    console.log(`  ${flag} ${f.padEnd(20)} ${String(lines).padStart(6)} lines / ${(bytes / 1024).toFixed(0)}K`);
  } catch {}
}
console.log('');

// 3. ~/.claude-panel 数据膨胀
console.log('## ~/.claude-panel 数据');
const dataDir = join(homedir(), '.claude-panel');
try {
  const files = readdirSync(dataDir);
  for (const f of files.slice(0, 20)) {
    try {
      const s = statSync(join(dataDir, f));
      if (!s.isFile()) continue;
      const flag = s.size > 5_000_000 ? '🔴' : s.size > 1_000_000 ? '🟡' : '🟢';
      console.log(`  ${flag} ${f.padEnd(40)} ${(s.size / 1024).toFixed(1)}K`);
    } catch {}
  }
} catch {}
console.log('');

// 4. 进程内存
console.log('## panel 进程');
try {
  const pid = execFileSync('lsof', ['-ti', `tcp:${PANEL_PORT}`], { encoding: 'utf8' }).trim().split('\n')[0];
  const mem = execFileSync('ps', ['-o', 'rss=', '-p', pid], { encoding: 'utf8' }).trim();
  const memMB = (parseInt(mem, 10) / 1024).toFixed(1);
  const flag = parseFloat(memMB) > 500 ? '🔴' : parseFloat(memMB) > 200 ? '🟡' : '🟢';
  console.log(`  ${flag} PID ${pid} RSS ${memMB}MB`);
} catch (e) {
  console.log(`  ⚠️ 探测失败: ${e.message}`);
}

console.log('');
console.log('🏁 audit done');
