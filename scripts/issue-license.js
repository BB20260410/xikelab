#!/usr/bin/env node
// 卖家本地签发 license 脚本（只在卖家电脑跑，需要私钥）
// 用法: node scripts/issue-license.js <email> <tier:free|pro|team> [days]
//   days = 0 或省略 → 永久
//   days = 365 → 一年

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { signLicense } from '../src/license/LicenseManager.js';

const [, , email, tier = 'pro', daysStr = '0'] = process.argv;

if (!email || !email.includes('@')) {
  console.error('用法: node scripts/issue-license.js <email> [tier:free|pro|team] [days]');
  console.error('示例: node scripts/issue-license.js buyer@x.com pro 365');
  process.exit(1);
}

const PRIV_KEY_PATH = path.join(os.homedir(), '.claude-panel-keys', 'panel-license-private-key.pem');
if (!fs.existsSync(PRIV_KEY_PATH)) {
  console.error(`❌ 私钥不存在: ${PRIV_KEY_PATH}`);
  console.error('   先跑: openssl genpkey -algorithm ed25519 -out ~/.claude-panel-keys/panel-license-private-key.pem');
  process.exit(1);
}

const privateKey = fs.readFileSync(PRIV_KEY_PATH, 'utf8');
const days = parseInt(daysStr, 10) || 0;
const expiresAt = days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : 0;

const licenseStr = signLicense({ email, tier, expiresAt }, privateKey);

console.log('✅ License 签发成功');
console.log('');
console.log(`邮箱:   ${email}`);
console.log(`Tier:   ${tier}`);
console.log(`有效期: ${days > 0 ? days + ' 天 (至 ' + new Date(expiresAt * 1000).toISOString() + ')' : '永久'}`);
console.log('');
console.log('--- LICENSE KEY (发给买家) ---');
console.log(licenseStr);
console.log('');
console.log('买家激活:');
console.log(`  curl -X POST http://localhost:51735/api/license/activate -H 'Content-Type: application/json' -d '{"license":"${licenseStr}"}'`);
console.log('或 panel UI: 设置 → License → 粘贴激活');
