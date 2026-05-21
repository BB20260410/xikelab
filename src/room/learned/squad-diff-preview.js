// squad-diff-preview — 计算两段文本的 unified diff（W8 aider/Cline 学习）
// 独立 helper，未接入 squad UI——等 sprint 级独立设计

/**
 * 计算简单的行级 diff（不是完整 LCS，但足够给用户看变化）
 * @param {string} before
 * @param {string} after
 * @returns {{ added: number, removed: number, unified: string }}
 */
export function diff(before, after) {
  const a = (before || '').split('\n');
  const b = (after || '').split('\n');

  const added = [];
  const removed = [];
  const unified = [];

  // 极简 diff：找连续相等前缀和后缀，中间标 - 旧 + 新
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix
         && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  // 加前缀（仅显示上下文 ±3 行）
  const ctxStart = Math.max(0, prefix - 3);
  for (let i = ctxStart; i < prefix; i++) unified.push(' ' + a[i]);

  // 删除的（a 中独有）
  for (let i = prefix; i < a.length - suffix; i++) {
    removed.push(a[i]);
    unified.push('-' + a[i]);
  }
  // 新增的（b 中独有）
  for (let i = prefix; i < b.length - suffix; i++) {
    added.push(b[i]);
    unified.push('+' + b[i]);
  }

  // 后缀上下文 ±3
  const ctxEnd = Math.min(a.length, a.length - suffix + 3);
  for (let i = a.length - suffix; i < ctxEnd; i++) unified.push(' ' + a[i]);

  return {
    added: added.length,
    removed: removed.length,
    unified: unified.join('\n'),
  };
}

/**
 * squad task attempt 之间的 diff（适合给 QA 看 Dev 改了啥）
 */
export function diffAttempts(prevAttempt, curAttempt) {
  return diff(prevAttempt?.content || '', curAttempt?.content || '');
}

/**
 * 用法（未来接入示例）：
 *   const d = diff(oldOutput, newOutput);
 *   ui.renderDiff(d.unified);   // 简单 monospace 渲染
 *   ui.renderStats(`+${d.added}/-${d.removed}`);
 */
