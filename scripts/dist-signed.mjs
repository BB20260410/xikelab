#!/usr/bin/env node
// dist-signed.mjs — 读 ~/.claude-panel/release-config.json 喂 env-var 给 electron-builder
// 做 signed + notarized .dmg。签名/公证逻辑全在 electron-builder（成熟、文档化）,本脚本只
// 负责安全地装载凭据 + 跑可靠的 ABI 修正流水线 + 校验。
//
// 用法:`npm run dist:signed`
//
// 流程:
//   1) 读 ~/.claude-panel/release-config.json(缺则告知字段)
//   2) 装 env-var:CSC_NAME / APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
//   3) 跑 build:app 流水线(electron-builder --dir + bsq3 ABI 修正)
//   4) electron-builder --mac dmg(在 .app 基础上压 .dmg,带签名/公证)
//   5) spctl + xcrun stapler 验证
//   6) 输出验证日志到 out/sign-verify.log

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(homedir(), '.claude-panel', 'release-config.json');
const REQUIRED = ['appleId', 'appleIdPassword', 'teamId', 'identity'];

function fatal(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    fatal(`未找到 ${CONFIG_PATH}\n请先创建,字段:\n  ${REQUIRED.join(', ')} (+可选 notaryTeamId,缺省=teamId)\n` +
          `权限建议:mkdir -p ~/.claude-panel && chmod 700 ~/.claude-panel,文件 chmod 600。`);
  }
  // 强校验权限(凭据明文,世界可读=泄漏风险)
  const mode = statSync(CONFIG_PATH).mode & 0o777;
  if (mode !== 0o600 && mode !== 0o400) {
    console.warn(`⚠ ${CONFIG_PATH} 权限是 ${mode.toString(8)},建议 chmod 600(凭据明文,避免世界可读)`);
  }
  let cfg;
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { fatal(`config JSON 解析失败:${e.message}`); }
  const missing = REQUIRED.filter((k) => !cfg[k] || typeof cfg[k] !== 'string' || !cfg[k].trim());
  if (missing.length) fatal(`config 缺字段:${missing.join(', ')}`);
  return cfg;
}

function run(label, cmd, args, opts = {}) {
  console.log(`\n▶ ${label}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) fatal(`${label} 失败,退出码 ${r.status}`);
  return r;
}

function runCapture(label, cmd, args, opts = {}) {
  console.log(`\n▶ ${label}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  console.log(r.stdout || ''); if (r.stderr) console.error(r.stderr);
  return r;
}

const cfg = loadConfig();
const env = {
  ...process.env,
  CSC_NAME: cfg.identity,                                    // 钥匙串里的完整 identity 串
  APPLE_ID: cfg.appleId,
  APPLE_APP_SPECIFIC_PASSWORD: cfg.appleIdPassword,
  APPLE_TEAM_ID: cfg.notaryTeamId || cfg.teamId,
};
// 不打印任何凭据,只显示哪些被装载
console.log(`✓ 已装载 env:CSC_NAME / APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID(值不打印)`);

// 步 1+2+3+4:跑 build:app 流水线(产 .app + 修正 bsq3 ABI)
run('build:app 流水线', 'node', ['scripts/release-build.mjs'], { env });

// 步 5:在已有 .app 上压 .dmg,带签名 + 公证
// electron-builder --mac dmg 检测到 .app 存在会跳过 rebuild,直接打 dmg 并 sign+notarize
run('electron-builder --mac dmg (sign + notarize)', 'npx', ['electron-builder', '--mac', 'dmg', '--prepackaged', 'out/mac-arm64/Xike Lab.app'], { env });

// 步 6:校验 .dmg
const dmgs = [];
try {
  const fs = await import('node:fs');
  for (const f of fs.readdirSync(join(ROOT, 'out'))) {
    if (f.endsWith('.dmg') && f.startsWith('Xike Lab')) dmgs.push(join(ROOT, 'out', f));
  }
} catch {}
if (!dmgs.length) fatal('未找到产出的 .dmg(out/Xike Lab-*.dmg)');
const dmg = dmgs[0];
console.log(`\n📦 .dmg 产出:${dmg}`);

const logLines = [`# Sign + Notarize verification`, `Time: ${new Date().toISOString()}`, `DMG: ${dmg}`, ''];
const spctl = runCapture('spctl -a -vv (Gatekeeper 校验)', 'spctl', ['-a', '-vv', '--type', 'install', dmg]);
logLines.push('## spctl', spctl.stdout || '', spctl.stderr || '', '');
const stapler = runCapture('xcrun stapler validate (公证票据校验)', 'xcrun', ['stapler', 'validate', dmg]);
logLines.push('## stapler', stapler.stdout || '', stapler.stderr || '', '');
writeFileSync(join(ROOT, 'out', 'sign-verify.log'), logLines.join('\n'));
console.log(`\n📝 验证日志:out/sign-verify.log`);

if (spctl.status !== 0) fatal('spctl 校验失败(.dmg 可能未正确签名 → Gatekeeper 会阻止安装)');
if (stapler.status !== 0) fatal('stapler 校验失败(公证票据未附,Gatekeeper 离线会阻止)');

console.log(`\n✅ 完成:signed + notarized .dmg 已产出并校验通过`);
console.log(`   下一步:把 .dmg 上传 GitHub Release(gh release create v2.0.0 ...)`);
