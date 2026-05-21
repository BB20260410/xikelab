// Claude Panel — 前端

// v0.56 修复：.inspector 的 backdrop-filter 让自身成为 fixed 子元素的 containing block
// 导致所有 .modal 被囚禁在右侧 300px 内不可见 → 现挪到 body 顶层逃逸
(() => {
  const portal = () => document.querySelectorAll('.modal').forEach(m => {
    if (m.parentElement !== document.body) document.body.appendChild(m);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', portal, { once: true });
  else portal();
})();

const state = {
  sessions: [],
  archivedSessions: [],
  activeId: null,
  ws: null,
  activeBusy: false,
  activeCwd: null,
  filePath: null,
  snapshotTimer: null,
  archivedExpanded: false,
  streamingDivs: new Map(), // v0.15 流式：blockIndex → DOM div
  stderrCurrentDiv: null,    // v0.21 当前 turn 的 stderr 累积 div
  collapsedGroups: new Set((() => {
    try { return JSON.parse(localStorage.getItem('cp-collapsed-groups') || '[]'); }
    catch { return []; }
  })()),
};
function persistCollapsedGroups() {
  try { localStorage.setItem('cp-collapsed-groups', JSON.stringify([...state.collapsedGroups])); } catch {}
}

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// S23 D6: apiCall helper — 跟 api() 不同的是失败时 toast 兜底返 null（非 throw）
// 28 处 try { await fetch().then() } catch { toast(...) } 模式的目标替代
// 用法：const r = await apiCall('/api/webhooks', { errorPrefix: '加载 webhook 失败' });
//       if (!r) return; // 已 toast，调用方仅需 early return
async function apiCall(path, opts = {}) {
  const { method = 'GET', body, errorPrefix = '请求失败' } = opts;
  try {
    const r = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => null);
    if (!r.ok || (json && json.ok === false)) {
      const msg = (json && json.error) || `HTTP ${r.status}`;
      toast(errorPrefix + '：' + msg, 'error');
      return null;
    }
    return json;
  } catch (e) {
    toast(errorPrefix + '：' + e.message, 'error');
    return null;
  }
}

// ─── v0.8 ConfirmModal（替代 confirm()）─────
// S29 starter: 主实现挪到 src/web/dialog.js (window.PanelDialog.confirmModal)
// 本 wrapper 22 处现有调用透明走 module；main.js 加载失败 fallback inline
function confirmModal(opts, maybeTitle) {
  if (window.PanelDialog && window.PanelDialog.confirmModal) {
    return window.PanelDialog.confirmModal(opts, maybeTitle);
  }
  // fallback inline
  if (typeof opts === 'string') opts = { message: opts, title: maybeTitle };
  opts = opts || {};
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal';
    overlay.innerHTML = `
      <div class="confirm-modal-bg"></div>
      <div class="confirm-modal-body">
        ${opts.title ? `<h3 class="confirm-modal-title">${escapeHtmlEarly(opts.title)}</h3>` : ''}
        <div class="confirm-modal-message">${escapeHtmlEarly(opts.message || '')}</div>
        <div class="confirm-modal-actions">
          <button class="cxbtn cxbtn-secondary" data-act="cancel">${escapeHtmlEarly(opts.cancelLabel || '取消')}</button>
          <button class="cxbtn ${opts.danger ? 'cxbtn-danger' : 'cxbtn-primary'}" data-act="confirm">${escapeHtmlEarly(opts.confirmLabel || '确认')}</button>
        </div>
      </div>
    `;
    const finish = (result) => {
      overlay.classList.add('confirm-modal-closing');
      setTimeout(() => overlay.remove(), 180);
      document.removeEventListener('keydown', keyHandler);
      resolve(result);
    };
    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      // v0.50 Q-01 IME fix: 输入法选字时 Enter 不应触发
      // S17-extra：danger 操作（删除等）不让 Enter 误触发，强制点击
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !opts.danger) { e.preventDefault(); finish(true); }
    };
    overlay.querySelector('.confirm-modal-bg').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-act="confirm"]').addEventListener('click', () => finish(true));
    document.addEventListener('keydown', keyHandler);
    document.body.appendChild(overlay);
    // S17-extra：danger 操作默认 focus 在 cancel（更安全），普通操作 focus 在 confirm
    setTimeout(() => overlay.querySelector(opts.danger ? '[data-act="cancel"]' : '[data-act="confirm"]').focus(), 30);
  });
}

// ─── v0.9 PromptModal（替代 prompt()）─────
// S29 starter: 主实现挪到 src/web/dialog.js
function promptModal(opts, maybeDefault) {
  if (window.PanelDialog && window.PanelDialog.promptModal) {
    return window.PanelDialog.promptModal(opts, maybeDefault);
  }
  // fallback inline
  if (typeof opts === 'string') opts = { title: opts, value: maybeDefault };
  opts = opts || {};
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal';
    const inputId = 'pm-' + Math.random().toString(36).slice(2, 8);
    const inputEl = opts.multiline
      ? `<textarea id="${inputId}" class="prompt-modal-input" rows="3" placeholder="${escapeHtmlEarly(opts.placeholder || '')}"></textarea>`
      : `<input type="text" id="${inputId}" class="prompt-modal-input" placeholder="${escapeHtmlEarly(opts.placeholder || '')}" />`;
    overlay.innerHTML = `
      <div class="confirm-modal-bg"></div>
      <div class="confirm-modal-body">
        ${opts.title ? `<h3 class="confirm-modal-title">${escapeHtmlEarly(opts.title)}</h3>` : ''}
        ${opts.message ? `<div class="confirm-modal-message">${escapeHtmlEarly(opts.message)}</div>` : ''}
        ${inputEl}
        <div class="confirm-modal-actions">
          <button class="cxbtn cxbtn-secondary" data-act="cancel">${escapeHtmlEarly(opts.cancelLabel || '取消')}</button>
          <button class="cxbtn cxbtn-primary" data-act="confirm">${escapeHtmlEarly(opts.confirmLabel || '确认')}</button>
        </div>
      </div>
    `;
    const finish = (result) => {
      overlay.classList.add('confirm-modal-closing');
      setTimeout(() => overlay.remove(), 180);
      document.removeEventListener('keydown', keyHandler);
      resolve(result);
    };
    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      // v0.50 Q-01 IME fix
      if (e.key === 'Enter' && !opts.multiline && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        const v = overlay.querySelector('.prompt-modal-input').value;
        finish(v);
      }
    };
    overlay.querySelector('.confirm-modal-bg').addEventListener('click', () => finish(null));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
    overlay.querySelector('[data-act="confirm"]').addEventListener('click', () => {
      const v = overlay.querySelector('.prompt-modal-input').value;
      finish(v);
    });
    document.addEventListener('keydown', keyHandler);
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.prompt-modal-input');
    if (opts.value != null) input.value = opts.value;
    setTimeout(() => { input.focus(); input.select?.(); }, 30);
  });
}

// ─── v0.7 Toast 通知（替代 alert）─────
function toast(message, kind = 'info', durationMs = 3500) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  // v0.51 T-45 fix: toast 上限 5 条，老的自动消失（防 error spam 堆积撑爆 DOM）
  const MAX_TOAST = 5;
  while (container.children.length >= MAX_TOAST) {
    container.firstChild?.remove();
  }
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.innerHTML = `
    <span>${escapeHtmlEarly(message)}</span>
    <button class="toast-close-btn" aria-label="关闭">✕</button>
  `;
  const dismiss = () => {
    if (t.classList.contains('toast-closing')) return;
    t.classList.add('toast-closing');
    setTimeout(() => t.remove(), 220);
  };
  t.querySelector('.toast-close-btn').addEventListener('click', dismiss);
  container.appendChild(t);
  if (durationMs > 0) setTimeout(dismiss, durationMs);
  return dismiss;
}
// escapeHtml 在 app.js 末尾定义，toast 早期被调用 → 这里给个早期可用版本
function escapeHtmlEarly(s) {
  return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function listSessions() {
  // v0.51 T-31 fix: 抛错时 silent log，避免 4s 重试每次触发 unhandledrejection toast
  let active, archived;
  try {
    [active, archived] = await Promise.all([
      api('/api/sessions'),
      api('/api/sessions?archived=1'),
    ]);
  } catch (e) {
    console.warn('[listSessions]', e?.message || e);
    return;
  }
  state.sessions = active;
  state.archivedSessions = archived;
  // v0.20 同步当前 activeBusy 跟 server 状态（防 WS 丢消息导致卡 busy）
  if (state.activeId) {
    const cur = active.find(s => s.id === state.activeId);
    if (cur && typeof cur.busy === 'boolean' && cur.busy !== state.activeBusy) {
      state.activeBusy = cur.busy;
      if (typeof updateBusyUI === 'function') updateBusyUI();
    }
  }
  renderList();
  renderArchived();
  if (typeof updateStatusBar === 'function') updateStatusBar();
}

async function setSessionArchived(id, archived) {
  await api(`/api/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived }),
  });
  // 归档时如果是当前激活的 → 切回 empty
  if (archived && state.activeId === id) {
    // v0.51 ZZZZZ-01 fix: 同 T-38（deleteSession）清所有 active state 一致性
    state.activeId = null;
    state.activeCwd = null;
    state.activeBusy = false;
    state.activeStarred = [];
    if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
    state.streamingDivs?.clear?.();
    showEmpty();
  }
  await listSessions();
}

async function renameSession(id, name) {
  if (!name || !name.trim()) return;
  await api(`/api/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: name.trim() }),
  });
  await listSessions();
  if (state.activeId === id) $('#chatHeaderName').textContent = name.trim();
}

// ─── v0.6 全局右键菜单（portal）─────
let activeContextMenu = null;
function closeContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}
function openContextMenu(items, x, y) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - items.length * 32) + 'px';
  for (const it of items) {
    if (it.divider) {
      const d = document.createElement('div');
      d.className = 'context-menu-divider';
      menu.appendChild(d);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'context-menu-item' + (it.danger ? ' danger' : '');
    btn.textContent = it.label;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      closeContextMenu();
      it.onSelect?.();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  activeContextMenu = menu;
}
document.addEventListener('click', closeContextMenu);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && activeContextMenu) {
    closeContextMenu();
    return;
  }
  // v0.16 Esc 中断当前 turn（在没 modal 打开时才触发）
  if (e.key === 'Escape' && state.activeBusy && !document.querySelector('.confirm-modal, #cmdkModal[style*="flex"], #projectModal[style*="flex"], #historyModal[style*="flex"]')) {
    const inInput = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    if (!inInput) {
      e.preventDefault();
      interruptCurrentTurn();
    }
  }
});

// ─── v0.6 双击重命名 ─────
function startRenameSession(sessionId, nameElement) {
  const oldName = nameElement.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = oldName;
  nameElement.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = (save) => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    const span = document.createElement('div');
    span.className = 'session-name';
    span.textContent = save && newName ? newName : oldName;
    input.replaceWith(span);
    if (save && newName && newName !== oldName) {
      renameSession(sessionId, newName);
    }
  };
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    // v0.50 Q-01 IME fix: 中文选字 Enter 不应 commit
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
}

async function createSession(name, cwd, mainGoal) {
  const s = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name, cwd, mainGoal }),
  });
  await listSessions();
  selectSession(s.id);
}

async function deleteSession(id) {
  await api(`/api/sessions/${id}`, { method: 'DELETE' });
  if (state.activeId === id) {
    // v0.51 T-38 fix: 清所有 active state，避免后续 toggleStar / append 用脏数据
    state.activeId = null;
    state.activeCwd = null;
    state.activeBusy = false;
    state.activeStarred = [];
    if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
    state.streamingDivs?.clear?.();
    showEmpty();
  }
  await listSessions();
}

// S24 minimum: escapeHtml 主实现挪到 src/web/utils.js (PanelUtils.escapeHtml)
// 156 处现有调用不动；hot path 走 PanelUtils；main.js 加载失败 fallback inline
function escapeHtml(s) {
  if (window.PanelUtils && window.PanelUtils.escapeHtml) {
    return window.PanelUtils.escapeHtml(s);
  }
  return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// v0.44 P1 #13: 多行字段（reasoning / issues / suggestions）保留换行
// S24 minimum: 同 escapeHtml 风格 wrapper
function escapeHtmlMl(s) {
  if (window.PanelUtils && window.PanelUtils.escapeHtmlMl) {
    return window.PanelUtils.escapeHtmlMl(s);
  }
  return escapeHtml(s).replace(/\n/g, '<br>');
}
// S24 minimum: shortenPath 主实现已挪到 src/web/utils.js (PanelUtils.shortenPath)
// 本 wrapper 保留向后兼容；7 处现有调用不动；main.js 加载失败时降级 inline 实现
function shortenPath(p) {
  if (window.PanelUtils && window.PanelUtils.shortenPath) {
    return window.PanelUtils.shortenPath(p);
  }
  // fallback
  if (!p) return '';
  const home = '/Users/' + (p.split('/')[2] || '');
  return p.replace(home, '~');
}

// v0.25 marked 自定义 code renderer：输出 .code-wrap 含 toolbar + 行号 + 折叠
let _markedConfigured = false;
function ensureMarkedConfigured() {
  if (_markedConfigured || !window.marked) return;
  try {
    const renderer = {
      code(token) {
        // marked v13 token object: { text, lang, escaped, ... }
        const text = (token && typeof token === 'object') ? (token.text || '') : (arguments[0] || '');
        const lang = ((token && token.lang) || arguments[1] || 'plaintext').toString().toLowerCase().slice(0, 30);
        const lines = text.split('\n').length;
        const collapsed = lines > 12;
        // v0.26 diff 专属逐行 span 着色
        let body;
        if (lang === 'diff') {
          body = text.split('\n').map(ln => {
            let cls = 'diff-ctx';
            if (ln.startsWith('+++') || ln.startsWith('---')) cls = 'diff-file';
            else if (ln.startsWith('@@')) cls = 'diff-hunk';
            else if (ln.startsWith('+')) cls = 'diff-add';
            else if (ln.startsWith('-')) cls = 'diff-del';
            return `<span class="diff-line ${cls}">${escapeHtmlEarly(ln)}</span>`;
          }).join('\n');
        } else {
          body = escapeHtmlEarly(text);
        }
        return [
          `<div class="code-wrap${collapsed ? ' code-collapsed' : ''}" data-lang="${escapeHtmlEarly(lang)}">`,
          `<div class="code-toolbar">`,
          `<span class="code-lang">${escapeHtmlEarly(lang)}</span>`,
          `<span class="code-lines">${lines} 行</span>`,
          `<button type="button" class="code-collapse-btn" aria-label="折叠/展开代码块" title="折叠/展开">${collapsed ? '▶' : '▼'}</button>`,
          `<button type="button" class="code-copy-btn" aria-label="复制代码到剪贴板" title="复制">📋</button>`,
          `</div>`,
          `<pre><code class="lang-${escapeHtmlEarly(lang)}">${body}</code></pre>`,
          `</div>`,
        ].join('');
      },
    };
    window.marked.use({ renderer });
    // v0.49 N-21 fix: DOMPurify hook 给所有 a 标签强制加 rel="noopener noreferrer" + target="_blank"
    // 防 Reverse Tabnabbing：新页面通过 window.opener 篡改原页
    if (window.DOMPurify && typeof window.DOMPurify.addHook === 'function') {
      window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.nodeName === 'A' && node.hasAttribute('href')) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      });
    }
    _markedConfigured = true;
  } catch (e) {
    // S26 B2：启动期 markdown init 失败用户应感知（影响 message render 体验）
    // 不用 setTimeout 因为 toast 可能 DOM 未 ready；toast(0) 不自动消失，强制用户看到
    console.warn('marked.use renderer failed:', e.message);
    try { toast('markdown 渲染降级（marked.use 失败：' + e.message + '）', 'warn', 0); } catch {}
  }
}

// v0.24/v0.25 marked + DOMPurify 替换手写 regex；CDN 失败时 fallback 到老 regex
function renderMarkdown(text) {
  if (!text) return '';
  // Path A: marked + DOMPurify
  if (typeof window !== 'undefined' && window.marked && window.DOMPurify) {
    try {
      ensureMarkedConfigured();
      const raw = window.marked.parse(text, {
        gfm: true,           // GitHub flavored
        breaks: true,        // \n → <br>（贴近 chat 习惯）
        headerIds: false,    // 不生成 id（防 XSS）
        mangle: false,
      });
      return window.DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: ['a','b','strong','i','em','u','s','del','code','pre','p','br','hr',
                       'ul','ol','li','blockquote','h1','h2','h3','h4','h5','h6',
                       'table','thead','tbody','tr','th','td','span','div','img','button'],
        ALLOWED_ATTR: ['href','target','rel','title','alt','src','class','colspan','rowspan',
                       'type','aria-label','data-lang'],
        ALLOW_DATA_ATTR: false,
        ADD_ATTR: ['target'],
        // v0.44 P1 #14: 限协议，禁 javascript: / data:image/svg / vbscript: 等绕过路径
        ALLOWED_URI_REGEXP: /^(https?:|mailto:|tel:|#|\/)/i,
      });
    } catch (e) {
      // 解析失败 → fallback
      console.warn('marked/DOMPurify failed, fallback:', e.message);
    }
  }
  // Path B: fallback 手写 regex（CDN 没加载时）
  let html = escapeHtml(text);
  html = html.replace(/```([a-zA-Z]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code}</code></pre>`;
  });
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function renderList() {
  const list = $('#sessionList');
  list.innerHTML = '';
  if (state.sessions.length === 0) {
    list.innerHTML = '<div class="muted small" style="padding:12px;text-align:center;">还没有活跃会话</div>';
    return;
  }
  // v0.19 Codex 风格分组：按 cwd 分组
  const groups = new Map(); // cwd → [sessions]
  for (const s of state.sessions) {
    if (!groups.has(s.cwd)) groups.set(s.cwd, []);
    groups.get(s.cwd).push(s);
  }
  // 单 cwd 组（≤1 个 session）不显 header，直接平铺
  const showGroups = groups.size > 1 || [...groups.values()].some(arr => arr.length > 1);
  if (!showGroups) {
    state.sessions.forEach(s => list.appendChild(buildSessionItem(s)));
    return;
  }
  // 按"组内最新 createdAt"倒序
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const aT = Math.max(...a[1].map(s => new Date(s.createdAt).getTime() || 0));
    const bT = Math.max(...b[1].map(s => new Date(s.createdAt).getTime() || 0));
    return bT - aT;
  });
  for (const [cwd, sessions] of sortedGroups) {
    const groupName = (cwd.split('/').filter(Boolean).pop()) || cwd;
    const collapsed = state.collapsedGroups.has(cwd);
    const groupBusy = sessions.some(s => s.busy);
    const totalUSD = sessions.reduce((s, x) => s + (x.totalUSD || 0), 0);
    const head = document.createElement('button');
    head.className = 'session-group-head' + (collapsed ? ' collapsed' : '');
    head.setAttribute('type', 'button');
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    head.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'} ${groupName} 组 (${sessions.length} 个会话)`);
    head.innerHTML = `
      <span class="group-arrow" aria-hidden="true">${collapsed ? '▶' : '▼'}</span>
      <span class="group-name" title="${escapeHtml(cwd)}">${escapeHtml(groupName)}</span>
      <span class="group-count">${sessions.length}${groupBusy ? ' · ⚡' : ''}${totalUSD > 0 ? ` · $${totalUSD.toFixed(2)}` : ''}</span>
    `;
    head.addEventListener('click', () => {
      if (state.collapsedGroups.has(cwd)) state.collapsedGroups.delete(cwd);
      else state.collapsedGroups.add(cwd);
      persistCollapsedGroups();
      renderList();
    });
    list.appendChild(head);
    if (!collapsed) {
      sessions.forEach(s => list.appendChild(buildSessionItem(s)));
    }
  }
}

function buildSessionItem(s) {
    const div = document.createElement('div');
    div.className = 'session-item' + (s.id === state.activeId ? ' active' : '') + (s.busy ? ' busy' : '');
    const rs = s.runState || 'idle';
    const goalChip = s.mainGoal ? `<div class="session-goal" title="${escapeHtml(s.mainGoal)}">🎯 ${escapeHtml(s.mainGoal.slice(0, 22))}${s.mainGoal.length > 22 ? '…' : ''}</div>` : '';
    div.innerHTML = `
      <div class="session-name">${escapeHtml(s.name)}</div>
      <div class="session-cwd">${escapeHtml(shortenPath(s.cwd))}</div>
      <div class="session-meta">${s.msgCount} 消息${s.busy ? ' · ⚡' : ''}${s.totalUSD > 0 ? ` · $${s.totalUSD.toFixed(2)}` : ''}</div>
      ${goalChip}
      <div class="session-status state-${rs}" title="${STATE_LABELS[rs] || rs}"></div>
      <div class="session-hover-actions">
        <button class="session-action-btn session-rename-btn" title="重命名（也可双击名称）" aria-label="重命名会话 ${escapeHtml(s.name)}">✏️</button>
        <button class="session-action-btn session-archive-btn" title="归档（不删除，移到底部折叠区）" aria-label="归档会话 ${escapeHtml(s.name)}">📦</button>
      </div>
    `;
    div.addEventListener('click', () => selectSession(s.id));
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu([
        { label: '✏️ 重命名', onSelect: () => {
          const nameEl = div.querySelector('.session-name');
          if (nameEl) startRenameSession(s.id, nameEl);
        }},
        { label: '🎯 编辑主目标', onSelect: async () => {
          const cur = s.mainGoal || '';
          const next = await promptModal({
            title: '编辑主目标',
            message: '每 5 个 user message 自动提醒 claude 防漂移。留空则禁用。',
            value: cur,
            placeholder: '例如：实现并发布 v0.8 风格统一',
            confirmLabel: '保存',
          });
          if (next !== null) {
            await api(`/api/sessions/${s.id}`, { method: 'PATCH', body: JSON.stringify({ mainGoal: next }) });
            await listSessions();
            toast(next ? `主目标已更新` : `主目标已清除`, 'success');
          }
        }},
        { label: '📦 归档', onSelect: () => setSessionArchived(s.id, true) },
        { label: '⤓ 导出为 markdown', onSelect: () => {
          // v0.50 F2: 触发下载
          const a = document.createElement('a');
          a.href = `/api/sessions/${s.id}/export`;
          a.download = (s.name || 'session') + '.md';
          document.body.appendChild(a); a.click(); a.remove();
          toast('已开始下载', 'success');
        }},
        { divider: true },
        { label: '🗑 彻底删除…', danger: true, onSelect: () => {
          confirmModal({
            title: '彻底删除会话？',
            message: `「${s.name}」会话数据不可恢复。\n如果只是想暂时收起，请用「📦 归档」。`,
            confirmLabel: '彻底删除',
            danger: true,
          }).then(ok => { if (ok) deleteSession(s.id); });
        }},
      ], e.clientX, e.clientY);
    });
    const nameEl = div.querySelector('.session-name');
    if (nameEl) {
      nameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRenameSession(s.id, nameEl);
      });
    }
    div.querySelector('.session-archive-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      setSessionArchived(s.id, true);
    });
    // v0.18 ✏️ 重命名按钮（发现性提升）
    div.querySelector('.session-rename-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const nameElInner = div.querySelector('.session-name');
      if (nameElInner) startRenameSession(s.id, nameElInner);
    });
    return div;
}

function renderArchived() {
  const section = $('#archivedSection');
  const list = $('#archivedList');
  const count = state.archivedSessions.length;
  $('#archivedCount').textContent = count;
  if (count === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  list.style.display = state.archivedExpanded ? '' : 'none';
  $('#archArrow').textContent = state.archivedExpanded ? '▼' : '▶';
  list.innerHTML = '';
  state.archivedSessions.forEach(s => {
    const div = document.createElement('div');
    div.className = 'archived-item';
    const archDate = s.archivedAt ? new Date(s.archivedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '';
    div.setAttribute('role', 'listitem');
    div.setAttribute('aria-label', `已归档会话: ${s.name}`);
    div.innerHTML = `
      <div class="arch-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>
      <div class="arch-meta muted small">${s.msgCount} 条 · 归档于 ${archDate}</div>
      <div class="arch-actions">
        <button class="btn-tiny" data-act="restore" title="恢复到活跃列表" aria-label="恢复会话 ${escapeHtml(s.name)}">↩</button>
        <button class="btn-tiny btn-tiny-danger" data-act="delete" title="彻底删除" aria-label="彻底删除会话 ${escapeHtml(s.name)}">🗑</button>
      </div>
    `;
    div.querySelector('[data-act="restore"]').addEventListener('click', (e) => {
      e.stopPropagation();
      setSessionArchived(s.id, false);
    });
    div.querySelector('[data-act="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      confirmModal({
        title: '彻底删除会话？',
        message: `「${s.name}」会话数据不可恢复。`,
        confirmLabel: '彻底删除',
        danger: true,
      }).then(ok => { if (ok) deleteSession(s.id); });
    });
    list.appendChild(div);
  });
}

$('#archivedToggle')?.addEventListener('click', () => {
  state.archivedExpanded = !state.archivedExpanded;
  $('#archivedToggle').setAttribute('aria-expanded', state.archivedExpanded ? 'true' : 'false');
  renderArchived();
});

function showEmpty() {
  $('#mainHeader').style.display = 'flex';
  $('#chatArea').style.display = 'none';
  $('#sessionInfo').innerHTML = '<span class="muted">— 未选中 —</span>';
}

function showChat() {
  $('#mainHeader').style.display = 'none';
  $('#chatArea').style.display = 'flex';
}

function appendMessage(m, providedIndex) {
  const out = $('#chatOutput');
  // v0.15 去重：若 assistant text 已经流式渲染过（finalized div 内容相同），跳过
  if (m.role === 'assistant' && m.content) {
    const finalized = out.querySelectorAll('.msg-finalized[data-full-text]');
    for (let i = finalized.length - 1; i >= 0 && i >= finalized.length - 5; i--) {
      if (finalized[i].dataset.fullText === m.content) return;
    }
  }
  const div = document.createElement('div');
  div.className = `msg msg-${m.role}`;
  // v0.50 F1/F5/F7: 给每条消息打上索引 + ⭐ 按钮支持
  const msgIdx = Number.isInteger(providedIndex) ? providedIndex : out.querySelectorAll('.msg').length;
  div.dataset.msgIdx = msgIdx;
  const time = new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let icon = '·';
  if (m.role === 'user') icon = '👤';
  else if (m.role === 'assistant') icon = '🤖';
  else if (m.role === 'tool_use') icon = '🔧';
  else if (m.role === 'system') icon = '🔁';
  // 是否已收藏（v0.51 R-14: 用 state.activeStarred，比 state.sessions 缓存更可靠）
  const starred = Array.isArray(state.activeStarred) && state.activeStarred.includes(msgIdx);
  div.innerHTML = `
    <div class="msg-head">
      <span class="msg-icon">${icon}</span>
      <span class="msg-role">${m.role}</span>
      <span class="msg-time">${time}</span>
      <button class="msg-star-btn ${starred ? 'starred' : ''}" title="收藏（也可右键菜单）" aria-label="收藏消息">★</button>
    </div>
    <div class="msg-body" data-raw-text="${escapeHtmlEarly(m.content || '')}">${renderMarkdown(m.content)}</div>
  `;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}

async function selectSession(id) {
  state.activeId = id;
  state.streamingDivs.clear(); // v0.15 切 session 清流式状态
  state.stderrCurrentDiv = null; // v0.21 切 session 清 stderr 累积
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  renderList();
  const s = await api(`/api/sessions/${id}`);
  state.activeCwd = s.cwd;
  // v0.51 R-14 fix: 用独立 state.activeStarred，确保 appendMessage 渲染 ★ 状态
  state.activeStarred = Array.isArray(s.starredIndices) ? s.starredIndices.slice() : [];
  // 同步到 state.sessions 缓存供其他地方读
  const cached = state.sessions.find(x => x.id === id);
  if (cached) cached.starredIndices = state.activeStarred;
  showChat();
  $('#chatOutput').innerHTML = '';
  $('#chatHeaderName').textContent = s.name;
  $('#chatHeaderInfo').textContent = shortenPath(s.cwd);
  // Main goal
  const goalEl = $('#chatHeaderGoal');
  if (s.mainGoal) {
    goalEl.textContent = '🎯 ' + s.mainGoal;
    goalEl.style.display = '';
  } else {
    goalEl.style.display = 'none';
  }
  // 状态/成本 chip 初始化
  updateStateChip(s.runState || 'idle');
  updateCostChip(s.totalUSD || 0, 0);
  // 隐藏所有 banner
  $('#dangerBanner').style.display = 'none';
  $('#loopGuardBanner').style.display = 'none';
  $('#focusChainBanner').style.display = 'none';
  $('#sessionInfo').innerHTML = `
    <div class="info-row"><strong>${escapeHtml(s.name)}</strong></div>
    <div class="info-row muted small" style="font-family:var(--mono);word-break:break-all;">${escapeHtml(shortenPath(s.cwd))}</div>
    ${s.claudeSessionId ? `<div class="info-row muted small" style="margin-top:6px;">SID: ${s.claudeSessionId.substring(0,8)}…</div>` : ''}
    <div class="info-row muted small" style="margin-top:6px;">${s.busy ? '⚡ 处理中' : '空闲'} · ${s.messages.length} 消息</div>
  `;
  if (s.messages) s.messages.forEach((m, i) => appendMessage(m, i));
  // 切到文件 tab 时刷新文件列表
  if (currentTab === 'files') loadFiles(s.cwd);
  // 加载 snapshot + meta + ctx（不论 tab 是哪个，badge 都要更新）
  refreshSnapshot();
  refreshCtx();
  startSnapshotPolling();
  updateWatcherToggleUI();
  $('#watcherVerdictBanner').style.display = 'none'; // 切 session 关闭旧 verdict

  // v0.50 Q-03 fix: WS 自动重连（指数退避，限 5 次）
  state.wsReconnectAttempts = 0;
  attachSessionWS(id);
}
function attachSessionWS(id) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws/${id}`);
  state.ws.addEventListener('close', () => {
    // 用户切走或会话被删则不重连
    if (state.activeId !== id) return;
    state.wsReconnectAttempts = (state.wsReconnectAttempts || 0) + 1;
    if (state.wsReconnectAttempts > 5) {
      toast('WS 连接丢失（已重试 5 次），刷新页面试试', 'error', 5000);
      return;
    }
    const delay = Math.min(8000, 800 * Math.pow(2, state.wsReconnectAttempts - 1));
    setTimeout(() => { if (state.activeId === id) attachSessionWS(id); }, delay);
  });
  state.ws.addEventListener('error', () => { /* close 会随后触发，统一在 close 处理 */ });
  state.ws.addEventListener('open', () => { state.wsReconnectAttempts = 0; });
  state.ws.addEventListener('message', ev => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'message') {
        appendMessage(msg.message);
      } else if (msg.type === 'messages_capped') {
        // v0.51 R-17 fix: server 截断了最前面 N 条，前端同步偏移 data-msg-idx + starredIndices
        const removed = msg.removed | 0;
        if (removed > 0) {
          // 移除最前面 removed 个 DOM 节点
          const out = $('#chatOutput');
          for (let k = 0; k < removed; k++) {
            const first = out.querySelector('.msg');
            if (first) first.remove();
          }
          // 剩余 .msg 节点的 data-msg-idx 全减 removed
          out.querySelectorAll('.msg').forEach(el => {
            const old = parseInt(el.dataset.msgIdx, 10);
            if (Number.isInteger(old)) el.dataset.msgIdx = old - removed;
          });
          // state.activeStarred 同步
          if (Array.isArray(state.activeStarred)) {
            state.activeStarred = state.activeStarred.filter(i => i >= removed).map(i => i - removed);
          }
        }
      } else if (msg.type === 'busy') {
        state.activeBusy = msg.busy;
        updateBusyUI();
        listSessions();
        // 每次 busy 切换（一次 turn 完成）刷一次 ctx + 兜底 finalize 所有流式状态
        if (!msg.busy) {
          refreshCtx();
          finalizeStderrDiv(); // v0.21: turn 完成 → stderr div 收尾
          // v0.30 fix: partial_stop 可能丢失 → 兜底 finalize 所有 streaming div
          for (const [idx, div] of state.streamingDivs) {
            if (div && !div.classList.contains('msg-finalized')) {
              const body = div.querySelector('.msg-body');
              if (body) {
                const fullText = body.dataset.rawText || body.textContent || '';
                body.innerHTML = renderMarkdown(fullText);
                div.dataset.fullText = fullText;
              }
              div.classList.remove('msg-streaming');
              div.classList.add('msg-finalized');
            }
          }
          state.streamingDivs.clear();
        }
      } else if (msg.type === 'stderr') {
        handleStderrChunk(msg.data);
      } else if (msg.type === 'error') {
        appendMessage({ role: 'tool_use', content: `❌ 错误: ${msg.error}`, ts: new Date().toISOString() });
      } else if (msg.type === 'state_change') {
        updateStateChip(msg.state);
      } else if (msg.type === 'cost_update') {
        if (msg.snapshot) updateCostChip(msg.snapshot.totalUSD, msg.snapshot.ratePerMinute);
      } else if (msg.type === 'danger_blocked') {
        showDangerBanner(msg);
        maybeRefreshSafetyIfOpen();
      } else if (msg.type === 'danger_warn') {
        showDangerBanner({ ...msg, blocked: false });
        maybeRefreshSafetyIfOpen();
      } else if (msg.type === 'loop_guard_break') {
        showLoopGuardBanner(msg);
        maybeRefreshSafetyIfOpen();
      } else if (msg.type === 'focus_chain_injected') {
        showFocusChainBanner(msg);
      } else if (msg.type === 'watcher_judging') {
        toast(`👁️ ${msg.provider} 监视者分析中…`, 'info', 2500);
      } else if (msg.type === 'watcher_verdict') {
        showWatcherVerdict(msg);
      } else if (msg.type === 'watcher_skipped') {
        toast(`👁️ 监视者跳过：${msg.reason}（${msg.limit || msg.max || ''}）`, 'warn', 3000);
      } else if (msg.type === 'watcher_error') {
        toast('👁️ 监视者出错：' + msg.error, 'error', 4000);
      } else if (msg.type === 'watcher_auto_executing') {
        toast(`🤖 监视者自动发送：${msg.prompt.slice(0, 60)}…（第 ${msg.autoPromptCount} 次）`, 'info', 4000);
      } else if (msg.type === 'partial_start') {
        handlePartialStart(msg);
      } else if (msg.type === 'partial_delta') {
        handlePartialDelta(msg);
      } else if (msg.type === 'partial_stop') {
        handlePartialStop(msg);
      }
    } catch (e) {}
  });
}

// ─── v0.21 stderr 流式聚合 + 折叠 ─────
function handleStderrChunk(chunk) {
  if (!chunk) return;
  let div = state.stderrCurrentDiv;
  if (!div || div.dataset.finalized === 'true') {
    div = document.createElement('div');
    div.className = 'msg msg-stderr msg-stderr-collapsed';
    div.dataset.finalized = 'false';
    div.innerHTML = `
      <button class="stderr-toggle" type="button" aria-expanded="false" aria-label="展开/折叠 stderr">
        <span class="stderr-arrow" aria-hidden="true">▶</span>
        <span class="stderr-label">⚠️ stderr</span>
        <span class="stderr-bytes">0 B</span>
        <span class="stderr-time">${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      </button>
      <pre class="stderr-body"></pre>
    `;
    const toggle = div.querySelector('.stderr-toggle');
    toggle.addEventListener('click', () => {
      const collapsed = div.classList.toggle('msg-stderr-collapsed');
      div.querySelector('.stderr-arrow').textContent = collapsed ? '▶' : '▼';
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
    $('#chatOutput').appendChild(div);
    state.stderrCurrentDiv = div;
  }
  const body = div.querySelector('.stderr-body');
  body.textContent += chunk;
  // 字节数显示（多字节字符按 byte length）
  const bytes = new Blob([body.textContent]).size;
  const fmtBytes = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  div.querySelector('.stderr-bytes').textContent = fmtBytes;
  const out = $('#chatOutput');
  out.scrollTop = out.scrollHeight;
}

function finalizeStderrDiv() {
  if (state.stderrCurrentDiv) {
    state.stderrCurrentDiv.dataset.finalized = 'true';
    state.stderrCurrentDiv = null;
  }
}

// ─── v0.15 流式渲染（content_block_delta）─────
function handlePartialStart(msg) {
  if (msg.blockType !== 'text' && msg.blockType !== 'thinking') return; // tool_use 走完整 message
  const out = $('#chatOutput');
  const div = document.createElement('div');
  div.className = 'msg msg-assistant msg-streaming';
  div.dataset.blockIndex = msg.blockIndex;
  const time = new Date(msg.ts || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const label = msg.blockType === 'thinking' ? 'thinking' : 'assistant';
  const icon = msg.blockType === 'thinking' ? '💭' : '🤖';
  div.innerHTML = `
    <div class="msg-head">
      <span class="msg-icon">${icon}</span>
      <span class="msg-role">${label}</span>
      <span class="msg-time">${time}</span>
    </div>
    <div class="msg-body" data-raw-text=""></div>
  `;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
  state.streamingDivs.set(msg.blockIndex, div);
}
function handlePartialDelta(msg) {
  const div = state.streamingDivs.get(msg.blockIndex);
  if (!div) return;
  const body = div.querySelector('.msg-body');
  const next = (body.dataset.rawText || '') + (msg.textDelta || '');
  body.dataset.rawText = next;
  body.textContent = next; // 流式期间纯文本（避免 reflow / 减少 markdown 重渲染开销）
  const out = $('#chatOutput');
  out.scrollTop = out.scrollHeight;
}
function handlePartialStop(msg) {
  const div = state.streamingDivs.get(msg.blockIndex);
  if (!div) return;
  const body = div.querySelector('.msg-body');
  const fullText = body.dataset.rawText || msg.finalText || '';
  // 最后一次渲染 markdown（取代纯文本）
  body.innerHTML = renderMarkdown(fullText);
  div.classList.remove('msg-streaming');
  div.classList.add('msg-finalized');
  div.dataset.fullText = fullText;
  state.streamingDivs.delete(msg.blockIndex);
}

// ───── v0.5 思维镜融合：状态 / 成本 / 警告 chip & banner ─────
const STATE_LABELS = {
  idle: '空闲', thinking: '思考中…', running: '执行中…',
  completed: '完成', error: '出错',
};
function updateStateChip(state) {
  const chip = $('#stateChip');
  if (!state) { chip.style.display = 'none'; return; }
  chip.style.display = 'inline-block';
  chip.textContent = STATE_LABELS[state] || state;
  chip.className = 'state-chip state-' + state;
}
function updateCostChip(totalUSD, ratePerMin) {
  const chip = $('#costChip');
  if (!totalUSD && !ratePerMin) { chip.style.display = 'none'; return; }
  chip.style.display = 'inline-flex';
  const rate = ratePerMin || 0;
  const txt = $('#costChipText');
  if (txt) txt.textContent = `$${totalUSD.toFixed(3)}${rate > 0 ? ` · $${rate.toFixed(3)}/min` : ''}`;
  if (rate > 0.5) chip.classList.add('cost-warn');
  else chip.classList.remove('cost-warn');
}

// v0.28 cost 30min mini 折线图
async function refreshCostSpark() {
  const svg = $('#costSpark');
  const path = $('#costSparkPath');
  if (!state.activeId || !svg || !path) return;
  try {
    const r = await api(`/api/sessions/${state.activeId}/cost-series?windowMin=30`);
    const series = (r.series || []).map(p => p.usd);
    if (series.length < 2 || series.every(v => v === 0)) {
      svg.style.display = 'none';
      return;
    }
    svg.style.display = 'inline-block';
    const w = 60, h = 14;
    const max = Math.max(...series, 0.0001);
    const points = series.map((v, i) => {
      const x = (i / (series.length - 1)) * w;
      const y = h - 1 - (v / max) * (h - 2);
      return [x, y];
    });
    // area path: 起点底 → 折线 → 终点底 close
    const d = `M 0,${h} L ${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L ')} L ${w},${h} Z`;
    path.setAttribute('d', d);
  } catch {
    svg.style.display = 'none';
  }
}
function showDangerBanner(msg) {
  const banner = $('#dangerBanner');
  const text = $('#dangerBannerText');
  const blocked = msg.blocked !== false;
  const sev = msg.severity || 'high';
  const cats = (msg.hits || []).map(h => `[${h.severity}] ${h.category}: ${h.advice}`).join('；') || '危险命令';
  text.textContent = `${blocked ? '已拦截' : '检测到'} ${sev.toUpperCase()} 级危险命令：${cats}`;
  banner.style.display = 'flex';
  banner.classList.toggle('danger-critical', sev === 'critical');
}
function showLoopGuardBanner(msg) {
  const banner = $('#loopGuardBanner');
  const text = $('#loopGuardBannerText');
  const r = msg.reason || {};
  let label = '';
  if (r.type === 'steps_exceeded') label = `单任务步数超限（${r.current}/${r.max}），claude 可能陷入循环`;
  else if (r.type === 'repeated_instruction') label = `检测到连续 ${r.count} 次相同指令，可能在卡死`;
  else if (r.type === 'cost_surge') label = `5min 成本激增 $${r.usdInWindow}（阈值 $${r.threshold}），可能在烧钱`;
  else if (r.type === 'file_churn') label = `文件 ${r.file} 10min 内修改 ${r.churnCount} 次，可能在反复改`;
  else label = '检测到异常循环';
  text.textContent = `LoopGuard 熔断：${label}`;
  banner.style.display = 'flex';
}
function showFocusChainBanner(msg) {
  const banner = $('#focusChainBanner');
  const text = $('#focusChainBannerText');
  text.textContent = `Focus Chain 已注入（第 ${msg.step} 轮，每 5 轮提醒一次）`;
  banner.style.display = 'flex';
  setTimeout(() => { banner.style.display = 'none'; }, 4000);
}

