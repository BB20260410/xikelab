// Claude Panel — 前端

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

// ─── v0.8 ConfirmModal（替代 confirm()）─────
// Promise<boolean> — true=确认 / false=取消
// opts: { title, message, confirmLabel='确认', cancelLabel='取消', danger=false }
function confirmModal(opts) {
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
      if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
    };
    overlay.querySelector('.confirm-modal-bg').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-act="confirm"]').addEventListener('click', () => finish(true));
    document.addEventListener('keydown', keyHandler);
    document.body.appendChild(overlay);
    setTimeout(() => overlay.querySelector('[data-act="confirm"]').focus(), 30);
  });
}

// ─── v0.9 PromptModal（替代 prompt()）─────
// Promise<string|null> — string=确认带值 / null=取消
// opts: { title, message, value='', placeholder='', confirmLabel='确认', cancelLabel='取消', multiline=false }
function promptModal(opts) {
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
      if (e.key === 'Enter' && !opts.multiline) {
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
  const [active, archived] = await Promise.all([
    api('/api/sessions'),
    api('/api/sessions?archived=1'),
  ]);
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
    state.activeId = null;
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
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
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
    state.activeId = null;
    showEmpty();
  }
  await listSessions();
}

function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortenPath(p) {
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
    _markedConfigured = true;
  } catch (e) {
    console.warn('marked.use renderer failed:', e.message);
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
  html = html.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
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

function appendMessage(m) {
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
  const time = new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let icon = '·';
  if (m.role === 'user') icon = '👤';
  else if (m.role === 'assistant') icon = '🤖';
  else if (m.role === 'tool_use') icon = '🔧';
  else if (m.role === 'system') icon = '🔁';
  div.innerHTML = `
    <div class="msg-head">
      <span class="msg-icon">${icon}</span>
      <span class="msg-role">${m.role}</span>
      <span class="msg-time">${time}</span>
    </div>
    <div class="msg-body">${renderMarkdown(m.content)}</div>
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
  if (s.messages) s.messages.forEach(appendMessage);
  // 切到文件 tab 时刷新文件列表
  if (currentTab === 'files') loadFiles(s.cwd);
  // 加载 snapshot + meta + ctx（不论 tab 是哪个，badge 都要更新）
  refreshSnapshot();
  refreshCtx();
  startSnapshotPolling();
  updateWatcherToggleUI();
  $('#watcherVerdictBanner').style.display = 'none'; // 切 session 关闭旧 verdict

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws/${id}`);
  state.ws.addEventListener('message', ev => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'message') {
        appendMessage(msg.message);
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
}
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
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    send();
  }
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

function attachWatcherSectionHandlers() {
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

function formatSize(b) {
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
    const { content } = await api('/api/file?path=' + encodeURIComponent(path));
    const input = $('#chatInput');
    const ext = path.split('.').pop();
    const ref = `\n\n参考文件 ${path}:\n\`\`\`${ext}\n${(content||'').substring(0, 2000)}\n\`\`\`\n\n`;
    input.value = input.value + ref;
    input.focus();
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
  localStorage.setItem('cp-theme', theme);
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

  // 命令组
  const COMMANDS = [
    { type: 'cmd', icon: '＋', title: '新建会话', subtitle: '⌘N', action: () => { closeCmdk(); openModal(); } },
    { type: 'cmd', icon: '🌓', title: '切换主题（暗/亮）', subtitle: '⌘D', action: () => { toggleTheme(); closeCmdk(); } },
    { type: 'cmd', icon: '🔄', title: '为当前会话接力', subtitle: '需先选中一个会话', action: () => { closeCmdk(); $('#btnHandoff')?.click(); } },
    { type: 'cmd', icon: '⤴', title: '在 Terminal 打开当前会话', subtitle: '', action: () => { closeCmdk(); $('#btnExternal')?.click(); } },
  ];
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
  } else if (e.key === 'Enter') {
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
(async () => {
  try {
    const r = await api('/api/version');
    const sub = $('#brandSubtitle');
    if (sub && r.version) sub.textContent = `多会话管理 · v${r.version}`;
    const title = $('#brandTitle');
    if (title && r.appName) title.textContent = r.appName;
  } catch {}
})();

// 启动
listSessions();
showEmpty();
setInterval(listSessions, 4000);
