#!/usr/bin/env node
// e2e-with-server.mjs（计划阶段 B1）
// 一条命令封装 e2e：随机空闲端口 + 隔离 HOME 起 server → 轮询就绪 → 跑 walkthrough
// → finally 必杀 server + 确认端口无监听 → 透传退出码。
//
// 解决「每次手动起服务 + kill + 查端口、易残留监听」的摩擦。
//   - 默认隔离 HOME（mkdtemp），server DATA_DIR 与 e2e owner-token 都走 os.homedir()，
//     设 HOME 后二者一致，且不污染真实 ~/.claude-panel。
//   - E2E_REAL_HOME=1 可改用真实 HOME（需要复用真实数据时）。
//   - PORT 可显式指定，否则取系统分配的空闲端口。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return true;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function portListening(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').trim().length > 0;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 隔离 HOME 后 Playwright 会在隔离目录找不到浏览器缓存（默认存真实 HOME）。
// 给 e2e 子进程指回真实缓存目录，server 仍用隔离 HOME 做数据隔离。
function playwrightCachePath(home) {
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(home, 'AppData', 'Local', 'ms-playwright');
  return join(home, '.cache', 'ms-playwright');
}

async function main() {
  const useRealHome = process.env.E2E_REAL_HOME === '1';
  const realHome = process.env.HOME || homedir();
  const isolatedHome = useRealHome ? null : mkdtempSync(join(tmpdir(), 'xikelab-e2e-'));
  const port = process.env.PORT ? Number(process.env.PORT) : await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const childEnv = { ...process.env, PORT: String(port) };
  if (isolatedHome) childEnv.HOME = isolatedHome;

  let server = null;
  let exitCode = 1;
  try {
    let serverLog = '';
    server = spawn('node', ['server.js'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => { serverLog += d.toString(); });
    server.stderr.on('data', (d) => { serverLog += d.toString(); });
    server.on('exit', (code) => {
      if (code && code !== 0) console.error(`⚠️ server 进程提前退出 code=${code}`);
    });

    const ready = await waitReady(`${baseUrl}/`, 30000);
    if (!ready) {
      console.error('❌ server 30s 内未就绪，日志尾部：\n' + serverLog.slice(-2000));
      throw new Error('server not ready');
    }
    console.log(`🚀 e2e server @ ${baseUrl}${isolatedHome ? `  (隔离 HOME=${isolatedHome})` : '  (真实 HOME)'}`);

    const e2eEnv = { ...childEnv, PANEL_URL: baseUrl };
    if (isolatedHome && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
      e2eEnv.PLAYWRIGHT_BROWSERS_PATH = playwrightCachePath(realHome);
    }
    const e2e = spawnSync('node', ['tests/e2e/panel-ui-walkthrough.mjs'], {
      cwd: ROOT,
      env: e2eEnv,
      stdio: 'inherit',
    });
    exitCode = e2e.status ?? 1;
  } finally {
    if (server && server.pid) {
      try { process.kill(server.pid, 'SIGTERM'); } catch { /* 已退出 */ }
      await sleep(800);
      try { process.kill(server.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }
    // 兜底：杀掉仍占用该端口的任何进程
    spawnSync('bash', ['-c', `lsof -ti tcp:${port} | xargs kill -9 2>/dev/null`]);
    await sleep(300);
    if (portListening(port)) {
      console.error(`⚠️ 端口 ${port} 仍在监听，清理失败`);
      exitCode = exitCode || 1;
    } else {
      console.log(`✅ 端口 ${port} 已清理，无残留监听`);
    }
    if (isolatedHome) {
      try { rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('e2e-with-server 失败：', e?.message || e);
  process.exit(1);
});