$('#btnDangerDismiss')?.addEventListener('click', () => $('#dangerBanner').style.display = 'none');

// ─── v0.35 Watcher 监视者 UI ─────
let _lastVerdictPrompt = null;

function showWatcherVerdict(msg) {
  const banner = $('#watcherVerdictBanner');
  const verdict = msg.verdict || {};
  const statusMap = {
    completed: { icon: '✅', label: '已完成', color: 'verdict-completed' },
    partial: { icon: '🟡', label: '部分完成', color: 'verdict-partial' },
    stuck: { icon: '⚠️', label: '卡住了', color: 'verdict-stuck' },
    need_user: { icon: '🙋', label: '需要你介入', color: 'verdict-need-user' },
    failed: { icon: '❌', label: '失败', color: 'verdict-failed' },
    drifted: { icon: '🌀', label: '偏离主目标', color: 'verdict-drifted' },
  };
  const meta = statusMap[verdict.status] || statusMap.partial;
  $('#watcherVerdictIcon').textContent = meta.icon;
  $('#watcherVerdictStatus').textContent = meta.label;
  $('#watcherVerdictConf').textContent = `置信 ${(verdict.confidence * 100).toFixed(0)}%`;
  $('#watcherVerdictProvider').textContent = msg.provider || '';
  $('#watcherVerdictReasoning').textContent = verdict.reasoning || '';
  banner.className = 'watcher-verdict-banner ' + meta.color;
  if (verdict.drift_detected) banner.classList.add('verdict-drift');

  const promptWrap = $('#watcherVerdictPromptWrap');
  const next = verdict.next_action || {};
  if (next.prompt && (next.type === 'continue' || next.type === 'retry_with_hint')) {
    $('#watcherVerdictPrompt').textContent = next.prompt;
    if (next.danger_level === 'needs_review') {
      $('#watcherVerdictPrompt').classList.add('verdict-prompt-danger');
    } else {
      $('#watcherVerdictPrompt').classList.remove('verdict-prompt-danger');
    }
    _lastVerdictPrompt = next.prompt;
    promptWrap.style.display = '';
  } else {
    promptWrap.style.display = 'none';
    _lastVerdictPrompt = null;
  }
  banner.style.display = '';
}

$('#btnWatcherDismiss')?.addEventListener('click', () => {
  $('#watcherVerdictBanner').style.display = 'none';
  _lastVerdictPrompt = null;
});
$('#btnWatcherReject')?.addEventListener('click', () => {
  $('#watcherVerdictBanner').style.display = 'none';
  _lastVerdictPrompt = null;
  toast('已拒绝监视者建议', 'info', 1500);
});
$('#btnWatcherAccept')?.addEventListener('click', async () => {
  if (!_lastVerdictPrompt || !state.activeId) return;
  try {
    const r = await api(`/api/sessions/${state.activeId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: _lastVerdictPrompt }),
    });
    if (r && r.ok === false) {
      toast('发送失败：' + (r.message || r.error), 'error');
    } else {
      $('#watcherVerdictBanner').style.display = 'none';
      _lastVerdictPrompt = null;
      toast('已接受并发送', 'success', 2000);
    }
  } catch (e) {
    toast('发送失败：' + e.message, 'error');
  }
});

// 👁️ 监视者 toggle 按钮
$('#btnWatcherToggle')?.addEventListener('click', async () => {
  if (!state.activeId) return;
  const cur = state.sessions.find(s => s.id === state.activeId);
  const next = !(cur?.watcherEnabled);
  try {
    await api(`/api/sessions/${state.activeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ watcherEnabled: next }),
    });
    toast(next ? '👁️ 监视者已启用（claude turn 完成时分析）' : '监视者已关闭', next ? 'success' : 'info', 2500);
    await listSessions();
    updateWatcherToggleUI();
  } catch (e) {
    toast('切换失败: ' + e.message, 'error');
  }
});

function updateWatcherToggleUI() {
  const btn = $('#btnWatcherToggle');
  if (!btn) return;
  const cur = state.sessions.find(s => s.id === state.activeId);
  const on = !!cur?.watcherEnabled;
  btn.textContent = on ? '👁️ 监视中' : '👁️ 监视';
  btn.classList.toggle('cxbtn-primary', on);
  btn.classList.toggle('cxbtn-secondary', !on);
  // v0.40 provider 下拉：仅启用时显示
  const sel = $('#watcherProviderSelect');
  if (sel) {
    sel.style.display = on ? 'inline-block' : 'none';
    if (on) {
      const pid = cur?.watcherProviderId || watcherState.defaultProviderId || 'ollama';
      sel.value = pid;
    }
  }
}

// v0.40 拉 providers 列表 + 渲染下拉
const watcherState = { providers: [], defaultProviderId: null, loaded: false };
async function loadWatcherProviders() {
  if (watcherState.loaded) return;
  try {
    const r = await fetch('/api/watcher/providers').then(x => x.json());
    watcherState.providers = r.providers || [];
    watcherState.defaultProviderId = r.defaultId || 'ollama';
    watcherState.loaded = true;
    const sel = $('#watcherProviderSelect');
    if (sel) {
      sel.innerHTML = '';
      for (const p of watcherState.providers) {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.displayName;
        sel.appendChild(o);
      }
    }
  } catch (e) {
    // S26 B2：Watcher providers 加载失败用户应感知（watcher tab 用不了）
    console.warn('loadWatcherProviders failed:', e.message);
    try { toast('Watcher providers 加载失败：' + e.message, 'error', 8000); } catch {}
  }
}
$('#watcherProviderSelect')?.addEventListener('change', async (e) => {
  if (!state.activeId) return;
  const pid = e.target.value;
  try {
    await api(`/api/sessions/${state.activeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ watcherProviderId: pid }),
    });
    toast(`监视者已切换到 ${watcherState.providers.find(p => p.id === pid)?.displayName || pid}`, 'success', 2000);
    await listSessions();
  } catch (e) { toast('切换失败：' + e.message, 'error'); }
});
loadWatcherProviders();
$('#btnLoopGuardDismiss')?.addEventListener('click', () => $('#loopGuardBanner').style.display = 'none');

function updateBusyUI() {
  const btn = $('#btnSend');
  const input = $('#chatInput');
  const interrupt = $('#btnInterrupt');
  if (state.activeBusy) {
    btn.disabled = true;
    btn.textContent = '处理中…';
    input.disabled = true;
    if (interrupt) interrupt.style.display = 'inline-flex';
  } else {
    btn.disabled = false;
    btn.textContent = '发送 ↵';
    input.disabled = false;
    if (interrupt) interrupt.style.display = 'none';
  }
}

// v0.16/v0.20 中断当前 turn — 双击立即 force reset
let lastInterruptClickTs = 0;
async function interruptCurrentTurn() {
  if (!state.activeId) return;
  const now = Date.now();
  const doubleClick = now - lastInterruptClickTs < 800;
  lastInterruptClickTs = now;
  try {
    if (doubleClick) {
      // 第二次快速点 = 强制重置（child 卡死时用）
      await api(`/api/sessions/${state.activeId}/reset-busy`, { method: 'POST' });
      toast('已强制释放 busy 状态（SIGTERM child）', 'warn', 3000);
    } else {
      await api(`/api/sessions/${state.activeId}/interrupt`, { method: 'POST' });
      toast('已发送中断 SIGINT · 不放？双击此按钮强制释放', 'warn', 3500);
    }
  } catch (e) {
    toast('中断失败: ' + e.message + ' · 尝试双击强制释放', 'error');
  }
}
$('#btnInterrupt')?.addEventListener('click', interruptCurrentTurn);
// busy 时按钮总是显示（即使非 busy 也允许用户点中断当作 reset）
function alwaysShowInterruptWhenStuck() {
  // 如果 send 按钮 disabled 但其实 server 已不 busy（>5s 没活动），显式让用户能强释
  // 这个 4s tick 由 setInterval(listSessions) 触发，listSessions 已经同步 activeBusy
}

async function send() {
  const input = $('#chatInput');
  const val = input.value.trim();
  if (!val || state.activeBusy || !state.activeId) return;
  const savedVal = val;
  input.value = '';
  try {
    const r = await api(`/api/sessions/${state.activeId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: val }),
    });
    // v0.31 真测 P2.2 fix: server 可能返回 ok:false（busy / loop_guard_break）
    if (r && r.ok === false) {
      input.value = savedVal; // 回填，让用户能修改
      if (r.error === 'busy') {
        toast(r.message || '上一条还在处理，等完成或点 ⏸', 'warn', 4000);
      } else if (r.error === 'loop_guard_break') {
        const rsn = r.reason || {};
        let label = rsn.type;
        if (rsn.type === 'repeated_instruction') label = `连续 ${rsn.count} 次相同指令被熔断`;
        else if (rsn.type === 'steps_exceeded') label = `任务步数超 ${rsn.max}`;
        else if (rsn.type === 'cost_surge') label = `5min 成本 $${rsn.usdInWindow} 超阈值`;
        toast('🔁 LoopGuard 熔断：' + label, 'error', 5000);
      } else {
        toast('发送被拒：' + (r.message || r.error), 'error', 4000);
      }
    }
  } catch (e) {
    input.value = savedVal;
    appendMessage({ role: 'tool_use', content: `❌ 发送失败: ${e.message}`, ts: new Date().toISOString() });
  }
}

// ───── Snapshot / Handoff（07 Continuum 集成）─────
async function refreshSnapshot() {
  if (!state.activeId) {
    $('#snapshotBody').innerHTML = '<div class="muted small" style="padding:8px;">— 未选中 session —</div>';
    $('#snapshotMeta').textContent = '—';
    $('#chainBadge').style.display = 'none';
    return;
  }
  const id = state.activeId;
  try {
    const [snap, meta] = await Promise.all([
      api(`/api/sessions/${id}/snapshot`),
      api(`/api/sessions/${id}/handoff-meta`),
    ]);
    // 切 session 时可能 id 变了，确保还在
    if (state.activeId !== id) return;

    // Chain badge
    if (meta.ok && meta.meta) {
      const d = meta.meta.chain_depth || 0;
      const h = meta.meta.handoff_count || 0;
      const badge = $('#chainBadge');
      if (d > 0 || h > 0) {
        badge.textContent = `链 ${d} · 切 ${h}`;
        badge.style.display = 'inline-block';
        if (d >= 5) badge.classList.add('warn');
        else badge.classList.remove('warn');
      } else {
        badge.style.display = 'none';
      }
    } else {
      $('#chainBadge').style.display = 'none';
    }

    // Snapshot body
    if (!snap.ok) {
      $('#snapshotBody').innerHTML = `
        <div class="muted small" style="padding:12px;line-height:1.6;">
          <strong>暂无快照</strong><br>
          ${escapeHtml(snap.hint || 'snapshot 还没生成')}<br><br>
          <span style="opacity:.7;">cwd hash: <code>${escapeHtml(snap.cwdHash || '?')}</code></span>
        </div>
      `;
      $('#snapshotMeta').textContent = '无快照';
    } else {
      const mtime = new Date(snap.mtime).toLocaleTimeString('zh-CN');
      $('#snapshotMeta').textContent = `${(snap.bytes/1024).toFixed(1)}KB · ${mtime}`;
      $('#snapshotBody').innerHTML = renderMarkdown(snap.content);
    }
  } catch (e) {
    $('#snapshotBody').innerHTML = `<div class="muted small" style="padding:8px;color:#c00;">${escapeHtml(e.message)}</div>`;
  }
}

function startSnapshotPolling() {
  if (state.snapshotTimer) clearInterval(state.snapshotTimer);
  state.snapshotTimer = setInterval(() => {
    refreshSnapshot();
    refreshCtx();
    refreshCostSpark();
  }, 5000);
}

async function refreshCtx() {
  if (!state.activeId) {
    $('#ctxMeter').style.display = 'none';
    $('#ctxWarnBanner').style.display = 'none';
    return;
  }
  const id = state.activeId;
  try {
    const r = await api(`/api/sessions/${id}/ctx`);
    if (state.activeId !== id) return;
    const meter = $('#ctxMeter');
    const banner = $('#ctxWarnBanner');
    if (!r.ok) {
      meter.style.display = 'none';
      banner.style.display = 'none';
      return;
    }
    meter.style.display = 'inline-flex';
    const pct = r.pct || 0;
    const fill = $('#ctxFill');
    fill.style.width = pct + '%';
    const fmtK = n => n >= 1e6 ? (n/1e6).toFixed(2) + 'M' : (n/1000).toFixed(1) + 'k';
    $('#ctxLabel').textContent = `${pct.toFixed(1)}% · ${fmtK(r.ctxTotal)} / ${fmtK(r.maxTokens)}`;
    fill.classList.remove('ctx-warn', 'ctx-danger');
    if (pct >= 90) {
      fill.classList.add('ctx-danger');
      banner.style.display = 'block';
      $('#ctxWarnText').textContent = `⚠️ 上下文已达 ${pct.toFixed(1)}%，建议立即点 🔄 接力换 session（避免 claude 自压缩损失上下文）`;
    } else if (pct >= 70) {
      fill.classList.add('ctx-warn');
      banner.style.display = 'block';
      $('#ctxWarnText').textContent = `📊 上下文 ${pct.toFixed(1)}%，开始累积。到 90% 会强烈建议接力。`;
    } else {
      banner.style.display = 'none';
    }
  } catch (e) {
    // 静默
  }
}

$('#btnSnapRefresh').addEventListener('click', refreshSnapshot);

$('#btnHandoff').addEventListener('click', async () => {
  if (!state.activeId) return;
  const ok = await confirmModal({
    title: '接力当前 session？',
    message: '归档当前 snapshot 并新建接力 session（同 cwd，第一条预置 HANDOFF 上下文让新 claude 接手）',
    confirmLabel: '🔄 接力',
  });
  if (!ok) return;
  try {
    const r = await api(`/api/sessions/${state.activeId}/handoff`, { method: 'POST' });
    if (!r.ok) { toast('接力失败: ' + (r.error || JSON.stringify(r)), 'error'); return; }
    appendMessage({
      role: 'tool_use',
      content: `✅ 已接力 → 新 session（链层 ${r.chainDepth}, snapshot ${(r.snapshotBytes/1024).toFixed(1)}KB, 归档 ${r.archivedAs || '-'}）`,
      ts: new Date().toISOString(),
    });
    await listSessions();
    selectSession(r.newSessionId);
  } catch (e) {
    toast('接力失败: ' + e.message, 'error');
  }
});

// 外部 Terminal 启动当前 session
$('#btnExternal').addEventListener('click', async () => {
  if (!state.activeId) return;
  try {
    await api(`/api/sessions/${state.activeId}/external`, { method: 'POST' });
    appendMessage({ role: 'tool_use', content: '✅ 已在 macOS Terminal 打开独立 claude 窗口', ts: new Date().toISOString() });
  } catch (e) { toast('打开失败: ' + e.message, 'error'); }
});

// 批量为所有 session 开 Terminal 窗口
$('#btnSpawnAll').addEventListener('click', async () => {
  if (!state.sessions.length) return;
  const ok = await confirmModal({
    title: `批量打开 ${state.sessions.length} 个 Terminal 窗口？`,
    message: `每个活跃 session 各开一个 macOS Terminal 窗口跑独立 claude。会同时弹 ${state.sessions.length} 个窗口。`,
    confirmLabel: '⤴⤴ 全开',
  });
  if (!ok) return;
  try {
    const r = await api('/api/spawn-batch', {
      method: 'POST',
      body: JSON.stringify({ ids: state.sessions.map(s => s.id) }),
    });
    appendMessage({ role: 'tool_use', content: `✅ 已开 ${r.spawned.length} 个 Terminal 窗口`, ts: new Date().toISOString() });
  } catch (e) { toast('批量打开失败: ' + e.message, 'error'); }
});

$('#btnSend').addEventListener('click', send);
$('#chatInput').addEventListener('keydown', e => {
  // v0.50 Q-01 IME fix: 中文选字 Enter 不该触发
  // v0.54 Sprint 7：Enter 发送 / Shift+Enter 换行 / ⌘+Enter 兼容（旧习惯）
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key !== 'Enter') return;
  if (e.shiftKey) return;
  e.preventDefault();
  send();
});

// 新建弹窗
function openModal() { $('#newModal').style.display = 'flex'; $('#newName').focus(); loadQuickCwd(); }
function closeModal() {
  $('#newModal').style.display = 'none';
  $('#newName').value = '';
  $('#newCwd').value = '';
  const g = $('#newMainGoal'); if (g) g.value = '';
}
async function loadQuickCwd() {
  const wrap = $('#quickCwd');
  wrap.innerHTML = '<span class="muted small">加载…</span>';
  try {
    const { items } = await api('/api/files?path=' + encodeURIComponent('~/Desktop'));
    wrap.innerHTML = '';
    items.filter(i => i.isDir).slice(0, 12).forEach(it => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = it.name;
      c.title = it.path;
      c.addEventListener('click', () => $('#newCwd').value = it.path);
      wrap.appendChild(c);
    });
  } catch (e) { wrap.innerHTML = ''; }
}

$('#btnNew').addEventListener('click', openModal);
$$('[data-close]').forEach(el => el.addEventListener('click', closeModal));
$('#btnCreateConfirm').addEventListener('click', async () => {
  const name = $('#newName').value.trim();
  const cwd = $('#newCwd').value.trim() || null;
  const mainGoal = $('#newMainGoal')?.value.trim() || null;
  try { await createSession(name, cwd, mainGoal); closeModal(); }
  catch (e) { toast('创建失败: ' + e.message, 'error'); }
});

// ───── Inspector tabs ─────
let currentTab = 'info';
$$('.ins-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    currentTab = tab;
    $$('.ins-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.ins-content').forEach(c => c.style.display = c.dataset.content === tab ? 'block' : 'none');
    if (tab === 'files' && state.activeCwd) loadFiles(state.activeCwd);
    if (tab === 'snapshot') refreshSnapshot();
    if (tab === 'projects') loadProjects();
    if (tab === 'safety') refreshSafety();
  });
});

// v0.27 安全历史 tab
async function refreshSafety() {
  const body = $('#safetyBody');
  const meta = $('#safetyMeta');
  if (!state.activeId) {
    body.innerHTML = '<div class="muted small" style="padding:8px;">— 未选中 session —</div>';
    meta.textContent = '—';
    return;
  }
  try {
    const r = await api(`/api/sessions/${state.activeId}/safety-history`);
    const dangers = r.danger || [];
    const breaks = r.loopGuard || [];
    meta.textContent = `🛑 ${dangers.length} 危险 · 🔁 ${breaks.length} 熔断`;
    if (dangers.length === 0 && breaks.length === 0) {
      body.innerHTML = '<div class="muted small" style="padding:12px;">本 session 暂无安全事件记录 ✅</div>';
      return;
    }
    let html = '';
    if (dangers.length > 0) {
      html += '<h3 class="safety-sec-h">🛑 DangerDetector 拦截/警告</h3>';
      html += '<div class="safety-list">';
      for (const d of dangers.slice().reverse()) {
        const t = new Date(d.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const sev = d.severity || 'unknown';
        const tag = d.blocked ? '已拦截' : '仅警告';
        html += `<div class="safety-item safety-${sev}">
          <div class="safety-row1">
            <span class="safety-sev sev-${sev}">${escapeHtml(sev)}</span>
            <span class="safety-tag">${tag}</span>
            <span class="safety-time">${t}</span>
          </div>
          <div class="safety-cmd"><code>${escapeHtml((d.command || '').slice(0, 200))}</code></div>
          <div class="safety-hits">
            ${(d.hits || []).slice(0, 3).map(h => `<div>• <b>[${escapeHtml(h.severity)}] ${escapeHtml(h.category)}</b> — ${escapeHtml(h.advice || '')}</div>`).join('')}
          </div>
        </div>`;
      }
      html += '</div>';
    }
    // v0.29 状态时序（最近 20 次转移）
    const stateHist = (r.stateHistory || []).slice(-20);
    if (stateHist.length > 0) {
      html += `<h3 class="safety-sec-h">📈 状态时序（最近 ${stateHist.length} 次，当前: ${escapeHtml(r.currentState || 'idle')}）</h3>`;
      html += '<div class="state-timeline">';
      for (let i = stateHist.length - 1; i >= 0; i--) {
        const t = stateHist[i];
        const time = new Date(t.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        html += `<div class="state-tx">
          <span class="state-time">${time}</span>
          <span class="state-from state-pill state-${escapeHtml(t.from)}">${escapeHtml(t.from)}</span>
          <span class="state-arrow">→</span>
          <span class="state-to state-pill state-${escapeHtml(t.to)}">${escapeHtml(t.to)}</span>
          <span class="state-reason">${escapeHtml(t.reason || '')}</span>
        </div>`;
      }
      html += '</div>';
    }

    if (breaks.length > 0) {
      html += '<h3 class="safety-sec-h">🔁 LoopGuard 熔断</h3>';
      html += '<div class="safety-list">';
      for (const b of breaks.slice().reverse()) {
        const t = new Date(b.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        let label = b.type;
        if (b.type === 'steps_exceeded') label = `单任务步数 ${b.current}/${b.max}`;
        else if (b.type === 'repeated_instruction') label = `重复指令 ×${b.count}: "${(b.text || '').slice(0, 60)}"`;
        else if (b.type === 'cost_surge') label = `5min 成本激增 $${b.usdInWindow} > $${b.threshold}`;
        else if (b.type === 'file_churn') label = `${b.file} 颤动 ${b.churnCount} 次`;
        html += `<div class="safety-item safety-loop">
          <div class="safety-row1">
            <span class="safety-sev sev-high">${escapeHtml(b.type)}</span>
            <span class="safety-time">${t}</span>
          </div>
          <div class="safety-cmd">${escapeHtml(label)}</div>
        </div>`;
      }
      html += '</div>';
    }
    // v0.37 watcher 历史 + 配置段
    html += await renderWatcherSection();
    // v0.47 hook 事件流段
    html += await renderHookEventsSection();

    body.innerHTML = html;
    attachWatcherSectionHandlers();
  } catch (e) {
    body.innerHTML = `<div class="muted small" style="padding:8px;color:#c00;">${escapeHtml(e.message)}</div>`;
  }
}
$('#btnSafetyRefresh')?.addEventListener('click', refreshSafety);

// v0.37 watcher 配置 + 历史
async function renderWatcherSection() {
  let cfg = null;
  let history = [];
  try {
    const r = await api('/api/watcher/config');
    cfg = r.config;
    if (state.activeId) {
      const sess = await api(`/api/sessions/${state.activeId}`);
      history = sess.watcherHistory || [];
    }
  } catch (e) {
    return `<h3 class="safety-sec-h">👁️ 监视者</h3><div class="muted small">加载失败: ${escapeHtml(e.message)}</div>`;
  }
  let html = '<h3 class="safety-sec-h">👁️ 监视者（其他 LLM 监督 Claude）</h3>';

  // 配置段
  html += `<div class="watcher-config-box">
    <div class="watcher-cfg-row">
      <label>启用</label>
      <input type="checkbox" id="cfgWatcherEnabled" ${cfg.enabled ? 'checked' : ''} />
      <label style="margin-left:12px;">自动模式</label>
      <input type="checkbox" id="cfgWatcherAuto" ${cfg.autoMode ? 'checked' : ''} title="开启后 verdict 通过安全检查就自动发回 claude（默认半自动需点接受）" />
    </div>
    <div class="watcher-cfg-row">
      <label>Provider</label>
      <select id="cfgWatcherProvider">
        <option value="ollama" ${cfg.provider==='ollama'?'selected':''}>Ollama（本地，零成本）</option>
        <option value="minimax" ${cfg.provider==='minimax'?'selected':''}>MiniMax（需 chat plan）</option>
      </select>
    </div>
    <div class="watcher-cfg-row">
      <label>Model</label>
      <input type="text" id="cfgWatcherModel" value="${escapeHtml(cfg.model || '')}" placeholder="gemma3:4b / qwen2.5:7b / abab6.5s-chat" />
    </div>
    <div class="watcher-cfg-row">
      <label>API Key</label>
      <input type="password" id="cfgWatcherKey" value="${escapeHtml(cfg.apiKey || '')}" placeholder="Ollama 留 'ollama' 即可" />
    </div>
    <div class="watcher-cfg-row">
      <label>Base URL</label>
      <input type="text" id="cfgWatcherBaseUrl" value="${escapeHtml(cfg.baseUrl || '')}" placeholder="留空走 provider 默认" />
    </div>
    <div class="watcher-cfg-actions">
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnWatcherTest">测试连通</button>
      <button class="cxbtn cxbtn-primary cxbtn-sm" id="btnWatcherSave">保存</button>
    </div>
  </div>`;

  // 历史段
  if (history.length === 0) {
    html += '<div class="muted small" style="padding:8px;">本 session 暂无监视者历史</div>';
  } else {
    html += `<div class="watcher-history-list">`;
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      const v = h.verdict || {};
      const time = new Date(h.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      html += `<div class="watcher-hist-item watcher-status-${v.status}">
        <div class="watcher-hist-row1">
          <span class="watcher-hist-status">${escapeHtml(v.status)}</span>
          <span class="watcher-hist-conf">${(v.confidence*100).toFixed(0)}%</span>
          <span class="watcher-hist-provider">${escapeHtml(h.provider)}</span>
          <span class="watcher-hist-time">${time}</span>
        </div>
        <div class="watcher-hist-reason">${escapeHtml((v.reasoning || '').slice(0, 200))}</div>
        ${v.next_action?.prompt ? `<div class="watcher-hist-prompt">→ ${escapeHtml(v.next_action.prompt.slice(0, 120))}</div>` : ''}
      </div>`;
    }
    html += '</div>';
  }
  return html;
}

// v0.47 hook 事件流（来自 Claude Code 外部 hook POST 进 panel 的 12 种事件）
async function renderHookEventsSection() {
  let events = [];
  try {
    if (state.activeId) {
      const r = await fetch(`/api/hooks?sessionId=${state.activeId}&limit=50`).then(x => x.json());
      events = r.events || [];
    }
  } catch {}
  let html = `<div class="safety-section-head" style="margin-top:14px;">🪝 Hook 事件流（最近 50 条）</div>`;
  if (events.length === 0) {
    html += `<div class="muted small" style="padding:8px;">本 session 暂无 hook 事件。<br>
      <button class="link-btn" id="lnkHooksDoc">如何配置 ~/.claude/settings.json 接入 →</button></div>`;
  } else {
    html += `<div class="hook-events-list">`;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const t = new Date(e.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      html += `<div class="hook-event-item hook-event-${e.event}">
        <span class="hook-event-name">${escapeHtml(e.event)}</span>
        ${e.tool ? `<span class="hook-event-tool">${escapeHtml(e.tool)}</span>` : ''}
        <span class="hook-event-time">${t}</span>
      </div>`;
    }
    html += '</div>';
  }
  return html;
}

function attachWatcherSectionHandlers() {
  // v0.47 hook 文档 modal
  $('#lnkHooksDoc')?.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const md = await fetch('/api/docs/HOOKS_USAGE.md').then(r => r.text());
      // 直接弹一个 modal 显示 markdown 渲染
      let modal = document.getElementById('docModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'docModal';
        modal.className = 'doc-modal';
        document.body.appendChild(modal);
      }
      modal.innerHTML = `<div class="doc-modal-content">
        <button class="doc-modal-close" aria-label="关闭">✕</button>
        <div class="doc-modal-body">${renderMarkdown(md)}</div>
      </div>`;
      modal.style.display = 'flex';
      modal.querySelector('.doc-modal-close').addEventListener('click', () => modal.style.display = 'none');
      modal.addEventListener('click', (ev) => { if (ev.target === modal) modal.style.display = 'none'; });
    } catch (err) {
      toast('打不开文档：' + err.message, 'error');
    }
  });
  $('#btnWatcherSave')?.addEventListener('click', async () => {
    const body = {
      enabled: $('#cfgWatcherEnabled').checked,
      autoMode: $('#cfgWatcherAuto').checked,
      provider: $('#cfgWatcherProvider').value,
      model: $('#cfgWatcherModel').value.trim(),
      baseUrl: $('#cfgWatcherBaseUrl').value.trim(),
    };
    const keyVal = $('#cfgWatcherKey').value;
    // 含 "..." 的脱敏值不覆盖原 key
    if (keyVal && !keyVal.includes('...')) body.apiKey = keyVal;
    try {
      const r = await api('/api/watcher/config', { method: 'PUT', body: JSON.stringify(body) });
      if (r.ok) toast('监视者配置已保存' + (r.adapterActive ? '（adapter active）' : ''), 'success', 3000);
      else toast('保存失败', 'error');
    } catch (e) { toast('保存失败: ' + e.message, 'error'); }
  });
  $('#btnWatcherTest')?.addEventListener('click', async () => {
    toast('测试中…', 'info', 1500);
    try {
      const r = await api('/api/watcher/test', { method: 'POST' });
      if (r.ok) {
        const v = r.verdict;
        toast(`✅ 测试通过：${v.status} (${(v.confidence*100).toFixed(0)}%) — ${v.reasoning.slice(0,80)}`, 'success', 5000);
      } else {
        toast('测试失败: ' + (r.error || '').slice(0, 200), 'error', 5000);
      }
    } catch (e) { toast('测试失败: ' + e.message, 'error', 5000); }
  });
}

// 实时增量：WS 收到危险/熔断时如果当前 safety tab 打开就刷新
function maybeRefreshSafetyIfOpen() {
  const safetyTab = document.querySelector('.ins-tab[data-tab="safety"]');
  if (safetyTab?.classList.contains('active')) refreshSafety();
}

// ───── 方案 B 项目监控 ─────
async function loadProjects() {
  const list = $('#projectList');
  list.innerHTML = '<div class="muted small" style="padding:8px;">加载中…</div>';
  try {
    const r = await api('/api/projects');
    if (!r.ok || !r.items?.length) {
      list.innerHTML = `<div class="muted small" style="padding:12px;">${escapeHtml(r.reason || '未发现含 PROGRESS.md 的项目')}</div>`;
      return;
    }
    list.innerHTML = '';
    for (const p of r.items) {
      const card = document.createElement('div');
      card.className = 'project-card';
      const color = { green: '🟢', yellow: '🟡', red: '🔴' }[p.statusColor] || '⚪️';
      const ascBadge = p.ascState ? `<span class="proj-asc">${escapeHtml(p.ascState)}</span>` : '';
      const runBadge = p.running
        ? `<span class="proj-run ${p.lockStale ? 'stale' : ''}">${p.lockStale ? '⚠️ 锁陈旧' : '🟢 跑'}</span>`
        : '';
      const launchdBadge = p.launchdPlist ? `<span class="proj-launchd" title="${escapeHtml(p.launchdPlist)}">⏰ launchd</span>` : '';
      const blockedBadge = (p.activeBlocked && p.activeBlocked > 0)
        ? `<span class="proj-blocked">🚧 ${p.activeBlocked}</span>` : '';
      const lastCommit = p.lastCommitAt ? new Date(p.lastCommitAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
      card.innerHTML = `
        <div class="proj-row1">
          <span class="proj-color">${color}</span>
          <span class="proj-name">${escapeHtml(p.name)}</span>
          <span class="proj-cycle">cycle ${p.cycles ?? 0}</span>
        </div>
        <div class="proj-row2">${ascBadge}${runBadge}${launchdBadge}${blockedBadge}<span class="proj-commit">⏱ ${lastCommit}</span></div>
        ${p.headline ? `<div class="proj-headline">${escapeHtml(p.headline)}</div>` : ''}
      `;
      card.addEventListener('click', () => openProjectModal(p.name));
      list.appendChild(card);
    }
  } catch (e) {
    list.innerHTML = `<div class="muted small" style="padding:8px;color:#c00;">${escapeHtml(e.message)}</div>`;
  }
}

async function openProjectModal(name) {
  $('#projectModal').style.display = 'flex';
  $('#projectModalTitle').textContent = name;
  const body = $('#projectModalBody');
  body.innerHTML = '<div class="muted small">加载中…</div>';
  try {
    const p = await api(`/api/projects/${encodeURIComponent(name)}`);
    const sec = (title, content) => content
      ? `<h3 class="proj-sec-h">${escapeHtml(title)}</h3><div class="proj-sec-body">${renderMarkdown(content)}</div>`
      : '';
    body.innerHTML = `
      <div class="proj-modal-meta muted small">
        path <code>${escapeHtml(p.path)}</code> · cycle ${p.cycles ?? 0}
        ${p.ascState ? ' · ASC ' + escapeHtml(p.ascState) : ''}
        ${p.running ? (p.lockStale ? ' · ⚠️ 锁陈旧 ' + p.lockAgeSec + 's' : ' · 🟢 在跑') : ''}
        ${p.launchdPlist ? ' · ⏰ ' + escapeHtml(p.launchdPlist) : ''}
      </div>
      ${sec('STATUS.md', p.sections?.status)}
      ${sec('BLOCKED.md', p.sections?.blocked)}
      ${sec('PROGRESS.md（最近 60 行）', p.sections?.progressTail)}
      ${sec('ERROR_LOG.md', p.sections?.errorLog)}
    `;
  } catch (e) {
    body.innerHTML = `<div class="muted small" style="color:#c00;padding:8px;">${escapeHtml(e.message)}</div>`;
  }
}

function closeProjectModal() { $('#projectModal').style.display = 'none'; }
$$('[data-close-project]').forEach(el => el.addEventListener('click', closeProjectModal));
$('#btnProjectsRefresh').addEventListener('click', loadProjects);

// ───── 接力链 history modal ─────
async function openHistoryModal() {
  if (!state.activeId) return;
  $('#historyModal').style.display = 'flex';
  const body = $('#historyModalBody');
  body.innerHTML = '<div class="muted small">加载中…</div>';
  try {
    const r = await api(`/api/sessions/${state.activeId}/handoff-history`);
    if (!r.ok || !r.items?.length) {
      body.innerHTML = '<div class="muted small" style="padding:8px;">尚无 history 归档（接力一次后会生成）</div>';
      return;
    }
    body.innerHTML = `
      <div class="muted small" style="margin-bottom:8px;">cwd: <code>${escapeHtml(r.cwd)}</code> · ${r.count} 个归档</div>
      <div class="history-list" id="historyList"></div>
      <div class="history-detail" id="historyDetail" style="display:none;">
        <div class="snapshot-head">
          <span class="muted small" id="historyDetailMeta"></span>
          <button class="btn-icon" id="btnHistBack">← 返回列表</button>
        </div>
        <div class="snapshot-body" id="historyDetailBody"></div>
      </div>
    `;
    const list = $('#historyList');
    for (const it of r.items) {
      const mtime = new Date(it.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const item = document.createElement('div');
      item.className = 'history-item';
      const triggerLabel = { panel: '🔁 panel', manual: '✋ manual', auto: '⏰ auto' }[it.trigger] || it.trigger;
      item.innerHTML = `
        <div class="hist-row1">
          <span class="hist-trigger trigger-${it.trigger}">${triggerLabel}</span>
          <span class="hist-time">${mtime}</span>
          <span class="hist-size">${(it.bytes/1024).toFixed(1)}KB</span>
        </div>
        <div class="hist-filename muted small">${escapeHtml(it.name)}</div>
      `;
      item.addEventListener('click', () => loadHistoryArchive(it.name));
      list.appendChild(item);
    }
    $('#btnHistBack').addEventListener('click', () => {
      $('#historyDetail').style.display = 'none';
      $('#historyList').style.display = '';
    });
  } catch (e) {
    body.innerHTML = `<div class="muted small" style="color:#c00;padding:8px;">${escapeHtml(e.message)}</div>`;
  }
}

async function loadHistoryArchive(filename) {
  try {
    const r = await api(`/api/sessions/${state.activeId}/handoff-history?file=${encodeURIComponent(filename)}`);
    if (!r.ok) { toast('加载失败', 'error'); return; }
    $('#historyList').style.display = 'none';
    $('#historyDetail').style.display = '';
    $('#historyDetailMeta').textContent = `${filename} · ${(r.bytes/1024).toFixed(1)}KB · ${new Date(r.mtime).toLocaleString('zh-CN')}`;
    $('#historyDetailBody').innerHTML = renderMarkdown(r.content);
  } catch (e) {
    toast('读取失败: ' + e.message, 'error');
  }
}

function closeHistoryModal() { $('#historyModal').style.display = 'none'; }
$$('[data-close-history]').forEach(el => el.addEventListener('click', closeHistoryModal));
$('#chainBadge').addEventListener('click', openHistoryModal);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if ($('#projectModal').style.display === 'flex') closeProjectModal();
    if ($('#historyModal').style.display === 'flex') closeHistoryModal();
  }
});

