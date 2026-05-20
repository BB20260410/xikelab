// Claude Panel — utils ES module (S18-1 starter)
// 当前仅作为 module 骨架，未被 index.html 加载（app.js 仍跑老 IIFE）
// 下次对话用户授权后激活：把 app.js 内的 escapeHtml/shortenPath/safeSlice 等 helper 迁出
//
// 加载方式（未来）：
//   index.html 加 <script type="module" src="/main.js">
//   main.js: import { escapeHtml } from './src/web/utils.js'

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

export function escapeHtmlMl(s) {
  return escapeHtml(s).replace(/\n/g, '<br>');
}

export function safeSlice(s, max) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) : s;
}

export function shortenPath(p) {
  if (!p) return '';
  const home = '/Users/' + (p.split('/')[2] || '');
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

// S24 扩：app.js:1916 formatSize 迁移
export function formatSize(b) {
  if (!b) return '';
  if (b < 1024) return b + 'B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'K';
  return (b / 1024 / 1024).toFixed(1) + 'M';
}

// S24 扩：app.js:2841 formatElapsed 迁移
export function formatElapsed(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
