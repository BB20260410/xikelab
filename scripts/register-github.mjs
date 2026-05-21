#!/usr/bin/env node
// scripts/register-github.mjs
// playwright 自动化骨架：打开 github.com/login 或 /signup，填邮箱，暂停等用户输密码
// 密码永不进脚本，避免泄漏到日志
//
// 用法：
//   node scripts/register-github.mjs --email ilifelahepeq54@gmail.com [--mode signup|login]

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const email = args.email || 'ilifelahepeq54@gmail.com';
const mode = args.mode || 'login';

console.log(`📦 GitHub ${mode === 'signup' ? '注册' : '登录'} 自动化`);
console.log(`   邮箱: ${email}`);
console.log('');

const browser = await chromium.launch({ headless: false, slowMo: 100 });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

if (mode === 'signup') {
  await page.goto('https://github.com/signup', { waitUntil: 'networkidle' });
  console.log('1. 已打开 signup 页');
  console.log('');
  console.log('请你在浏览器里：');
  console.log('  a. 输入邮箱（建议复制下面这行）：', email);
  console.log('  b. 自己输 username（建议 hxx-panel 或类似）');
  console.log('  c. 自己从 Apple Notes 取密码粘贴');
  console.log('  d. 完成 CAPTCHA');
  console.log('  e. 点 Continue → 去 Gmail 看 6 位验证码');
  console.log('  f. 完成 onboarding survey 或 skip');
  console.log('');
  console.log('完成后回这个终端按 Enter 继续');
} else {
  await page.goto('https://github.com/login', { waitUntil: 'networkidle' });
  console.log('1. 已打开 login 页');
  console.log('');
  console.log('请你在浏览器里：');
  console.log('  a. Username/email：你的 GitHub username 或邮箱');
  console.log('  b. Password：自己从 Apple Notes 取密码粘贴（永远别口头告诉我）');
  console.log('  c. 完成 2FA（如果开了）');
  console.log('');
  console.log('完成后回这个终端按 Enter 继续');
}

// 等待用户登录完成
await waitForEnter();

// 验证登录成功
await page.waitForLoadState('networkidle');
const loggedIn = await page.evaluate(() => {
  return !!document.querySelector('meta[name="user-login"][content]');
});

if (!loggedIn) {
  console.log('❌ 登录未成功（meta[user-login] 不存在）');
  console.log('   当前 URL:', page.url());
  await browser.close();
  process.exit(1);
}

const username = await page.evaluate(() => document.querySelector('meta[name="user-login"]')?.content);
console.log(`✅ 登录成功！username: ${username}`);
console.log('');

// 创建 repo
console.log('2. 自动跳到创建 repo 页');
await page.goto('https://github.com/new');
await page.waitForSelector('input#repository_name', { timeout: 10000 });

const repoName = args.repo || 'xikely';
await page.fill('input#repository_name', repoName);
console.log(`   已填 repo 名：${repoName}`);
console.log('');
console.log('请你在浏览器里：');
console.log('  a. 检查 description（已留空，可手填）');
console.log('  b. 选 Public（panel 开源策略，必须公开才能用免费 GitHub Release）');
console.log('  c. 滚到底部点 Create repository');
console.log('');
console.log('完成后回终端按 Enter');
await waitForEnter();

// 生成 PAT
console.log('3. 跳到 PAT 生成页');
await page.goto('https://github.com/settings/tokens/new?scopes=repo&description=panel-release-publish');
await page.waitForLoadState('networkidle');
console.log('');
console.log('请你在浏览器里：');
console.log('  a. 检查 scope：✅ repo（已勾）');
console.log('  b. expiration：90 days 或 No expiration（建议 90 days）');
console.log('  c. 点 Generate token');
console.log('  d. ⚠️ 复制 token（只显示一次！）');
console.log('  e. 把 token 贴下面（建议直接 ⌘C 后粘到终端）：');
process.stdout.write('   PAT: ');
const token = await readLine();

if (!token || !token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
  console.log('❌ token 格式不对（应 ghp_ 或 github_pat_ 开头）');
  await browser.close();
  process.exit(1);
}

// 存到 ~/.claude-panel/github-token.json (0o600)
const fs = await import('node:fs');
const path = await import('node:path');
const os = await import('node:os');
const tokenPath = path.join(os.homedir(), '.claude-panel', 'github-token.json');
const dir = path.dirname(tokenPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(tokenPath, JSON.stringify({ token, username, repo: repoName, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
console.log(`✅ token 存到 ${tokenPath} (0o600)`);
console.log('');
console.log('4. 下一步：跑 npm run dist:publish');
console.log(`   先 export GH_TOKEN=$(node -p "require('${tokenPath}').token")`);
console.log(`   再 npm run dist:publish`);
console.log('');
console.log('✅ GitHub 准备完成！');

await browser.close();

// === helpers ===
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function waitForEnter() {
  return new Promise(resolve => {
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}

function readLine() {
  return new Promise(resolve => {
    let buf = '';
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (chunk) => {
      buf += chunk;
      if (buf.includes('\n')) {
        process.stdin.off('data', onData);
        resolve(buf.trim());
      }
    };
    process.stdin.on('data', onData);
  });
}
