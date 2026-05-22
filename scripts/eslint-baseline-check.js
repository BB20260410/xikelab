#!/usr/bin/env node
// panel ESLint baseline check
//
// 读 eslint-report.json，按校准后 baseline 校验：
//   - hard error <= 0（必须保持 0）
//   - warning   <= 0（阶段 3 清理后实测 0，零容忍 drift）
//
// 失败时退出码 1 阻塞 CI；通过退出 0。
// 同步信息打到 stdout，便于 CI 日志可追。

import { readFileSync } from 'fs';

const REPORT = 'eslint-report.json';
const HARD_ERROR_MAX = 0;
const WARNING_MAX = 0;

let report;
try {
  report = JSON.parse(readFileSync(REPORT, 'utf8'));
} catch (e) {
  console.error(`[baseline-check] 无法读取 ${REPORT}: ${e.message}`);
  process.exit(2);
}

let errors = 0;
let warnings = 0;
const errorFiles = [];

for (const f of report) {
  errors += f.errorCount || 0;
  warnings += f.warningCount || 0;
  if (f.errorCount) {
    errorFiles.push({
      file: f.filePath,
      messages: (f.messages || []).filter(m => m.severity === 2).map(m => ({
        line: m.line, col: m.column, rule: m.ruleId, msg: m.message,
      })),
    });
  }
}

console.log(`[baseline-check] errors=${errors} warnings=${warnings}`);
console.log(`[baseline-check] thresholds: error<=${HARD_ERROR_MAX} warning<=${WARNING_MAX}`);

if (errors > HARD_ERROR_MAX) {
  console.error(`[baseline-check] FAIL — ${errors} hard error(s) > ${HARD_ERROR_MAX}`);
  for (const ef of errorFiles) {
    console.error(`  ${ef.file}`);
    for (const m of ef.messages) {
      console.error(`    L${m.line}:${m.col} [${m.rule}] ${m.msg}`);
    }
  }
  process.exit(1);
}

if (warnings > WARNING_MAX) {
  console.error(`[baseline-check] FAIL — ${warnings} warning(s) > ${WARNING_MAX} (baseline drift)`);
  process.exit(1);
}

console.log('[baseline-check] PASS');
process.exit(0);
