// Xikely — UI 原子组件集（S18-4）
// 当前 app.js 非 module，本文件用 IIFE 暴露 window.UI.*
// S18-1 改 module 后再升级 ES module export
(function () {
  if (window.UI) return;
  const UI = {};

  // 内部 escape，组件不依赖 app.js 的 escapeHtml（app.js 在本文件之后加载）
  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  UI._esc = esc; // 暴露给其他组件复用

  // ========== EmptyState (S18-4a) ==========
  // panel 内散落的 <div class="muted small" style="padding:..."> 提示统一入口
  // kind: 'empty' (默认) | 'loading' | 'error' | 'neutral'
  // opts: { kind, text (string, 自动 escape), hint (string, **HTML 允许**, 调用方负责 escape),
  //         padding (默认按 kind), align: 'left'|'center', icon (string, 自动加在 text 前) }
  // 返回 HTML 字符串
  UI.EmptyState = function EmptyState(opts) {
    opts = opts || {};
    const kind = opts.kind || 'empty';
    const text = opts.text || '';
    const hint = opts.hint || '';
    const icon = opts.icon || '';
    const padding = opts.padding || (kind === 'loading' ? '8px' : kind === 'error' ? '8px' : '12px');
    const align = opts.align === 'center' ? 'text-align:center;' : '';
    let color = '';
    if (kind === 'error') color = 'color:#dc3545;';
    const style = 'padding:' + esc(padding) + ';' + align + color;
    const iconPart = icon ? esc(icon) + ' ' : '';
    const hintPart = hint ? '<br>' + hint : '';
    return '<div class="muted small" style="' + style + '">' + iconPart + esc(text) + hintPart + '</div>';
  };

  // ========== Badge (S18-4b) ==========
  // <span class="badge [is-${kind}]">${esc(text)}</span>
  // 注意：.badge 的 CSS 是局部 scope（仅 .webhook-item .wname / .mcp-item .mname 下生效）
  // 跨场景使用需要先把 .badge 提到全局；本 helper 只生成 HTML，不动 CSS scope
  // opts: { text (string, 自动 escape), kind (modifier，如 'disabled'/'stdio'/'sse'/'http') }
  UI.Badge = function Badge(opts) {
    opts = opts || {};
    const text = opts.text || '';
    const kind = opts.kind || '';
    const cls = 'badge' + (kind ? ' is-' + esc(kind) : '');
    return '<span class="' + cls + '">' + esc(text) + '</span>';
  };

  // ========== Tag (S18-4c) ==========
  // <span class="tag [is-${kind}]">${esc(text)}</span>
  // 注意：panel style.css 目前**没有** .tag class 定义；helper 仅生成 HTML
  // 未来要视觉化时需在 style.css 加 .tag/.tag.is-* 规则
  // 当前 panel 内仅 safety-tag 一处，不在 S18-3/S18-4 改造范围
  // opts: { text (auto-escape), kind (modifier, auto-escape) }
  UI.Tag = function Tag(opts) {
    opts = opts || {};
    const text = opts.text || '';
    const kind = opts.kind || '';
    const cls = 'tag' + (kind ? ' is-' + esc(kind) : '');
    return '<span class="' + cls + '">' + esc(text) + '</span>';
  };

  // ========== Card (S18-4d) ==========
  // <div class="card [is-${kind}]"><div class="card-head">${header}</div><div class="card-body">${body}</div>[<div class="card-foot">${footer}</div>]</div>
  // 注意：panel 内无 .card 基础类，只有变体（plugin-cmd-card / room-turn-card）；
  // helper 仅生成结构 HTML，使用前需在 style.css 加 .card 规则
  // header/body/footer **不 escape**（HTML 允许），调用方负责安全
  // opts: { header, body, footer, kind }
  UI.Card = function Card(opts) {
    opts = opts || {};
    const head = opts.header || '';
    const body = opts.body || '';
    const foot = opts.footer || '';
    const kind = opts.kind || '';
    const cls = 'card' + (kind ? ' is-' + esc(kind) : '');
    let html = '<div class="' + cls + '">';
    if (head) html += '<div class="card-head">' + head + '</div>';
    html += '<div class="card-body">' + body + '</div>';
    if (foot) html += '<div class="card-foot">' + foot + '</div>';
    html += '</div>';
    return html;
  };

  // ========== List (S18-4e) ==========
  // <aside class="list-pane">[<div class="list-head">${header}</div>]<div class="list-body">${items}</div></aside>
  // 注意：panel 现有 .webhook-list-pane / .mcp-list-pane CSS 内容相同；全局 .list-pane 等 CSS 待 S18-6 添加
  // header/items/empty **不 escape**（HTML 允许）
  // opts: { header, items (concat 后的多个 list-item HTML), empty (items 为空时插入的 fallback HTML) }
  UI.List = function List(opts) {
    opts = opts || {};
    const header = opts.header || '';
    const items = opts.items || '';
    const empty = opts.empty || '';
    let html = '<aside class="list-pane">';
    if (header) html += '<div class="list-head">' + header + '</div>';
    html += '<div class="list-body">' + (items ? items : empty) + '</div>';
    html += '</aside>';
    return html;
  };
  // 单 item helper
  // <div class="list-item [active=true→is-active]" [data-key=...]>${body}</div>
  UI.ListItem = function ListItem(opts) {
    opts = opts || {};
    const body = opts.body || '';
    const key = opts.key != null ? opts.key : '';
    const cls = 'list-item' + (opts.active ? ' is-active' : '');
    const keyAttr = key !== '' ? ' data-key="' + esc(String(key)) + '"' : '';
    return '<div class="' + cls + '"' + keyAttr + '>' + body + '</div>';
  };

  // ========== Drawer (S18-4f) ==========
  // <aside class="drawer is-${side}">[<div class="drawer-head">${header}</div>]<div class="drawer-body">${body}</div></aside>
  // 注意：panel 现仅 #squadTaskDetail 一处使用，动态 createElement+classList toggle 控制可见
  // 全局 .drawer / .drawer.is-* / .drawer-head / .drawer-body CSS 留待 S18-6 添加
  // 开关行为不由 helper 管理（避免与 Modal 重复）；调用方用 classList 'is-open' 等控制
  // header/body **不 escape**（HTML 允许）
  // opts: { side ('right'|'left'|'top'|'bottom', 默认 right), header, body }
  UI.Drawer = function Drawer(opts) {
    opts = opts || {};
    const side = opts.side || 'right';
    const header = opts.header || '';
    const body = opts.body || '';
    const cls = 'drawer is-' + esc(side);
    let html = '<aside class="' + cls + '">';
    if (header) html += '<div class="drawer-head">' + header + '</div>';
    html += '<div class="drawer-body">' + body + '</div>';
    html += '</aside>';
    return html;
  };

  // S18-4 完成 (a EmptyState / b Badge / c Tag / d Card / e List+ListItem / f Drawer)

  window.UI = UI;
})();