// ───── 文件浏览器 ─────
async function loadFiles(path) {
  state.filePath = path;
  $('#filePath').textContent = shortenPath(path);
  const list = $('#fileList');
  list.innerHTML = '<div class="muted small" style="padding:8px;">加载…</div>';
  try {
    const { items } = await api('/api/files?path=' + encodeURIComponent(path));
    list.innerHTML = '';
    // 加 .. 上一级
    const up = document.createElement('div');
    up.className = 'file-item up';
    up.innerHTML = '<span class="file-icon">↑</span><span class="file-name">.. 上一级</span>';
    up.addEventListener('click', () => {
      const parent = path.replace(/\/[^/]+\/?$/, '') || '/';
      loadFiles(parent);
    });
    list.appendChild(up);
    items.forEach(it => {
      const div = document.createElement('div');
      div.className = 'file-item' + (it.isDir ? ' dir' : '');
      const icon = it.isDir ? '📁' : '📄';
      const sizeStr = it.isDir ? '' : formatSize(it.size);
      div.innerHTML = `<span class="file-icon">${icon}</span><span class="file-name">${escapeHtml(it.name)}</span><span class="file-size">${sizeStr}</span>`;
      div.addEventListener('click', () => {
        if (it.isDir) loadFiles(it.path);
        else openFileInChat(it.path);
      });
      list.appendChild(div);
    });
  } catch (e) {
    list.innerHTML = `<div class="muted small" style="padding:8px;color:#c00;">${e.message}</div>`;
  }
}

// S24 minimum: formatSize 主实现挪到 src/web/utils.js
function formatSize(b) {
  if (window.PanelUtils && window.PanelUtils.formatSize) return window.PanelUtils.formatSize(b);
  if (!b) return '';
  if (b < 1024) return b + 'B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + 'K';
  return (b/1024/1024).toFixed(1) + 'M';
}

async function openFileInChat(path) {
  if (!state.activeId) {
    toast('先选一个 session', 'warn');
    return;
  }
  try {
    const resp = await api('/api/file?path=' + encodeURIComponent(path));
    const { content, truncated, size } = resp;
    const input = $('#chatInput');
    const ext = path.split('.').pop();
    const previewBody = (content || '').substring(0, 2000);
    const header = truncated
      ? `参考文件 ${path}（已截断：原文件 ${(size/1024/1024).toFixed(1)}MB，仅取前 1MB 的前 2000 字符）:`
      : `参考文件 ${path}:`;
    const ref = `\n\n${header}\n\`\`\`${ext}\n${previewBody}\n\`\`\`\n\n`;
    input.value = input.value + ref;
    input.focus();
    if (truncated) toast('文件 > 1MB，已截断', 'warn');
  } catch (e) {
    toast('读文件失败: ' + e.message, 'error');
  }
}

// 全局快捷键
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault();
    openModal();
  }
  if (e.key === 'Escape' && $('#newModal').style.display === 'flex') {
    closeModal();
  }
  if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
    const idx = parseInt(e.key, 10) - 1;
    if (state.sessions[idx]) {
      e.preventDefault();
      selectSession(state.sessions[idx].id);
    }
  }
});

// ─── v0.6 主题切换 ─────
function applyTheme(theme) {
  const html = document.documentElement;
  html.classList.remove('light', 'dark');
  if (theme === 'dark' || theme === 'light') html.classList.add(theme);
  // v0.51 U-08 fix: 隐私模式 / quota 超限时 localStorage 抛错，吞掉防整个 applyTheme 失败
  try { localStorage.setItem('cp-theme', theme); } catch {}
}
function toggleTheme() {
  const cur = localStorage.getItem('cp-theme');
  // 系统/未设置 → 强制 light；light → dark；dark → light
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
}
(() => {
  const saved = localStorage.getItem('cp-theme');
  if (saved === 'dark' || saved === 'light') applyTheme(saved);
})();
$('#themeToggle')?.addEventListener('click', toggleTheme);

// v0.14: 🔐 Claude 登录按钮
$('#btnLoginClaude')?.addEventListener('click', async () => {
  const ok = await confirmModal({
    title: '在 Terminal 打开 claude /login？',
    message: '会启动 macOS Terminal 跑 `claude /login` 自动进入 OAuth 浏览器跳转。完成登录后关闭 Terminal 窗口回 panel。',
    confirmLabel: '🔐 开始登录',
  });
  if (!ok) return;
  try {
    const r = await api('/api/login-claude', { method: 'POST' });
    toast(r.message || '已开 Terminal 完成登录', 'info', 5000);
  } catch (e) {
    toast('启动登录失败: ' + e.message, 'error');
  }
});

// ─── v0.6 StatusBar 更新 ─────
function updateStatusBar() {
  const active = state.sessions.length;
  const busy = state.sessions.filter(s => s.busy || s.runState === 'running' || s.runState === 'thinking').length;
  const archived = state.archivedSessions.length;
  const totalCost = state.sessions.reduce((s, x) => s + (x.totalUSD || 0), 0);
  $('#statusActive').textContent = `活跃 ${active}`;
  $('#statusBusy').textContent = `在跑 ${busy}`;
  $('#statusArchived').textContent = `归档 ${archived}`;
  $('#statusCost').textContent = `累计 $${totalCost.toFixed(3)}`;
  const sync = $('#statusSync');
  const dot = $('#statusDotSync');
  sync.textContent = `同步 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  dot.className = 'status-dot';
}
// updateStatusBar 已经在 listSessions 末尾自动调；额外 4s 兜底刷新一下时间显示
setInterval(updateStatusBar, 4000);

// ─── v0.6 ⌘K 命令面板 ─────
const cmdkState = { activeIdx: 0, items: [] };

function buildCmdkItems(query) {
  const q = query.trim().toLowerCase();
  const items = [];

  // v0.80 真迁：COMMANDS 静态声明从 cmdk-commands.js module 拿（main.js 桥接）
  // 失败 fallback 用 inline 定义（main.js 没加载时兼容）
  let COMMANDS;
  if (window.PanelCmdk?.BUILTIN_COMMANDS) {
    const dispatcher = {
      openModal: () => { closeCmdk(); openModal(); },
      toggleTheme: () => { toggleTheme(); closeCmdk(); },
      btnHandoff: () => { closeCmdk(); $('#btnHandoff')?.click(); },
      btnExternal: () => { closeCmdk(); $('#btnExternal')?.click(); },
    };
    COMMANDS = window.PanelCmdk.BUILTIN_COMMANDS.map(c => ({
      type: 'cmd',
      icon: c.icon, title: c.title, subtitle: c.subtitle,
      action: dispatcher[c.actionRef] || (() => closeCmdk()),
    }));
  } else {
    // fallback inline
    COMMANDS = [
      { type: 'cmd', icon: '＋', title: '新建会话', subtitle: '⌘N', action: () => { closeCmdk(); openModal(); } },
      { type: 'cmd', icon: '🌓', title: '切换主题（暗/亮）', subtitle: '⌘D', action: () => { toggleTheme(); closeCmdk(); } },
      { type: 'cmd', icon: '🔄', title: '为当前会话接力', subtitle: '需先选中一个会话', action: () => { closeCmdk(); $('#btnHandoff')?.click(); } },
      { type: 'cmd', icon: '⤴', title: '在 Terminal 打开当前会话', subtitle: '', action: () => { closeCmdk(); $('#btnExternal')?.click(); } },
    ];
  }
  for (const c of COMMANDS) {
    if (!q || c.title.toLowerCase().includes(q)) items.push(c);
  }

  // session 跳转组
  for (const s of state.sessions) {
    const blob = (s.name + ' ' + s.cwd + ' ' + (s.mainGoal || '')).toLowerCase();
    if (q && !blob.includes(q)) continue;
    items.push({
      type: 'session',
      icon: '✦',
      title: s.name,
      subtitle: shortenPath(s.cwd) + (s.mainGoal ? ` · 🎯 ${s.mainGoal}` : ''),
      action: () => { selectSession(s.id); closeCmdk(); },
    });
  }
  // 归档跳转组
  for (const s of state.archivedSessions || []) {
    const blob = (s.name + ' ' + s.cwd).toLowerCase();
    if (q && !blob.includes(q)) continue;
    items.push({
      type: 'archived',
      icon: '📦',
      title: s.name + '（归档）',
      subtitle: shortenPath(s.cwd) + ' · 双击恢复',
      action: () => {
        confirmModal({
          title: '从归档恢复？',
          message: `「${s.name}」恢复到活跃会话列表。`,
          confirmLabel: '↩ 恢复',
        }).then(ok => { if (ok) setSessionArchived(s.id, false).then(closeCmdk); });
      },
    });
  }
  return items;
}

function openCmdk() {
  $('#cmdkModal').style.display = 'flex';
  $('#cmdkInput').value = '';
  cmdkState.activeIdx = 0;
  renderCmdk('');
  setTimeout(() => $('#cmdkInput').focus(), 0);
}
function closeCmdk() {
  $('#cmdkModal').style.display = 'none';
}
function renderCmdk(query) {
  cmdkState.items = buildCmdkItems(query);
  if (cmdkState.activeIdx >= cmdkState.items.length) cmdkState.activeIdx = 0;
  const list = $('#cmdkList');
  list.innerHTML = '';
  if (cmdkState.items.length === 0) {
    list.innerHTML = '<div class="cmdk-empty">没匹配到</div>';
    return;
  }
  cmdkState.items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'cmdk-item' + (i === cmdkState.activeIdx ? ' active' : '');
    row.innerHTML = `
      <span class="cmdk-icon">${it.icon}</span>
      <span class="cmdk-title">${escapeHtml(it.title)}</span>
      <span class="cmdk-subtitle">${escapeHtml(it.subtitle || '')}</span>
    `;
    row.addEventListener('click', () => it.action?.());
    row.addEventListener('mouseenter', () => {
      cmdkState.activeIdx = i;
      [...list.children].forEach((c, j) => c.classList.toggle('active', j === i));
    });
    list.appendChild(row);
  });
}
$('#cmdkInput')?.addEventListener('input', e => renderCmdk(e.target.value));
$('#cmdkInput')?.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    cmdkState.activeIdx = Math.min(cmdkState.activeIdx + 1, cmdkState.items.length - 1);
    renderCmdk($('#cmdkInput').value);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    cmdkState.activeIdx = Math.max(0, cmdkState.activeIdx - 1);
    renderCmdk($('#cmdkInput').value);
  } else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    const it = cmdkState.items[cmdkState.activeIdx];
    if (it) it.action?.();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeCmdk();
  }
});
$('#cmdkModal')?.addEventListener('click', e => {
  if (e.target.id === 'cmdkModal') closeCmdk();
});

// 全局快捷键：⌘K 打开命令面板 / ⌘D 切主题
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCmdk();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    toggleTheme();
  }
});

// ─── v0.23 内嵌真终端（PTY + xterm.js）─────
const termState = {
  termId: null,
  ws: null,
  xterm: null,
  fitAddon: null,
  resizeObserver: null,
};

function showTermArea() {
  $('#mainHeader').style.display = 'none';
  $('#chatArea').style.display = 'none';
  $('#roomArea').style.display = 'none';
  $('#pluginArea').style.display = 'none';
  const ov = $('#overviewArea'); if (ov) ov.style.display = 'none';
  $('#termArea').style.display = 'flex';
}

function hideTermArea() {
  $('#termArea').style.display = 'none';
  if (state.activeId) {
    $('#chatArea').style.display = 'flex';
  } else {
    $('#mainHeader').style.display = 'flex';
  }
}

async function openTerm(cwd) {
  showTermArea();
  if (termState.termId) {
    // 关闭旧 term
    await closeTerm();
  }
  const container = $('#termContainer');
  container.innerHTML = '';
  try {
    const r = await api('/api/term', {
      method: 'POST',
      body: JSON.stringify({ cwd: cwd || null, cols: 100, rows: 30 }),
    });
    termState.termId = r.termId;
    $('#termMeta').textContent = `pid ${r.pid} · ${shortenPath(r.cwd)} · ${r.shell.split('/').pop()}`;
    $('#btnTermClose').style.display = 'inline-flex';

    // 启 xterm
    const xterm = new window.Terminal({
      cursorBlink: true,
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 13,
      theme: getXtermTheme(),
      scrollback: 2000,
      convertEol: false,
    });
    const fitAddon = new window.FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(container);
    fitAddon.fit();
    xterm.focus();
    termState.xterm = xterm;
    termState.fitAddon = fitAddon;

    // 连 WS
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/term/${r.termId}`);
    termState.ws = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'data') xterm.write(msg.data);
        else if (msg.type === 'exit') {
          xterm.write(`\r\n\x1b[33m[终端退出 code=${msg.exitCode}]\x1b[0m\r\n`);
          $('#termMeta').textContent = `已退出 (code ${msg.exitCode})`;
          termState.termId = null;
        }
      } catch {}
    };
    ws.onopen = () => {
      // 立即发一次 resize 给服务端，让 PTY 大小跟 xterm 对齐
      const cols = xterm.cols, rows = xterm.rows;
      try { ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch {}
    };
    xterm.onData(d => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d }));
    });
    xterm.onResize(({ cols, rows }) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    // 容器 resize 自动 fit
    if (termState.resizeObserver) termState.resizeObserver.disconnect();
    termState.resizeObserver = new ResizeObserver(() => { try { fitAddon.fit(); } catch {} });
    termState.resizeObserver.observe(container);

    toast('终端已打开 · 跑 `claude` 试试 TUI 模式', 'success', 3500);
  } catch (e) {
    toast('开终端失败: ' + e.message, 'error');
    $('#termMeta').textContent = '失败';
  }
}

function getXtermTheme() {
  const isDark = document.documentElement.classList.contains('dark') ||
    (!document.documentElement.classList.contains('light') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return isDark ? {
    background: '#0d0e14', foreground: '#e5e2db', cursor: '#C15F3C', selectionBackground: '#3a3733',
    black: '#181818', red: '#b3322f', green: '#138a36', yellow: '#d97706',
    blue: '#339cff', magenta: '#7c3aed', cyan: '#06b6d4', white: '#afafaf',
  } : {
    background: '#F8F6F2', foreground: '#2D2D2D', cursor: '#C15F3C', selectionBackground: '#e8e3d8',
    black: '#0d0d0d', red: '#b3322f', green: '#138a36', yellow: '#d97706',
    blue: '#0285ff', magenta: '#7c3aed', cyan: '#06b6d4', white: '#5d5d5d',
  };
}

async function closeTerm() {
  if (termState.ws) { try { termState.ws.close(); } catch {} }
  if (termState.termId) {
    try { await api(`/api/term/${termState.termId}`, { method: 'DELETE' }); } catch {}
  }
  if (termState.xterm) { try { termState.xterm.dispose(); } catch {} }
  if (termState.resizeObserver) { try { termState.resizeObserver.disconnect(); } catch {} }
  termState.termId = null;
  termState.ws = null;
  termState.xterm = null;
  termState.fitAddon = null;
  termState.resizeObserver = null;
  $('#termContainer').innerHTML = '';
  $('#btnTermClose').style.display = 'none';
  $('#termMeta').textContent = '未打开';
}

$('#btnTerminal')?.addEventListener('click', () => {
  if (termState.termId) {
    showTermArea(); // 已开就切回显示
  } else {
    openTerm(null);
  }
});
$('#btnTermNew')?.addEventListener('click', () => openTerm(null));
$('#btnTermInCwd')?.addEventListener('click', () => openTerm(state.activeCwd || null));
$('#btnTermClose')?.addEventListener('click', async () => {
  await closeTerm();
  toast('终端已关闭', 'info', 1500);
});
$('#btnTermBack')?.addEventListener('click', hideTermArea);

// v0.25 代码块复制 + 折叠（event delegation on #chatOutput）
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.code-copy-btn');
  if (copyBtn) {
    e.stopPropagation();
    const wrap = copyBtn.closest('.code-wrap');
    const code = wrap?.querySelector('pre > code');
    if (code) {
      const text = code.textContent || '';
      navigator.clipboard?.writeText(text).then(() => {
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✓';
        copyBtn.classList.add('copy-success');
        setTimeout(() => {
          copyBtn.textContent = orig;
          copyBtn.classList.remove('copy-success');
        }, 1500);
      }).catch(err => toast('复制失败: ' + err.message, 'error'));
    }
    return;
  }
  const collapseBtn = e.target.closest('.code-collapse-btn');
  if (collapseBtn) {
    e.stopPropagation();
    const wrap = collapseBtn.closest('.code-wrap');
    if (wrap) {
      const nowCollapsed = wrap.classList.toggle('code-collapsed');
      collapseBtn.textContent = nowCollapsed ? '▶' : '▼';
      collapseBtn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
    }
    return;
  }
});

// v0.30 fix: 启动时拉动态版本号写到 brand-subtitle
// v0.46: 同时刷 statusVersion（之前硬编码 v0.6）
(async () => {
  try {
    const r = await api('/api/version');
    const sub = $('#brandSubtitle');
    if (sub && r.version) sub.textContent = `多会话管理 · v${r.version}`;
    const title = $('#brandTitle');
    if (title && r.appName) title.textContent = r.appName;
    const ver = $('#statusVersion');
    if (ver && r.version) ver.textContent = `v${r.version} · ⌘K 命令面板`;
    // v0.50 帮助 tab 也同步版本号
    const aboutVer = $('#aboutVersion');
    if (aboutVer && r.version) aboutVer.textContent = `v${r.version}`;
  } catch {}
})();

// ========== v0.39 多 AI 聊天室 ==========
const roomState = {
  rooms: [],
  activeId: null,
  ws: null,
};

function showRoomArea() {
  $('#mainHeader').style.display = 'none';
  $('#chatArea').style.display = 'none';
  $('#termArea').style.display = 'none';
  $('#pluginArea').style.display = 'none';
  const ov = $('#overviewArea'); if (ov) ov.style.display = 'none';
  $('#roomArea').style.display = 'flex';
}
function hideRoomArea() {
  $('#roomArea').style.display = 'none';
  if (roomState.ws) { try { roomState.ws.close(); } catch {} roomState.ws = null; }
  if (state.activeId) $('#chatArea').style.display = 'flex';
  else $('#mainHeader').style.display = 'flex';
}

async function loadRooms() {
  try {
    const r = await fetch('/api/rooms').then(x => x.json());
    roomState.rooms = r.rooms || [];
    renderRoomList();
    loadArchivedRooms();   // v0.52 同步刷归档
    updateRunningRoomsIndicator();   // v0.52 并发提示
  } catch (e) {
    toast('加载房间失败：' + e.message, 'error');
  }
}

// v0.52 顶部"运行中 N 房"指示器 + 高并发警告
function updateRunningRoomsIndicator() {
  const running = (roomState.rooms || []).filter(r => r.status === 'running').length;
  const el = $('#statusRoomsRunning');
  if (!el) return;
  el.textContent = `🏟 运行中 ${running} 房`;
  if (running >= 5) {
    el.style.color = '#dc2626';
    el.title = `${running} 房同时运行——同账户 LLM 大概率 rate limit。建议错开 model 池或暂停部分房`;
  } else if (running >= 3) {
    el.style.color = '#b45309';
    el.title = `${running} 房同时运行——同账户高并发可能 rate limit。建议错开 Claude/Codex/Gemini 池`;
  } else {
    el.style.color = '';
    el.title = '正在运行的聊天室数（≥3 提示并发限速）';
  }
}

function renderRoomList() {
  const list = $('#roomList');
  if (!list) return;
  list.innerHTML = '';
  for (const r of roomState.rooms) {
    const div = document.createElement('div');
    div.className = 'room-list-item' + (r.id === roomState.activeId ? ' active' : '');
    div.dataset.id = r.id;
    const memberCount = (r.members || []).filter(m => m.enabled !== false).length;
    div.innerHTML = `
      <div class="room-list-item-name">${escapeHtml(r.name || '未命名')}</div>
      <div class="room-list-item-meta">
        <span>${memberCount} 成员</span>
        <span>${r.status === 'running' ? '🟠 讨论中' : r.status === 'done' ? '🟢 完成' : r.status === 'error' ? '🔴 错误' : '⚪ ' + (ROOM_STATUS_ZH[r.status] || '闲置')}</span>
      </div>
      <button class="room-list-item-archive" data-act="archive" title="归档此房间">📦</button>`;
    div.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="archive"]')) return;
      selectRoom(r.id);
    });
    div.querySelector('[data-act="archive"]').addEventListener('click', (e) => {
      e.stopPropagation();
      setRoomArchived(r.id, true);
    });
    list.appendChild(div);
  }
}

// v0.52 房间归档
const _roomArchState = { expanded: false, archived: [] };
async function loadArchivedRooms() {
  try {
    const r = await fetch('/api/rooms?archived=1').then(x => x.json());
    _roomArchState.archived = r.rooms || [];
    renderArchivedRooms();
  } catch {}
}
function renderArchivedRooms() {
  const section = $('#roomArchivedSection');
  const list = $('#roomArchivedList');
  const arr = _roomArchState.archived;
  $('#roomArchivedCount').textContent = arr.length;
  if (arr.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';
  list.style.display = _roomArchState.expanded ? '' : 'none';
  $('#roomArchArrow').textContent = _roomArchState.expanded ? '▼' : '▶';
  list.innerHTML = '';
  for (const r of arr) {
    const archDate = r.archivedAt ? new Date(r.archivedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '';
    const div = document.createElement('div');
    div.className = 'archived-item';
    div.innerHTML = `
      <div class="arch-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name || '未命名')}</div>
      <div class="arch-meta muted small">${(r.members || []).length} 成员 · 归档于 ${archDate}</div>
      <div class="arch-actions">
        <button class="btn-tiny" data-act="restore" title="恢复到活跃列表">↩</button>
        <button class="btn-tiny btn-tiny-danger" data-act="delete" title="彻底删除">🗑</button>
      </div>`;
    div.querySelector('[data-act="restore"]').addEventListener('click', (e) => {
      e.stopPropagation();
      setRoomArchived(r.id, false);
    });
    div.querySelector('[data-act="delete"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmModal('彻底删除房间「' + r.name + '」？', '彻底删除');
      if (!ok) return;
      await fetch(`/api/rooms/${r.id}`, { method: 'DELETE' });
      await loadArchivedRooms();
    });
    list.appendChild(div);
  }
}

async function setRoomArchived(id, archived) {
  try {
    await fetch(`/api/rooms/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived }),
    });
    if (archived && roomState.activeId === id) {
      roomState.activeId = null;
      $('#roomDebate').style.display = 'none';
      $('.room-empty').style.display = '';
    }
    await loadRooms();
    await loadArchivedRooms();
    toast(archived ? '已归档' : '已恢复', 'success', 1500);
  } catch (e) { toast('操作失败：' + e.message, 'error'); }
}

$('#roomArchivedToggle')?.addEventListener('click', () => {
  _roomArchState.expanded = !_roomArchState.expanded;
  $('#roomArchivedToggle').setAttribute('aria-expanded', _roomArchState.expanded ? 'true' : 'false');
  renderArchivedRooms();
});

async function createRoom(mode = 'debate', defaultPartner) {
  const defaultName = mode === 'squad' ? 'AI 团队拆活' : mode === 'chat' ? '单模型聊天' : mode === 'arena' ? '多模型联网核对' : '多模型辩论';
  const name = await promptModal('给房间起个名字', defaultName);
  if (!name) return;
  try {
    const r = await fetch('/api/rooms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mode, defaultPartner }),
    }).then(x => x.json());
    if (r.ok) {
      await loadRooms();
      selectRoom(r.room.id);
    } else {
      toast('创建失败', 'error');
    }
  } catch (e) {
    toast('创建失败：' + e.message, 'error');
  }
}

async function selectRoom(id) {
  roomState.activeId = id;
  if (roomState.ws) { try { roomState.ws.close(); } catch {} roomState.ws = null; }
  renderRoomList();
  const r = await fetch(`/api/rooms/${id}`).then(x => x.json());
  if (!r.ok) return;
  renderRoomDebate(r.room);
  // v0.51 S-27 fix: room WS 自动重连（指数退避，最多 5 次）
  roomState.wsReconnectAttempts = 0;
  attachRoomWS(id);
}
function attachRoomWS(id) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/room/${id}`);
  roomState.ws = ws;
  ws.onmessage = ev => {
    try { handleRoomEvent(JSON.parse(ev.data)); } catch {}
  };
  ws.onopen = () => { roomState.wsReconnectAttempts = 0; };
  ws.onclose = () => {
    if (roomState.ws === ws) roomState.ws = null;
    // 用户切走或会话被删则不重连
    if (roomState.activeId !== id) return;
    roomState.wsReconnectAttempts = (roomState.wsReconnectAttempts || 0) + 1;
    if (roomState.wsReconnectAttempts > 5) {
      toast('房间 WS 连接丢失（重试 5 次），请重新打开房间', 'error', 5000);
      return;
    }
    const delay = Math.min(8000, 800 * Math.pow(2, roomState.wsReconnectAttempts - 1));
    setTimeout(() => { if (roomState.activeId === id) attachRoomWS(id); }, delay);
  };
}

// v0.47 模型清单（每个 adapter 可选模型 + 默认/自定义）
// 来源：claude --help 实测接受别名+全名；codex exec -m 实测 gpt-5.5 可用；系统知识库提示 Claude 4.X 是当前最新
const MODEL_OPTIONS = {
  claude: [
    '',                       // 默认（CLI 自己决定）
    'opus',                   // 别名 = claude-opus-4-7
    'sonnet',                 // 别名 = claude-sonnet-4-6
    'haiku',                  // 别名 = claude-haiku-4-5
    'claude-opus-4-7',        // 全名精确锁版本
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ],
  codex: [
    '',                       // 默认（用户 config.toml 决定，当前 gpt-5.5）
    'gpt-5.5',                // 当前默认/最新
    'gpt-5',
    'gpt-5-codex',
    'o3',
    'o3-mini',
  ],
  ollama: [
    '',
    'gemma3:4b',
    'qwen2.5:7b',
    'llama3.2:3b',
    'gpt-oss:20b',
  ],
  minimax: [
    '',
    'MiniMax-M2.7',           // 2026 最新
    'MiniMax-M2.6',
    'MiniMax-M2',
    'abab7-chat',
    'abab6.5s-chat',
  ],
  ccr: [
    '',                       // CCR 自己路由（推荐留默认）
    'opus',
    'sonnet',
    'haiku',
  ],
  // v0.56 U11 Gemini 三种入口（2026-05-20 实测）：
  // ✅ 实测可用：3.1-pro-preview / 3.1-flash-lite / 3-flash-preview
  // 🆕 新 stable：3.5-flash（文档已上 stable，gemini CLI 0.42 暂未识别，HTTP 直连可能可用）
  // 关停：3 Pro Preview（2026-03 已下线）
  gemini: [
    '',
    'gemini-3.5-flash',                       // 🆕 2026-05 最新 stable flash（CLI 0.42 暂未识别，HTTP 端点优先试）
    'gemini-3.1-pro-preview',                 // 最强 pro（preview）
    'gemini-3.1-pro-preview-customtools',     // 带 bash+tools 变体（agent 场景）
    'gemini-3.1-flash-lite',                  // ✅ 实测可用 stable
    'gemini-3.1-flash-lite-preview',
    'gemini-3.1-flash-image-preview',         // 🆕 图像生成
    'gemini-3.1-flash-live-preview',          // 🆕 实时对话
    'gemini-3-flash-preview',                 // ✅ 实测可用
    'gemini-2.5-pro',                         // 2.5 系列 stable
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ],
  'gemini-openai': [
    '',
    'google/gemini-3.5-flash',                // 🆕 OpenRouter 前缀
    'google/gemini-3.1-pro-preview',
    'google/gemini-3.1-flash-lite',
    'google/gemini-3-flash-preview',
    'gemini-3.5-flash',                       // 直连 Google OpenAI 兼容 endpoint 不带前缀
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite',
  ],
  'gemini-cli': [
    '',
    'gemini-3.5-flash',                       // 🆕（CLI 0.42 报 ModelNotFoundError，等 CLI 升级）
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ],
};

function renderRoomDebate(room) {
  $('#roomDebate').style.display = 'flex';
  $('.room-empty').style.display = 'none';
  $('#roomNameDisplay').textContent = (room.name || '未命名') + (
    room.mode === 'squad' ? '  · 团队拆活' :
    room.mode === 'chat'  ? '  · 单聊'  :
    room.mode === 'arena' ? '  · 联网核对'  :
    '  · 辩论'
  );
  $('#roomTopicInput').value = room.topic || '';
  updateRoomStatusChip(room.status);
  renderRoomMembers(room);
  // v0.41/v0.48 按 mode 切换视图
  const isSquad = room.mode === 'squad';
  const isChat = room.mode === 'chat';
  $('#squadBoard').style.display = isSquad ? 'flex' : 'none';
  $('#roomRounds').style.display = (isSquad || isChat) ? 'none' : 'flex';
  $('#chatRoom').style.display = isChat ? 'flex' : 'none';
  // chat 模式隐藏任务输入区（chat 直接在底部输入框）
  const topicWrap = document.querySelector('.room-topic-wrap');
  if (topicWrap) topicWrap.style.display = isChat ? 'none' : 'flex';
  // v0.52 大轮数控件仅 debate 模式显示，并回填 room.debateRounds
  const roundsWrap = $('#roomDebateRoundsWrap');
  const roundsInput = $('#roomDebateRoundsInput');
  if (roundsWrap) roundsWrap.style.display = (!isSquad && !isChat) ? 'flex' : 'none';
  if (roundsInput) {
    let n = parseInt(room.debateRounds, 10);
    if (!Number.isFinite(n)) n = 2;
    n = Math.max(1, Math.min(10, n));
    roundsInput.value = String(n);
  }
  // 启动按钮文案：debate / arena / squad
  const isArena = room.mode === 'arena';
  const startBtn = $('#btnRoomStart');
  if (startBtn) {
    if (isSquad) startBtn.textContent = '🚀 启动小组';
    else if (isArena) startBtn.textContent = '🏟 启动对决';
    else if (!isChat) startBtn.textContent = `🚀 启动辩论（${roundsInput?.value || 2} 大轮）`;
  }
  // arena 房不需要"大轮数"控件
  if (roundsWrap && isArena) roundsWrap.style.display = 'none';
  // v0.42 QA 严格度下拉，仅 squad 房显示
  const qaLabel = $('#qaStrictLabel');
  if (qaLabel) {
    qaLabel.style.display = isSquad ? 'inline-flex' : 'none';
    const sel = $('#qaStrictSelect');
    if (sel) sel.value = room.qaStrictness || 'standard';
  }
  if (isChat) {
    renderChatRoom(room);
    $('#roomConsensusHead').textContent = '';
    $('#roomConsensus').style.display = 'none';
  } else if (isSquad) {
    renderSquadKanban(room.taskList || []);
    $('#roomConsensusHead').textContent = '🎯 最终交付（PM 总结）';
  } else if (isArena) {
    renderRounds(room.rounds || []);
    $('#roomConsensusHead').textContent = '🌐 统一最优意见（已联网核对）';
  } else {
    renderRounds(room.rounds || []);
    $('#roomConsensusHead').textContent = '🎯 最终共识方案（Claude 主持）';
  }
  if (room.finalConsensus) {
    $('#roomConsensus').style.display = 'flex';
    // v0.45 P2: 读 finalDegraded 字段加 banner
    const degradedBadge = room.finalDegraded ? '<div class="final-degraded-badge">⚠️ Judge 失败，下面是 R3 三方终稿降级合并</div>' : '';
    $('#roomConsensusBody').innerHTML = degradedBadge + renderMarkdown(room.finalConsensus);
  } else {
    $('#roomConsensus').style.display = 'none';
  }
}

// v0.52 房间 adapter providers 缓存（GET /api/room-adapters/providers）
let roomProvidersCache = [];
async function refreshRoomProviders() {
  try {
    const r = await fetch('/api/room-adapters/providers').then(x => x.json());
    if (r?.ok && Array.isArray(r.providers)) roomProvidersCache = r.providers;
  } catch {}
}
refreshRoomProviders();

function renderRoomMembers(room) {
  const wrap = $('#roomMembers');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const [idx, m] of (room.members || []).entries()) {
    const chip = document.createElement('div');
    chip.className = 'room-member-chip' + (m.enabled === false ? ' disabled' : '');
    chip.dataset.idx = idx;

    // v0.52 adapter id 下拉（让用户切到 gemini / minimax / custom:xxx 等）
    const adapterSel = document.createElement('select');
    adapterSel.title = '切换 adapter（claude/codex/ollama/gemini/...）';
    adapterSel.className = 'room-member-adapter';
    const providers = roomProvidersCache.length > 0 ? roomProvidersCache : [{ id: m.adapterId, displayName: m.adapterId }];
    // 若当前 adapterId 不在 providers 缓存里（例如配置变化后），仍保留一项以免显示空
    const hasCurrent = providers.some(p => p.id === m.adapterId);
    const finalProviders = hasCurrent ? providers : [{ id: m.adapterId, displayName: m.adapterId + ' (未注册)' }, ...providers];
    for (const p of finalProviders) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.displayName || p.id;
      if (p.id === m.adapterId) o.selected = true;
      adapterSel.appendChild(o);
    }
    adapterSel.addEventListener('change', () => {
      const newId = adapterSel.value;
      const provider = roomProvidersCache.find(p => p.id === newId);
      // 切 adapter 时同步 displayName + 清掉 model（新 adapter 的 MODEL_OPTIONS 可能不同）
      updateMember(idx, { adapterId: newId, displayName: provider?.displayName || newId, model: '' });
    });

    // v0.52 model 改成 input + datalist：允许自由填新型号（MiniMax-M2.7 / gemini-3-pro 等）
    const opts = MODEL_OPTIONS[m.adapterId] || [];
    const listId = `models-${m.adapterId.replace(/[^a-z0-9-]/gi, '_')}-${idx}`;
    const dataList = document.createElement('datalist');
    dataList.id = listId;
    for (const opt of opts) {
      if (!opt) continue;
      const o = document.createElement('option');
      o.value = opt;
      dataList.appendChild(o);
    }
    const select = document.createElement('input');
    select.type = 'text';
    select.className = 'room-member-model';
    select.setAttribute('list', listId);
    select.value = m.model || '';
    select.placeholder = '默认';
    select.title = '模型名（自由输入，预置清单仅作提示）';
    select.addEventListener('change', () => updateMember(idx, { model: select.value.trim() }));
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'room-member-toggle';
    toggleBtn.textContent = m.enabled === false ? '✓' : '✕';
    toggleBtn.title = m.enabled === false ? '启用' : '关闭';
    toggleBtn.addEventListener('click', () => updateMember(idx, { enabled: !(m.enabled !== false) }));
    const roleBadge = m.role ? `<span class="room-member-role ${m.role}">${m.role}</span>` : '';
    chip.innerHTML = `${roleBadge}<span>${escapeHtml(m.displayName)}</span>`;
    chip.appendChild(adapterSel);
    chip.appendChild(select);
    chip.appendChild(dataList);
    chip.appendChild(toggleBtn);
    // v0.52 移除按钮（让用户能精简成员）
    const removeBtn = document.createElement('button');
    removeBtn.className = 'room-member-toggle';
    removeBtn.textContent = '🗑';
    removeBtn.title = '移除该成员';
    removeBtn.addEventListener('click', () => removeMember(idx));
    chip.appendChild(removeBtn);
    wrap.appendChild(chip);
  }
  // v0.52 ＋ 加成员
  const addChip = document.createElement('button');
  addChip.className = 'room-member-chip room-member-add';
  addChip.textContent = '＋ 加成员';
  addChip.title = '从已注册 adapter 中挑一个加入（可在 ⚙️ adapter 配置里启用 Gemini/MiniMax/自定义）';
  addChip.addEventListener('click', () => addRoomMember());
  wrap.appendChild(addChip);
}

