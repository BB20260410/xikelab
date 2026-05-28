#!/usr/bin/env node
// release-build.mjs — 可靠的桌面打包流水线
//
// 解决 electron-builder 已知坑:`npm run package` 跑完后,@electron/rebuild 偶发 silent
// 失败(显示「preparing→finished」但实际未对 better-sqlite3 重编为 Electron ABI),
// 致 .app 内 better-sqlite3.node 仍是 Node ABI 127,运行时报 NODE_MODULE_VERSION mismatch。
//
// 流程:
//   1) electron-builder --mac --dir         打包初始 .app(此时 bsq3.node 可能是错的 ABI)
//   2) 强制 @electron/rebuild Electron 37    项目 node_modules/bsq3.node → Electron ABI 136
//   3) cp 项目 bsq3.node → .app 内对应位置    .app 内 bsq3.node → Electron ABI(运行 OK)
//   4) npm rebuild better-sqlite3           项目 node_modules/bsq3.node → Node ABI 127(测试 OK)
//   5) 验证两者 sha256 不同(分别 Electron/Node ABI)
//
// 用法:`npm run build:app`(替代直接 `npm run package`)

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_VERSION = '37.10.3';
const ARCH = 'arm64';
const APP_NAME = 'Xike Lab.app';
const PROJ_NODE = join(ROOT, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
const APP_NODE = join(ROOT, 'out/mac-arm64', APP_NAME, 'Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node');

function run(label, cmd, args, opts = {}) {
  console.log(`\n▶ ${label}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${label} 失败,退出码 ${r.status}`);
}
function hash(p) { return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) : '(无文件)'; }

console.log(`=== Xike Lab 桌面打包流水线 (Electron ${ELECTRON_VERSION}, ${ARCH}) ===`);

// 1) 主打包
run('1. electron-builder --mac --dir', 'npx', ['electron-builder', '--mac', '--dir']);
if (!existsSync(APP_NODE)) throw new Error(`.app 未产出预期 .node 路径: ${APP_NODE}`);
console.log(`   .app 内 bsq3.node 哈希(可能是错 ABI): ${hash(APP_NODE)}`);

// 2) 强制为 Electron 37 重编 bsq3(修 @electron/rebuild 偶发 silent failure)
run('2. force @electron/rebuild for Electron 37', 'npx', [
  '@electron/rebuild', '--version', ELECTRON_VERSION, '--only', 'better-sqlite3', '--force', '--arch', ARCH,
]);
const electronHash = hash(PROJ_NODE);
console.log(`   项目 bsq3.node 哈希(Electron ABI): ${electronHash}`);

// 3) 把项目 Electron-ABI bsq3.node 拷贝到 .app(替换可能错的版本)
copyFileSync(PROJ_NODE, APP_NODE);
console.log(`3. 拷贝项目 bsq3.node → .app 内\n   .app 内 bsq3.node 哈希(应=Electron): ${hash(APP_NODE)}`);

// 4) 项目 bsq3.node 回 Node ABI(测试要用)
run('4. npm rebuild better-sqlite3 (Node ABI)', 'npm', ['rebuild', 'better-sqlite3']);
const nodeHash = hash(PROJ_NODE);
console.log(`   项目 bsq3.node 哈希(Node ABI): ${nodeHash}`);

// 5) 验证:.app 内 = Electron ABI,项目 = Node ABI,二者不同
const appHash = hash(APP_NODE);
if (appHash !== electronHash) throw new Error(`.app 内 .node 哈希(${appHash}) 应保持 Electron ABI(${electronHash}),被改写了`);
if (nodeHash === appHash) throw new Error(`项目 .node 与 .app 内同 ABI,测试与运行时只能二选一`);
console.log(`\n✅ 打包完成且 ABI 分离正确:`);
console.log(`   - .app(运行时,Electron ABI): ${appHash}`);
console.log(`   - 项目 node_modules(测试,Node ABI): ${nodeHash}`);
console.log(`   后续 npm test 可跑(Node ABI);.app 可运行(Electron ABI)。`);
