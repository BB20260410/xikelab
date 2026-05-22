// src/server/archive/diff-viewer.js
//
// 补 panel 弱点 W2（无内置 diff viewer）— Phase 7 A3
// 给定 2 个事件序列（来自 LsmArchiver.scanBy 或任意 jsonl），按字段抽 text，做行级 diff
//
// 用 Myers diff 简化版（LCS DP，N×M）。事件序列短（debate 一轮 4-8 模型 × ~50 行），N×M 在 5e4 内可忽略。
// 不引第三方 diff 库（避免给 panel 加 dep；jsdiff 依赖 chrome）
//
// 返回结构：{ ops: [{op: '=' | '-' | '+', text}], stats: {added, removed, same} }

function splitLines(s) {
  if (typeof s !== 'string') s = String(s ?? '');
  return s.split('\n');
}

/** 经典 LCS DP，回溯输出 diff ops */
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  // dp[i][j] = LCS length of a[0..i-1] vs b[0..j-1]
  // 用 Int32Array 数组省内存
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { ops.push({ op: '=', text: a[i - 1] }); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { ops.push({ op: '-', text: a[i - 1] }); i--; }
    else { ops.push({ op: '+', text: b[j - 1] }); j--; }
  }
  while (i > 0) { ops.push({ op: '-', text: a[--i] }); }
  while (j > 0) { ops.push({ op: '+', text: b[--j] }); }
  ops.reverse();
  return ops;
}

/** 对两段文本做行级 diff */
export function diffText(left, right) {
  const a = splitLines(left), b = splitLines(right);
  const ops = lcsDiff(a, b);
  let added = 0, removed = 0, same = 0;
  for (const o of ops) {
    if (o.op === '+') added++;
    else if (o.op === '-') removed++;
    else same++;
  }
  return { ops, stats: { added, removed, same } };
}

/** 把事件序列拼成可 diff 的文本（默认抽 text/content 字段，行间 \n） */
function eventsToText(events, field = 'text') {
  return events.map((e) => (e?.[field] ?? JSON.stringify(e))).join('\n');
}

/** 给定两个事件序列做 diff（panel 调用面入口） */
export function diffEventStreams(leftEvents, rightEvents, { field = 'text' } = {}) {
  return diffText(eventsToText(leftEvents, field), eventsToText(rightEvents, field));
}

/** 把 ops 渲染成 unified diff 文本（CLI / 日志友好） */
export function renderUnified({ ops }) {
  return ops.map((o) => `${o.op === '=' ? ' ' : o.op}${o.text}`).join('\n');
}