async function updateMember(idx, patch) {
  if (!roomState.activeId) return;
  const r = await fetch(`/api/rooms/${roomState.activeId}`).then(x => x.json());
  if (!r.ok) return;
  const members = [...(r.room.members || [])];
  if (!members[idx]) return;
  members[idx] = { ...members[idx], ...patch };
  const u = await fetch(`/api/rooms/${roomState.activeId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ members }),
  }).then(x => x.json());
  if (u.ok) renderRoomMembers(u.room);
}

async function removeMember(idx) {
  if (!roomState.activeId) return;
  const r = await fetch(`/api/rooms/${roomState.activeId}`).then(x => x.json());
  if (!r.ok) return;
  const members = [...(r.room.members || [])];
  if (members.length <= 1) { toast('至少保留 1 个成员', 'warn'); return; }
  members.splice(idx, 1);
  const u = await fetch(`/api/rooms/${roomState.activeId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ members }),
  }).then(x => x.json());
  if (u.ok) renderRoomMembers(u.room);
}

async function addRoomMember() {
  if (!roomState.activeId) return;
  if (roomProvidersCache.length === 0) await refreshRoomProviders();
  if (roomProvidersCache.length === 0) { toast('暂无可用 adapter（点 ⚙️ 配置 Gemini/MiniMax/自定义）', 'warn'); return; }
  // S19 B3：原 native prompt() blocking 改 promptModal；lines 用 ' / ' 单行显示，CSS word-break 自动 wrap
  const lines = roomProvidersCache.map((p, i) => `${i + 1}.${p.displayName || p.id}`).join(' / ');
  const sel = await promptModal({
    title: '加成员：选 adapter',
    message: `${lines}（输入序号 1-${roomProvidersCache.length}）`,
    value: '1',
  });
  if (sel == null) return;
  const idx = parseInt(sel, 10) - 1;
  const provider = roomProvidersCache[idx];
  if (!provider) { toast('无效序号', 'error'); return; }
  const r = await fetch(`/api/rooms/${roomState.activeId}`).then(x => x.json());
  if (!r.ok) return;
  const members = [...(r.room.members || [])];
  members.push({ adapterId: provider.id, displayName: provider.displayName || provider.id, model: '', enabled: true });
  const u = await fetch(`/api/rooms/${roomState.activeId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ members }),
  }).then(x => x.json());
  if (u.ok) renderRoomMembers(u.room);
  else toast('加成员失败：' + (u.error || ''), 'error');
}

// v0.52 状态翻译表
const ROOM_STATUS_ZH = {
  idle: '闲置', running: '进行中', paused: '已暂停', done: '已完成', error: '出错',
  auto_paused: '🛑 自动暂停',
};

// v0.52 elapsed 计时器（辩论 turn placeholder + 小组 task 卡片共用）
let _elapsedTimer = null;
// S24 minimum: formatElapsed 主实现挪到 src/web/utils.js
function formatElapsed(sec) {
  if (window.PanelUtils && window.PanelUtils.formatElapsed) return window.PanelUtils.formatElapsed(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function startElapsedTicker() {
  if (_elapsedTimer) return;
  _elapsedTimer = setInterval(() => {
    const targets = document.querySelectorAll('[data-elapsed="1"]');
    if (targets.length === 0) { clearInterval(_elapsedTimer); _elapsedTimer = null; return; }
    const now = Date.now();
    for (const el of targets) {
      const parent = el.closest('[data-started-at]') || el.parentElement?.closest('[data-started-at]');
      if (!parent) continue;
      const start = parseInt(parent.dataset.startedAt || '0', 10);
      if (!start) continue;
      const sec = Math.floor((now - start) / 1000);
      const label = el.dataset.label || '思考中';
      el.textContent = `⏳ ${label}… ${formatElapsed(sec)}`;
      // v0.52 卡死检测：60s 无 stdout 进度变红
      const lastProg = parseInt(parent.dataset.lastProgressAt || '0', 10);
      if (lastProg > 0) {
        const idleSec = Math.floor((now - lastProg) / 1000);
        if (idleSec >= 60 && !parent.classList.contains('stalled')) {
          parent.classList.add('stalled');
          const progEl = parent.querySelector('.room-turn-progress');
          if (progEl) {
            progEl.textContent = `⚠️ ${idleSec}s 无新输出（疑似卡住，可点 ⏹ 立即结束）`;
            progEl.style.color = '#dc2626';
          }
        } else if (parent.classList.contains('stalled')) {
          const progEl = parent.querySelector('.room-turn-progress');
          if (progEl) progEl.textContent = `⚠️ ${idleSec}s 无新输出（疑似卡住，可点 ⏹ 立即结束）`;
        }
      }
    }
  }, 1000);
}
function maybeStopElapsedTicker() {
  // 若 DOM 里没有 data-elapsed 元素，停止 ticker（省 CPU）
  if (document.querySelector('[data-elapsed="1"]')) return;
  if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
}
function updateRoomStatusChip(status) {
  const chip = $('#roomStatusChip');
  const s = status || 'idle';
  chip.className = 'room-status-chip ' + s;
  chip.textContent = ROOM_STATUS_ZH[s] || s;
  $('#btnRoomAbort').style.display = s === 'running' ? 'inline-flex' : 'none';

  // v0.52 paused/error 显示"重启"；只有 debate/squad 支持"续跑"
  // v0.53 Sprint 3.5：auto_paused 也算 paused 状态，可续跑/重启
  const isPausedOrError = (s === 'paused' || s === 'error' || s === 'auto_paused');
  const activeRoom = (roomState.rooms || []).find(rr => rr.id === roomState.activeId);
  const supportsResume = activeRoom && (activeRoom.mode === 'debate' || activeRoom.mode === 'squad');
  const r = $('#btnRoomResume'); if (r) r.style.display = (isPausedOrError && supportsResume) ? 'inline-flex' : 'none';
  const rr = $('#btnRoomRestart'); if (rr) rr.style.display = isPausedOrError ? 'inline-flex' : 'none';

  // v0.54 Sprint 4.1：状态变化时 toggle 所有 turn 卡 retry 按钮（避免 running 时点了被后端拒）
  const isRunning = s === 'running';
  document.querySelectorAll('#roomRounds .room-turn-retry').forEach((btn) => {
    if (isRunning) {
      btn.disabled = true;
      btn.textContent = '⏸ 等房暂停';
      btn.title = '房间正在跑后续 round，等跑完或手动暂停后再重试';
    } else if (btn.disabled) {
      btn.disabled = false;
      btn.textContent = '🔄 重试这个';
      btn.title = '只重跑这一个 AI，不影响其他成员';
    }
  });
}

// v0.52 全局 Esc：聊天室区域可见时按 Esc 触发结束
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // 仅当房间区域可见 + 当前房 status=running 时生效
  const roomArea = $('#roomArea');
  if (!roomArea || roomArea.style.display === 'none') return;
  const abortBtn = $('#btnRoomAbort');
  if (!abortBtn || abortBtn.style.display === 'none') return;
  // 输入框焦点时不抢（Esc 让用户取消输入）
  const t = document.activeElement;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
  e.preventDefault();
  abortDebate();
});

// v0.52 兼容 kind 带 `@<n>` 后缀（多大轮 debate）；老房间 kind 无后缀按大轮 1 渲染
const ROUND_TITLES = {
  r1_propose: '第 1 阶段 · 独立提案',
  r2_critique: '第 2 阶段 · 互评修订',
  r3_final: '第 3 阶段 · 终稿表态',
  r4_judge: '主持总结',
  proposals: '🏟 各方独立提案（匿名）',     // v0.52 Sprint1-A Arena
  arena_judge: '🌐 联网核对 + 综合最优',
};
function getRoundTitle(kind) {
  const m = /^(r[123])_(propose|critique|final)@(\d+)$/.exec(kind);
  if (m) {
    const base = `${m[1]}_${m[2]}`;
    return `第 ${m[3]} 大轮 · ${ROUND_TITLES[base] || base}`;
  }
  // 老 kind：r1_propose / r2_critique / r3_final / r4_judge
  return ROUND_TITLES[kind] || kind;
}

function renderRounds(rounds) {
  const wrap = $('#roomRounds');
  wrap.innerHTML = '';
  for (const round of rounds) {
    const card = document.createElement('div');
    card.className = 'room-round';
    card.dataset.kind = round.kind;
    card.innerHTML = `
      <div class="room-round-head">${escapeHtml(getRoundTitle(round.kind))}</div>
      <div class="room-round-cards"></div>`;
    const cardsWrap = card.querySelector('.room-round-cards');
    for (const t of (round.turns || [])) cardsWrap.appendChild(renderTurnCard(t, round.kind));
    wrap.appendChild(card);
  }
}

// v0.54 Sprint 4.1：拿当前 active room status（从 chip className 读，跟 WS 实时同步）
function getCurrentRoomStatus() {
  const chip = $('#roomStatusChip');
  if (!chip) return null;
  // className 形如 "room-status-chip running"
  const m = chip.className.match(/\b(idle|running|paused|done|error|auto_paused)\b/);
  return m ? m[1] : null;
}

function renderTurnCard(turn, kind) {
  const div = document.createElement('div');
  div.className = 'room-turn-card' + (turn.error ? ' error' : '');
  div.dataset.speaker = turn.speaker;
  // v0.52 Sprint1-D error 卡片右上加重试按钮
  // v0.54 Sprint 4.1：房间 running 时按钮 disabled + 解释（dispatcher 不允许 running 状态局部重试，防数据竞争）
  const isRunning = getCurrentRoomStatus() === 'running';
  const retryBtn = turn.error
    ? (isRunning
        ? `<button class="room-turn-retry" disabled title="房间正在跑后续 round，等跑完或手动暂停后再重试">⏸ 等房暂停</button>`
        : `<button class="room-turn-retry" data-kind="${escapeHtml(kind || '')}" data-speaker="${escapeHtml(turn.speaker)}" title="只重跑这一个 AI，不影响其他成员">🔄 重试这个</button>`)
    : '';
  div.innerHTML = `
    <div class="room-turn-head">
      <span class="room-turn-speaker">${escapeHtml(turn.displayName)}</span>
      ${turn.tokensOut ? `<span class="room-turn-tokens">${turn.tokensOut} tok</span>` : ''}
      ${retryBtn}
      <button class="room-turn-expand" title="全屏展开看完整内容">⤢</button>
    </div>
    <div class="room-turn-content"></div>`;
  div.querySelector('.room-turn-content').innerHTML = renderMarkdown(turn.content || '');
  const btn = div.querySelector('.room-turn-retry');
  if (btn) btn.addEventListener('click', (e) => {
    e.stopPropagation();
    retryTurn(btn.dataset.kind, btn.dataset.speaker);
  });
  return div;
}

async function retryTurn(kind, speaker) {
  if (!roomState.activeId) return;
  try {
    const r = await fetch(`/api/rooms/${roomState.activeId}/retry-turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, speaker }),
    }).then(x => x.json());
    if (r?.ok) toast('已重试，等待新输出…', 'info', 2000);
    else toast('重试失败：' + (r?.error || ''), 'error');
  } catch (e) { toast('重试失败：' + e.message, 'error'); }
}

function ensureRoundCard(kind) {
  // v0.52 kind 可能含 `@`（如 r1_propose@2），用 CSS.escape 安全选属性
  const safeKind = (window.CSS && CSS.escape) ? CSS.escape(kind) : kind;
  let card = $(`#roomRounds .room-round[data-kind="${safeKind}"]`);
  if (!card) {
    const wrap = $('#roomRounds');
    card = document.createElement('div');
    card.className = 'room-round';
    card.dataset.kind = kind;
    card.innerHTML = `
      <div class="room-round-head">${escapeHtml(getRoundTitle(kind))}</div>
      <div class="room-round-cards"></div>`;
    wrap.appendChild(card);
  }
  return card.querySelector('.room-round-cards');
}

// ===== v0.41 Squad Kanban 渲染 + 详情抽屉 =====
const SQUAD_COLS = ['pending', 'in_progress', 'in_review', 'done', 'escalated'];
let squadCurrentTasks = []; // 缓存最新 taskList 用于抽屉
// v0.52 task 进入 in_progress/in_review 的起始时间（看板 elapsed 计时用）
const _squadTaskStartedAt = new Map(); // taskId → { phase: 'dev'|'qa', start: Date.now(), who: 'Claude' }

function renderSquadKanban(taskList) {
  squadCurrentTasks = taskList || [];
  for (const status of SQUAD_COLS) {
    const col = $('#squadCol' + status.split('_').map(s => s[0].toUpperCase() + s.slice(1)).join(''));
    if (!col) continue;
    col.innerHTML = '';
  }
  for (const t of squadCurrentTasks) {
    const col = $('#squadCol' + t.status.split('_').map(s => s[0].toUpperCase() + s.slice(1)).join(''));
    if (!col) continue;
    const card = document.createElement('div');
    card.className = 'squad-task-card ' + t.status;
    card.dataset.id = t.id;
    const reviewCount = (t.reviews || []).length;
    const lastReject = (t.reviews || []).filter(r => r.verdict === 'reject').length;

    // v0.52 实时状态：in_progress 显示"🧑‍💻 谁 实现中 elapsed"；in_review 显示"🔍 谁 审查中 elapsed"
    let liveBadge = '';
    const tick = _squadTaskStartedAt.get(t.id);
    if (t.status === 'in_progress' && tick?.phase === 'dev') {
      card.dataset.startedAt = String(tick.start);
      liveBadge = `<span class="squad-task-live" data-elapsed="1" data-label="${escapeHtml(tick.who || 'Dev')} 实现中">⏳ ${escapeHtml(tick.who || 'Dev')} 实现中… 00:00</span>`;
      startElapsedTicker();
    } else if (t.status === 'in_review' && tick?.phase === 'qa') {
      card.dataset.startedAt = String(tick.start);
      liveBadge = `<span class="squad-task-live" data-elapsed="1" data-label="${escapeHtml(tick.who || 'QA')} 审查中">⏳ ${escapeHtml(tick.who || 'QA')} 审查中… 00:00</span>`;
      startElapsedTicker();
    } else if (t.status === 'escalated' && t.escalateReason) {
      liveBadge = `<span class="squad-task-live error">⚠️ ${escapeHtml(t.escalateReason)}</span>`;
    } else if (t.status === 'done') {
      liveBadge = `<span class="squad-task-live ok">✅ 已完成</span>`;
    }

    // v0.54 Sprint 6：escalated task 卡片显示「🔄 重试此任务」按钮（仅房非 running 时可点）
    const isRunning = getCurrentRoomStatus() === 'running';
    const retryBtn = t.status === 'escalated'
      ? (isRunning
          ? `<button class="squad-task-retry" disabled title="房间正在跑后续 task，先 ⏹ 暂停再重试">⏸ 等房暂停</button>`
          : `<button class="squad-task-retry" data-task-id="${escapeHtml(t.id)}" title="reset 此 task + 连带被牵连的下游 task，自动 resume 接着跑">🔄 重试此任务</button>`)
      : '';

    card.innerHTML = `
      <span class="squad-task-id">${escapeHtml(t.id)}</span>
      <span class="squad-task-title">${escapeHtml(t.title || '')}</span>
      ${liveBadge}
      <span class="squad-task-meta">
        <span class="iter">迭代 ${t.iterations || 0}/${t.maxIterations || 5}</span>
        ${reviewCount ? `<span>📝 ${reviewCount} 次审查</span>` : ''}
        ${lastReject ? `<span style="color:#dc2626;">↩️ 打回 ${lastReject}</span>` : ''}
        ${(t.dependencies || []).length ? `<span>依赖 ${t.dependencies.join('/')}</span>` : ''}
      </span>
      ${retryBtn}`;
    card.addEventListener('click', () => openSquadDetail(t.id));
    // 阻止重试按钮点击冒泡到 card（避免打开 detail drawer）
    card.querySelector('.squad-task-retry')?.addEventListener('click', (e) => {
      e.stopPropagation();
      retrySquadTask(t.id);
    });
    col.appendChild(card);
  }
}

async function retrySquadTask(taskId) {
  if (!roomState.activeId) return;
  if (!confirm(`重试 task "${taskId}"？\n\n会同时 reset 所有被它牵连的下游 task（状态变 pending）。`)) return;
  try {
    const r = await fetch(`/api/rooms/${roomState.activeId}/retry-task`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    }).then(x => x.json());
    if (r.ok) toast(`已开始重试 ${taskId}，等待 dispatcher 重新调度…`, 'info', 3000);
    else toast('重试失败：' + (r.error || 'unknown'), 'error');
  } catch (e) { toast('重试失败：' + e.message, 'error'); }
}

function openSquadDetail(taskId) {
  const t = squadCurrentTasks.find(x => x.id === taskId);
  if (!t) return;
  let drawer = $('#squadTaskDetail');
  if (!drawer) {
    drawer = document.createElement('div');
    drawer.id = 'squadTaskDetail';
    drawer.className = 'squad-task-detail hidden';
    document.body.appendChild(drawer);
  }
  const injectionsHtml = (t.userInjections || []).length
    ? `<div class="squad-injections"><b>已注入提示</b>：<ul>${(t.userInjections || []).map(i => `<li>[${(i.at || '').slice(11,19)}] ${escapeHtml(i.content)}</li>`).join('')}</ul></div>`
    : '';
  const canInject = t.status !== 'done';
  drawer.innerHTML = `
    <div class="squad-task-detail-head">
      <h3>${escapeHtml(t.id)} · ${escapeHtml(t.title || '')}</h3>
      <button class="close-btn" id="squadDetailClose" aria-label="关闭任务详情" title="关闭（ESC）">✕</button>
    </div>
    <div><b>描述</b>：${escapeHtml(t.desc || '')}</div>
    <div><b>负责</b>：${escapeHtml(t.assigneeId)} · <b>审查</b>：${escapeHtml(t.reviewerId)}</div>
    <div><b>状态</b>：${escapeHtml(t.status)} · <b>迭代</b>：${t.iterations || 0}/${t.maxIterations || 5}</div>
    ${(t.dependencies || []).length ? `<div><b>依赖</b>：${t.dependencies.map(escapeHtml).join(', ')}</div>` : ''}
    ${injectionsHtml}
    ${canInject ? `<div class="squad-inject-wrap">
      <label class="squad-inject-label">📨 给本 task 追加指示（Dev 下次重做时会看到，QA 死循环时尤其有用）</label>
      <textarea id="squadInjectInput" rows="2" placeholder="例：把方括号改成花括号；或：用 enumerate 不要 range"></textarea>
      <button class="cxbtn cxbtn-primary cxbtn-sm" id="squadInjectBtn">注入指示</button>
    </div>` : ''}
    <hr/>
    <div><b>历史</b></div>
    <div id="squadTaskTimeline"></div>
  `;
  const tl = drawer.querySelector('#squadTaskTimeline');
  const events = [];
  (t.attempts || []).forEach((a, i) => events.push({ kind: 'attempt', i: i + 1, at: a.at, by: a.by, content: a.content, error: a.error }));
  (t.reviews || []).forEach((r, i) => events.push({ kind: 'review', i: i + 1, at: r.at, by: r.by, ...r }));
  events.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  for (const ev of events) {
    const div = document.createElement('div');
    if (ev.kind === 'attempt') {
      div.className = 'squad-attempt';
      // v0.70.2-t5: 第 2+ 次 attempt 加"对比上次"按钮（W8 squad-diff-preview）
      const diffBtnHtml = ev.i >= 2
        ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-attempt-diff="${ev.i - 1}-${ev.i}" data-task-id="${escapeHtml(t.id)}" title="对比第 ${ev.i - 1} 次和第 ${ev.i} 次的内容差异">📐 对比上次</button>`
        : '';
      div.innerHTML = `<div class="squad-attempt-head">🔨 第 ${ev.i} 次提交 · ${escapeHtml(ev.by)} · ${ev.at?.slice(11, 19) || ''} ${diffBtnHtml}</div>${renderMarkdown(ev.content || '')}`;
    } else {
      div.className = 'squad-review ' + (ev.verdict === 'pass' ? 'pass' : 'reject');
      div.innerHTML = `<div class="squad-review-head">${ev.verdict === 'pass' ? '✅ 通过' : '❌ 打回'} · ${escapeHtml(ev.by)} · ${ev.at?.slice(11, 19) || ''} · 置信度 ${(ev.confidence || 0).toFixed(2)}</div>
        ${ev.reasoning ? `<div><b>结论</b>：${escapeHtmlMl(ev.reasoning)}</div>` : ''}
        ${(ev.issues || []).length ? `<div><b>问题</b>：<ul>${ev.issues.map(it => '<li>' + escapeHtmlMl(it) + '</li>').join('')}</ul></div>` : ''}
        ${(ev.suggestions || []).length ? `<div><b>建议</b>：<ul>${ev.suggestions.map(it => '<li>' + escapeHtmlMl(it) + '</li>').join('')}</ul></div>` : ''}`;
    }
    tl.appendChild(div);
  }
  drawer.classList.remove('hidden');
  drawer.querySelector('#squadDetailClose').addEventListener('click', () => drawer.classList.add('hidden'));
  // v0.70.2-t5: attempt 对比按钮
  drawer.querySelectorAll('[data-attempt-diff]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const [fromStr, toStr] = btn.dataset.attemptDiff.split('-');
      const tid = btn.dataset.taskId;
      const roomId = roomState.activeId;
      if (!roomId || !tid) return;
      try {
        const r = await fetch(`/api/rooms/${roomId}/tasks/${tid}/diff?from=${parseInt(fromStr) - 1}&to=${parseInt(toStr) - 1}`).then(x => x.json());
        if (!r.ok) { toast('对比失败：' + (r.error || ''), 'error'); return; }
        if (!r.diff) { toast(r.reason || 'attempt 不足', 'warn'); return; }
        const d = r.diff;
        await confirmModal({
          title: `📐 attempt ${fromStr} → ${toStr} 对比（+${d.added}/-${d.removed} 行）`,
          message: d.unified || '(无差异)',
          confirmLabel: '关闭', cancelLabel: '',
        });
      } catch (e) { toast('异常：' + e.message, 'error'); }
    });
  });
  const injectBtn = drawer.querySelector('#squadInjectBtn');
  if (injectBtn) {
    injectBtn.addEventListener('click', async () => {
      const input = drawer.querySelector('#squadInjectInput');
      const content = (input?.value || '').trim();
      if (!content) { toast('先填指示内容', 'warn'); return; }
      try {
        const r = await fetch(`/api/rooms/${roomState.activeId}/tasks/${taskId}/inject`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        }).then(x => x.json());
        if (r.ok) {
          toast(`已注入：${content.slice(0, 30)}${content.length > 30 ? '…' : ''}`, 'success', 2500);
          input.value = '';
          await pullRoomAndRender();
          openSquadDetail(taskId); // 重渲染
        } else {
          toast('注入失败：' + (r.error || ''), 'error');
        }
      } catch (e) { toast('注入失败：' + e.message, 'error'); }
    });
  }
}

// ===== v0.48 Chat 房 1v1 渲染 =====
function renderChatRoom(room) {
  const msgWrap = $('#chatRoomMessages');
  if (!msgWrap) return;
  msgWrap.innerHTML = '';
  const conv = room.conversation || [];
  if (conv.length === 0) {
    const enabled = (room.members || []).find(m => m.enabled !== false);
    msgWrap.innerHTML = `<div class="chat-room-empty">和 <b>${escapeHtml(enabled?.displayName || '?')}</b> 开始 1v1 对话。<br>
      下面输入框输入消息，⌘+Enter 或点 [发送] 即可。<br>
      <span style="font-size:11px;">注：模型有 shell + 文件系统权限，可让它真去做任务（如写文件 / 跑命令 / 查 API）</span></div>`;
    return;
  }
  for (const m of conv) {
    msgWrap.appendChild(buildChatMessageEl(m));
  }
  // 滚到底
  msgWrap.scrollTop = msgWrap.scrollHeight;
}

function buildChatMessageEl(m) {
  const div = document.createElement('div');
  const isUser = m.from === 'user';
  // v0.54 Sprint 5.5：forward 注入的结论 context 加专属 class
  const isForwardCtx = m.fromForward === true || m.from === 'forward-context';
  div.className = 'chat-room-msg'
    + (isUser ? ' user' : '')
    + (m.error ? ' error' : '')
    + (m.thinking ? ' chat-room-msg-thinking' : '')
    + (isForwardCtx ? ' chat-room-msg-forward-ctx' : '');
  if (m.thinking) div.dataset.thinking = '1';
  const time = m.at ? new Date(m.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const avatar = isUser ? '👤' : (isForwardCtx ? '📌' : (m.displayName?.match(/\p{Emoji}/u)?.[0] || '🤖'));
  const name = isUser ? '我' : (m.displayName || m.from);
  const badge = isForwardCtx ? '<span class="chat-room-forward-badge">上轮结论 · 自动作为对话 context</span>' : '';
  div.innerHTML = `
    <div class="chat-room-msg-avatar">${avatar}</div>
    <div>
      <div class="chat-room-msg-bubble"></div>
      <div class="chat-room-msg-meta">${escapeHtml(name)} · ${time}${m.tokensOut ? ' · ' + m.tokensOut + ' tok' : ''}${badge}</div>
    </div>`;
  div.querySelector('.chat-room-msg-bubble').innerHTML = m.thinking
    ? '思考中…'
    : (isUser ? escapeHtml(m.content || '').replace(/\n/g, '<br>') : renderMarkdown(m.content || ''));
  return div;
}

async function sendChatMessage() {
  const input = $('#chatRoomInput');
  const text = (input?.value || '').trim();
  if (!text) return;
  if (!roomState.activeId) return;
  input.value = '';
  $('#btnChatAbort').style.display = 'inline-flex';
  try {
    const r = await fetch(`/api/rooms/${roomState.activeId}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then(x => x.json());
    if (!r.ok) toast('发送失败：' + (r.error || ''), 'error');
  } catch (e) {
    toast('发送失败：' + e.message, 'error');
  }
}

async function abortChat() {
  if (!roomState.activeId) return;
  await fetch(`/api/rooms/${roomState.activeId}/abort`, { method: 'POST' });
  $('#btnChatAbort').style.display = 'none';
}

function handleRoomEvent(msg) {
  if (msg.type === 'connected') {
    if (msg.room) renderRoomDebate(msg.room);
    return;
  }
  // v0.70.2 W5+W6：debate state machine 元数据 → inspector tab 渲染
  if (msg.type === 'debate_state_meta') {
    try {
      const log = $('#debateStateLog');
      if (log) {
        // 清空首次的占位
        if (log.querySelector('.muted')) log.innerHTML = '';
        const consensusBadge = msg.consensus
          ? `<span style="color:#2da44e;font-weight:600;">✓ 共识 (score=${(msg.consensusScore || 0).toFixed(2)})</span>`
          : `<span style="color:var(--gray-mid);">分歧/继续 (score=${(msg.consensusScore || 0).toFixed(2)})</span>`;
        const evid = (msg.consensusEvidence || []).map(e => `<div style="margin-left:12px;color:var(--gray-mid);">└ ${escapeHtml(e)}</div>`).join('');
        log.insertAdjacentHTML('beforeend', `
          <div style="border-bottom:1px dashed var(--color-border-light);padding:6px 0;">
            <div><b>${escapeHtml(msg.kind)}</b> · 大轮 ${msg.macroRound} · state=${escapeHtml(msg.state)}</div>
            <div class="muted" style="font-size:11px;">${escapeHtml(msg.stateDesc || '')}</div>
            <div>${consensusBadge}</div>
            ${evid}
          </div>
        `);
        log.scrollTop = log.scrollHeight;
      }
    } catch {}
    return;
  }
  // v0.53 Sprint 3.5 自动暂停
  if (msg.type === 'room_auto_paused') {
    updateRoomStatusChip('auto_paused');
    toast(`房间已自动暂停：${msg.reason || '连续失败'}。检查 adapter 配置后可点 ▶ 续跑`, 'error', 6000);
    loadRooms();
    return;
  }
  if (msg.type === 'debate_start') {
    updateRoomStatusChip('running');
    $('#roomRounds').innerHTML = '';
    $('#roomConsensus').style.display = 'none';
    loadRooms();
    return;
  }
  // v0.52 续跑
  if (msg.type === 'debate_resume') {
    updateRoomStatusChip('running');
    toast('辩论从未完成阶段续跑…', 'info', 2500);
    loadRooms();
    return;
  }
  // v0.52 Sprint1-A Arena 事件
  if (msg.type === 'arena_start') {
    updateRoomStatusChip('running');
    $('#roomRounds').innerHTML = '';
    $('#roomConsensus').style.display = 'none';
    loadRooms();
    return;
  }
  if (msg.type === 'arena_done') {
    updateRoomStatusChip('done');
    toast('对决完成 🏟', 'success', 3000);
    loadRooms();
    return;
  }
  if (msg.type === 'arena_paused') {
    updateRoomStatusChip('paused');
    toast('对决已暂停', 'info');
    loadRooms();
    return;
  }
  if (msg.type === 'arena_error') {
    updateRoomStatusChip('error');
    toast('对决出错：' + msg.error, 'error');
    loadRooms();
    return;
  }
  if (msg.type === 'round_skip') {
    // resume 跳过已完成阶段，前端不用渲染（rounds 数据已在 store 里，pullRoomAndRender 已显示）
    return;
  }
  if (msg.type === 'judge_skip') {
    return;
  }
  if (msg.type === 'round_start') {
    ensureRoundCard(msg.kind);
    return;
  }
  if (msg.type === 'turn_start') {
    const cards = ensureRoundCard(msg.kind);
    const placeholder = document.createElement('div');
    placeholder.className = 'room-turn-card speaking';
    placeholder.dataset.speaker = msg.speaker;
    placeholder.dataset.pending = '1';
    placeholder.dataset.startedAt = String(Date.now());
    placeholder.dataset.lastProgressAt = String(Date.now());
    placeholder.dataset.bytesSeen = '0';
    placeholder.innerHTML = `
      <div class="room-turn-head">
        <span class="room-turn-speaker">${escapeHtml(msg.displayName)}</span>
        <span class="room-turn-spinner" data-elapsed="1">⏳ 思考中… 00:00</span>
      </div>
      <div class="room-turn-progress" style="font-size:11px;color:#6b7280;padding:4px 12px 0;">已收 0 KB</div>
      <div class="room-turn-content"></div>`;
    cards.appendChild(placeholder);
    startElapsedTicker();
    return;
  }
  if (msg.type === 'turn_progress') {
    // v0.52 spawn 收到 stdout 时更新"已收 X KB / Y 秒前"
    const cards = ensureRoundCard(msg.kind);
    const safeSpeaker = (window.CSS && CSS.escape) ? CSS.escape(msg.speaker) : msg.speaker;
    const placeholder = cards.querySelector(`.room-turn-card[data-speaker="${safeSpeaker}"][data-pending]`);
    if (placeholder) {
      placeholder.dataset.lastProgressAt = String(Date.now());
      placeholder.dataset.bytesSeen = String(msg.bytes || 0);
      const kb = ((msg.bytes || 0) / 1024).toFixed(1);
      const progEl = placeholder.querySelector('.room-turn-progress');
      if (progEl) {
        progEl.textContent = `已收 ${kb} KB`;
        progEl.style.color = '#6b7280';
      }
      placeholder.classList.remove('stalled');
    }
    return;
  }
  if (msg.type === 'turn_done') {
    const cards = ensureRoundCard(msg.kind);
    const placeholder = cards.querySelector(`.room-turn-card[data-speaker="${msg.speaker}"][data-pending]`);
    const real = renderTurnCard(msg, msg.kind);
    if (placeholder) placeholder.replaceWith(real); else cards.appendChild(real);
    // v0.52 Sprint1-D: 重试成功也走 turn_done，但要把"以前的 error 卡"也替换掉
    if (msg.retry) {
      const oldErr = cards.querySelector(`.room-turn-card.error[data-speaker="${msg.speaker}"]`);
      if (oldErr && oldErr !== placeholder) oldErr.replaceWith(real.cloneNode(true));
    }
    maybeStopElapsedTicker();
    return;
  }
  if (msg.type === 'turn_error') {
    const cards = ensureRoundCard(msg.kind);
    const placeholder = cards.querySelector(`.room-turn-card[data-speaker="${msg.speaker}"][data-pending]`);
    const elapsed = placeholder ? Math.floor((Date.now() - parseInt(placeholder.dataset.startedAt || '0', 10)) / 1000) : 0;
    const real = renderTurnCard({
      speaker: msg.speaker,
      displayName: msg.displayName || msg.speaker,
      content: `❌ ${msg.error || '失败'}${elapsed ? `（耗时 ${formatElapsed(elapsed)}）` : ''}`,
      error: true,
    }, msg.kind);
    if (placeholder) placeholder.replaceWith(real); else cards.appendChild(real);
    maybeStopElapsedTicker();
    return;
  }
  // v0.52 Sprint1-D 局部重试启动
  if (msg.type === 'turn_retry_start') {
    const cards = ensureRoundCard(msg.kind);
    const safeSpeaker = (window.CSS && CSS.escape) ? CSS.escape(msg.speaker) : msg.speaker;
    const oldErr = cards.querySelector(`.room-turn-card.error[data-speaker="${safeSpeaker}"]`);
    const placeholder = document.createElement('div');
    placeholder.className = 'room-turn-card speaking';
    placeholder.dataset.speaker = msg.speaker;
    placeholder.dataset.pending = '1';
    placeholder.dataset.startedAt = String(Date.now());
    placeholder.dataset.lastProgressAt = String(Date.now());
    placeholder.innerHTML = `
      <div class="room-turn-head">
        <span class="room-turn-speaker">${escapeHtml(msg.displayName || msg.speaker)}</span>
        <span class="room-turn-spinner" data-elapsed="1" data-label="重试中">⏳ 重试中… 00:00</span>
      </div>
      <div class="room-turn-progress" style="font-size:11px;color:#6b7280;padding:4px 12px 0;">已收 0 KB</div>
      <div class="room-turn-content"></div>`;
    if (oldErr) oldErr.replaceWith(placeholder); else cards.appendChild(placeholder);
    startElapsedTicker();
    return;
  }
  if (msg.type === 'round_done') {
    return;
  }
  if (msg.type === 'judge_start') {
    ensureRoundCard('r4_judge');
    return;
  }
  if (msg.type === 'judge_done') {
    $('#roomConsensus').style.display = 'flex';
    $('#roomConsensusBody').innerHTML = renderMarkdown(msg.content || '');
    // 也补 round card
    const cards = ensureRoundCard('r4_judge');
    cards.appendChild(renderTurnCard({ speaker: 'claude', displayName: '🟣 Claude（主持）', content: msg.content }));
    return;
  }
  if (msg.type === 'judge_error') {
    toast('主持总结失败：' + msg.error, 'error');
    return;
  }
  if (msg.type === 'debate_done') {
    updateRoomStatusChip('done');
    toast('辩论完成 🎯', 'success', 3000);
    loadRooms();   // 刷新房间列表 + 运行中指示器
    return;
  }
  // v0.41 squad events
  if (msg.type === 'squad_start') {
    updateRoomStatusChip('running');
    $('#squadBoard').style.display = 'flex';
    $('#roomRounds').style.display = 'none';
    $('#roomConsensus').style.display = 'none';
    for (const c of SQUAD_COLS) {
      const col = $('#squadCol' + c.split('_').map(s => s[0].toUpperCase() + s.slice(1)).join(''));
      if (col) col.innerHTML = '';
    }
    return;
  }
  if (msg.type === 'pm_planning') {
    toast(`PM(${msg.pm}) 正在拆任务...`, 'info', 2500);
    return;
  }
  if (msg.type === 'plan_done') {
    toast(`PM 拆出 ${msg.taskList.length} 个任务`, 'success', 2500);
    renderSquadKanban(msg.taskList);
    return;
  }
  if (msg.type === 'plan_cycle_fixed') {
    toast(`PM 输出有依赖环，已退化成线性`, 'warn', 3000);
    return;
  }
  if (msg.type === 'batch_start') {
    return;
  }
  if (msg.type === 'task_dev_start') {
    _squadTaskStartedAt.set(msg.taskId, { phase: 'dev', start: Date.now(), who: msg.dev || 'Dev' });
    pullRoomAndRender();
    return;
  }
  if (msg.type === 'task_dev_done') {
    _squadTaskStartedAt.delete(msg.taskId);
    pullRoomAndRender();
    return;
  }
  if (msg.type === 'task_qa_start') {
    _squadTaskStartedAt.set(msg.taskId, { phase: 'qa', start: Date.now(), who: msg.qa || 'QA' });
    pullRoomAndRender();
    return;
  }
  if (msg.type === 'task_qa_done') {
    _squadTaskStartedAt.delete(msg.taskId);
    pullRoomAndRender();
    if (msg.review?.verdict === 'reject') {
      toast(`${msg.taskId} 被 ${msg.by} 打回（第 ${msg.iteration} 次审查）`, 'warn', 3000);
    } else if (msg.review?.verdict === 'pass') {
      toast(`${msg.taskId} ✅ 通过审查`, 'success', 2500);
    }
    return;
  }
  if (msg.type === 'task_done') {
    _squadTaskStartedAt.delete(msg.taskId);
    pullRoomAndRender();
    return;
  }
  if (msg.type === 'task_escalated') {
    _squadTaskStartedAt.delete(msg.taskId);
    pullRoomAndRender();
    toast(`${msg.taskId} ⚠️ 已搁置（${msg.reason}）— task 跑失败需要人工介入，可在卡片上点重试`, 'error', 5000);
  }
  // v0.54 Sprint 6：squad 单 task 重试事件
  if (msg.type === 'task_retry_start') {
    const cascaded = msg.cascadedCount ? `（含 ${msg.cascadedCount} 个被牵连下游）` : '';
    toast(`🔄 ${msg.taskId} 开始重试${cascaded}…`, 'info', 3500);
    loadRooms();
    return;
  }
  if (msg.type === 'task_retry_error') {
    toast(`${msg.taskId} 重试失败：${msg.error || 'unknown'}`, 'error', 5000);
    return;
  }
  if (msg.type === 'final_summary_start') {
    toast('PM 正在总结最终交付...', 'info', 2500);
    return;
  }
  if (msg.type === 'final_summary_done') {
    $('#roomConsensus').style.display = 'flex';
    $('#roomConsensusBody').innerHTML = renderMarkdown(msg.content || '');
    return;
  }
  if (msg.type === 'squad_done') {
    updateRoomStatusChip('done');
    toast('小组协作完成 🎯', 'success', 3500);
    loadRooms();
    return;
  }
  if (msg.type === 'squad_paused') {
    updateRoomStatusChip('paused');
    toast('小组已暂停', 'info');
    loadRooms();
    return;
  }
  if (msg.type === 'squad_error') {
    updateRoomStatusChip('error');
    toast('小组出错：' + msg.error, 'error');
    loadRooms();
    return;
  }
  if (msg.type === 'squad_start') {
    loadRooms();
  }
  // v0.48 chat 事件
  if (msg.type === 'chat_user_msg') {
    const wrap = $('#chatRoomMessages');
    if (!wrap) return;
    const empty = wrap.querySelector('.chat-room-empty');
    if (empty) empty.remove();
    wrap.appendChild(buildChatMessageEl(msg.message));
    wrap.scrollTop = wrap.scrollHeight;
    return;
  }
  if (msg.type === 'chat_thinking') {
    const wrap = $('#chatRoomMessages');
    if (!wrap) return;
    wrap.querySelectorAll('[data-thinking="1"]').forEach(el => el.remove());
    const placeholder = buildChatMessageEl({
      from: msg.member, displayName: msg.displayName, content: '', thinking: true, at: new Date().toISOString(),
    });
    wrap.appendChild(placeholder);
    wrap.scrollTop = wrap.scrollHeight;
    return;
  }
  if (msg.type === 'chat_ai_msg') {
    const wrap = $('#chatRoomMessages');
    if (!wrap) return;
    wrap.querySelectorAll('[data-thinking="1"]').forEach(el => el.remove());
    wrap.appendChild(buildChatMessageEl(msg.message));
    wrap.scrollTop = wrap.scrollHeight;
    $('#btnChatAbort').style.display = 'none';
    return;
  }
  if (msg.type === 'chat_error') {
    const wrap = $('#chatRoomMessages');
    if (wrap) {
      wrap.querySelectorAll('[data-thinking="1"]').forEach(el => el.remove());
      if (msg.message) wrap.appendChild(buildChatMessageEl(msg.message));
    }
    $('#btnChatAbort').style.display = 'none';
    toast('chat 失败：' + msg.error, 'error', 4000);
    return;
  }
  if (msg.type === 'chat_aborted') {
    $('#chatRoomMessages')?.querySelectorAll('[data-thinking="1"]').forEach(el => el.remove());
    $('#btnChatAbort').style.display = 'none';
    toast('已中断 AI 思考', 'info', 2000);
    return;
  }
  if (msg.type === 'debate_paused') {
    updateRoomStatusChip('paused');
    toast('辩论已暂停', 'info');
    loadRooms();
    return;
  }
  if (msg.type === 'debate_error') {
    updateRoomStatusChip('error');
    toast('辩论出错：' + msg.error, 'error');
    loadRooms();
    return;
  }
}

async function startDebate() {
  const topic = $('#roomTopicInput').value.trim();
  if (!topic) { toast('先填任务再启动', 'warn'); return; }
  if (!roomState.activeId) return;
  // v0.52 并发警告
  const running = (roomState.rooms || []).filter(r => r.status === 'running' && r.id !== roomState.activeId).length;
  if (running >= 3) {
    const ok = await confirmModal({
      title: '⚠️ 高并发提示',
      message: `已有 ${running} 个房间在运行。同账户 LLM 高并发可能 rate limit（Claude 同账户 ~10 并发上限）。建议错开 model 池或暂停部分房。要继续启动吗？`,
      confirmLabel: '继续启动',
      cancelLabel: '取消',
    });
    if (!ok) return;
  }
  // v0.52 debate 模式才带 debateRounds；squad/chat 模式同 endpoint 仅传 topic
  const body = { topic };
  const roundsInput = $('#roomDebateRoundsInput');
  if (roundsInput && roundsInput.offsetParent !== null) {
    let n = parseInt(roundsInput.value, 10);
    if (Number.isFinite(n)) {
      n = Math.max(1, Math.min(10, n));
      body.debateRounds = n;
    }
  }
  try {
    const r = await fetch(`/api/rooms/${roomState.activeId}/debate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(x => x.json());
    if (r.ok) toast(body.debateRounds ? `辩论已启动（${body.debateRounds} 大轮）…` : '辩论已启动…', 'info');
    else toast('启动失败：' + (r.error || ''), 'error');
  } catch (e) { toast('启动失败：' + e.message, 'error'); }
}

async function abortDebate() {
  if (!roomState.activeId) return;
  try {
    const r = await fetch(`/api/rooms/${roomState.activeId}/abort`, { method: 'POST' }).then(x => x.json());
    if (r?.ok && r.aborted) toast('已发送结束信号，AI 调用收尾中…', 'info', 2500);
    else if (r?.ok) toast('当前房未在运行', 'warn', 2000);
    else toast('结束失败：' + (r?.error || ''), 'error');
  } catch (e) { toast('结束失败：' + e.message, 'error'); }
}

async function deleteRoom() {
  if (!roomState.activeId) return;
  const ok = await confirmModal({
    title: '🗑 删除房间',
    message: '将永久删除：房间记录 + 所有 turn / conversation / taskList / finalConsensus。\n\n此操作不可恢复，是否继续？',
    confirmLabel: '永久删除',
    cancelLabel: '取消',
    danger: true,
  });
  if (!ok) return;
  await fetch(`/api/rooms/${roomState.activeId}`, { method: 'DELETE' });
  roomState.activeId = null;
  $('#roomDebate').style.display = 'none';
  $('.room-empty').style.display = '';
  await loadRooms();
}

// v0.44 P2 #16: throttle，避免 WS 事件 burst 触发请求风暴
// v0.45 P1-3: trailing 调用 capture activeId，房间切换后不再拉错房间
let _pullRoomThrottle = { pending: false, timer: null, lastAt: 0 };
async function pullRoomAndRender() {
  if (!roomState.activeId) return;
  const THROTTLE_MS = 250;
  const now = Date.now();
  const targetId = roomState.activeId; // capture，trailing 时校验
  if (now - _pullRoomThrottle.lastAt < THROTTLE_MS) {
    if (!_pullRoomThrottle.pending) {
      _pullRoomThrottle.pending = true;
      _pullRoomThrottle.timer = setTimeout(() => {
        _pullRoomThrottle.pending = false;
        _pullRoomThrottle.timer = null;
        if (roomState.activeId === targetId) pullRoomAndRender();
      }, THROTTLE_MS - (now - _pullRoomThrottle.lastAt));
    }
    return;
  }
  _pullRoomThrottle.lastAt = now;
  try {
    const r = await fetch(`/api/rooms/${targetId}`).then(x => x.json());
    if (roomState.activeId !== targetId) return; // 期间切走了
    if (r.ok && r.room?.mode === 'squad') {
      renderSquadKanban(r.room.taskList || []);
    }
  } catch {}
}

$('#btnRooms')?.addEventListener('click', () => {
  showRoomArea();
  loadRooms();
});
$('#btnRoomBack')?.addEventListener('click', hideRoomArea);
$('#btnRoomNewDebate')?.addEventListener('click', () => createRoom('debate'));
$('#btnRoomNewSquad')?.addEventListener('click', () => createRoom('squad'));
$('#btnRoomNewArena')?.addEventListener('click', () => createRoom('arena'));

// v0.52 Sprint1-F：转发当前 finalConsensus 给新房
// v0.56 U10：让 squad/debate/arena 也能选「全部对话历史」作为 topic（之前只能用 finalConsensus）
document.querySelectorAll('#roomConsensusActions [data-forward]').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!roomState.activeId) return;
    const targetMode = btn.dataset.forward;
    const targetLabel = { squad: 'AI 团队拆活', debate: '多模型辩论', arena: '多模型联网核对', chat: '单模型聊天' }[targetMode] || targetMode;

    // 选 seed 范围：chat 模式已经默认 seed 全部 → 不问；其他 3 个先问 scope 再问 autoStart
    let seedScope = 'all';
    if (targetMode !== 'chat') {
      const useAll = await confirmModal({
        title: `转给${targetLabel} · 用什么做 topic？`,
        message: '「全部对话历史」会把源房的完整 R1/R2/R3 讨论 + 最终结论一起 seed 进新房（信息量大，新房 AI 能看到推理过程）。「只用最终结论」更短更聚焦，但新房只看得到结论文字。',
        confirmLabel: '📚 全部对话历史（推荐）',
        cancelLabel: '📌 只用最终结论',
      });
      seedScope = useAll ? 'all' : 'final';
    }
    const autoStart = targetMode !== 'chat' && await confirmModal({
      title: `转给${targetLabel}`,
      message: `已选「${seedScope === 'all' ? '全部对话历史' : '只用最终结论'}」作为 topic。要不要立即启动？`,
      confirmLabel: '新建并立即启动',
      cancelLabel: '只新建不启动',
    });
    try {
      const r = await fetch('/api/rooms/forward', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceRoomId: roomState.activeId, targetMode, autoStart: !!autoStart, seedScope }),
      }).then(x => x.json());
      if (r?.ok && r.newRoomId) {
        toast(`已创建新${targetLabel}${r.started ? '并启动' : ''}`, 'success', 2500);
        await loadRooms();
        selectRoom(r.newRoomId);
      } else {
        toast('转发失败：' + (r?.error || ''), 'error');
      }
    } catch (e) { toast('转发失败：' + e.message, 'error'); }
  });
});
$('#btnRoomNewChat')?.addEventListener('click', async () => {
  // 让用户选搭子
  const partner = await promptModal('和谁聊？（claude / codex / ollama / minimax）', 'codex');
  if (!partner) return;
  createRoom('chat', partner);
});
$('#btnChatSend')?.addEventListener('click', sendChatMessage);
$('#btnChatAbort')?.addEventListener('click', abortChat);
$('#chatRoomInput')?.addEventListener('keydown', (e) => {
  // v0.54 Sprint 7：Enter 发送 / Shift+Enter 换行 / ⌘+Enter 也发送（兼容旧习惯）
  // IME 选字时不触发
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key !== 'Enter') return;
  if (e.shiftKey) return;             // Shift+Enter 让 textarea 自然换行
  e.preventDefault();
  sendChatMessage();
});
$('#qaStrictSelect')?.addEventListener('change', async (e) => {
  if (!roomState.activeId) return;
  try {
    await fetch(`/api/rooms/${roomState.activeId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qaStrictness: e.target.value }),
    });
    toast(`QA 严格度已切换到 ${e.target.value}`, 'success', 2000);
  } catch (err) { toast('切换失败：' + err.message, 'error'); }
});
$('#btnRoomStart')?.addEventListener('click', startDebate);
$('#btnRoomAbort')?.addEventListener('click', abortDebate);
$('#btnRoomDelete')?.addEventListener('click', deleteRoom);

