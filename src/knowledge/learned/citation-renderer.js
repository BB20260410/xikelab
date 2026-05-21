// citation-renderer — 把 AI reply 中的 [N] 标记替换成可跳转锚点（W10 R2R 学习）
// 配合 buildContextFor 返回的 citations[]

/**
 * 替换 AI reply 中 [1] [2] 形如标记为 HTML 锚点
 * @param {string} text     AI 原始回复
 * @param {Array} citations  来自 buildContextFor.citations
 * @returns {string} HTML 字符串（含 sup + a 锚点）
 */
export function renderCitations(text, citations = []) {
  if (typeof text !== 'string' || !text) return text;
  if (!Array.isArray(citations) || citations.length === 0) return text;
  const citMap = new Map(citations.map(c => [c.index, c]));
  // 匹配 [N] 但避免 [text](url) 中的 url 部分
  return text.replace(/\[(\d+)\](?!\()/g, (match, numStr) => {
    const n = parseInt(numStr, 10);
    const c = citMap.get(n);
    if (!c) return match;  // 没对应 citation 不替换
    const title = `${c.docTitle}${c.sourceUrl ? ' · ' + c.sourceUrl : ''}\n\n${c.textSnippet}`;
    return `<sup><a href="#cite-${n}" data-cite-chunk-id="${c.chunkId}" title="${escapeAttr(title)}" class="citation-link">[${n}]</a></sup>`;
  });
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/**
 * 用 citations 数组渲染底部参考文献区
 */
export function renderBibliography(citations = []) {
  if (!Array.isArray(citations) || citations.length === 0) return '';
  const items = citations.map(c => {
    const src = c.sourceUrl
      ? `<a href="${escapeAttr(c.sourceUrl)}" target="_blank">${escapeAttr(c.docTitle)}</a>`
      : escapeAttr(c.docTitle);
    return `<li id="cite-${c.index}">[${c.index}] ${src} <span style="color:#888;font-size:11px;">— ${escapeAttr(c.textSnippet.slice(0, 80))}...</span></li>`;
  });
  return `<div class="citations-block"><div><b>📚 引用来源</b></div><ol class="citations-list">${items.join('')}</ol></div>`;
}
