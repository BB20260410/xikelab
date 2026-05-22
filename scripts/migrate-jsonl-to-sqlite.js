#!/usr/bin/env node
// 一次性把 ~/.claude-panel 下所有 jsonl 导入 SQLite
// 安全：写完不删 jsonl，原文件保留作 fallback

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initSqlite, appendEvent, getStats } from '../src/storage/SqliteStore.js';

const HOME = path.join(os.homedir(), '.claude-panel');

const SOURCES = [
  { glob: /^mcp-calls-(\d{4})-(\d{2})\.jsonl$/, kind: 'mcp_call' },
  { glob: /^metrics-(\d{4})-(\d{2})\.jsonl$/, kind: 'metric' },
  { glob: /^autopilot-log\.jsonl$/, kind: 'autopilot' },
  { glob: /^licenses-issued\.jsonl$/, kind: 'license_issued' },
];

function migrateFile(filePath, kind) {
  if (!fs.existsSync(filePath)) return { imported: 0, skipped: 0 };
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  let imported = 0, skipped = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const ts = obj.ts ? (typeof obj.ts === 'number' ? obj.ts : new Date(obj.ts).getTime()) : Date.now();
      const roomId = obj.roomId || obj.room_id || obj.room || null;
      const tag = obj.tag || obj.provider || obj.type || null;
      appendEvent({ kind, ts, roomId, tag, ...obj });
      imported++;
    } catch {
      skipped++;
    }
  }
  return { imported, skipped };
}

initSqlite();
console.log('📦 开始迁移 jsonl → SQLite');
console.log('   目录:', HOME);
console.log('');

let totalImported = 0, totalSkipped = 0;
const files = fs.existsSync(HOME) ? fs.readdirSync(HOME) : [];
for (const file of files) {
  for (const src of SOURCES) {
    if (src.glob.test(file)) {
      const { imported, skipped } = migrateFile(path.join(HOME, file), src.kind);
      if (imported || skipped) {
        console.log(`   ${file} → ${src.kind}: ${imported} 行 ✅  ${skipped ? '(skip ' + skipped + ' 解析失败)' : ''}`);
        totalImported += imported;
        totalSkipped += skipped;
      }
    }
  }
}

console.log('');
console.log(`✅ 完成：导入 ${totalImported} 行，跳过 ${totalSkipped} 行`);
console.log('');
console.log('SQLite 状态:');
console.log(JSON.stringify(getStats(), null, 2));
console.log('');
console.log('💡 原 jsonl 文件保留（作 fallback）。如确认无误可手动 rm。');