// v0.52 重启（清空进度重头跑）
$('#btnRoomRestart')?.addEventListener('click', async () => {
  if (!roomState.activeId) return;
  const ok = await confirmModal({
    title: '🔄 重启房间？',
    message: '会**清空当前已经跑出来的 R1/R2/R3 内容**，按当前 topic 从头重跑。继续吗？',
    confirmLabel: '重启',
    cancelLabel: '取消',
    danger: true,
  });
  if (!ok) return;
  await startDebate();   // 沿用现有 start，dispatcher.start 自然会清空 rounds
});

// v0.52 续跑（从未完成阶段接着跑）
$('#btnRoomResume')?.addEventListener('click', async () => {
  if (!roomState.activeId) return;
  try {
    const r = await fetch(`/api/rooms/${roomState.activeId}/resume`, { method: 'POST' }).then(x => x.json());
    if (r?.ok) toast('已发送续跑信号…', 'info', 2500);
    else toast('续跑失败：' + (r?.error || ''), 'error');
  } catch (e) { toast('续跑失败：' + e.message, 'error'); }
});

// v0.52 debate 大轮数 change → PATCH 持久化（防误改后启动取错值）
$('#roomDebateRoundsInput')?.addEventListener('change', async (e) => {
  if (!roomState.activeId) return;
  let n = parseInt(e.target.value, 10);
  if (!Number.isFinite(n)) n = 2;
  n = Math.max(1, Math.min(10, n));
  e.target.value = String(n);
  const startBtn = $('#btnRoomStart');
  if (startBtn && startBtn.textContent.includes('debate')) {
    startBtn.textContent = `🚀 启动辩论（${n} 大轮）`;
  }
  try {
    const r = await fetch(`/api/rooms/${roomState.activeId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ debateRounds: n }),
    }).then(x => x.json());
    if (r?.ok) toast(`大轮数已设为 ${n}`, 'success', 1500);
    else toast('保存失败：' + (r?.error || ''), 'error');
  } catch (err) { toast('保存失败：' + err.message, 'error'); }
});

// ============ v0.54 Sprint 10：删除 Ruflo 集成（用户不用） ============

// ============ v0.52 Plugin 中心（Sprint 10 误删，v0.56 修复重写） ============
// v0.84 真做 SSOT mirror：pluginState
const _pluginStateRaw = { list: [], activeId: null };
const pluginState = new Proxy(_pluginStateRaw, {
  set(target, key, value) {
    target[key] = value;
    try { window.PanelStore?.set?.(`plugin.${String(key)}`, value); } catch {}
    return true;
  },
});

function showPluginArea() {
  $('#mainHeader') && ($('#mainHeader').style.display = 'none');
  $('#chatArea') && ($('#chatArea').style.display = 'none');
  $('#termArea') && ($('#termArea').style.display = 'none');
  $('#roomArea') && ($('#roomArea').style.display = 'none');
  $('#overviewArea') && ($('#overviewArea').style.display = 'none');
  $('#pluginArea').style.display = 'flex';
  loadPluginList();
}
function hidePluginArea() {
  $('#pluginArea').style.display = 'none';
  if (state.activeId) $('#chatArea').style.display = 'flex';
  else $('#mainHeader').style.display = 'flex';
}

async function loadPluginList() {
  try {
    const r = await fetch('/api/plugins').then(x => x.json());
    pluginState.list = r.plugins || [];
    renderPluginList();
    if (pluginState.activeId) {
      const e = pluginState.list.find(p => p.id === pluginState.activeId);
      if (e) renderPluginDetail(pluginState.activeId);
      else pluginState.activeId = null;
    }
  } catch (e) { toast('加载 plugin 列表失败：' + e.message, 'error'); }
}

function renderPluginList() {
  const root = $('#pluginList');
  if (!root) return;
  if (pluginState.list.length === 0) {
    root.innerHTML = '<div class="muted small" style="padding:12px;">没加载任何 plugin（builtin + user 都空？）</div>';
    return;
  }
  root.innerHTML = pluginState.list.map(p => {
    const active = pluginState.activeId === p.id ? ' active' : '';
    const sourceBadge = p.source === 'builtin' ? '<span class="badge">内置</span>' : '<span class="badge">用户</span>';
    const statusBadge = p.valid
      ? '<span class="badge" style="color:#2da44e;">✓ 可用</span>'
      : `<span class="badge" style="color:#dc3545;" title="${escapeHtml(p.error || 'bin 探测失败')}">⚠️ 不可用</span>`;
    return `<div class="plugin-list-item${active}" data-id="${escapeHtml(p.id)}">
      <div class="plugin-list-item-head">
        <span style="font-size:16px;">${escapeHtml(p.icon || '🧩')}</span>
        <span class="plugin-list-item-name">${escapeHtml(p.displayName || p.id)}</span>
      </div>
      <div class="plugin-list-item-meta">
        ${sourceBadge} ${statusBadge}
        <span class="muted">${escapeHtml(p.type || 'spawn')} · ${(p.commands || []).length} cmd</span>
      </div>
    </div>`;
  }).join('');
  root.querySelectorAll('.plugin-list-item').forEach(el => {
    el.addEventListener('click', () => {
      pluginState.activeId = el.dataset.id;
      renderPluginList();
      renderPluginDetail(pluginState.activeId);
    });
  });
}

async function renderPluginDetail(id) {
  const root = $('#pluginMain');
  if (!root) return;
  root.innerHTML = '<div class="muted small" style="padding:20px;">加载详情中…</div>';
  let manifest;
  try {
    const r = await fetch('/api/plugins/' + encodeURIComponent(id)).then(x => x.json());
    if (!r.ok) { root.innerHTML = '<div class="muted">加载失败：' + escapeHtml(r.error || 'unknown') + '</div>'; return; }
    manifest = r.manifest;
  } catch (e) { root.innerHTML = '<div class="muted">异常：' + escapeHtml(e.message) + '</div>'; return; }

  const entry = pluginState.list.find(p => p.id === id);
  const cmdList = (manifest.commands || []).map(c => `
    <div class="plugin-cmd-card">
      <div><b>${escapeHtml(c.id)}</b> · ${escapeHtml(c.name || '')}</div>
      <div class="muted small">${escapeHtml(c.description || '')}</div>
      <div class="muted small" style="font-family:ui-monospace,monospace;font-size:11px;">args: ${escapeHtml((c.args || []).join(' '))}</div>
      <button class="cxbtn cxbtn-primary cxbtn-sm" data-run-cmd="${escapeHtml(c.id)}">▶ 运行</button>
    </div>
  `).join('');
  const isBuiltin = entry?.source === 'builtin';
  root.innerHTML = `
    <div class="plugin-detail-head">
      <h2>${escapeHtml(manifest.icon || '🧩')} ${escapeHtml(manifest.displayName || manifest.id)}</h2>
      <span class="muted small">${escapeHtml(manifest.id)} · v${escapeHtml(manifest.version || '0.0.0')} · type=${escapeHtml(manifest.type || 'spawn')}</span>
      <div class="plugin-detail-actions">
        ${isBuiltin ? '<span class="muted small">内置 plugin 不可卸载</span>' : `<button class="cxbtn cxbtn-danger cxbtn-sm" id="btnPluginUninstall">🗑 卸载</button>`}
      </div>
    </div>
    <div class="plugin-detail-body">
      ${entry?.error ? `<div style="padding:10px;background:rgba(220,53,69,0.08);border-left:3px solid #dc3545;border-radius:4px;">⚠️ ${escapeHtml(entry.error)}</div>` : ''}
      <h3>命令清单（${(manifest.commands || []).length}）</h3>
      <div class="plugin-cmd-list">${cmdList || '<div class="muted">此 plugin 未声明命令</div>'}</div>
    </div>
  `;
  $('#btnPluginUninstall')?.addEventListener('click', async () => {
    if (!confirm(`卸载 plugin "${id}"？`)) return;
    try {
      const r = await fetch('/api/plugins/' + encodeURIComponent(id), { method: 'DELETE' }).then(x => x.json());
      if (r.ok) { toast('已卸载', 'success', 1500); pluginState.activeId = null; loadPluginList(); }
      else toast('卸载失败：' + (r.error || 'unknown'), 'error');
    } catch (e) { toast('卸载失败：' + e.message, 'error'); }
  });
  root.querySelectorAll('[data-run-cmd]').forEach(el => {
    el.addEventListener('click', () => runPluginCommand(id, el.dataset.runCmd));
  });
}

async function runPluginCommand(pluginId, commandId) {
  const prompt = await promptModal({ title: `运行 ${pluginId}.${commandId}`, message: '输入要发给 plugin 的 prompt（可空）', multiline: true, placeholder: '...' });
  if (prompt === null) return;
  const loading = toast(`运行中（${pluginId}.${commandId}）…`, 'info', 60000);
  try {
    const r = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/exec`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId, prompt: prompt || '' }),
    }).then(x => x.json());
    try { loading?.remove?.(); } catch {}
    if (r.ok) {
      await confirmModal({
        title: `✓ ${pluginId}.${commandId} 完成`,
        message: r.reply ? r.reply.slice(0, 4000) + (r.reply.length > 4000 ? '\n…（已截断）' : '') : '(空回复)',
        confirmLabel: '关闭', cancelLabel: '',
      });
    } else {
      toast('运行失败：' + (r.error || 'unknown'), 'error', 5000);
    }
  } catch (e) {
    try { loading?.remove?.(); } catch {}
    toast('异常：' + e.message, 'error');
  }
}

async function installPluginFromFile(file) {
  if (!file) return;
  if (file.size > 32 * 1024) { toast('manifest 文件过大（>32KB）', 'error'); return; }
  try {
    const text = await file.text();
    const manifest = JSON.parse(text);
    const r = await fetch('/api/plugins/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    }).then(x => x.json());
    if (r.ok) { toast('已安装 ' + (manifest.id || manifest.displayName || ''), 'success', 2000); loadPluginList(); }
    else toast('安装失败：' + (r.error || 'unknown'), 'error', 5000);
  } catch (e) { toast('解析 manifest 失败：' + e.message, 'error'); }
}

$('#btnPlugins')?.addEventListener('click', showPluginArea);
$('#btnPluginBack')?.addEventListener('click', hidePluginArea);
$('#btnPluginInstall')?.addEventListener('click', () => $('#pluginInstallFile')?.click());
$('#pluginInstallFile')?.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) installPluginFromFile(f);
  e.target.value = '';
});
$('#btnPluginReload')?.addEventListener('click', async () => {
  try {
    const r = await fetch('/api/plugins/reload', { method: 'POST' }).then(x => x.json());
    if (r.ok) { toast('已重扫', 'success', 1500); loadPluginList(); }
    else toast('刷新失败：' + (r.error || 'unknown'), 'error');
  } catch (e) { toast('刷新失败：' + e.message, 'error'); }
});


// v0.50 全局错误兜底：未捕获的 Promise/异常显示 toast（避免静默崩）
// v0.51 R-10 fix: 过滤掉浏览器/扩展噪声（ResizeObserver / "Script error." / 跨源 / 扩展 / CDN）
const NOISY_ERROR_PATTERNS = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /Loading chunk \d+ failed/i,
  /NetworkError when attempting to fetch resource/i,
];
function isNoisyError(msg, filename) {
  if (!msg) return true;
  if (filename && (filename.includes('extension://') || filename.includes('cdn.jsdelivr') || filename.includes('chrome-extension'))) return true;
  return NOISY_ERROR_PATTERNS.some(re => re.test(msg));
}
window.addEventListener('error', (e) => {
  if (isNoisyError(e.message, e.filename)) return;
  try { toast('页面错误：' + (e.message || 'unknown'), 'error', 5000); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason || '').slice(0, 200);
  if (!msg || msg.includes('AbortError') || isNoisyError(msg)) return;
  try { toast('异步错误：' + msg, 'error', 5000); } catch {}
});

// v0.50 Q-04 fix: clipboard 降级到 execCommand（非 secure context / 旧浏览器）
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    toast(ok ? '已复制（兼容模式）' : '复制失败，请手动选中', ok ? 'success' : 'warn');
  } catch (e) {
    toast('复制失败：' + e.message, 'error');
  }
}

// ============ v0.50 体验优化 6 件套 ============

// ─── F1 跨 session 全局搜索（⌘⇧F）─────
const searchState = { items: [], activeIdx: 0, debounceTimer: null };
function openSearch() {
  $('#searchModal').style.display = 'flex';
  $('#searchInput').value = '';
  searchState.items = [];
  searchState.activeIdx = 0;
  renderSearchResults();
  setTimeout(() => $('#searchInput').focus(), 0);
}
function closeSearch() { $('#searchModal').style.display = 'none'; }
function escRegexp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function runSearch(q) {
  if (!q || !q.trim()) { searchState.items = []; renderSearchResults(); return; }
  try {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q.trim()) + '&limit=50').then(x => x.json());
    if (r.ok) {
      searchState.items = r.hits || [];
      searchState.activeIdx = 0;
    } else {
      searchState.items = [];
    }
  } catch (e) {
    searchState.items = [];
  }
  renderSearchResults();
}
function renderSearchResults() {
  const list = $('#searchResults');
  if (!list) return;
  if (searchState.items.length === 0) {
    list.innerHTML = '<div class="cmdk-empty">没匹配到（输入关键词开始搜索）</div>';
    return;
  }
  const q = $('#searchInput').value.trim();
  list.innerHTML = searchState.items.map((h, i) => {
    const snippet = q ? escapeHtml(h.snippet).replace(new RegExp(escRegexp(q), 'gi'), m => `<mark>${m}</mark>`) : escapeHtml(h.snippet);
    return `<div class="search-hit ${i === searchState.activeIdx ? 'active' : ''}" data-idx="${i}">
      <div class="search-hit-head">
        <span class="search-hit-name">${escapeHtml(h.sessionName || '?')}</span>
        <span class="search-hit-role">${h.role} · msg #${h.msgIndex}${h.ts ? ' · ' + new Date(h.ts).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : ''}</span>
      </div>
      <div class="search-hit-snippet">${snippet}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.search-hit').forEach(el => {
    el.addEventListener('click', () => jumpToSearchHit(parseInt(el.dataset.idx, 10)));
  });
}
function jumpToSearchHit(idx) {
  const h = searchState.items[idx];
  if (!h) return;
  closeSearch();
  selectSession(h.sessionId);
  // v0.51 ZZZZZ-02 fix: 300ms 不够时 retry，避免大 session 渲染慢导致静默失败
  let attempts = 0;
  const tryFind = () => {
    const el = document.querySelector(`#chatOutput .msg[data-msg-idx="${h.msgIndex}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('msg-highlight');
      setTimeout(() => el.classList.remove('msg-highlight'), 2400);
      return;
    }
    if (++attempts < 10) setTimeout(tryFind, 100);
    else toast('原消息可能已被截断或会话切换，请重新搜索', 'warn');
  };
  setTimeout(tryFind, 150);
}
$('#searchInput')?.addEventListener('input', (e) => {
  if (searchState.debounceTimer) clearTimeout(searchState.debounceTimer);
  searchState.debounceTimer = setTimeout(() => runSearch(e.target.value), 200);
});
$('#searchInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (searchState.items.length > 0) {
      searchState.activeIdx = Math.min(searchState.items.length - 1, searchState.activeIdx + 1);
      renderSearchResults();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (searchState.items.length > 0) {
      searchState.activeIdx = Math.max(0, searchState.activeIdx - 1);
      renderSearchResults();
    }
  } else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    if (searchState.items[searchState.activeIdx]) jumpToSearchHit(searchState.activeIdx);
  }
});
$('#searchModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'searchModal') closeSearch();
});

// ─── v0.53 Sprint 3.5 跨房搜索（⌘⇧R）─────
const roomSearchState = { items: [], activeIdx: 0, debounceTimer: null };
function openRoomSearch() {
  $('#roomSearchModal').style.display = 'flex';
  $('#roomSearchInput').value = '';
  roomSearchState.items = [];
  roomSearchState.activeIdx = 0;
  renderRoomSearchResults();
  setTimeout(() => $('#roomSearchInput').focus(), 0);
}
function closeRoomSearch() { $('#roomSearchModal').style.display = 'none'; }
async function runRoomSearch(q) {
  if (!q || !q.trim()) { roomSearchState.items = []; renderRoomSearchResults(); return; }
  const incl = $('#roomSearchInclArchived')?.checked ? '1' : '0';
  try {
    const r = await fetch('/api/rooms/search?q=' + encodeURIComponent(q.trim()) + '&limit=50&includeArchived=' + incl).then(x => x.json());
    if (r.ok) {
      roomSearchState.items = r.hits || [];
      roomSearchState.activeIdx = 0;
    } else {
      roomSearchState.items = [];
    }
  } catch {
    roomSearchState.items = [];
  }
  renderRoomSearchResults();
}
function renderRoomSearchResults() {
  const list = $('#roomSearchResults');
  if (!list) return;
  if (roomSearchState.items.length === 0) {
    list.innerHTML = '<div class="cmdk-empty">没匹配到（输入关键词开始搜索 · 跨所有房）</div>';
    return;
  }
  const q = $('#roomSearchInput').value.trim();
  const modeLabel = { debate: '🗣 多模型辩论', squad: '👥 团队拆活', arena: '🏟 联网核对', chat: '💬 单聊' };
  list.innerHTML = roomSearchState.items.map((h, i) => {
    const snippet = q
      ? escapeHtml(h.snippet).replace(new RegExp(escRegexp(q), 'gi'), m => `<mark>${m}</mark>`)
      : escapeHtml(h.snippet);
    return `<div class="search-hit ${i === roomSearchState.activeIdx ? 'active' : ''}" data-idx="${i}">
      <div class="search-hit-head">
        <span class="search-hit-name">${escapeHtml(h.roomName || '?')}</span>
        <span class="search-hit-role">${modeLabel[h.mode] || h.mode} · ${escapeHtml(h.where || '')}${h.speaker ? ' · ' + escapeHtml(h.speaker) : ''}</span>
      </div>
      <div class="search-hit-snippet">${snippet}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.search-hit').forEach(el => {
    el.addEventListener('click', () => jumpToRoomSearchHit(parseInt(el.dataset.idx, 10)));
  });
}
function jumpToRoomSearchHit(idx) {
  const h = roomSearchState.items[idx];
  if (!h) return;
  closeRoomSearch();
  // 切换到房间区域并选中房
  showRoomArea();
  loadRooms().then(() => selectRoom(h.roomId));
}
$('#roomSearchInput')?.addEventListener('input', (e) => {
  if (roomSearchState.debounceTimer) clearTimeout(roomSearchState.debounceTimer);
  roomSearchState.debounceTimer = setTimeout(() => runRoomSearch(e.target.value), 200);
});
$('#roomSearchInclArchived')?.addEventListener('change', () => {
  runRoomSearch($('#roomSearchInput').value);
});
$('#roomSearchInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeRoomSearch(); }
  else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (roomSearchState.items.length > 0) {
      roomSearchState.activeIdx = Math.min(roomSearchState.items.length - 1, roomSearchState.activeIdx + 1);
      renderRoomSearchResults();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (roomSearchState.items.length > 0) {
      roomSearchState.activeIdx = Math.max(0, roomSearchState.activeIdx - 1);
      renderRoomSearchResults();
    }
  } else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    if (roomSearchState.items[roomSearchState.activeIdx]) jumpToRoomSearchHit(roomSearchState.activeIdx);
  }
});
$('#roomSearchModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'roomSearchModal') closeRoomSearch();
});

// ─── F3 浏览器通知（长任务完成）─────
const notifState = { enabled: false, granted: false };
function notifInit() {
  if (!('Notification' in window)) return;
  notifState.enabled = localStorage.getItem('cp-notif-enabled') !== '0';
  notifState.granted = Notification.permission === 'granted';
  if (notifState.enabled && !notifState.granted && Notification.permission === 'default') {
    // 首次后台 turn_end 时再请求权限，避免无故弹
  }
}
async function maybeNotify(title, body) {
  if (!notifState.enabled) return;
  if (!('Notification' in window)) return;
  if (!document.hidden) return; // tab 在前台不通知
  try {
    if (Notification.permission === 'default') {
      const r = await Notification.requestPermission();
      notifState.granted = r === 'granted';
    }
    if (Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, icon: '/favicon.ico', silent: false });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => { try { n.close(); } catch {} }, 8000);
  } catch {}
}
notifInit();

// ─── F4 ⌘? cheatsheet ─────
function openCheatsheet() { $('#cheatsheetModal').style.display = 'flex'; }
function closeCheatsheet() { $('#cheatsheetModal').style.display = 'none'; }
$('#cheatsheetModal')?.addEventListener('click', (e) => { if (e.target.id === 'cheatsheetModal') closeCheatsheet(); });
$('#statusKbBtn')?.addEventListener('click', openCheatsheet);

// ─── F6 Prompts 模板库（⌘P）─────
async function openPrompts() {
  $('#promptsModal').style.display = 'flex';
  await loadPromptsList();
  setTimeout(() => $('#promptName')?.focus(), 0);
}
function closePrompts() { $('#promptsModal').style.display = 'none'; }
async function loadPromptsList() {
  try {
    const r = await fetch('/api/prompts').then(x => x.json());
    const list = r.prompts || [];
    const el = $('#promptsList');
    if (!el) return;
    if (list.length === 0) {
      el.innerHTML = '<div class="cmdk-empty" style="padding:18px;">还没模板。下面填名+内容点「添加」存一条。</div>';
      return;
    }
    el.innerHTML = list.map(p => `<div class="prompts-item" data-id="${escapeHtml(p.id)}">
      <div class="prompts-item-name">
        <span>${escapeHtml(p.name)}</span>
        <button class="prompts-item-del" data-del="${escapeHtml(p.id)}" title="删除">🗑</button>
      </div>
      <div class="prompts-item-preview">${escapeHtml(String(p.content).slice(0, 120))}${p.content.length > 120 ? '…' : ''}</div>
    </div>`).join('');
    el.querySelectorAll('.prompts-item').forEach(item => {
      item.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('prompts-item-del')) return;
        const id = item.dataset.id;
        const p = list.find(x => x.id === id);
        if (!p) return;
        const input = $('#chatInput');
        if (!input) { toast('先选一个 session', 'warn'); return; }
        input.value = input.value ? input.value + '\n\n' + p.content : p.content;
        input.focus();
        closePrompts();
        toast(`已插入「${p.name}」`, 'success', 2000);
      });
    });
    el.querySelectorAll('.prompts-item-del').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const id = btn.dataset.del;
        if (!await confirmModal({ title: '删除模板？', message: '不可撤销', confirmLabel: '删除', danger: true })) return;
        await fetch('/api/prompts/' + id, { method: 'DELETE' });
        loadPromptsList();
      });
    });
  } catch (e) {
    $('#promptsList').innerHTML = '<div class="cmdk-empty">加载失败：' + escapeHtml(e.message) + '</div>';
  }
}
$('#btnPromptAdd')?.addEventListener('click', async () => {
  const name = $('#promptName').value.trim();
  const content = $('#promptContent').value.trim();
  if (!name || !content) { toast('名称和内容都不能空', 'warn'); return; }
  try {
    const r = await fetch('/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) }).then(x => x.json());
    if (r.ok) {
      $('#promptName').value = '';
      $('#promptContent').value = '';
      loadPromptsList();
      toast('模板已添加', 'success');
    } else {
      toast('添加失败：' + r.error, 'error');
    }
  } catch (e) {
    toast('异常：' + e.message, 'error');
  }
});
$('#promptsModal')?.addEventListener('click', (e) => { if (e.target.id === 'promptsModal') closePrompts(); });

// ─── F5 + F7：message 右键菜单（收藏 / 分叉）+ ⭐ 渲染 ─────
// v0.51 R-04 fix: in-flight 去重，避免快速双击导致 UI 状态错位
const _toggleStarInflight = new Set();
async function toggleStar(sessionId, msgIndex) {
  const key = sessionId + '#' + msgIndex;
  if (_toggleStarInflight.has(key)) return; // 同一条正在 toggle，忽略
  _toggleStarInflight.add(key);
  try {
    const r = await fetch(`/api/sessions/${sessionId}/star`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgIndex }) }).then(x => x.json());
    if (r.ok) {
      // 同步更新本地（避免重渲全部）
      if (sessionId === state.activeId) state.activeStarred = r.starredIndices || [];
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess) sess.starredIndices = r.starredIndices;
      // 重渲该条 msg 的 ⭐ 状态
      const el = document.querySelector(`#chatOutput .msg[data-msg-idx="${msgIndex}"] .msg-star-btn`);
      if (el) el.classList.toggle('starred', r.starredIndices.includes(msgIndex));
      return r.starredIndices;
    } else if (r?.error) {
      toast('收藏失败：' + r.error, 'error');
    }
  } catch (e) {
    toast('收藏失败：' + e.message, 'error');
  } finally {
    _toggleStarInflight.delete(key);
  }
}
async function forkSession(sessionId, fromIndex) {
  if (!await confirmModal({ title: '从这条消息分叉？', message: `新 session 会复制前 ${fromIndex + 1} 条消息，cwd 同当前，但 claudeSessionId 重置（新一轮 fresh claude）`, confirmLabel: '分叉' })) return;
  try {
    const r = await fetch(`/api/sessions/${sessionId}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromIndex }) }).then(x => x.json());
    if (r.ok) {
      toast(`分叉成功（复制 ${r.copiedCount} 条）`, 'success');
      await listSessions();
      selectSession(r.newSessionId);
    } else {
      toast('分叉失败：' + r.error, 'error');
    }
  } catch (e) {
    toast('异常：' + e.message, 'error');
  }
}
// 用事件委托给 chatOutput 处理 ⭐ 点击 + 右键
document.addEventListener('click', (e) => {
  const star = e.target.closest('.msg-star-btn');
  if (!star) return;
  const msg = star.closest('.msg');
  if (!msg) return;
  const idx = parseInt(msg.dataset.msgIdx, 10);
  if (!Number.isInteger(idx)) return;
  if (!state.activeId) return;
  toggleStar(state.activeId, idx);
});
document.addEventListener('contextmenu', (e) => {
  const msg = e.target.closest('#chatOutput .msg');
  if (!msg) return;
  const idx = parseInt(msg.dataset.msgIdx, 10);
  if (!Number.isInteger(idx)) return;
  if (!state.activeId) return;
  e.preventDefault();
  const sess = state.sessions.find(s => s.id === state.activeId);
  const starred = (sess?.starredIndices || []).includes(idx);
  openContextMenu([
    { label: starred ? '☆ 取消收藏' : '⭐ 收藏', onSelect: () => toggleStar(state.activeId, idx) },
    { label: '🍴 从这里分叉新 session', onSelect: () => forkSession(state.activeId, idx) },
    { label: '📋 复制内容', onSelect: () => {
      const body = msg.querySelector('.msg-body');
      const text = body?.dataset?.rawText || body?.textContent || '';
      // v0.50 Q-04 fix: clipboard 在非 secure context 或拒绝时降级
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => toast('已复制', 'success'))
          .catch(() => fallbackCopy(text));
      } else {
        fallbackCopy(text);
      }
    }},
  ], e.clientX, e.clientY);
});

// ─── F8 ctx 警告条 + F3 turn_end 通知 hook ─────
async function updateCtxWarningBar() {
  if (!state.activeId) { hideCtxBar(); return; }
  try {
    const r = await fetch(`/api/sessions/${state.activeId}/ctx`).then(x => x.json());
    if (r?.ok && typeof r.pct === 'number') showCtxBar(r.pct);
    else hideCtxBar();
  } catch {
    hideCtxBar();
  }
}
function ensureCtxBar() {
  let bar = document.getElementById('ctxWarningBar');
  if (bar) return bar;
  const chatArea = document.getElementById('chatArea');
  if (!chatArea) return null;
  bar = document.createElement('div');
  bar.id = 'ctxWarningBar';
  bar.className = 'ctx-warning-bar';
  bar.innerHTML = `
    <span class="ctx-warn-msg"></span>
    <button class="cxbtn cxbtn-primary cxbtn-sm ctx-warn-action" id="ctxWarnHandoff" title="开新 session 接力">🔁 接力</button>
  `;
  chatArea.insertBefore(bar, chatArea.firstChild);
  bar.querySelector('#ctxWarnHandoff').addEventListener('click', () => {
    $('#btnHandoff')?.click();
  });
  return bar;
}
function showCtxBar(pct) {
  const bar = ensureCtxBar();
  if (!bar) return;
  bar.classList.remove('warn', 'danger');
  if (pct >= 85) {
    bar.classList.add('danger');
    bar.querySelector('.ctx-warn-msg').textContent = `🚨 上下文 ${pct.toFixed(0)}% — 已接近上限，建议立即接力（一键 →）`;
  } else if (pct >= 70) {
    bar.classList.add('warn');
    bar.querySelector('.ctx-warn-msg').textContent = `⚠️ 上下文 ${pct.toFixed(0)}% — 接近上限，考虑接力`;
  }
}
function hideCtxBar() {
  const bar = document.getElementById('ctxWarningBar');
  if (bar) bar.classList.remove('warn', 'danger');
}
// 每次 ctx 刷新（status bar tick）也检查 bar
setInterval(updateCtxWarningBar, 5000);

// ─── 快捷键统一处理 ─────
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
    e.preventDefault(); openSearch();
  } else if (mod && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
    e.preventDefault(); openRoomSearch();  // v0.53 Sprint 3.5 跨房搜索
  } else if (mod && (e.key === 'p' || e.key === 'P') && !e.shiftKey && !e.altKey) {
    e.preventDefault(); openPrompts();
  } else if (mod && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
    e.preventDefault(); openCheatsheet();
  } else if (e.key === 'Escape') {
    if ($('#searchModal').style.display === 'flex') closeSearch();
    else if ($('#roomSearchModal')?.style.display === 'flex') closeRoomSearch();
    else if ($('#cheatsheetModal').style.display === 'flex') closeCheatsheet();
    else if ($('#promptsModal').style.display === 'flex') closePrompts();
  }
});

// ─── F3 长任务 turn_end 通知（在 ws message handler 已经处理 busy=false，这里 hook 全局）─────
// 监听 ws state 的 busy false 事件——简单做法：在 setInterval 4s 里检查上次 busy 状态变化
const notifTrack = { lastBusyById: new Map() };
setInterval(() => {
  const aliveIds = new Set();
  for (const s of (state.sessions || [])) {
    aliveIds.add(s.id);
    const prev = notifTrack.lastBusyById.get(s.id);
    if (prev === true && !s.busy) {
      // 这个 session 刚从 busy 变 idle → 触发通知
      maybeNotify(`✅ ${s.name} 完成`, '点击切回 panel 查看');
    }
    notifTrack.lastBusyById.set(s.id, s.busy);
  }
  // v0.51 R-15 fix: 清理已删除的 session entry，避免 Map 单调增长
  for (const id of notifTrack.lastBusyById.keys()) {
    if (!aliveIds.has(id)) notifTrack.lastBusyById.delete(id);
  }
}, 4000);

// ============ v0.52 Room Adapter 配置 modal ============
let roomAdaptersConfigDraft = null; // 当前 modal 编辑中的副本

async function openRoomAdaptersModal() {
  try {
    const r = await fetch('/api/room-adapters').then(x => x.json());
    if (!r?.ok) { toast('加载配置失败：' + (r?.error || ''), 'error'); return; }
    roomAdaptersConfigDraft = r.config;
    const modal = $('#roomAdaptersModal');
    modal.style.display = 'flex';

    // 4 个固定 section
    for (const sectionId of ['minimax', 'gemini', 'gemini_openai', 'gemini_cli']) {
      const sec = modal.querySelector(`.adapter-section[data-id="${sectionId}"]`);
      if (!sec) continue;
      const cfg = r.config[sectionId] || {};
      sec.querySelector('[data-field="enabled"]').checked = !!cfg.enabled;
      for (const field of ['apiKey', 'baseUrl', 'model']) {
        const input = sec.querySelector(`[data-field="${field}"]`);
        if (input) input.value = cfg[field] || '';
      }
      // v0.52 timeoutMs / maxTokens
      const tInput = sec.querySelector('[data-field="timeoutMs"]');
      if (tInput) tInput.value = cfg.timeoutMs || 0;
      const mInput = sec.querySelector('[data-field="maxTokens"]');
      if (mInput) mInput.value = cfg.maxTokens || 0;
    }
    // v0.52 spawn_overrides 内置 CLI adapter timeout
    const ovSec = modal.querySelector('.adapter-section[data-id="spawn_overrides"]');
    if (ovSec) {
      const ov = r.config.spawn_overrides || {};
      for (const k of ['claudeTimeoutMs', 'codexTimeoutMs', 'ccrTimeoutMs']) {
        const input = ovSec.querySelector(`[data-field="${k}"]`);
        if (input) input.value = ov[k] || 0;
      }
    }
    // gemini_cli 状态徽章
    const status = $('#geminiCliStatus');
    if (status) {
      status.textContent = r.geminiCliAvailable ? '✅ 已检测到 `gemini` 命令' : '⚠️ PATH 中未检测到 `gemini`，启用不生效';
      status.style.color = r.geminiCliAvailable ? '#16a34a' : '#dc2626';
    }
    // customs 列表
    renderCustomsList(r.config.customs || []);
    // 重置保存状态
    setAdapterSaveStatus('', '');
  } catch (e) {
    toast('加载配置异常：' + e.message, 'error');
  }
}

function closeRoomAdaptersModal() {
  $('#roomAdaptersModal').style.display = 'none';
  roomAdaptersConfigDraft = null;
}

function renderCustomsList(customs) {
  const list = $('#customsList');
  if (!list) return;
  list.innerHTML = '';
  for (const c of customs) {
    list.appendChild(renderCustomRow(c));
  }
}

function renderCustomRow(c) {
  const row = document.createElement('div');
  row.className = 'custom-row';
  row.dataset.id = c.id || '';
  row.innerHTML = `
    <div class="custom-row-head">
      <label><input type="checkbox" data-field="enabled" ${c.enabled !== false ? 'checked' : ''} /> 启用</label>
      <input type="text" data-field="displayName" class="grow" placeholder="显示名（如 Groq Llama 70B）" maxlength="80" />
      <button class="btn-icon" data-action="remove" title="删除该自定义条目">🗑</button>
    </div>
    <div class="adapter-fields">
      <label>id <input type="text" data-field="id" placeholder="标识符（字母数字-_）" pattern="[A-Za-z0-9_-]{1,40}" maxlength="40" /></label>
      <label>Model <input type="text" data-field="model" placeholder="如 llama-3.1-70b-versatile" /></label>
      <label>Base URL <input type="text" data-field="baseUrl" placeholder="如 https://api.groq.com/openai/v1" /></label>
      <label>API Key <input type="password" data-field="apiKey" placeholder="autocomplete: off" autocomplete="off" /></label>
      <label>超时（毫秒，0=默认 1 小时）<input type="number" data-field="timeoutMs" min="0" max="7200000" step="60000" placeholder="0" /></label>
      <label>最大输出 tokens（0=不传）<input type="number" data-field="maxTokens" min="0" max="200000" step="1024" placeholder="0" /></label>
    </div>
  `;
  row.querySelector('[data-field="displayName"]').value = c.displayName || '';
  row.querySelector('[data-field="id"]').value = c.id || '';
  row.querySelector('[data-field="model"]').value = c.model || '';
  row.querySelector('[data-field="baseUrl"]').value = c.baseUrl || '';
  row.querySelector('[data-field="apiKey"]').value = c.apiKey || '';
  row.querySelector('[data-field="timeoutMs"]').value = c.timeoutMs || 0;
  row.querySelector('[data-field="maxTokens"]').value = c.maxTokens || 0;
  row.querySelector('[data-action="remove"]').addEventListener('click', () => row.remove());
  return row;
}

function collectRoomAdaptersFromDOM() {
  const modal = $('#roomAdaptersModal');
  const out = {};
  for (const sectionId of ['minimax', 'gemini', 'gemini_openai', 'gemini_cli']) {
    const sec = modal.querySelector(`.adapter-section[data-id="${sectionId}"]`);
    if (!sec) continue;
    const obj = { enabled: sec.querySelector('[data-field="enabled"]').checked };
    for (const field of ['apiKey', 'baseUrl', 'model']) {
      const input = sec.querySelector(`[data-field="${field}"]`);
      if (input) obj[field] = input.value;
    }
    const tInput = sec.querySelector('[data-field="timeoutMs"]');
    if (tInput) obj.timeoutMs = parseInt(tInput.value, 10) || 0;
    const mInput = sec.querySelector('[data-field="maxTokens"]');
    if (mInput) obj.maxTokens = parseInt(mInput.value, 10) || 0;
    out[sectionId] = obj;
  }
  // v0.52 spawn_overrides
  const ovSec = modal.querySelector('.adapter-section[data-id="spawn_overrides"]');
  if (ovSec) {
    const ov = {};
    for (const k of ['claudeTimeoutMs', 'codexTimeoutMs', 'ccrTimeoutMs']) {
      const input = ovSec.querySelector(`[data-field="${k}"]`);
      ov[k] = input ? (parseInt(input.value, 10) || 0) : 0;
    }
    out.spawn_overrides = ov;
  }
  const customs = [];
  for (const row of $('#customsList').querySelectorAll('.custom-row')) {
    const tInput = row.querySelector('[data-field="timeoutMs"]');
    const mInput = row.querySelector('[data-field="maxTokens"]');
    customs.push({
      id: row.querySelector('[data-field="id"]').value.trim(),
      displayName: row.querySelector('[data-field="displayName"]').value.trim(),
      baseUrl: row.querySelector('[data-field="baseUrl"]').value.trim(),
      apiKey: row.querySelector('[data-field="apiKey"]').value,
      model: row.querySelector('[data-field="model"]').value.trim(),
      enabled: row.querySelector('[data-field="enabled"]').checked,
      timeoutMs: tInput ? (parseInt(tInput.value, 10) || 0) : 0,
      maxTokens: mInput ? (parseInt(mInput.value, 10) || 0) : 0,
    });
  }
  out.customs = customs;
  return out;
}

function setAdapterSaveStatus(text, kind) {
  const el = $('#adapterSaveStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'adapter-save-status' + (kind ? ' ' + kind : '');
}

async function saveRoomAdaptersFromModal() {
  const body = collectRoomAdaptersFromDOM();
  setAdapterSaveStatus('保存中…', '');
  try {
    const r = await fetch('/api/room-adapters', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(x => x.json());
    if (r?.ok) {
      setAdapterSaveStatus(`已保存。当前可用 adapter：${(r.activeProviders || []).join(' / ')}`, 'success');
      await refreshRoomProviders();
      // 若已开房间，刷新成员区让新 adapter 可选
      if (roomState.activeId) {
        const rr = await fetch(`/api/rooms/${roomState.activeId}`).then(x => x.json());
        if (rr?.ok) renderRoomMembers(rr.room);
      }
    } else {
      setAdapterSaveStatus('保存失败：' + (r?.error || 'unknown'), 'error');
    }
  } catch (e) {
    setAdapterSaveStatus('保存异常：' + e.message, 'error');
  }
}

$('#btnRoomAdapters')?.addEventListener('click', openRoomAdaptersModal);
$('#btnSaveRoomAdapters')?.addEventListener('click', saveRoomAdaptersFromModal);
$('#btnAddCustom')?.addEventListener('click', () => {
  $('#customsList').appendChild(renderCustomRow({ enabled: true }));
});
document.querySelectorAll('[data-close-room-adapters]').forEach(el => {
  el.addEventListener('click', closeRoomAdaptersModal);
});

// ========== v0.53 Sprint 3 — 📊 总览面板 ==========
const overviewState = {
  shown: false,
  range: '7d',
  byAdapterMetric: 'totalTokens',
  charts: { ts: null, byAdapter: null },
  globalWs: null,
  refreshTimer: null,
  chartLibLoading: null,   // Promise，避免重复注入
};

function rangeToFromIso(range) {
  const now = Date.now();
  const ms = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 }[range] || 7 * 86400000;
  return new Date(now - ms).toISOString();
}
function rangeBucket(range) { return range === '24h' ? 'hour' : 'day'; }
function fmtUSD(n) { return '$' + (n || 0).toFixed(4); }
function fmtBigInt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n || 0);
}
function fmtMs(ms) {
  if (!ms) return '0ms';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'm';
}

async function ensureChartLib() {
  if (window.Chart) return window.Chart;
  if (overviewState.chartLibLoading) return overviewState.chartLibLoading;
  overviewState.chartLibLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/chart.umd.min.js';
    s.onload = () => resolve(window.Chart);
    s.onerror = () => reject(new Error('chart.js 加载失败'));
    document.head.appendChild(s);
  });
  return overviewState.chartLibLoading;
}

function showOverviewArea() {
  $('#mainHeader').style.display = 'none';
  $('#chatArea').style.display = 'none';
  $('#termArea').style.display = 'none';
  $('#roomArea').style.display = 'none';
  $('#pluginArea') && ($('#pluginArea').style.display = 'none');
  $('#overviewArea').style.display = 'flex';
  overviewState.shown = true;
  refreshOverview();
  connectOverviewWs();
  if (!overviewState.refreshTimer) {
    overviewState.refreshTimer = setInterval(refreshOverview, 30000);
  }
}
function hideOverviewArea() {
  $('#overviewArea').style.display = 'none';
  overviewState.shown = false;
  if (state.activeId) $('#chatArea').style.display = 'flex';
  else $('#mainHeader').style.display = 'flex';
  if (overviewState.refreshTimer) {
    clearInterval(overviewState.refreshTimer);
    overviewState.refreshTimer = null;
  }
}

async function refreshOverview() {
  if (!overviewState.shown) return;
  try {
    const range = overviewState.range;
    const fromIso = rangeToFromIso(range);
    const bucket = rangeBucket(range);
    const [ov, ts, ba, health] = await Promise.all([
      fetch('/api/metrics/overview').then(r => r.json()).catch(() => ({})),
      fetch('/api/metrics/timeseries?from=' + encodeURIComponent(fromIso) + '&bucket=' + bucket).then(r => r.json()).catch(() => ({})),
      fetch('/api/metrics/by-adapter?from=' + encodeURIComponent(fromIso)).then(r => r.json()).catch(() => ({})),
      fetch('/api/metrics/health').then(r => r.json()).catch(() => ({})),
    ]);
    renderOverviewBlockA(ov);
    await renderOverviewBlockB(ts);
    await renderOverviewBlockC(ba);
    renderOverviewBlockD(health);
  } catch (e) {
    console.warn('refreshOverview failed:', e?.message);
  }
}

function renderOverviewBlockA(ov) {
  const rooms = ov?.rooms || { running: 0, paused: 0, idle: 0, error: 0, done: 0, auto_paused: 0 };
  const numbers = $('#ovRoomsNumbers');
  if (numbers) {
    const cells = [
      { lbl: '运行中', n: rooms.running || 0, cls: 'is-running' },
      { lbl: '暂停', n: (rooms.paused || 0) + (rooms.auto_paused || 0), cls: 'is-paused' },
      { lbl: '闲置', n: rooms.idle || 0, cls: '' },
      { lbl: '错误', n: rooms.error || 0, cls: 'is-error' },
      { lbl: '完成', n: rooms.done || 0, cls: 'is-done' },
    ];
    numbers.innerHTML = cells.map(c =>
      `<div class="overview-room-num ${c.cls}"><div class="n">${c.n}</div><div class="lbl">${c.lbl}</div></div>`
    ).join('');
  }
  const active = $('#ovActiveRooms');
  if (active) {
    const list = ov?.activeRooms || [];
    if (list.length === 0) {
      active.innerHTML = '<div class="overview-active-room-empty">当前没有运行/暂停的房间</div>';
    } else {
      active.innerHTML = list.map(r => {
        const modeLabel = ({ debate: '多模型辩论', squad: '团队拆活', arena: '联网核对', chat: '单聊' })[r.mode] || r.mode;
        const stCls = 'is-' + (r.status || 'idle');
        const safeName = String(r.name || '未命名').replace(/[<>&"]/g, '');
        return `<div class="overview-active-room-item" data-room-id="${r.id}">
          <span class="room-status-dot ${stCls}"></span>
          <span class="name">${safeName}</span>
          <span class="mode-chip">${modeLabel}</span>
        </div>`;
      }).join('');
      active.querySelectorAll('.overview-active-room-item').forEach(el => {
        el.addEventListener('click', () => {
          const rid = el.dataset.roomId;
          hideOverviewArea();
          showRoomArea();
          loadRooms().then(() => {
            selectRoom && selectRoom(rid);
          });
        });
      });
    }
  }
  // 顶部今日数字
  const stats = $('#ovTsStats');
  const t = ov?.today || {};
  if (stats) {
    stats.innerHTML = `
      <span class="overview-ts-stat">今日 in <strong>${fmtBigInt(t.tokensIn || 0)}</strong></span>
      <span class="overview-ts-stat">今日 out <strong>${fmtBigInt(t.tokensOut || 0)}</strong></span>
      <span class="overview-ts-stat">估算 <strong>${fmtUSD(t.costUSD || 0)}</strong></span>
      <span class="overview-ts-stat">turns <strong>${t.turns || 0}</strong></span>
    `;
  }
}

async function renderOverviewBlockB(ts) {
  const canvas = $('#ovChartTimeseries');
  if (!canvas) return;
  let Chart;
  try { Chart = await ensureChartLib(); }
  catch (e) {
    canvas.outerHTML = '<div class="overview-active-room-empty">图表库加载失败：' + e.message + '</div>';
    return;
  }
  const series = (ts?.series) || [];
  // 把 ts 字符串("2026-05-20T03" 或 "2026-05-20")格式化成更短显示
  const labels = series.map(p => p.ts.length > 10 ? p.ts.slice(5, 13).replace('T', ' ') + ':00' : p.ts.slice(5));
  const tokensIn = series.map(p => p.tokensIn || 0);
  const tokensOut = series.map(p => p.tokensOut || 0);
  const cost = series.map(p => p.costUSD || 0);
  if (overviewState.charts.ts) {
    overviewState.charts.ts.data.labels = labels;
    overviewState.charts.ts.data.datasets[0].data = tokensIn;
    overviewState.charts.ts.data.datasets[1].data = tokensOut;
    overviewState.charts.ts.data.datasets[2].data = cost;
    overviewState.charts.ts.update('none');
    return;
  }
  overviewState.charts.ts = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'tokens in', data: tokensIn, borderColor: '#1d4ed8', backgroundColor: 'rgba(29,78,216,0.08)', tension: 0.25, yAxisID: 'y' },
        { label: 'tokens out', data: tokensOut, borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.08)', tension: 0.25, yAxisID: 'y' },
        { label: 'USD（右轴）', data: cost, borderColor: '#c15f3c', borderDash: [4, 4], backgroundColor: 'transparent', tension: 0.25, yAxisID: 'y1', pointRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        y:  { beginAtZero: true, position: 'left', ticks: { callback: (v) => fmtBigInt(v) } },
        y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: (v) => '$' + v.toFixed(3) } },
      },
      plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } },
    },
  });
}

async function renderOverviewBlockC(ba) {
  const canvas = $('#ovChartByAdapter');
  if (!canvas) return;
  let Chart;
  try { Chart = await ensureChartLib(); }
  catch { return; }
  const list = (ba?.adapters || []).slice();
  const metric = overviewState.byAdapterMetric;
  list.sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  const labels = list.map(a => a.id);
  const values = list.map(a => a[metric] || 0);
  const metricLabel = {
    totalTokens: '总 tokens',
    totalCostUSD: '总成本 USD',
    avgLatencyMs: '平均延迟 ms',
    successRate: '成功率',
    count: '调用次数',
  }[metric] || metric;

  if (overviewState.charts.byAdapter) {
    overviewState.charts.byAdapter.data.labels = labels;
    overviewState.charts.byAdapter.data.datasets[0].data = values;
    overviewState.charts.byAdapter.data.datasets[0].label = metricLabel;
    overviewState.charts.byAdapter.update('none');
  } else {
    overviewState.charts.byAdapter = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: [{ label: metricLabel, data: values, backgroundColor: '#c15f3c' }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, ticks: { callback: (v) => {
            if (metric === 'totalCostUSD') return '$' + v.toFixed(2);
            if (metric === 'avgLatencyMs') return fmtMs(v);
            if (metric === 'successRate') return (v * 100).toFixed(0) + '%';
            return fmtBigInt(v);
          } } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }
  const note = $('#ovByAdapterNote');
  if (note) {
    note.textContent = list.length
      ? `共 ${list.length} 个 adapter（${overviewState.range} 窗口）。成本为估算，可能与实际账单 ±20% 偏差。`
      : '所选时间窗内无数据。跑一个房（debate / squad / arena / chat）就会出现。';
  }
}

function renderOverviewBlockD(health) {
  const stats = $('#ovHealthStats');
  const warns = $('#ovHealthWarnings');
  const p = health?.panel || {};
  const f = health?.files || {};
  if (stats) {
    const rows = [
      { k: 'panel RSS', v: (p.rssMB || 0) + ' MB' },
      { k: 'panel 堆', v: (p.heapMB || 0) + ' MB' },
      { k: 'uptime', v: fmtMs((p.uptimeS || 0) * 1000) },
      { k: '活跃房', v: health?.activeRooms || 0 },
      { k: 'data.json', v: (f.dataJsonMB || 0) + ' MB' },
      { k: 'rooms.json', v: (f.roomsJsonMB || 0) + ' MB' },
      { k: 'metrics', v: (f.metricsMB || 0) + ' MB' },
      { k: 'pid', v: p.pid || '-' },
    ];
    stats.innerHTML = rows.map(r =>
      `<div class="overview-health-row"><span class="k">${r.k}</span><span class="v">${r.v}</span></div>`
    ).join('');
  }
  if (warns) {
    const list = health?.warnings || [];
    const warningsHtml = list.length === 0
      ? '<div class="overview-health-ok">✓ 一切正常</div>'
      : list.map(w => `<div class="overview-health-warn">⚠ ${w.replace(/[<>&"]/g, '')}</div>`).join('');
    // v0.53 Sprint 3.5：retention 一键清理按钮
    warns.innerHTML = warningsHtml + `
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnRetentionClean" style="margin-top:10px;width:100%;" title="删除 X 月之前的 metrics-*.jsonl 文件">🗑 清理老 metrics</button>
    `;
    $('#btnRetentionClean')?.addEventListener('click', cleanOldMetrics);
  }
}

async function cleanOldMetrics() {
  // 默认建议：3 个月前的删
  const now = new Date();
  const ago = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const defaultMonth = `${ago.getFullYear()}-${String(ago.getMonth() + 1).padStart(2, '0')}`;
  const month = await promptModal(
    '清理 metrics（输入 YYYY-MM，删除该月份及之前的 metrics-*.jsonl）',
    defaultMonth
  );
  if (!month) return;
  if (!/^\d{4}-\d{2}$/.test(month)) { toast('格式应为 YYYY-MM', 'error'); return; }
  const confirm = await confirmModal({
    title: '清理老 metrics',
    message: `将删除 ${month} 及之前的所有 metrics-*.jsonl 文件。此操作不可撤销。`,
    confirmLabel: '删除', cancelLabel: '取消',
  });
  if (!confirm) return;
  try {
    const r = await fetch('/api/metrics?olderThan=' + encodeURIComponent(month), { method: 'DELETE' }).then(x => x.json());
    if (r.ok) {
      toast(`已删除 ${r.count} 个文件：${(r.deleted || []).join(', ') || '（无）'}`, 'success', 3500);
      refreshOverview();
    } else {
      toast('清理失败：' + (r.error || 'unknown'), 'error');
    }
  } catch (e) {
    toast('清理失败：' + e.message, 'error');
  }
}

// v0.53 Sprint 3.5：/ws/global 改为全局长连接（不依赖 overview 打开）+ 自动重连
const globalWsState = { ws: null, reconnectAttempts: 0, reconnectTimer: null };
function ensureGlobalWs() {
  if (globalWsState.ws && globalWsState.ws.readyState <= 1) return globalWsState.ws;
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/global`);
    globalWsState.ws = ws;
    ws.onopen = () => { globalWsState.reconnectAttempts = 0; };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'metrics_update') {
          if (overviewState.shown) {
            if (overviewState._pendingRefresh) return;
            overviewState._pendingRefresh = setTimeout(() => {
              overviewState._pendingRefresh = null;
              refreshOverview();
            }, 1500);
          }
        } else if (msg.type === 'health_warning') {
          // 任何时候都 toast 提醒
          const warnings = Array.isArray(msg.warnings) ? msg.warnings : [];
          for (const w of warnings.slice(0, 3)) toast('⚠️ ' + w, 'error', 8000);
          if (overviewState.shown) refreshOverview();
        }
      } catch {}
    };
    ws.onclose = () => {
      globalWsState.ws = null;
      // 指数退避重连（上限 8s，最多 8 次）
      globalWsState.reconnectAttempts++;
      if (globalWsState.reconnectAttempts > 8) return;
      const delay = Math.min(8000, 800 * Math.pow(2, globalWsState.reconnectAttempts - 1));
      if (globalWsState.reconnectTimer) clearTimeout(globalWsState.reconnectTimer);
      globalWsState.reconnectTimer = setTimeout(ensureGlobalWs, delay);
    };
    ws.onerror = () => {};
  } catch (e) {
    console.warn('connect /ws/global failed:', e.message);
  }
  return globalWsState.ws;
}
// 沿用旧名兼容
function connectOverviewWs() { ensureGlobalWs(); }

$('#btnOverview')?.addEventListener('click', () => {
  if (overviewState.shown) hideOverviewArea();
  else showOverviewArea();
});

// ========== v0.53 Sprint 3 — 🎯 房间模板 ==========
const roomTemplateState = {
  list: [],
  activeId: null,
};

function modeChip(mode) {
  const map = { debate: '🗣 多模型辩论', squad: '👥 团队拆活', arena: '🏟 联网核对', chat: '💬 单聊' };
  return map[mode] || mode;
}

async function openRoomTemplateModal() {
  $('#roomTemplateModal').style.display = 'flex';
  try {
    const r = await fetch('/api/room-templates').then(x => x.json());
    roomTemplateState.list = r.templates || [];
    renderRoomTemplateList();
    if (roomTemplateState.list.length > 0) {
      selectRoomTemplate(roomTemplateState.list[0].id);
    }
  } catch (e) {
    toast('加载模板失败：' + e.message, 'error');
  }
}

function closeRoomTemplateModal() {
  $('#roomTemplateModal').style.display = 'none';
  roomTemplateState.activeId = null;
}

function renderRoomTemplateList() {
  const root = $('#roomTemplateList');
  if (!root) return;
  const builtins = roomTemplateState.list.filter(t => t.builtin);
  const users = roomTemplateState.list.filter(t => !t.builtin);
  let html = '';
  if (builtins.length > 0) {
    html += '<div class="room-template-list-section">内置</div>';
    for (const t of builtins) html += renderRoomTemplateItem(t);
  }
  if (users.length > 0) {
    html += '<div class="room-template-list-section">我的</div>';
    for (const t of users) html += renderRoomTemplateItem(t);
  }
  if (!html) html = '<div class="muted small" style="padding: 20px;">没有可用模板</div>';
  root.innerHTML = html;
  root.querySelectorAll('.room-template-item').forEach(el => {
    el.addEventListener('click', () => selectRoomTemplate(el.dataset.tid));
  });
}

function renderRoomTemplateItem(t) {
  const active = roomTemplateState.activeId === t.id ? ' active' : '';
  return `<div class="room-template-item${active}" data-tid="${escapeHtml(t.id)}">
    <span class="tname">${escapeHtml(t.name)}</span>
    <span class="tmode"><span class="chip">${modeChip(t.mode)}</span>${(t.preset?.members || []).length} 成员</span>
  </div>`;
}

function selectRoomTemplate(id) {
  roomTemplateState.activeId = id;
  renderRoomTemplateList();
  const t = roomTemplateState.list.find(x => x.id === id);
  const root = $('#roomTemplateDetail');
  if (!root) return;
  if (!t) { root.innerHTML = '<div class="muted small">模板不存在</div>'; return; }
  const debateRoundsLine = t.mode === 'debate' && t.preset?.debateRounds
    ? `<span><strong>大轮数：</strong>${t.preset.debateRounds}</span>` : '';
  const qaStrictLine = t.mode === 'squad' && t.preset?.qaStrictness
    ? `<span><strong>QA 严格度：</strong>${escapeHtml(t.preset.qaStrictness)}</span>` : '';
  const membersHtml = (t.preset?.members || []).map(m => {
    const roleChip = m.role ? `<span class="role-chip">${escapeHtml(m.role)}</span>` : '';
    const modelChip = m.model ? `<span class="role-chip">${escapeHtml(m.model)}</span>` : '';
    const disabledHint = m.enabled === false ? ' <span class="muted">(默认禁用)</span>' : '';
    return `<li>${escapeHtml(m.displayName || m.adapterId)}${roleChip}${modelChip}${disabledHint}</li>`;
  }).join('');
  const placeholder = escapeHtml(t.preset?.topicPlaceholder || '');
  const defaultName = t.name;
  const deleteBtn = t.builtin
    ? ''
    : `<button class="cxbtn cxbtn-danger cxbtn-sm room-template-detail-delete" id="btnRoomTemplateDelete">🗑 删除此模板</button>`;
  root.innerHTML = `
    <h3>${modeChip(t.mode)} · ${escapeHtml(t.name)}</h3>
    <div class="desc">${escapeHtml(t.description || '')}</div>
    <div class="meta">
      <span><strong>类型：</strong>${modeChip(t.mode)}</span>
      <span><strong>成员：</strong>${(t.preset?.members || []).length} 个</span>
      ${debateRoundsLine}
      ${qaStrictLine}
    </div>
    <strong>成员列表</strong>
    <ul class="members-list">${membersHtml}</ul>
    <div class="room-template-detail-form">
      <label>房间名（必填）</label>
      <input id="rtNewName" maxlength="200" placeholder="给新房一个名字" value="${escapeHtml(defaultName)}" />
      <label>初始 topic（可空，建房后再填）</label>
      <input id="rtNewTopic" maxlength="500" placeholder="${placeholder}" />
      <div class="actions">
        ${deleteBtn}
        <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-close-room-template>取消</button>
        <button class="cxbtn cxbtn-primary" id="btnCreateRoomFromTemplate">▶ 用此模板建房</button>
      </div>
    </div>
  `;
  $('#btnCreateRoomFromTemplate')?.addEventListener('click', () => createRoomFromTemplate(t.id));
  $('#btnRoomTemplateDelete')?.addEventListener('click', () => deleteRoomTemplate(t.id));
  root.querySelectorAll('[data-close-room-template]').forEach(el => {
    el.addEventListener('click', closeRoomTemplateModal);
  });
}

async function createRoomFromTemplate(templateId) {
  const t = roomTemplateState.list.find(x => x.id === templateId);
  if (!t) return;
  const name = ($('#rtNewName')?.value || '').trim();
  if (!name) { toast('请填写房间名', 'error'); return; }
  const topic = ($('#rtNewTopic')?.value || '').trim();
  try {
    const r = await fetch('/api/rooms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, mode: t.mode,
        members: t.preset?.members || [],
      }),
    }).then(x => x.json());
    if (!r.ok || !r.room) { toast('创建失败：' + (r.error || 'unknown'), 'error'); return; }
    // 套 debateRounds / qaStrictness
    const patch = {};
    if (t.mode === 'debate' && t.preset?.debateRounds) patch.debateRounds = t.preset.debateRounds;
    if (t.mode === 'squad' && t.preset?.qaStrictness) patch.qaStrictness = t.preset.qaStrictness;
    if (Object.keys(patch).length > 0) {
      try {
        await fetch(`/api/rooms/${r.room.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
      } catch {}
    }
    closeRoomTemplateModal();
    await loadRooms();
    selectRoom(r.room.id);
    // 若有 topic，prefill 到输入框（不自动启动）
    if (topic) {
      setTimeout(() => {
        const ti = $('#roomTopicInput');
        if (ti) ti.value = topic;
      }, 200);
    }
    toast(`已从模板「${t.name}」创建房间`, 'success', 2500);
  } catch (e) {
    toast('创建失败：' + e.message, 'error');
  }
}

async function deleteRoomTemplate(id) {
  const t = roomTemplateState.list.find(x => x.id === id);
  if (!t || t.builtin) return;
  const ok = await confirmModal({
    title: '删除模板',
    message: `要删除模板「${t.name}」吗？此操作不可撤销（内置模板无法删除，用户模板可删）。`,
    confirmLabel: '删除',
    cancelLabel: '取消',
  });
  if (!ok) return;
  try {
    const r = await fetch(`/api/room-templates/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(x => x.json());
    if (r.ok) {
      toast('模板已删除', 'success', 1800);
      // 重新拉
      const rr = await fetch('/api/room-templates').then(x => x.json());
      roomTemplateState.list = rr.templates || [];
      renderRoomTemplateList();
      const next = roomTemplateState.list[0];
      if (next) selectRoomTemplate(next.id);
      else $('#roomTemplateDetail').innerHTML = '<div class="muted small">没有可用模板</div>';
    } else {
      toast('删除失败：' + (r.error || 'unknown'), 'error');
    }
  } catch (e) {
    toast('删除失败：' + e.message, 'error');
  }
}

$('#btnRoomNewFromTemplate')?.addEventListener('click', openRoomTemplateModal);
document.querySelectorAll('[data-close-room-template]').forEach(el => {
  el.addEventListener('click', closeRoomTemplateModal);
});
$('#btnOverviewBack')?.addEventListener('click', hideOverviewArea);
$('#btnOverviewRefresh')?.addEventListener('click', refreshOverview);
$('#overviewRangeSelect')?.addEventListener('change', (e) => {
  overviewState.range = e.target.value;
  // 切换时间窗时销毁旧 chart 重建（避免坐标轴遗留）
  if (overviewState.charts.ts) { overviewState.charts.ts.destroy(); overviewState.charts.ts = null; }
  if (overviewState.charts.byAdapter) { overviewState.charts.byAdapter.destroy(); overviewState.charts.byAdapter = null; }
  refreshOverview();
});
$('#ovByAdapterMetric')?.addEventListener('change', (e) => {
  overviewState.byAdapterMetric = e.target.value;
  if (overviewState.charts.byAdapter) { overviewState.charts.byAdapter.destroy(); overviewState.charts.byAdapter = null; }
  refreshOverview();
});

// ========== v0.54 Sprint 4 — 🔔 Webhook 出站推送 ==========
const webhookState = { items: [], activeId: null, isNew: false };

// S18-3：改走 Modal 组件，open/close 变薄壳，原 state 复位挪进 onClose hook
window.Modal?.register('webhookModal', {
  onOpen: () => refreshWebhookList(),
  onClose: () => { webhookState.activeId = null; webhookState.isNew = false; },
});
function openWebhookModal() { window.Modal.open('webhookModal'); }
function closeWebhookModal() { window.Modal.close('webhookModal'); }

async function refreshWebhookList() {
  try {
    const r = await fetch('/api/webhooks').then(x => x.json());
    webhookState.items = r.webhooks || [];
  } catch (e) {
    webhookState.items = [];
    toast('加载 webhook 列表失败：' + e.message, 'error');
  }
  renderWebhookList();
  if (webhookState.activeId) {
    const e = webhookState.items.find(w => w.id === webhookState.activeId);
    if (e) renderWebhookDetail(e);
    else { webhookState.activeId = null; renderWebhookEmpty(); }
  } else if (!webhookState.isNew) {
    renderWebhookEmpty();
  }
}

function renderWebhookList() {
  const root = $('#webhookList');
  const count = $('#webhookCount');
  if (count) count.textContent = String(webhookState.items.length);
  if (!root) return;
  if (webhookState.items.length === 0) {
    root.innerHTML = window.UI.EmptyState({ kind: 'empty', text: '还没配置 webhook · 点 ＋ 新建', padding: '12px 4px' });
    return;
  }
  root.innerHTML = webhookState.items.map(w => {
    const active = webhookState.activeId === w.id ? ' active' : '';
    const fmtBadge = ({ discord: '🟣 Discord', slack: '🟢 Slack', json: '📦 JSON' })[w.format] || w.format;
    const disabled = w.enabled === false ? window.UI.Badge({ text: '已禁用', kind: 'disabled' }) : '';
    const stats = w.stats || { successCount: 0, errorCount: 0 };
    return `<div class="webhook-item${active}" data-wid="${escapeHtml(w.id)}">
      <div class="wname">${escapeHtml(w.name)} ${window.UI.Badge({ text: fmtBadge })}${disabled}</div>
      <div class="wurl">${escapeHtml(w.url)}</div>
      <div class="wstats">触发 <span class="ok">✓${stats.successCount}</span> <span class="err">✕${stats.errorCount}</span>${stats.lastError ? ' · ' + escapeHtml(stats.lastError.slice(0, 50)) : ''}</div>
    </div>`;
  }).join('');
  root.querySelectorAll('.webhook-item').forEach(el => {
    el.addEventListener('click', () => {
      webhookState.activeId = el.dataset.wid;
      webhookState.isNew = false;
      const w = webhookState.items.find(x => x.id === webhookState.activeId);
      if (w) { renderWebhookList(); renderWebhookDetail(w); }
    });
  });
}

function renderWebhookEmpty() {
  $('#webhookDetail').innerHTML = window.UI.EmptyState({ kind: 'neutral', text: '从左侧选一项编辑，或点 ＋ 新建一个', padding: '20px' });
}

function renderWebhookDetail(w) {
  const isNew = webhookState.isNew;
  const events = w.events || ['room_done', 'room_error', 'room_auto_paused'];
  const headers = w.headers || {};
  const headersJson = Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : '';
  $('#webhookDetail').innerHTML = `
    <div class="webhook-form-row">
      <label>名字</label>
      <input id="whName" maxlength="80" placeholder="例：我的 Discord 服务器" value="${escapeHtml(w.name || '')}" />
    </div>
    <div class="webhook-form-row">
      <label>URL（必须 https://，仅 localhost 允许 http）</label>
      <input id="whUrl" maxlength="2048" placeholder="https://discord.com/api/webhooks/.../..." value="${escapeHtml(w.url || '')}" />
      ${isNew ? '' : '<div class="webhook-help-text">已存在的 webhook，URL 显示为掩码版（保留原 URL）。重新填则覆盖。</div>'}
    </div>
    <div class="webhook-form-row">
      <label>格式</label>
      <select id="whFormat">
        <option value="discord" ${w.format === 'discord' ? 'selected' : ''}>Discord（嵌入 embed 卡片）</option>
        <option value="slack" ${w.format === 'slack' ? 'selected' : ''}>Slack（attachments）</option>
        <option value="json" ${w.format === 'json' ? 'selected' : ''}>JSON（原始 event payload）</option>
      </select>
    </div>
    <div class="webhook-form-row">
      <label>订阅事件</label>
      <div class="webhook-events-row">
        <label><input type="checkbox" id="whEv_done"        ${events.includes('room_done') ? 'checked' : ''} /> 房间完成 (debate/squad/arena_done)</label>
        <label><input type="checkbox" id="whEv_error"       ${events.includes('room_error') ? 'checked' : ''} /> 房间出错 (*_error)</label>
        <label><input type="checkbox" id="whEv_auto_paused" ${events.includes('room_auto_paused') ? 'checked' : ''} /> 自动暂停</label>
      </div>
    </div>
    <div class="webhook-form-row">
      <label>自定义 headers（JSON 格式，可空）</label>
      <textarea id="whHeaders" placeholder='{"X-Token": "your-token"}'>${escapeHtml(headersJson)}</textarea>
      <div class="webhook-help-text">仅 json 格式有用。Authorization 头允许配但请谨慎。host/content-length 等被过滤。</div>
    </div>
    <div class="webhook-form-row">
      <label><input type="checkbox" id="whEnabled" ${w.enabled !== false ? 'checked' : ''} /> 启用</label>
    </div>
    <div class="webhook-form-actions">
      ${isNew ? '' : '<button class="cxbtn cxbtn-danger cxbtn-sm left-grow" id="btnWebhookDelete">🗑 删除</button>'}
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnWebhookTest" ${isNew ? 'disabled title="先保存才能测试"' : ''}>🧪 发送测试推送</button>
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-close-webhook>取消</button>
      <button class="cxbtn cxbtn-primary" id="btnWebhookSave">${isNew ? '✓ 创建' : '💾 保存'}</button>
    </div>
  `;
  $('#btnWebhookSave')?.addEventListener('click', () => saveWebhook(isNew ? null : w.id));
  $('#btnWebhookTest')?.addEventListener('click', () => testWebhookById(w.id));
  $('#btnWebhookDelete')?.addEventListener('click', () => deleteWebhook(w.id));
  // S18-3：data-close-webhook 由 Modal event delegation 接管，不再每次重绑
}

function collectWebhookFromForm() {
  const eventsArr = [];
  if ($('#whEv_done')?.checked) eventsArr.push('room_done');
  if ($('#whEv_error')?.checked) eventsArr.push('room_error');
  if ($('#whEv_auto_paused')?.checked) eventsArr.push('room_auto_paused');
  let headers = {};
  const hRaw = ($('#whHeaders')?.value || '').trim();
  if (hRaw) {
    try { const obj = JSON.parse(hRaw); if (obj && typeof obj === 'object' && !Array.isArray(obj)) headers = obj; }
    catch { throw new Error('headers JSON 解析失败'); }
  }
  return {
    name: $('#whName')?.value || '',
    url: $('#whUrl')?.value || '',
    format: $('#whFormat')?.value || 'json',
    events: eventsArr,
    headers,
    enabled: $('#whEnabled')?.checked,
  };
}

async function saveWebhook(idOrNull) {
  let body;
  try { body = collectWebhookFromForm(); }
  catch (e) { toast(e.message, 'error'); return; }
  const isNew = !idOrNull;
  // 编辑时如果 URL 是掩码（含 "..."），不覆盖（让后端保留旧 URL）—— 这里前端做：URL 含 "..." 时去掉 url 字段
  if (!isNew && body.url && body.url.includes('...')) delete body.url;
  try {
    const r = await fetch(isNew ? '/api/webhooks' : '/api/webhooks/' + encodeURIComponent(idOrNull), {
      method: isNew ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(x => x.json());
    if (r.ok) {
      toast(isNew ? '已创建' : '已保存', 'success', 1800);
      webhookState.isNew = false;
      webhookState.activeId = r.webhook?.id;
      await refreshWebhookList();
    } else {
      toast('保存失败：' + (r.error || 'unknown'), 'error');
    }
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}

async function testWebhookById(id) {
  try {
    const r = await fetch(`/api/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' }).then(x => x.json());
    if (r.ok) toast('测试推送成功 ✓ 查看目标平台确认收到', 'success', 3000);
    else toast('测试推送失败：' + (r.error || 'unknown'), 'error', 5000);
    await refreshWebhookList();
  } catch (e) { toast('测试失败：' + e.message, 'error'); }
}

async function deleteWebhook(id) {
  const w = webhookState.items.find(x => x.id === id);
  if (!w) return;
  const ok = await confirmModal({
    title: '删除 webhook',
    message: `要删除「${w.name}」吗？此操作不可撤销。`,
    confirmLabel: '删除', cancelLabel: '取消',
  });
  if (!ok) return;
  try {
    const r = await fetch('/api/webhooks/' + encodeURIComponent(id), { method: 'DELETE' }).then(x => x.json());
    if (r.ok) {
      toast('已删除', 'success', 1500);
      webhookState.activeId = null;
      await refreshWebhookList();
    } else { toast('删除失败：' + (r.error || 'unknown'), 'error'); }
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}

$('#btnWebhooks')?.addEventListener('click', openWebhookModal);

// ========== v0.54 Sprint 4.5 — 📂 聊天归档配置 ==========
// v0.84 真做 SSOT 第一步：archiveState 用 Proxy 包装，每次 set 自动镜像到 PanelStore
const _archiveStateRaw = { config: null, list: [] };
const archiveState = new Proxy(_archiveStateRaw, {
  set(target, key, value) {
    target[key] = value;
    try { window.PanelStore?.set?.(`archive.${String(key)}`, value); } catch {}
    return true;
  },
});

// S18-3：改走 Modal 组件
window.Modal?.register('archiveModal', {
  onOpen: async () => {
    await refreshArchiveConfig();
    renderArchiveModal();
    await refreshArchiveList();
    renderArchiveModal();   // 第二次渲染带上 list
  },
});
function openArchiveModal() { window.Modal.open('archiveModal'); }
function closeArchiveModal() { window.Modal.close('archiveModal'); }

async function refreshArchiveConfig() {
  try {
    const resp = await fetch('/api/archive/config');
    if (!resp.ok) {
      archiveState.config = null;
      archiveState.loadError = `HTTP ${resp.status}（panel 端点不存在？检查 panel 版本是否最新；当前 panel 可能需要重启）`;
      return;
    }
    const r = await resp.json();
    archiveState.config = r.config || null;
    archiveState.loadError = null;
  } catch (e) {
    archiveState.config = null;
    archiveState.loadError = '网络或解析错误：' + e.message;
  }
}

async function refreshArchiveList() {
  try {
    const r = await fetch('/api/archive/list').then(x => x.json());
    archiveState.list = r.items || [];
  } catch { archiveState.list = []; }
}

function archiveTreePreview(cfg) {
  const sample = '搜索2-b31b9a35';
  const sampleB = '机房-abc12345';
  const t = cfg.timeFormat === 'YYYY-MM' ? '2026-05' : '2026-05-20';
  if (cfg.structure === 'flat') {
    return `${cfg.rootPath}/\n├── final-consensus.md\n├── full-transcript.md\n└── meta.json\n\n（所有房文件混在一起，按 room id 区分；不建议房多时用）`;
  }
  if (cfg.structure === 'room-then-time') {
    return `${cfg.rootPath}/\n├── ${sample}/\n│   ├── ${t}/\n│   │   ├── final-consensus.md\n│   │   ├── full-transcript.md\n│   │   └── meta.json\n│   └── 2026-05-19/...\n└── ${sampleB}/\n    └── ${t}/...`;
  }
  // time-then-room
  return `${cfg.rootPath}/\n├── ${t}/\n│   ├── ${sample}/\n│   │   ├── final-consensus.md\n│   │   ├── full-transcript.md\n│   │   └── meta.json\n│   └── ${sampleB}/...\n└── 2026-05-19/...`;
}

function renderArchiveModal() {
  const root = $('#archiveModalBody');
  if (!root) return;
  const cfg = archiveState.config;
  if (!cfg) {
    const err = archiveState.loadError || '未知错误';
    root.innerHTML = `<div class="muted small" style="padding:20px;line-height:1.6;">
      <p>❌ <b>归档配置加载失败</b></p>
      <p style="color:#dc3545;font-family:ui-monospace,monospace;font-size:11px;">${escapeHtml(err)}</p>
      <p>常见原因：</p>
      <ol style="line-height:1.8;">
        <li>panel 版本太旧没归档端点 → 请重启 panel（终端跑 <code>kill -TERM $(lsof -iTCP:51735 -sTCP:LISTEN -t)</code> 后 <code>cd /Users/hxx/Desktop/00_项目/05_Claude可视化面板 && nohup node server.js > /tmp/panel.log 2>&1 &</code>）</li>
        <li>配置文件损坏 → 删 <code>~/.claude-panel/archive-config.json</code> 让 panel 用默认</li>
        <li>panel 后端 crash → 看 <code>/tmp/panel*.log</code></li>
      </ol>
      <p><button class="cxbtn cxbtn-primary cxbtn-sm" onclick="(async()=>{await refreshArchiveConfig();renderArchiveModal();})()">↻ 重试</button></p>
    </div>`;
    return;
  }
  const list = archiveState.list || [];
  root.innerHTML = `
    <div class="archive-section">
      <div class="archive-section-title">🌳 全局归档根目录</div>
      <div class="archive-form-row">
        <label>rootPath（绝对路径，支持 ~/）</label>
        <input id="arRootPath" maxlength="1024" value="${escapeHtml(cfg.rootPath || '')}" placeholder="~/Documents/claude-panel-archive" />
        <div class="help">所有房间完成后归档到这个目录下。沙箱限制：必须在 home 子树或 /tmp 内，不能命中 .ssh / .aws / Library/Keychains 等敏感目录。</div>
      </div>
      <div class="archive-form-row">
        <label>目录结构</label>
        <select id="arStructure">
          <option value="time-then-room" ${cfg.structure === 'time-then-room' ? 'selected' : ''}>按时间分类 → 房间名分类（推荐）</option>
          <option value="room-then-time" ${cfg.structure === 'room-then-time' ? 'selected' : ''}>按房间名分类 → 时间分类</option>
          <option value="flat" ${cfg.structure === 'flat' ? 'selected' : ''}>扁平（所有文件混在 rootPath 下）</option>
        </select>
      </div>
      <div class="archive-form-row">
        <label>时间格式</label>
        <select id="arTimeFormat">
          <option value="YYYY-MM-DD" ${cfg.timeFormat === 'YYYY-MM-DD' ? 'selected' : ''}>YYYY-MM-DD（每天一个目录）</option>
          <option value="YYYY-MM" ${cfg.timeFormat === 'YYYY-MM' ? 'selected' : ''}>YYYY-MM（每月一个目录）</option>
        </select>
      </div>
      <div class="archive-form-row">
        <label><input type="checkbox" id="arAutoArchive" ${cfg.autoArchive ? 'checked' : ''} /> 房完成后自动归档（建议开启）</label>
        <div class="help">关闭后只能手动 POST /api/archive/rooms/:id 触发，或在房详情区点"📂 立即归档"。</div>
      </div>
    </div>
    <div class="archive-section">
      <div class="archive-section-title">🌲 目录预览</div>
      <div class="archive-tree-preview" id="arTreePreview">${escapeHtml(archiveTreePreview(cfg))}</div>
    </div>
    <div class="archive-section">
      <div class="archive-section-title">📜 已归档房 (<span id="arListCount">${list.length}</span>)</div>
      <div id="arList">${
        list.length === 0
          ? '<div class="archive-list-empty">还没归档过任何房（开 autoArchive 后房完成时自动出现，或手动点立即归档）</div>'
          : list.slice(0, 20).map(it => {
              const modeLabel = ({ debate: '🗣 多模型辩论', squad: '👥 团队拆活', arena: '🏟 联网核对', chat: '💬 单聊' })[it.mode] || it.mode;
              return `<div class="archive-list-item">
                <span class="mode">${modeLabel}</span>
                <span class="name">${escapeHtml(it.name)}</span>
                <span class="dir">${escapeHtml(it.dir)}</span>
              </div>`;
            }).join('') + (list.length > 20 ? `<div class="muted small">…还有 ${list.length - 20} 个</div>` : '')
      }</div>
    </div>
    <div class="archive-actions-row">
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-close-archive>取消</button>
      <button class="cxbtn cxbtn-primary" id="btnArchiveSave">💾 保存配置</button>
    </div>
  `;
  $('#btnArchiveSave')?.addEventListener('click', saveArchiveConfig);
  // 实时预览：改 rootPath/structure/timeFormat 时刷新树
  ['#arRootPath', '#arStructure', '#arTimeFormat'].forEach(sel => {
    $(sel)?.addEventListener('input', () => {
      const preview = $('#arTreePreview');
      if (preview) {
        const pseudo = {
          rootPath: $('#arRootPath').value || cfg.rootPath,
          structure: $('#arStructure').value,
          timeFormat: $('#arTimeFormat').value,
        };
        preview.textContent = archiveTreePreview(pseudo);
      }
    });
  });
  // S18-3：data-close-archive 由 Modal event delegation 接管，不再每次重绑
}

async function saveArchiveConfig() {
  const body = {
    rootPath: $('#arRootPath').value.trim(),
    structure: $('#arStructure').value,
    timeFormat: $('#arTimeFormat').value,
    autoArchive: $('#arAutoArchive').checked,
  };
  try {
    const r = await fetch('/api/archive/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(x => x.json());
    if (r.ok) {
      archiveState.config = r.config;
      toast('已保存配置', 'success', 1800);
      renderArchiveModal();
    } else {
      toast('保存失败：' + (r.error || 'unknown'), 'error', 5000);
    }
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}

$('#btnArchive')?.addEventListener('click', openArchiveModal);
// S18-3：data-close-archive 全局绑定由 Modal event delegation 接管

// ========== v0.55 Sprint 12 — 🔌 MCP 服务器 ==========
const mcpState = { list: [], status: {}, activeName: null, isNew: false };

// S18-3：改走 Modal 组件
window.Modal?.register('mcpModal', {
  onOpen: () => refreshMcpList(),
  onClose: () => { mcpState.activeName = null; mcpState.isNew = false; },
});
function openMcpModal() { window.Modal.open('mcpModal'); }

// v0.70.3-t4: MCP 调用历史按钮（W7 接入可见）
document.addEventListener('click', async (e) => {
  if (e.target?.id !== 'btnMcpCallHistory') return;
  try {
    const r = await fetch('/api/mcp/call-history?limit=50').then(x => x.json());
    if (!r.ok) { toast('拉历史失败：' + (r.error || ''), 'error'); return; }
    const calls = r.calls || [];
    if (calls.length === 0) {
      await confirmModal({ title: '📜 MCP 调用历史', message: '当前无调用记录。\n触发任何 MCP tool（在房间内 / autopilot / squad）后这里会出现 jsonl 日志。', confirmLabel: '关闭', cancelLabel: '' });
      return;
    }
    const lines = calls.slice(-30).reverse().map(c =>
      `${c.at?.slice(11, 19) || '?'} · ${c.serverId}.${c.toolName} · ${c.durationMs}ms · ${c.success ? '✓' : '✗ ' + (c.error || '')}`
    ).join('\n');
    await confirmModal({
      title: `📜 MCP 调用历史（最近 ${calls.length}）`,
      message: lines,
      confirmLabel: '关闭', cancelLabel: '',
    });
  } catch (e) { toast('异常：' + e.message, 'error'); }
});
function closeMcpModal() { window.Modal.close('mcpModal'); }

async function refreshMcpList() {
  try {
    const r = await fetch('/api/mcp/servers').then(x => x.json());
    mcpState.list = r.servers || [];
    mcpState.status = r.status || {};
  } catch (e) {
    mcpState.list = [];
    toast('加载 MCP 列表失败：' + e.message, 'error');
  }
  renderMcpList();
  if (mcpState.activeName) {
    const e = mcpState.list.find(s => s.name === mcpState.activeName);
    if (e) renderMcpDetail(e);
    else { mcpState.activeName = null; renderMcpEmpty(); }
  } else if (!mcpState.isNew) {
    renderMcpEmpty();
  }
}

function renderMcpList() {
  const root = $('#mcpList');
  const count = $('#mcpCount');
  if (count) count.textContent = String(mcpState.list.length);
  if (!root) return;
  if (mcpState.list.length === 0) {
    root.innerHTML = window.UI.EmptyState({ kind: 'empty', text: '还没配 MCP server · 点 ＋ 新建', padding: '12px 4px' });
    return;
  }
  root.innerHTML = mcpState.list.map(s => {
    const active = mcpState.activeName === s.name ? ' active' : '';
    const disabled = s.enabled === false ? window.UI.Badge({ text: '已禁用', kind: 'disabled' }) : '';
    const typeBadge = window.UI.Badge({ text: s.type, kind: s.type });
    const desc = s.type === 'stdio'
      ? `${escapeHtml(s.command)} ${escapeHtml((s.args || []).join(' '))}`
      : escapeHtml(s.url || '');
    const st = mcpState.status[s.name];
    let statusLine = '<span class="mstatus">未连接</span>';
    if (st) {
      if (st.connected) statusLine = `<span class="mstatus"><span class="ok">● 已连接</span>${st.toolsCount != null ? ' · ' + st.toolsCount + ' tools' : ''}</span>`;
      else if (st.lastError) statusLine = `<span class="mstatus"><span class="err">● 连接失败</span> ${escapeHtml(st.lastError.slice(0, 40))}</span>`;
    }
    return `<div class="mcp-item${active}" data-name="${escapeHtml(s.name)}">
      <div class="mname">${escapeHtml(s.name)} ${typeBadge}${disabled}</div>
      <div class="mdesc">${desc}</div>
      ${statusLine}
    </div>`;
  }).join('');
  root.querySelectorAll('.mcp-item').forEach(el => {
    el.addEventListener('click', () => {
      mcpState.activeName = el.dataset.name;
      mcpState.isNew = false;
      const e = mcpState.list.find(s => s.name === mcpState.activeName);
      if (e) { renderMcpList(); renderMcpDetail(e); }
    });
  });
}

function renderMcpEmpty() {
  $('#mcpDetail').innerHTML = `
    <div class="muted small" style="padding:20px;">
      <p><b>MCP（Model Context Protocol）</b>让你给 AI 房成员挂载外部 tool。比如 filesystem server 让 Claude 读文件、playwright server 让 AI 跑浏览器、github server 让 AI 操作 PR。</p>
      <p>配置好后 Claude spawn adapter 自动启用（CLI 原生 <code>--mcp-config</code>）；Codex / Gemini CLI / HTTP adapter 待后续。</p>
      <p>常见公开 server：<code>npx -y @modelcontextprotocol/server-everything</code>（演示）/ <code>server-filesystem</code>（带路径） / <code>server-puppeteer</code>。</p>
    </div>
  `;
}

function renderMcpDetail(s) {
  const isNew = mcpState.isNew;
  const t = s.type || 'stdio';
  const args = (s.args || []).join(' ');
  const envJson = s.env && Object.keys(s.env).length > 0 ? JSON.stringify(s.env, null, 2) : '';
  const headersJson = s.headers && Object.keys(s.headers).length > 0 ? JSON.stringify(s.headers, null, 2) : '';
  const stdioFields = t === 'stdio' ? `
    <div class="mcp-form-row">
      <label>command（绝对路径或 PATH 内可执行）</label>
      <input id="mcpCommand" maxlength="256" placeholder="npx / node / /usr/local/bin/uv" value="${escapeHtml(s.command || '')}" />
      <div class="help">禁止含空格 / 元字符 ($ ; & | 等) / 危险命令（rm/curl/sudo/wget）</div>
    </div>
    <div class="mcp-form-row">
      <label>args（空格分隔；JSON 数组也行）</label>
      <input id="mcpArgs" maxlength="2048" placeholder="-y @modelcontextprotocol/server-filesystem /Users/hxx/Desktop" value="${escapeHtml(args)}" />
    </div>
    <div class="mcp-form-row">
      <label>env（JSON 对象，仅 [A-Z_] 键名）</label>
      <textarea id="mcpEnv" placeholder='{"DEBUG":"*","API_TOKEN":"..."}'>${escapeHtml(envJson)}</textarea>
      <div class="help">含 KEY/TOKEN/SECRET/PASSWORD 的值在列表中会自动掩码显示</div>
    </div>
  ` : '';
  const httpFields = t === 'sse' || t === 'http' ? `
    <div class="mcp-form-row">
      <label>URL</label>
      <input id="mcpUrl" maxlength="2048" placeholder="https://api.example.com/mcp 或 http://localhost:3000/mcp" value="${escapeHtml(s.url || '')}" />
      <div class="help">必须 https:// 或 http://localhost</div>
    </div>
    <div class="mcp-form-row">
      <label>headers（JSON 对象，可空）</label>
      <textarea id="mcpHeaders" placeholder='{"Authorization":"Bearer ..."}'>${escapeHtml(headersJson)}</textarea>
    </div>
  ` : '';

  $('#mcpDetail').innerHTML = `
    <div class="mcp-form-row">
      <label>name（唯一，只能字母数字 _ . -）</label>
      <input id="mcpName" maxlength="64" placeholder="如 filesystem / github / playwright" value="${escapeHtml(s.name || '')}" ${isNew ? '' : 'disabled'} />
      ${isNew ? '' : '<div class="help">name 创建后不可改；如需改名请删了重建</div>'}
    </div>
    <div class="mcp-form-row">
      <label>type</label>
      <select id="mcpType">
        <option value="stdio" ${t === 'stdio' ? 'selected' : ''}>stdio（最常见，本地 spawn 子进程）</option>
        <option value="sse" ${t === 'sse' ? 'selected' : ''}>sse（远程 Server-Sent Events）</option>
        <option value="http" ${t === 'http' ? 'selected' : ''}>http（远程 Streamable HTTP）</option>
      </select>
    </div>
    ${stdioFields}
    ${httpFields}
    <div class="mcp-form-row">
      <label><input type="checkbox" id="mcpEnabled" ${s.enabled !== false ? 'checked' : ''} /> 启用（Claude spawn 时自动注入此 server）</label>
    </div>
    <div id="mcpToolsArea"></div>
    <div class="mcp-form-actions">
      ${isNew ? '' : '<button class="cxbtn cxbtn-danger cxbtn-sm left-grow" id="btnMcpDelete">🗑 删除</button>'}
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnMcpTest" ${isNew ? 'disabled title="先保存才能测试"' : ''}>🧪 测试连接 + 列工具</button>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnMcpResources" ${isNew ? 'disabled title="先保存才能查看"' : ''}>📂 查看 Resources</button>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnMcpPrompts" ${isNew ? 'disabled title="先保存才能查看"' : ''}>💬 查看 Prompts</button>
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-close-mcp>取消</button>
      <button class="cxbtn cxbtn-primary" id="btnMcpSave">${isNew ? '✓ 创建' : '💾 保存'}</button>
    </div>
  `;
  // type 切换时刷新字段
  $('#mcpType')?.addEventListener('change', (e) => {
    const newT = e.target.value;
    const merged = { ...s, type: newT };
    renderMcpDetail(merged);
  });
  $('#btnMcpSave')?.addEventListener('click', () => saveMcp(isNew ? null : s.name));
  $('#btnMcpTest')?.addEventListener('click', () => testMcp(s.name));
  $('#btnMcpDelete')?.addEventListener('click', () => deleteMcp(s.name));
  // B-013: MCP resources / prompts 查看
  $('#btnMcpResources')?.addEventListener('click', () => viewMcpResources(s.name));
  $('#btnMcpPrompts')?.addEventListener('click', () => viewMcpPrompts(s.name));
  // S18-3：data-close-mcp 由 Modal event delegation 接管，不再每次重绑
}

function collectMcpFromForm() {
  const body = {
    name: $('#mcpName')?.value?.trim() || '',
    type: $('#mcpType')?.value || 'stdio',
    enabled: $('#mcpEnabled')?.checked,
  };
  if (body.type === 'stdio') {
    body.command = ($('#mcpCommand')?.value || '').trim();
    // args 支持空格分隔 或 JSON 数组
    const argsRaw = ($('#mcpArgs')?.value || '').trim();
    if (argsRaw.startsWith('[')) {
      try { body.args = JSON.parse(argsRaw); } catch { throw new Error('args JSON 解析失败'); }
    } else {
      body.args = argsRaw ? argsRaw.match(/("[^"]*"|'[^']*'|\S+)/g)?.map(s => s.replace(/^["']|["']$/g, '')) || [] : [];
    }
    const envRaw = ($('#mcpEnv')?.value || '').trim();
    body.env = envRaw ? (() => { try { return JSON.parse(envRaw); } catch { throw new Error('env JSON 解析失败'); } })() : {};
  } else {
    body.url = ($('#mcpUrl')?.value || '').trim();
    const headersRaw = ($('#mcpHeaders')?.value || '').trim();
    body.headers = headersRaw ? (() => { try { return JSON.parse(headersRaw); } catch { throw new Error('headers JSON 解析失败'); } })() : {};
  }
  return body;
}

async function saveMcp(nameOrNull) {
  let body;
  try { body = collectMcpFromForm(); }
  catch (e) { toast(e.message, 'error'); return; }
  const isNew = !nameOrNull;
  try {
    const r = await fetch(isNew ? '/api/mcp/servers' : `/api/mcp/servers/${encodeURIComponent(nameOrNull)}`, {
      method: isNew ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(x => x.json());
    if (r.ok) {
      toast(isNew ? '已创建' : '已保存', 'success', 1800);
      mcpState.isNew = false;
      mcpState.activeName = r.server?.name;
      await refreshMcpList();
    } else {
      toast('保存失败：' + (r.error || 'unknown'), 'error');
    }
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}

// B-013 v0.9：MCP resources 查看（goose-style "MCP 一等公民"）
async function viewMcpResources(name) {
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/resources`).then(x => x.json());
    if (!r.ok) { toast('拉 resources 失败：' + (r.error || ''), 'error'); return; }
    const list = r.resources || [];
    if (list.length === 0) {
      await confirmModal({ title: `📂 ${name} · Resources`, message: '该 MCP server 未暴露任何 resource。\n\nresource 是 MCP server 提供的数据源（文件/URL/查询结果等），AI 可以列出 + 读取。', confirmLabel: '关闭', cancelLabel: '' });
      return;
    }
    const lines = list.map((r, i) =>
      `[${i + 1}] ${r.name || r.uri || '?'}\n     uri: ${r.uri || '-'}\n     ${r.description ? r.description.slice(0, 100) : ''}\n     mime: ${r.mimeType || '-'}`
    ).join('\n\n');
    await confirmModal({
      title: `📂 ${name} · Resources (${list.length})`,
      message: lines,
      confirmLabel: '关闭', cancelLabel: '',
    });
  } catch (e) { toast('异常：' + e.message, 'error'); }
}

// B-013 v0.9：MCP prompts 查看
async function viewMcpPrompts(name) {
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/prompts`).then(x => x.json());
    if (!r.ok) { toast('拉 prompts 失败：' + (r.error || ''), 'error'); return; }
    const list = r.prompts || [];
    if (list.length === 0) {
      await confirmModal({ title: `💬 ${name} · Prompts`, message: '该 MCP server 未暴露任何 prompt 模板。\n\nprompt 是 MCP server 预定义的 prompt 模板（可带参数），AI 可一键应用。', confirmLabel: '关闭', cancelLabel: '' });
      return;
    }
    const lines = list.map((p, i) => {
      const args = (p.arguments || []).map(a => `${a.name}${a.required ? '*' : ''}`).join(', ');
      return `[${i + 1}] ${p.name || '?'}\n     args: ${args || '(无)'}\n     ${p.description ? p.description.slice(0, 100) : ''}`;
    }).join('\n\n');
    await confirmModal({
      title: `💬 ${name} · Prompts (${list.length})`,
      message: lines,
      confirmLabel: '关闭', cancelLabel: '',
    });
  } catch (e) { toast('异常：' + e.message, 'error'); }
}

async function testMcp(name) {
  const toolsArea = $('#mcpToolsArea');
  if (toolsArea) toolsArea.innerHTML = window.UI.EmptyState({ kind: 'loading', icon: '🧪', text: '测试连接中（首次连 stdio 可能 5-15s）…' });
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/test`, { method: 'POST' }).then(x => x.json());
    if (r.ok) {
      const tools = r.tools || [];
      toolsArea.innerHTML = `
        <div class="mcp-form-row">
          <label>✓ 连接成功 · ${tools.length} tools · ${r.resourcesCount} resources · ${r.promptsCount} prompts</label>
          <div class="mcp-tools-list">
            ${tools.length === 0 ? '<div class="muted small">此 server 未声明 tool</div>' :
              tools.map(t => `<div class="mcp-tool-item"><div class="tname">${escapeHtml(t.name)}</div>${t.description ? `<div class="tdesc">${escapeHtml(t.description.slice(0, 200))}</div>` : ''}</div>`).join('')}
          </div>
        </div>
      `;
      await refreshMcpList();
    } else {
      toolsArea.innerHTML = window.UI.EmptyState({ kind: 'error', icon: '❌', text: '连接失败：' + (r.error || 'unknown') });
    }
  } catch (e) {
    toolsArea.innerHTML = window.UI.EmptyState({ kind: 'error', icon: '❌', text: '异常：' + (e.message || '') });
  }
}

async function deleteMcp(name) {
  const ok = await confirmModal({ title: '删除 MCP server', message: `要删除「${name}」吗？相关连接会立即断开。`, confirmLabel: '删除', cancelLabel: '取消' });
  if (!ok) return;
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(x => x.json());
    if (r.ok) {
      toast('已删除', 'success', 1500);
      mcpState.activeName = null;
      await refreshMcpList();
    } else { toast('删除失败：' + (r.error || 'unknown'), 'error'); }
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}

$('#btnMcp')?.addEventListener('click', openMcpModal);

// ========== v0.56 Sprint 15-R4 — 🤖 Autopilot ==========
// v0.84 真做 SSOT mirror：autopilotState
const _autopilotStateRaw = { config: null, logs: [] };
// B-018 v0.9: 渲染 autopilot 执行日志表格
function renderAutopilotLogTable(logs) {
  if (!logs || logs.length === 0) {
    return '<div class="muted small" style="padding:12px;text-align:center;">📭 暂无日志（开启后房事件 done/error/auto_paused 会自动写）</div>';
  }
  // 按天分组
  const byDay = new Map();
  for (const l of logs.slice().reverse()) {
    const day = (l.at || '').slice(0, 10) || '未知日期';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(l);
  }
  const typeIcons = {
    fired: '✅', triggered: '✅',
    error: '❌', failed: '❌',
    skipped: '⏭', skip: '⏭',
    paused: '⏸', resumed: '▶',
  };
  const typeColors = {
    fired: 'var(--color-success)', triggered: 'var(--color-success)',
    error: 'var(--color-danger)', failed: 'var(--color-danger)',
    skipped: 'var(--gray-mid)', skip: 'var(--gray-mid)',
  };
  let html = `
    <table style="width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11.5px;">
      <thead style="position:sticky;top:0;background:var(--bg-top);z-index:1;">
        <tr style="border-bottom:1px solid var(--color-border-light);">
          <th style="text-align:left;padding:6px 8px;font-weight:600;">时间</th>
          <th style="text-align:left;padding:6px 8px;font-weight:600;">事件</th>
          <th style="text-align:left;padding:6px 8px;font-weight:600;">规则</th>
          <th style="text-align:left;padding:6px 8px;font-weight:600;">详情</th>
        </tr>
      </thead>
      <tbody>
  `;
  for (const [day, items] of byDay) {
    html += `<tr><td colspan="4" style="padding:8px;background:var(--bg-surface);font-weight:600;color:var(--color-text-foreground-secondary);">📅 ${escapeHtml(day)}（${items.length} 条）</td></tr>`;
    for (const l of items) {
      const time = (l.at || '').slice(11, 19);
      const typ = l.type || 'event';
      const icon = typeIcons[typ] || '•';
      const color = typeColors[typ] || 'var(--color-text-foreground)';
      const rule = l.ruleName || l.ruleId || '-';
      const detailParts = [];
      if (l.roomId) detailParts.push(`房=${l.roomId.slice(0, 8)}`);
      if (l.newRoomId) detailParts.push(`→ 新房=${l.newRoomId.slice(0, 8)}`);
      if (l.targetMode) detailParts.push(`mode=${l.targetMode}`);
      if (l.error) detailParts.push(`<span style="color:var(--color-danger);">err: ${escapeHtml(l.error.slice(0, 60))}</span>`);
      if (l.reason) detailParts.push(`原因: ${escapeHtml(l.reason.slice(0, 60))}`);
      const detail = detailParts.join(' · ') || '—';
      html += `
        <tr style="border-bottom:1px solid var(--color-border-light);">
          <td style="padding:4px 8px;color:var(--gray-mid);">${escapeHtml(time)}</td>
          <td style="padding:4px 8px;color:${color};">${icon} ${escapeHtml(typ)}</td>
          <td style="padding:4px 8px;min-width:0;word-break:break-word;">${escapeHtml(rule)}</td>
          <td style="padding:4px 8px;min-width:0;word-break:break-word;color:var(--color-text-foreground-secondary);">${detail}</td>
        </tr>
      `;
    }
  }
  html += '</tbody></table>';
  return html;
}

// v0.84 真做 SSOT mirror：autopilotState（_autopilotStateRaw 已在 line 5942 定义）
const autopilotState = new Proxy(_autopilotStateRaw, {
  set(target, key, value) {
    target[key] = value;
    try { window.PanelStore?.set?.(`autopilot.${String(key)}`, value); } catch {}
    return true;
  },
});

async function openAutopilotModal() {
  $('#autopilotModal').style.display = 'flex';
  await refreshAutopilot();
}
function closeAutopilotModal() { $('#autopilotModal').style.display = 'none'; }

async function refreshAutopilot() {
  try {
    const [cfg, logs] = await Promise.all([
      fetch('/api/autopilot/config').then(x => x.json()),
      fetch('/api/autopilot/log?limit=50').then(x => x.json()),
    ]);
    autopilotState.config = cfg.config || null;
    autopilotState.logs = logs.logs || [];
    renderAutopilotModal();
  } catch (e) {
    $('#autopilotModalBody').innerHTML = `<div class="muted small" style="padding:20px;color:#dc3545;">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderAutopilotModal() {
  const root = $('#autopilotModalBody');
  const cfg = autopilotState.config;
  if (!cfg) { root.innerHTML = '<div class="muted">无配置</div>'; return; }
  const logs = autopilotState.logs || [];
  const rules = cfg.rules || [];
  root.innerHTML = `
    <div class="autopilot-toggle-row">
      <span class="big-switch ${cfg.enabled ? 'is-on' : 'is-off'}">${cfg.enabled ? '🟢 已启用' : '⚪ 已关闭'}</span>
      <div class="ap-desc">
        ${cfg.enabled
          ? '房 done/error 时按下方规则自动 forward / notify；用户主动 claim 的房不动；每链最多 ' + cfg.maxHopsDefault + ' hop'
          : '默认关。开启后房自动触发跨房链路。所有动作都记日志，随时可关。'}
      </div>
      <button class="cxbtn ${cfg.enabled ? 'cxbtn-danger' : 'cxbtn-primary'}" id="btnAutopilotToggle">${cfg.enabled ? '⏸ 关闭' : '▶ 启用'}</button>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnAutopilotDryRun" title="模拟一次房间事件，看哪些规则会匹配（不真触发）">🧪 试跑</button>
    </div>

    <div>
      <div style="display:flex;align-items:center;margin-bottom:8px;">
        <h3 style="margin:0;flex:1;font-size:14px;">规则（${rules.length} 条）</h3>
        <label style="font-size:12px;color:var(--text-sec);">链路上限：
          <input type="number" id="apMaxHops" min="1" max="20" value="${cfg.maxHopsDefault}" style="width:60px;margin-left:4px;" />
        </label>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnApSaveHops" style="margin-left:6px;">💾</button>
      </div>
      <div class="autopilot-rules">
        ${rules.map(r => `
          <div class="autopilot-rule ${r.enabled ? '' : 'is-disabled'}" data-rule-id="${escapeHtml(r.id)}">
            <input type="checkbox" class="ap-rule-toggle" ${r.enabled ? 'checked' : ''} data-rule-id="${escapeHtml(r.id)}" />
            <div class="info">
              <div class="name">${escapeHtml(r.name)}${r.id.startsWith('builtin-') ? ' <span class="badge-builtin">内置</span>' : ''}</div>
              <div class="meta">事件 <b>${escapeHtml(r.when)}</b>${r.sourceMode ? ' · 仅 ' + escapeHtml(r.sourceMode) + ' 房' : ''} · 动作 <b>${escapeHtml(r.action)}</b>${r.targetMode ? ' → ' + escapeHtml(r.targetMode) : ''}${r.autoStart ? ' (autoStart)' : ''}</div>
            </div>
            ${r.id.startsWith('builtin-') ? '' : '<button class="cxbtn cxbtn-danger cxbtn-sm" data-rule-del="' + escapeHtml(r.id) + '">🗑</button>'}
          </div>
        `).join('')}
      </div>
    </div>

    <div>
      <div style="display:flex;align-items:center;margin:0 0 8px 0;gap:8px;flex-wrap:wrap;">
        <h3 style="margin:0;font-size:14px;flex:1;">📊 执行日志（${logs.length}）</h3>
        <select id="apLogFilter" class="ap-log-filter" style="font-size:12px;padding:3px 8px;border-radius:4px;border:1px solid var(--color-border-light);background:var(--bg-top);">
          <option value="">所有事件</option>
          <option value="fired">✅ 已触发</option>
          <option value="error">❌ 失败</option>
          <option value="skipped">⏭ 跳过</option>
        </select>
        <input id="apLogSearch" type="text" placeholder="搜规则名/房 ID" style="font-size:12px;padding:3px 8px;border-radius:4px;border:1px solid var(--color-border-light);background:var(--bg-top);max-width:160px;" />
      </div>
      <div class="autopilot-log-table" id="apLogTable" style="font-size:12px;border:1px solid var(--color-border-light);border-radius:6px;max-height:300px;overflow:auto;">
        ${renderAutopilotLogTable(logs)}
      </div>
    </div>

    <div class="archive-actions-row">
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnApRefresh">↻ 刷新</button>
      <button class="cxbtn cxbtn-primary" data-close-autopilot>关闭</button>
    </div>
  `;
  // B-018: 日志过滤 + 搜索
  function applyLogFilters() {
    const typ = $('#apLogFilter')?.value || '';
    const q = ($('#apLogSearch')?.value || '').trim().toLowerCase();
    let filtered = autopilotState.logs || [];
    if (typ) filtered = filtered.filter(l => (l.type || '').includes(typ));
    if (q) filtered = filtered.filter(l => JSON.stringify(l).toLowerCase().includes(q));
    const tbl = $('#apLogTable');
    if (tbl) tbl.innerHTML = renderAutopilotLogTable(filtered);
  }
  $('#apLogFilter')?.addEventListener('change', applyLogFilters);
  $('#apLogSearch')?.addEventListener('input', applyLogFilters);

  $('#btnAutopilotToggle')?.addEventListener('click', toggleAutopilot);
  // v0.70.2-t4: dry-run 按钮（学自 W9 Flowise/Langflow/n8n dry-run）
  $('#btnAutopilotDryRun')?.addEventListener('click', async () => {
    const eventType = await promptModal({
      title: '🧪 Autopilot 规则试跑',
      message: '输入模拟的事件 type（room_done / room_error / room_auto_paused）',
      value: 'room_done',
    });
    if (!eventType) return;
    try {
      const r = await fetch('/api/autopilot/dry-run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: { type: eventType.trim(), sourceRoomId: roomState?.activeId || 'fake' } }),
      }).then(x => x.json());
      if (!r.ok) { toast('试跑失败：' + (r.error || ''), 'error'); return; }
      const matched = r.matched || [], actions = r.actions || [], skipped = r.skipped || [];
      const msg = `匹配规则 ${matched.length} 条：\n${matched.map(m => '  ✓ ' + m.name).join('\n') || '  (无)'}\n\n` +
                  `会触发 ${actions.length} 个 action：\n${actions.map(a => `  → ${a.ruleName}: ${a.action}${a.targetMode ? ' → ' + a.targetMode : ''}`).join('\n') || '  (无)'}\n\n` +
                  `跳过 ${skipped.length} 条：\n${skipped.map(s => `  − ${s.name}（${s.reason}）`).join('\n') || '  (无)'}`;
      await confirmModal({ title: '🧪 试跑结果（未真触发）', message: msg, confirmLabel: '关闭', cancelLabel: '' });
    } catch (e) { toast('试跑异常：' + e.message, 'error'); }
  });
  $('#btnApSaveHops')?.addEventListener('click', saveAutopilotHops);
  $('#btnApRefresh')?.addEventListener('click', refreshAutopilot);
  root.querySelectorAll('.ap-rule-toggle').forEach(el => {
    el.addEventListener('change', () => toggleAutopilotRule(el.dataset.ruleId, el.checked));
  });
  root.querySelectorAll('[data-rule-del]').forEach(el => {
    el.addEventListener('click', () => deleteAutopilotRule(el.dataset.ruleDel));
  });
  root.querySelectorAll('[data-close-autopilot]').forEach(el => el.addEventListener('click', closeAutopilotModal));
}

async function toggleAutopilot() {
  try {
    const r = await fetch('/api/autopilot/toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !autopilotState.config.enabled }),
    }).then(x => x.json());
    if (r.ok) { toast(r.enabled ? '✓ Autopilot 已启用' : '⏸ Autopilot 已关闭', 'success', 2000); refreshAutopilot(); }
    else toast('切换失败：' + (r.error || 'unknown'), 'error');
  } catch (e) { toast('切换失败：' + e.message, 'error'); }
}
async function saveAutopilotHops() {
  const v = Number($('#apMaxHops').value) || 5;
  try {
    const r = await fetch('/api/autopilot/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxHopsDefault: v }),
    }).then(x => x.json());
    if (r.ok) { toast('已保存', 'success', 1500); refreshAutopilot(); }
    else toast('保存失败：' + (r.error || 'unknown'), 'error');
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}
async function toggleAutopilotRule(ruleId, enabled) {
  const rule = autopilotState.config.rules.find(r => r.id === ruleId);
  if (!rule) return;
  try {
    const r = await fetch('/api/autopilot/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...rule, enabled }),
    }).then(x => x.json());
    if (r.ok) refreshAutopilot();
    else toast('保存失败：' + (r.error || 'unknown'), 'error');
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}
async function deleteAutopilotRule(id) {
  // S19 B2：原 confirm() blocking + 视觉不一致，改 confirmModal danger 风格
  const ok = await confirmModal({
    title: '删除 Autopilot 规则',
    message: '确定删除此规则？此操作不可撤销。',
    confirmLabel: '删除',
    cancelLabel: '取消',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await fetch(`/api/autopilot/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(x => x.json());
    if (r.ok) { toast('已删除', 'success', 1500); refreshAutopilot(); }
    else toast('删除失败：' + (r.error || 'unknown'), 'error');
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}

$('#btnAutopilot')?.addEventListener('click', openAutopilotModal);
document.querySelectorAll('[data-close-autopilot]').forEach(el => el.addEventListener('click', closeAutopilotModal));
$('#btnMcpNew')?.addEventListener('click', () => {
  mcpState.isNew = true;
  mcpState.activeName = null;
  renderMcpList();
  renderMcpDetail({ name: '', type: 'stdio', command: '', args: [], env: {}, enabled: true });
});
// S18-3：data-close-mcp 全局绑定由 Modal event delegation 接管

// ========== v0.54 Sprint 9 — 📝 生成总结报告 ==========
const reportState = { lastResult: null };

function openReportModal() {
  if (!roomState.activeId) { toast('先选一个房间', 'warn'); return; }
  $('#reportModal').style.display = 'flex';
  renderReportForm();
}
function closeReportModal() { $('#reportModal').style.display = 'none'; reportState.lastResult = null; }

function getAvailableAdapters() {
  // 从 roomState 当前房的 members 拿默认 adapter，加上常见 fallback
  const members = (roomState.rooms || []).find(r => r.id === roomState.activeId)?.members || [];
  const ids = new Set(members.map(m => m.adapterId));
  // 加常见 fallback（即使本房没用过这个 adapter，也可能用来跑报告）
  ['claude', 'codex', 'gemini-cli', 'minimax'].forEach(id => ids.add(id));
  return Array.from(ids);
}

function renderReportForm() {
  const root = $('#reportModalBody');
  if (!root) return;
  const adapters = getAvailableAdapters();
  root.innerHTML = `
    <div class="muted small">让 AI 把本房所有 turn 浓缩成一份人类可读报告（按房模式不同输出 5-6 节）。原始记录不动，报告作为独立 markdown 输出。</div>
    <div class="report-form-row">
      <label>用哪个 AI 总结？</label>
      <select id="rpAdapter">
        ${adapters.map(a => `<option value="${escapeHtml(a)}" ${a === 'claude' ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
      </select>
      <div class="help">推荐 claude（指令遵循 + 中文输出最稳）。注意：会调一次该 adapter 的真 LLM 请求，会算成本。</div>
    </div>
    <div class="report-form-row">
      <label>model（可空，让 adapter 自己选）</label>
      <input id="rpModel" maxlength="100" placeholder="如 claude-sonnet-4-6 / 留空走默认" />
    </div>
    <div class="report-form-row">
      <label>保存路径（可空 → 不写盘，只在 modal 里看 + 下载）</label>
      <input id="rpOutputPath" maxlength="1024" placeholder="如 ~/Documents/<房名>-report.md，或留空" />
      <div class="help">填路径会写盘到该文件；勾下面的"自动路径"则用归档配置的 rootPath。</div>
    </div>
    <div class="report-form-row">
      <label><input type="checkbox" id="rpAutoPath" /> 自动路径（用归档配置的 rootPath/&lt;房名&gt;-report-&lt;时间&gt;.md）</label>
    </div>
    <div class="report-actions">
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-close-report>取消</button>
      <button class="cxbtn cxbtn-primary" id="btnReportGo">▶ 生成报告</button>
    </div>
  `;
  $('#btnReportGo')?.addEventListener('click', runReport);
  root.querySelectorAll('[data-close-report]').forEach(el => el.addEventListener('click', closeReportModal));
}

async function runReport() {
  const adapterId = $('#rpAdapter').value;
  const model = ($('#rpModel').value || '').trim();
  const outputPath = ($('#rpOutputPath').value || '').trim();
  const autoPath = $('#rpAutoPath').checked;

  // 渲染 progress
  const root = $('#reportModalBody');
  root.innerHTML = `
    <div class="report-progress">
      <span class="spinner"></span>
      正在让 ${escapeHtml(adapterId)} 总结全房聊天 — 长聊天可能 30~300s，结果通过 WS 推送回来…
      <div class="muted small" id="rpJobMeta" style="margin-top:10px;font-family:ui-monospace,monospace;font-size:11px;"></div>
    </div>
  `;

  // v0.55 Sprint 14 F1：改异步 job 模式（修 Safari fetch 60s timeout 报 "Load failed"）
  // 1) POST 立即返 jobId
  // 2) 监听 /ws/global 的 report_done / report_error 匹配 jobId
  let jobId = null;
  let resolved = false;
  let timeoutTimer = null;
  let listener = null;

  function cleanup() {
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    if (listener && globalWsState.ws) {
      try { globalWsState.ws.removeEventListener('message', listener); } catch {}
    }
    listener = null;
  }

  function fail(msg) {
    if (resolved) return; resolved = true; cleanup();
    root.innerHTML = `
      <div class="muted" style="padding:20px;color:#dc3545;">❌ 生成失败：${escapeHtml(msg)}</div>
      <div class="report-actions">
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="rpBack">← 重试</button>
        <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-close-report>关闭</button>
      </div>`;
    $('#rpBack')?.addEventListener('click', renderReportForm);
    root.querySelectorAll('[data-close-report]').forEach(el => el.addEventListener('click', closeReportModal));
  }

  function succeed(data) {
    if (resolved) return; resolved = true; cleanup();
    reportState.lastResult = data;
    renderReportPreview(data);
  }

  // 先连/确保 WS 已连
  ensureGlobalWs();

  try {
    const resp = await fetch(`/api/rooms/${roomState.activeId}/report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapterId, model, outputPath: outputPath || undefined, autoPath }),
    });
    const r = await resp.json();
    if (!resp.ok || r.error) { fail(r.error || `HTTP ${resp.status}`); return; }
    jobId = r.jobId;
    const meta = $('#rpJobMeta');
    if (meta) meta.textContent = `jobId: ${jobId}（已排队，等待 AI 返回）`;
  } catch (e) {
    fail('提交任务异常：' + e.message);
    return;
  }

  // 监听 WS 等结果（超时 5 min）
  listener = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'report_done' && msg.jobId === jobId) {
        // v0.70.2-t2: assertion warning → toast（学自 W11 promptfoo）
        if (Array.isArray(msg.assertionFailed) && msg.assertionFailed.length > 0) {
          const summary = msg.assertionFailed.map(f => `${f.type}: ${f.reason}`).join(' / ');
          toast(`⚠️ 报告质量校验 ${msg.assertionFailed.length} 项未通过：${summary}`, 'warn', 8000);
        }
        succeed({
          content: msg.content, path: msg.path,
          tokensIn: msg.tokensIn, tokensOut: msg.tokensOut,
          elapsedMs: msg.elapsedMs, truncated: msg.truncated,
        });
      } else if (msg.type === 'report_error' && msg.jobId === jobId) {
        fail(msg.error || 'unknown');
      }
    } catch {}
  };
  if (globalWsState.ws) {
    globalWsState.ws.addEventListener('message', listener);
  } else {
    // WS 还没连上时延迟挂载（ensureGlobalWs 创建后会重连）
    setTimeout(() => { if (globalWsState.ws) globalWsState.ws.addEventListener('message', listener); }, 300);
  }
  timeoutTimer = setTimeout(() => fail('超时 5 分钟未收到 AI 响应；可能 adapter 配置错或 LLM 卡了'), 5 * 60 * 1000);
}

function renderReportPreview(r) {
  const root = $('#reportModalBody');
  const tokens = `${r.tokensIn || 0} in / ${r.tokensOut || 0} out`;
  const elapsed = (r.elapsedMs / 1000).toFixed(1) + 's';
  const pathLine = r.path
    ? `<div>📂 已保存到：<code>${escapeHtml(r.path)}</code></div>`
    : `<div class="muted">未保存到磁盘（仅在此处预览，可点下方"💾 下载"保存）</div>`;
  const truncated = r.truncated ? '<div style="color:#c15f3c;">⚠️ 原内容过长，已截断到 200KB（中段被省略）</div>' : '';
  root.innerHTML = `
    <div class="report-preview-wrap">
      <div class="report-preview-meta">
        ✓ 生成完成 · 耗时 ${elapsed} · ${tokens} tokens
        ${pathLine}
        ${truncated}
      </div>
      <div class="report-preview-content" id="rpPreviewBody"></div>
      <div class="report-actions">
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="rpDownload">💾 下载 .md</button>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="rpCopy">📋 复制全文</button>
        <button class="cxbtn cxbtn-tertiary cxbtn-sm" id="rpRegenerate">↻ 换 AI 重生成</button>
        <button class="cxbtn cxbtn-primary" data-close-report>关闭</button>
      </div>
    </div>
  `;
  $('#rpPreviewBody').innerHTML = renderMarkdown(r.content || '');
  $('#rpDownload')?.addEventListener('click', () => {
    const blob = new Blob([r.content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safe = (roomState.rooms || []).find(x => x.id === roomState.activeId)?.name || 'room';
    a.href = url; a.download = safe.replace(/[\/\\:*?"<>|]/g, '_') + '-report.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('#rpCopy')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(r.content || '').then(() => toast('已复制', 'success', 1500));
  });
  $('#rpRegenerate')?.addEventListener('click', renderReportForm);
  root.querySelectorAll('[data-close-report]').forEach(el => el.addEventListener('click', closeReportModal));
}

$('#btnReportNow')?.addEventListener('click', openReportModal);
document.querySelectorAll('[data-close-report]').forEach(el => el.addEventListener('click', closeReportModal));

// ========== v0.55 Sprint 13-D — 📈 时间线 ==========
const timelineState = { chart: null };

async function openTimelineModal() {
  if (!roomState.activeId) { toast('先选一个房间', 'warn'); return; }
  $('#timelineModal').style.display = 'flex';
  const root = $('#timelineModalBody');
  root.innerHTML = '<div class="muted small" style="padding:20px;">加载中…</div>';
  try {
    const r = await fetch('/api/metrics/by-room?roomId=' + encodeURIComponent(roomState.activeId)).then(x => x.json());
    if (!r.ok || !r.turns) { root.innerHTML = `<div class="muted small" style="padding:20px;">加载失败：${escapeHtml(r.error || 'unknown')}</div>`; return; }
    renderTimeline(r.turns);
  } catch (e) {
    root.innerHTML = `<div class="muted small" style="padding:20px;color:#dc3545;">异常：${escapeHtml(e.message)}</div>`;
  }
}
function closeTimelineModal() {
  $('#timelineModal').style.display = 'none';
  if (timelineState.chart) { try { timelineState.chart.destroy(); } catch {} timelineState.chart = null; }
}

async function renderTimeline(turns) {
  const root = $('#timelineModalBody');
  if (turns.length === 0) {
    root.innerHTML = `<div class="muted small" style="padding:20px;">此房还没有任何 turn 被 metrics 记录（说明房还没真跑过 turn，或者 v0.53 metrics 引入前的旧房）</div>`;
    return;
  }
  // 排序 ascending
  turns.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const tStart = new Date(turns[0].ts).getTime();
  const tEnd = new Date(turns[turns.length - 1].ts).getTime();
  const totalLatency = turns.reduce((s, t) => s + (t.latencyMs || 0), 0);
  const totalTokIn = turns.reduce((s, t) => s + (t.tokensIn || 0), 0);
  const totalTokOut = turns.reduce((s, t) => s + (t.tokensOut || 0), 0);
  const totalCost = turns.reduce((s, t) => s + (t.estCostUSD || 0), 0);
  const errCount = turns.filter(t => !t.success).length;
  const adapters = [...new Set(turns.map(t => t.adapter))];

  root.innerHTML = `
    <div class="timeline-stats">
      <span><strong>${turns.length}</strong> turns</span>
      <span><strong>${adapters.length}</strong> adapters: ${escapeHtml(adapters.join(' / '))}</span>
      <span>跨度 <strong>${((tEnd - tStart) / 1000 / 60).toFixed(1)}</strong> min</span>
      <span>总 latency <strong>${(totalLatency / 1000).toFixed(1)}</strong> s</span>
      <span>tokens <strong>${totalTokIn}</strong> in / <strong>${totalTokOut}</strong> out</span>
      <span>估算成本 <strong>$${totalCost.toFixed(4)}</strong></span>
      <span class="${errCount > 0 ? 'badge-err' : ''}">错误 <strong>${errCount}</strong></span>
    </div>
    <div class="timeline-chart-wrap"><canvas id="timelineChart"></canvas></div>
    <div>
      <div class="timeline-row" style="font-weight:600;border-bottom:2px solid var(--line);">
        <span>时间</span><span>adapter</span><span>turn</span><span style="text-align:right;">latency</span><span style="text-align:right;">tokens out</span><span style="text-align:center;">状态</span>
      </div>
      <div class="timeline-list" id="timelineList"></div>
    </div>
  `;
  // 行列表
  const listRoot = $('#timelineList');
  listRoot.innerHTML = turns.map(t => {
    const ts = new Date(t.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const latencyStr = t.latencyMs >= 1000 ? (t.latencyMs / 1000).toFixed(1) + 's' : t.latencyMs + 'ms';
    return `<div class="timeline-row ${t.success ? '' : 'err'}">
      <span class="ts">${ts}</span>
      <span class="adapter">${escapeHtml(t.adapter)}</span>
      <span class="turn">${escapeHtml(t.turn)}</span>
      <span class="latency">${latencyStr}</span>
      <span class="tokens">${t.tokensOut || 0}</span>
      <span style="text-align:center;" class="${t.success ? 'badge-ok' : 'badge-err'}">${t.success ? '✓' : '✕'}</span>
    </div>`;
  }).join('');

  // Chart.js scatter（按 adapter 分组着色）
  try {
    const Chart = await ensureChartLib();
    const canvas = $('#timelineChart');
    const colorMap = { claude: '#a855f7', codex: '#22c55e', 'gemini-cli': '#3b82f6', gemini: '#06b6d4', minimax: '#eab308', ollama: '#0ea5e9', plugin: '#f97316', report: '#c15f3c', 'openai-api': '#6366f1' };
    const datasets = adapters.map((a) => ({
      label: a,
      data: turns.filter(t => t.adapter === a).map(t => ({
        x: new Date(t.ts).getTime() - tStart,
        y: t.latencyMs || 0,
        rawTurn: t.turn,
        success: t.success,
      })),
      backgroundColor: colorMap[a] || '#6b7280',
      borderColor: colorMap[a] || '#6b7280',
      pointRadius: 5,
    }));
    if (timelineState.chart) { try { timelineState.chart.destroy(); } catch {} }
    timelineState.chart = new Chart(canvas, {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: 'time elapsed (ms from first turn)' } },
          y: { title: { display: true, text: 'latency (ms)' }, beginAtZero: true },
        },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const p = ctx.raw;
                return `${ctx.dataset.label} · ${p.rawTurn} · ${p.y}ms · ${p.success ? '✓' : '✕'}`;
              },
            },
          },
        },
      },
    });
  } catch (e) {
    // S20 X5：chart 渲染失败用户应感知（Chart.js 卡死 / 数据格式错）
    console.warn('chart render failed:', e.message);
    toast('趋势图渲染失败：' + e.message, 'error', 4000);
  }
}

$('#btnTimeline')?.addEventListener('click', openTimelineModal);
document.querySelectorAll('[data-close-timeline]').forEach(el => el.addEventListener('click', closeTimelineModal));

// 房详情区："📂 立即归档"按钮
$('#btnArchiveNow')?.addEventListener('click', async () => {
  if (!roomState.activeId) return;
  try {
    const r = await fetch(`/api/archive/rooms/${encodeURIComponent(roomState.activeId)}`, { method: 'POST' }).then(x => x.json());
    if (r.ok) {
      toast(`已归档到 ${r.dir}（${r.files.length} 个文件）`, 'success', 5000);
    } else {
      toast('归档失败：' + (r.error || 'unknown'), 'error', 5000);
    }
  } catch (e) { toast('归档失败：' + e.message, 'error'); }
});
$('#btnWebhookNew')?.addEventListener('click', () => {
  webhookState.isNew = true;
  webhookState.activeId = null;
  renderWebhookList();
  renderWebhookDetail({
    name: '', url: '', format: 'discord',
    events: ['room_done', 'room_error', 'room_auto_paused'],
    headers: {}, enabled: true,
  });
});
// S18-3：data-close-webhook 全局绑定由 Modal event delegation 接管

// S19-2: 全局 textarea auto-resize（随内容增高，避免长文本只能滚动）
(function initAutoResize() {
  const TARGETS = ['#roomTopicInput', '#chatRoomInput', '#chatInput'];
  function fit(ta) {
    if (!ta) return;
    // 用 max-height 做硬上限，超过后转滚动
    const cs = getComputedStyle(ta);
    const maxH = parseInt(cs.maxHeight) || 600;
    ta.style.height = 'auto';
    const next = Math.min(maxH, ta.scrollHeight + 2);
    ta.style.height = next + 'px';
    ta.style.overflowY = ta.scrollHeight > maxH ? 'auto' : 'hidden';
  }
  TARGETS.forEach(sel => {
    const ta = $(sel);
    if (!ta) return;
    // 给 textarea 一个 max-height（避免无限增长撑爆 panel）
    if (!ta.style.maxHeight) ta.style.maxHeight = sel === '#roomTopicInput' ? '60vh' : '40vh';
    ta.addEventListener('input', () => fit(ta));
    // 初次设值后也 fit 一次
    setTimeout(() => fit(ta), 0);
    // 当外部 JS 改 value 时（forward seed 等），用 MutationObserver 太重，用 timer 轻探
    let lastLen = ta.value.length;
    setInterval(() => {
      if (ta.value.length !== lastLen) { lastLen = ta.value.length; fit(ta); }
    }, 600);
  });
})();

// v0.56 S17-extra：topic textarea 附件上传（选文件 / 拖拽 / 粘贴）+ 实时字数统计
(function initTopicAttachments() {
  const ta = $('#roomTopicInput');
  const fileInput = $('#topicAttachFile');
  const btn = $('#btnTopicAttach');
  const list = $('#topicAttachList');
  const count = $('#topicCharCount');
  if (!ta || !fileInput || !btn || !list || !count) return;

  const MAX_TA = 1048576;            // 1MB cap (跟 maxlength 同)
  const PER_FILE_CAP = 800 * 1024;   // 单文件 800KB cap，防一次性塞爆
  const attached = []; // {name, size}

  const fmtSize = (b) => b < 1024 ? `${b}B` : b < 1024*1024 ? `${(b/1024).toFixed(1)}K` : `${(b/1024/1024).toFixed(2)}M`;

  function renderChips() {
    list.innerHTML = attached.map((a, i) => `
      <span class="attach-chip" title="${escapeHtml(a.name)} · ${fmtSize(a.size)}">
        <span class="attach-chip-name">${escapeHtml(a.name)}</span>
        <span class="muted small">${fmtSize(a.size)}</span>
        <button class="attach-chip-rm" data-idx="${i}" title="移除该附件（仅移除标签，已 append 的内容仍在 textarea）">×</button>
      </span>
    `).join('');
    list.querySelectorAll('.attach-chip-rm').forEach(b => b.addEventListener('click', (e) => {
      const idx = +e.target.dataset.idx;
      attached.splice(idx, 1);
      renderChips();
    }));
  }

  function updateCharCount() {
    const n = ta.value.length;
    count.textContent = n >= 1000 ? `${(n/1000).toFixed(1)}K 字 / 1M 上限` : `${n} 字`;
    count.classList.toggle('warn', n > 500000 && n < 950000);
    count.classList.toggle('danger', n >= 950000);
  }
  ta.addEventListener('input', updateCharCount);
  updateCharCount();

  async function ingestFiles(files) {
    for (const f of files) {
      if (f.size > PER_FILE_CAP) {
        toast(`${f.name} 太大（${fmtSize(f.size)} > 800KB），跳过`, 'warn', 4000);
        continue;
      }
      // 只读文本
      if (f.type && !f.type.startsWith('text/') && !/\.(txt|md|json|log|csv|xml|ya?ml|html?|s?css|js|ts|py|go|rs|java|c|cpp|h|swift|kt|sh|sql|diff|patch)$/i.test(f.name)) {
        toast(`${f.name} 不像文本（${f.type || 'no mime'}），跳过`, 'warn', 4000);
        continue;
      }
      try {
        const text = await f.text();
        const remaining = MAX_TA - ta.value.length - 100;
        if (remaining <= 0) {
          toast(`textarea 已满（1MB 上限），${f.name} 无法 append`, 'error', 4000);
          break;
        }
        const insert = text.length > remaining
          ? text.slice(0, remaining) + `\n…（${f.name} 已截断，超出 1MB 上限）`
          : text;
        const sep = ta.value && !ta.value.endsWith('\n') ? '\n\n' : '\n';
        ta.value += `${sep}--- 📎 附件：${f.name}（${fmtSize(f.size)}）---\n${insert}\n--- /附件 ---\n`;
        attached.push({ name: f.name, size: f.size });
        toast(`📎 已添加 ${f.name}`, 'success', 1800);
      } catch (e) {
        toast(`读取 ${f.name} 失败：${e.message}`, 'error', 4000);
      }
    }
    renderChips();
    updateCharCount();
  }

  btn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    ingestFiles([...e.target.files]);
    e.target.value = '';
  });

  // 拖拽
  ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.classList.add('dragover'); });
  ta.addEventListener('dragleave', () => ta.classList.remove('dragover'));
  ta.addEventListener('drop', (e) => {
    e.preventDefault();
    ta.classList.remove('dragover');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) ingestFiles(files);
  });

  // 粘贴文件（如截图、复制的文件）
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      ingestFiles(files);
    }
  });
})();

// v0.56 U6：topic textarea 展开/收起
$('#btnTopicExpand')?.addEventListener('click', () => {
  const ta = $('#roomTopicInput');
  const btn = $('#btnTopicExpand');
  if (!ta) return;
  const expanded = ta.classList.toggle('is-expanded');
  document.body.classList.toggle('has-topic-expanded', expanded);
  btn.textContent = expanded ? '⤡ 收起' : '⤢ 展开';
  if (expanded) ta.focus();
});

// v0.56 U7：单 turn-card 展开/收起（事件委托到 #roomRounds）
$('#roomRounds')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.room-turn-expand');
  if (!btn) return;
  e.stopPropagation();
  const card = btn.closest('.room-turn-card');
  if (!card) return;
  const expanded = card.classList.toggle('is-expanded');
  document.body.classList.toggle('has-turn-expanded', expanded);
  btn.textContent = expanded ? '⤡' : '⤢';
  btn.title = expanded ? '收起' : '全屏展开看完整内容';
});

// v0.56 U7+S17-3：ESC 按"最上一层"顺序逐层关（confirmModal > 普通 modal > 展开态 > drawer）
function closeTopOverlay() {
  // 1. confirmModal / promptModal（动态 append，layer 最高）
  const confirms = [...document.querySelectorAll('.confirm-modal:not(.confirm-modal-closing)')];
  if (confirms.length) {
    const top = confirms[confirms.length - 1];
    // 优先点 cancel 走正常 finish(null) 路径（会 resolve Promise 给调用方）
    const cancel = top.querySelector('[data-act="cancel"]');
    if (cancel) cancel.click(); else top.remove();
    return true;
  }
  // 2. cmdk-modal（display:flex）
  const cmdkOpen = [...document.querySelectorAll('.cmdk-modal')].filter(m => m.style.display === 'flex');
  if (cmdkOpen.length) {
    cmdkOpen[cmdkOpen.length - 1].style.display = 'none';
    return true;
  }
  // 3. 普通 modal
  const modalOpen = [...document.querySelectorAll('.modal')].filter(m => m.style.display === 'flex');
  if (modalOpen.length) {
    const top = modalOpen[modalOpen.length - 1];
    // S18-3：Modal 注册过的走 Modal.close（触发 onClose hook + detach focus trap + 清 openStack）
    if (top.id && window.Modal && window.Modal.isManaged(top.id)) {
      window.Modal.close(top.id);
    } else {
      top.style.display = 'none';
    }
    return true;
  }
  // 4. turn-card 全屏展开
  const expCard = document.querySelector('.room-turn-card.is-expanded');
  if (expCard) {
    expCard.classList.remove('is-expanded');
    const btn = expCard.querySelector('.room-turn-expand');
    if (btn) { btn.textContent = '⤢'; btn.title = '全屏展开看完整内容'; }
    document.body.classList.remove('has-turn-expanded');
    return true;
  }
  // 5. topic textarea 全屏展开
  const ta = $('#roomTopicInput');
  if (ta?.classList.contains('is-expanded')) {
    ta.classList.remove('is-expanded');
    document.body.classList.remove('has-topic-expanded');
    const tb = $('#btnTopicExpand'); if (tb) tb.textContent = '⤢ 展开';
    return true;
  }
  // 6. drawer / overlay
  const drawer = document.querySelector('.squad-task-detail-overlay.open, .drawer.open, [data-overlay-open="1"]');
  if (drawer) {
    drawer.classList.remove('open');
    drawer.removeAttribute('data-overlay-open');
    return true;
  }
  return false;
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (closeTopOverlay()) e.stopPropagation();
});

// v0.56 U9+S17-4：点 modal-bg 关 modal，但要 mousedown + mouseup 都在 bg 上才算
// 避免用户在 modal 内拖选文本，鼠标抬起在 bg 上时误关
let _bgMouseDownTarget = null;
document.addEventListener('mousedown', (e) => {
  _bgMouseDownTarget = e.target.classList?.contains('modal-bg') ? e.target : null;
});
document.addEventListener('mouseup', (e) => {
  const t = _bgMouseDownTarget;
  _bgMouseDownTarget = null;
  if (!t || e.target !== t) return;
  const modal = t.closest('.modal');
  if (!modal) return;
  // S18-3：注册过 Modal 的走 Modal.close 触发 onClose hook（state 复位/focus 归位）
  if (modal.id && window.Modal && window.Modal.isManaged(modal.id)) {
    window.Modal.close(modal.id);
  } else {
    modal.style.display = 'none';
  }
});

// v0.56 U13：欢迎页 6 卡片 CTA — 点击直接进入对应流程
document.querySelectorAll('[data-cta]').forEach(btn => {
  btn.addEventListener('click', () => {
    const cta = btn.dataset.cta;
    if (cta === 'new-session') { $('#btnNew')?.click(); return; }
    if (cta === 'terminal')    { $('#btnTerminal')?.click(); return; }
    if (cta.startsWith('rooms-')) {
      const mode = cta.slice(6); // chat/debate/squad/arena
      $('#btnRooms')?.click();
      const targetBtn = ({
        chat: '#btnRoomNewChat',
        debate: '#btnRoomNewDebate',
        squad: '#btnRoomNewSquad',
        arena: '#btnRoomNewArena',
      })[mode];
      if (targetBtn) requestAnimationFrame(() => $(targetBtn)?.click());
    }
  });
});

// v0.56 U12：inspector 可拖动 resize（左侧 5px 拖动条）
(function initInspectorResize() {
  const resizer = $('#inspectorResizer');
  if (!resizer) return;
  const KEY = 'panel:inspectorW';
  const MIN = 220, MAX = 700, DEFAULT = 340;
  // 恢复持久化宽度
  const saved = parseInt(localStorage.getItem(KEY) || '0', 10);
  if (saved >= MIN && saved <= MAX) {
    document.documentElement.style.setProperty('--inspector-w', saved + 'px');
  }
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    resizer.classList.add('dragging');
    document.body.classList.add('inspector-dragging');
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // 鼠标距右边距离 = inspector 宽度
    const w = Math.min(MAX, Math.max(MIN, window.innerWidth - e.clientX));
    document.documentElement.style.setProperty('--inspector-w', w + 'px');
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('inspector-dragging');
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--inspector-w'), 10);
    if (w) localStorage.setItem(KEY, String(w));
  });
  // 双击复位
  resizer.addEventListener('dblclick', () => {
    document.documentElement.style.setProperty('--inspector-w', DEFAULT + 'px');
    localStorage.setItem(KEY, String(DEFAULT));
  });
})();

// v0.56 U3：inspector 折叠/展开按钮（持久化到 localStorage）
(function initInspectorToggle() {
  // v0.70.2: debate-state log clear 按钮
  $('#btnDebateStateClear')?.addEventListener('click', () => {
    const log = $('#debateStateLog');
    if (log) log.innerHTML = '<div class="muted small">— 等待 debate_state_meta WS 事件 —</div>';
  });
  const btn = $('#btnInspectorToggle');
  if (!btn) return;
  const KEY = 'panel:inspectorHidden';
  const apply = () => {
    const hidden = localStorage.getItem(KEY) === '1';
    document.body.classList.toggle('inspector-hidden', hidden);
    btn.textContent = hidden ? '⇤' : '⇥';
    btn.title = hidden ? '展开右侧 inspector 面板' : '折叠右侧 inspector 面板';
  };
  apply();
  btn.addEventListener('click', () => {
    const hidden = document.body.classList.contains('inspector-hidden');
    localStorage.setItem(KEY, hidden ? '0' : '1');
    apply();
  });
})();

// 启动
listSessions();
showEmpty();
// S21 P2：visibility-aware polling — 页面隐藏时不 fetch（省电 + 省网络）
// 用户切回 panel 时 visibilitychange 触发立即拉一次同步
setInterval(() => { if (!document.hidden) listSessions(); }, 4000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) listSessions();
});
// v0.53 Sprint 3.5：建立 /ws/global 全局连接，接 health_warning 推送
ensureGlobalWs();
