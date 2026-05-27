// Xike Lab — 前端

// Round 5：owner-token bootstrap —— 后端启动时打印 ?t=<token> 入口 URL；
// 这里读出存 sessionStorage 然后清掉 URL（避免 referer / 浏览历史 / 截图泄漏）。
// 之后 api() 和 wsUrl() 自动注入；用户手动复制 URL 才能拿 token，
// 本机其他 UID 裸 curl `/` 拿不到（HTML 静态文件不 inject）。
(() => {
  try {
    const params = new URLSearchParams(location.search);
    const t = (params.get('t') || '').trim();
    if (t && t.length >= 32) {
      sessionStorage.setItem('panel-owner-token', t);
      params.delete('t');
      const q = params.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    }
  } catch {}
})();
function getOwnerToken() {
  try { return sessionStorage.getItem('panel-owner-token') || ''; } catch { return ''; }
}
function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getOwnerToken();
  const sep = path.includes('?') ? '&' : '?';
  return `${proto}://${location.host}${path}${token ? sep + 'token=' + encodeURIComponent(token) : ''}`;
}

// Round 5：全局 fetch 劫持兜底 —— app.js 有 70+ 处直接 fetch('/api/...')，
// 改每处太繁琐易漏；这里只对同源 /api/ 和 /v1/ 路径注入 token，
// 跨域请求（anthropic.com 等）和已被显式设过 header 的请求不受影响。
(() => {
  if (window.__panelFetchPatched) return;
  window.__panelFetchPatched = true;
  const _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string'
        ? input
        : (input && typeof input.url === 'string' ? input.url : '');
      const sameOriginApi = url.startsWith('/api/') || url.startsWith('/v1/');
      if (sameOriginApi && typeof input === 'string') {
        const token = getOwnerToken();
        if (token) {
          init = init || {};
          const h = new Headers(init.headers || {});
          if (!h.has('X-Panel-Owner-Token')) h.set('X-Panel-Owner-Token', token);
          init.headers = h;
        }
      }
    } catch {}
    return _fetch(input, init);
  };
})();

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

function queuePanelStoreMirror(path, value) {
  try {
    if (window.PanelStore?.set) {
      window.PanelStore.set(path, value);
      return;
    }
    const pending = window.__panelPendingStateMirrors ||= [];
    const existing = pending.find(item => item && item.path === path);
    if (existing) existing.value = value;
    else pending.push({ path, value });
  } catch {}
}

function createPanelMirroredState(namespace, initialState) {
  for (const key of Object.keys(initialState || {})) {
    queuePanelStoreMirror(`${namespace}.${key}`, initialState[key]);
  }
  return new Proxy(initialState, {
    set(target, key, value) {
      target[key] = value;
      queuePanelStoreMirror(`${namespace}.${String(key)}`, value);
      return true;
    },
  });
}

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getOwnerToken();
  if (token) headers['X-Panel-Owner-Token'] = token;
  const r = await fetch(path, {
    ...opts,
    headers,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── P2 权限治理 UI 闭环：高风险写操作「审批后安全重试」─────
// 后端约定：ask → HTTP 202 + { ok:false, error:'approval_required', approval, approvalId }
//          deny → HTTP 403 + { ok:false, error:'permission_denied', permissionDecision }
// 本机制只引导用户「批准后带 approvalId 重试同一请求」，绑定原 action/target，
// 不自动重放危险终端命令（shell.exec 类不接入此机制）。
async function requestWithApproval(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getOwnerToken();
  if (token) headers['X-Panel-Owner-Token'] = token;
  let r;
  try {
    r = await fetch(path, { ...opts, headers });
  } catch (e) {
    return { status: 'error', httpStatus: 0, error: e.message };
  }
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  if (r.status === 202 && body && body.error === 'approval_required') {
    return {
      status: 'approval_required',
      httpStatus: 202,
      body,
      approvalId: body.approvalId || body.approval?.id || null,
      approval: body.approval || null,
      permissionDecision: body.permissionDecision || null,
    };
  }
  if (r.status === 403 && body && body.error === 'permission_denied') {
    return { status: 'denied', httpStatus: 403, body, permissionDecision: body.permissionDecision || null };
  }
  if (!r.ok || (body && body.ok === false)) {
    return { status: 'error', httpStatus: r.status, body, error: (body && body.error) || `HTTP ${r.status}` };
  }
  return { status: 'ok', httpStatus: r.status, body };
}

// 批准最新一个 approval 后带「全部已批准的 approvalId」重发原请求。
// approvalId 走 X-Panel-Approval-Id header（逗号分隔，不改原 body，避免污染配置类入口 payload）；
// 后端按 action/target 各自匹配对应 id，支持 watcher 这类同一请求内多重审批的链式批准。
async function approveAndRetryRequest(approvalIds, path, opts = {}) {
  const ids = (Array.isArray(approvalIds) ? approvalIds : [approvalIds]).filter(Boolean);
  if (!ids.length) throw new Error('缺少 approvalId');
  await api(`/api/approvals/${encodeURIComponent(ids[ids.length - 1])}/approve`, {
    method: 'POST',
    body: JSON.stringify({ reason: '审批后重试原操作' }),
  });
  const retryOpts = { ...opts, headers: { ...(opts.headers || {}), 'X-Panel-Approval-Id': ids.join(',') } };
  return requestWithApproval(path, retryOpts);
}

function maskUrlForDisplay(url) {
  const s = String(url || '');
  try { const u = new URL(s); return u.host + (u.pathname && u.pathname !== '/' ? '/…' : ''); }
  catch { return s.length > 40 ? s.slice(0, 40) + '…' : s; }
}

// 通用「需要审批」弹窗：展示 approval payload 摘要，返回 Promise<'approve'|'cancel'>（纯展示+等待决定）
function openApprovalRetryModal(opts = {}) {
  const { approvalId, approval, permissionDecision, actionLabel } = opts;
  const payload = approval?.payload || permissionDecision?.approvalPayload || {};
  const target = payload.target || {};
  const action = payload.action || permissionDecision?.action || '-';
  const risk = payload.risk || permissionDecision?.risk || 'high';
  const reason = payload.reason || permissionDecision?.reason || '需要人工批准';
  const urlDisp = target.url ? maskUrlForDisplay(target.url) : '';
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal approval-retry-modal';
    overlay.setAttribute('data-approval-retry-modal', approvalId || '');
    overlay.innerHTML = `
      <div class="confirm-modal-bg"></div>
      <div class="confirm-modal-body">
        <h3 class="confirm-modal-title">需要人工批准${actionLabel ? '：' + escapeHtml(actionLabel) : ''}</h3>
        <div class="approval-retry-summary">
          <div class="approval-retry-row"><span>操作</span><code>${escapeHtml(String(action))}</code></div>
          ${target.operation ? `<div class="approval-retry-row"><span>动作</span><code>${escapeHtml(String(target.operation))}</code></div>` : ''}
          ${urlDisp ? `<div class="approval-retry-row"><span>目标</span><code>${escapeHtml(urlDisp)}</code></div>` : ''}
          <div class="approval-retry-row"><span>风险</span><code>${escapeHtml(String(risk))}</code></div>
          <div class="approval-retry-row"><span>原因</span><span>${escapeHtml(String(reason))}</span></div>
          <div class="approval-retry-row"><span>审批 ID</span><code>${escapeHtml(approvalId || '-')}</code></div>
        </div>
        <div class="approval-retry-note">批准后将带 approvalId 重试同一操作（绑定原 action/target）；不会自动重放危险终端命令。</div>
        <div class="confirm-modal-actions">
          <button class="cxbtn cxbtn-tertiary" data-approval-retry-open-center>打开审批中心</button>
          <button class="cxbtn cxbtn-secondary" data-approval-retry-cancel>取消</button>
          <button class="cxbtn cxbtn-primary" data-approval-retry-confirm>批准并重试</button>
        </div>
      </div>
    `;
    let settled = false;
    const finish = (decision) => { if (settled) return; settled = true; overlay.remove(); resolve(decision); };
    overlay.querySelector('.confirm-modal-bg').addEventListener('click', () => finish('cancel'));
    overlay.querySelector('[data-approval-retry-cancel]').addEventListener('click', () => finish('cancel'));
    overlay.querySelector('[data-approval-retry-open-center]').addEventListener('click', () => {
      finish('cancel');
      try { openApprovalModal?.(); } catch { /* 审批中心可能未加载 */ }
    });
    overlay.querySelector('[data-approval-retry-confirm]').addEventListener('click', () => finish('approve'));
    document.body.appendChild(overlay);
  });
}

// 处理（可能多步的）审批后重试链：弹窗 → 批准 → 重试 → 若仍需审批则对下一个 approval 再弹，
// 直到 ok / denied / error / 用户取消。支持 watcher 这类双重审批入口。单 approval 入口只循环一次。
async function handleApprovalFlow(initialResult, path, opts, handlers = {}) {
  const { actionLabel = '', onOk, onDenied, onError, maxSteps = 5 } = handlers;
  let res = initialResult;
  let step = 0;
  const approvedIds = []; // 累积所有已批准的 approvalId，重试时全部带上（双重审批入口每步匹配各自的）
  while (res && res.status === 'approval_required') {
    step += 1;
    if (step > maxSteps) {
      toast('审批步骤过多，请到审批中心逐项处理', 'error', 5000);
      return;
    }
    const decision = await openApprovalRetryModal({
      approvalId: res.approvalId,
      approval: res.approval,
      permissionDecision: res.permissionDecision,
      actionLabel: step > 1 ? `${actionLabel}（第 ${step} 步审批）` : actionLabel,
    });
    if (decision !== 'approve') return; // 用户取消，静默
    if (res.approvalId && !approvedIds.includes(res.approvalId)) approvedIds.push(res.approvalId);
    try {
      res = await approveAndRetryRequest(approvedIds, path, opts);
    } catch (e) {
      res = { status: 'error', error: e.message || String(e) };
    }
  }
  if (!res) return;
  if (res.status === 'ok') { if (onOk) await onOk(res); }
  else if (res.status === 'denied') {
    if (onDenied) onDenied(res);
    else toast('操作被拒绝：' + (res.permissionDecision?.reason || 'permission denied'), 'error', 5000);
  } else {
    if (onError) onError(res);
    else toast('操作失败：' + (res.error || res.status || 'unknown'), 'error');
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
      let safe = window.DOMPurify.sanitize(raw, {
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
      // B-005 v0.9：外链图片走本地缓存 proxy（防外链失效）
      safe = safe.replace(/<img\b([^>]*?)\ssrc=["'](https?:\/\/[^"']+)["']/gi, (m, attrs, src) => {
        return `<img${attrs} src="/api/img-cache?url=${encodeURIComponent(src)}" data-original-src="${src.replace(/"/g, '&quot;')}"`;
      });
      return safe;
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
  state.ws = new WebSocket(wsUrl(`/ws/${id}`));
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
          for (const [, div] of state.streamingDivs) {
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
      } else if (msg.type === 'approval_required') {
        handleApprovalRequired(msg);
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
    } catch {}
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
  } catch {
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
  } catch { wrap.innerHTML = ''; }
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
    // watcher config 是双重审批入口（provider.model_config.write + auto_accept.scope），走链式批准
    const path = '/api/watcher/config';
    const opts = { method: 'PUT', body: JSON.stringify(body) };
    const result = await requestWithApproval(path, opts);
    await handleApprovalFlow(result, path, opts, {
      actionLabel: '写入监视者 Provider 配置',
      onOk: (r) => toast('监视者配置已保存' + (r.body?.adapterActive ? '（adapter active）' : ''), 'success', 3000),
      onError: (r) => toast('保存失败：' + (r.error || 'unknown'), 'error'),
    });
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
    const ws = new WebSocket(wsUrl(`/ws/term/${r.termId}`));
    termState.ws = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'data') xterm.write(msg.data);
        else if (msg.type === 'approval_required') {
          handleApprovalRequired(msg);
        } else if (msg.type === 'exit') {
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
  activeRoom: null,
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
  roomState.activeRoom = null;
  renderRoomLineage(null);
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
    const objectiveTitle = r.objective?.title || r.lineage?.taskId || '';
    const objectiveHtml = objectiveTitle
      ? `<div class="room-list-item-objective" title="${escapeHtml(objectiveTitle)}">目标 ${escapeHtml(objectiveTitle.slice(0, 42))}${objectiveTitle.length > 42 ? '…' : ''}</div>`
      : '';
    div.innerHTML = `
      <div class="room-list-item-name">${escapeHtml(r.name || '未命名')}</div>
      ${objectiveHtml}
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
      roomState.activeRoom = null;
      $('#roomDebate').style.display = 'none';
      $('.room-empty').style.display = '';
      renderRoomLineage(null);
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
      toast(r.error || '创建失败', 'error');
    }
  } catch (e) {
    toast('创建失败：' + e.message, 'error');
  }
}

async function selectRoom(id) {
  roomState.activeId = id;
  roomState.activeRoom = null;
  if (roomState.ws) { try { roomState.ws.close(); } catch {} roomState.ws = null; }
  renderRoomList();
  const r = await fetch(`/api/rooms/${id}`).then(x => x.json());
  if (!r.ok) return;
  roomState.activeRoom = r.room;
  renderRoomDebate(r.room);
  // v0.51 S-27 fix: room WS 自动重连（指数退避，最多 5 次）
  roomState.wsReconnectAttempts = 0;
  attachRoomWS(id);
}
function attachRoomWS(id) {
  const ws = new WebSocket(wsUrl(`/ws/room/${id}`));
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
  roomState.activeRoom = room || null;
  $('#roomDebate').style.display = 'flex';
  $('.room-empty').style.display = 'none';
  renderRoomLineage(room);
  $('#roomNameDisplay').textContent = (room.name || '未命名') + (
    room.mode === 'squad' ? '  · 团队拆活' :
    room.mode === 'chat'  ? '  · 单聊'  :
    room.mode === 'arena' ? '  · 联网核对'  :
    '  · 辩论'
  );
  {
    const _topicTa = $('#roomTopicInput');
    _topicTa.value = room.topic || '';
    _topicTa.dispatchEvent(new Event('input', { bubbles: false }));
  }
  updateRoomStatusChip(room.status);
  renderRoomMembers(room);
  renderRoomSkillBindings(room);
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

function statusLabel(status) {
  return ROOM_STATUS_ZH[status] || status || '未知';
}

function shortLineageValue(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.length <= 36) return s;
  return `${s.slice(0, 14)}…${s.slice(-14)}`;
}

function renderRoomLineage(room) {
  const panel = $('#roomLineagePanel');
  if (!panel) return;
  if (!room) {
    panel.innerHTML = `
      <div class="room-lineage-title">目标追溯</div>
      <div class="room-lineage-empty">选择房间后显示目标、任务链路和上下文注入状态。</div>`;
    return;
  }

  const objective = room.objective || null;
  const lineage = room.lineage || {};
  const contextSummary = room.projectContextSummary || room.projectContext || null;
  const tasks = Array.isArray(room.taskList) ? room.taskList : [];
  const counts = tasks.reduce((acc, t) => {
    const key = t?.status || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const acceptance = Array.isArray(objective?.acceptanceCriteria) ? objective.acceptanceCriteria : [];
  const lineageRows = [
    ['project', lineage.projectId || room.cwd || ''],
    ['objective', lineage.objectiveId || objective?.id || ''],
    ['task', lineage.taskId || ''],
    ['parent room', lineage.parentRoomId || ''],
    ['parent task', lineage.parentTaskId || ''],
    ['source', lineage.source || 'manual'],
  ].filter(([, value]) => value);
  const taskChips = tasks.slice(0, 10).map(t => {
    const st = t?.status || 'unknown';
    const title = t?.title || t?.id || 'task';
    return `<span class="room-lineage-task-chip ${escapeHtml(st)}" title="${escapeHtml(st)} · ${escapeHtml(title)}">${escapeHtml(t?.id || title)}</span>`;
  }).join('');
  const hiddenTasks = tasks.length > 10 ? `<span class="room-lineage-task-chip">+${tasks.length - 10}</span>` : '';
  const countText = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' / ');
  const contextFiles = Array.isArray(contextSummary?.files)
    ? contextSummary.files.slice(0, 3).map(f => f.name || f.path).filter(Boolean)
    : [];

  panel.innerHTML = `
    <div class="room-lineage-title">目标追溯</div>
    <div class="room-lineage-node">
      <div class="label">当前目标</div>
      <div class="value">${escapeHtml(objective?.title || room.name || '未命名目标')}</div>
      <div class="room-lineage-path">
        <span>状态 ${escapeHtml(statusLabel(objective?.status || room.status))}${acceptance.length ? ` · 验收 ${acceptance.length} 条` : ''}</span>
        ${objective?.description ? `<span>${escapeHtml(objective.description.slice(0, 120))}${objective.description.length > 120 ? '…' : ''}</span>` : ''}
      </div>
    </div>
    <div class="room-lineage-node">
      <div class="label">链路</div>
      <div class="room-lineage-path">
        ${lineageRows.length ? lineageRows.map(([label, value]) => `<span>${escapeHtml(label)} <code title="${escapeHtml(value)}">${escapeHtml(shortLineageValue(value))}</code></span>`).join('') : '<span>未记录 lineage</span>'}
      </div>
    </div>
    <div class="room-lineage-node">
      <div class="label">任务</div>
      <div class="value">${tasks.length ? `${tasks.length} 个任务` : '暂无任务'}</div>
      ${countText ? `<div class="room-lineage-path"><span>${escapeHtml(countText)}</span></div>` : ''}
      ${taskChips || hiddenTasks ? `<div class="room-lineage-task-list">${taskChips}${hiddenTasks}</div>` : ''}
    </div>
    <div class="room-lineage-node">
      <div class="label">项目上下文</div>
      <div class="value">${contextSummary?.fileCount ? `${contextSummary.fileCount} 个文件 · ${contextSummary.totalChars || 0} 字符` : '未注入'}</div>
      <div class="room-lineage-path">
        ${contextSummary?.truncated ? '<span>已截断，避免上下文膨胀</span>' : ''}
        ${contextFiles.length ? `<span>${contextFiles.map(escapeHtml).join(' / ')}</span>` : ''}
      </div>
    </div>`;
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

let roomAgentProfilesCache = [];
let roomAgentProfilesLoaded = false;
async function refreshRoomAgentProfiles() {
  if (roomAgentProfilesLoaded) return;
  roomAgentProfilesLoaded = true;
  try {
    const r = await api('/api/agent-registry');
    if (r?.ok && Array.isArray(r.profiles)) {
      roomAgentProfilesCache = r.profiles.map((profile) => ({
        id: profile.id,
        title: profile.title || profile.id,
      }));
    }
  } catch {
    roomAgentProfilesLoaded = false;
  }
}

let roomSkillsCache = [];
let roomSkillsLoaded = false;
async function refreshRoomSkills() {
  if (roomSkillsLoaded) return;
  roomSkillsLoaded = true;
  try {
    const r = await fetch('/api/skills').then(x => x.json());
    if (r?.ok && Array.isArray(r.skills)) {
      roomSkillsCache = r.skills
        .filter(skill => skill.enabled !== false)
        .map(skill => ({
          name: skill.name,
          displayName: skill.displayName || skill.name,
          description: skill.description || '',
          bodyLen: Number(skill.bodyLen || 0),
          updatedAt: skill.updatedAt || '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  } catch {
    roomSkillsLoaded = false;
  }
}

function renderRoomSkillBindings(room) {
  const root = $('#roomSkillBindings');
  if (!root) return;
  if (!roomSkillsLoaded) {
    root.innerHTML = '<span class="room-skill-label">Skills</span><span class="room-skill-empty">加载中…</span>';
    refreshRoomSkills().then(() => {
      if (roomState.activeRoom?.id === room?.id) renderRoomSkillBindings(roomState.activeRoom);
    });
    return;
  }
  const active = new Set(Array.isArray(room?.skills) ? room.skills : []);
  if (roomSkillsCache.length === 0) {
    root.innerHTML = '<span class="room-skill-label">Skills</span><span class="room-skill-empty">暂无可绑定 Skill</span>';
    return;
  }
  root.innerHTML = `
    <span class="room-skill-label">Skills</span>
    <div class="room-skill-chip-list">
      ${roomSkillsCache.map(skill => `
        <label class="room-skill-chip ${active.has(skill.name) ? 'is-active' : ''}" title="${escapeHtml(skill.description)}">
          <input type="checkbox" value="${escapeHtml(skill.name)}" ${active.has(skill.name) ? 'checked' : ''} />
          <span>${escapeHtml(skill.name)}</span>
        </label>
      `).join('')}
    </div>
  `;
  root.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => updateRoomSkillsFromControls(root));
  });
}

async function updateRoomSkillsFromControls(root = $('#roomSkillBindings')) {
  if (!roomState.activeId || !root) return;
  const skills = [...root.querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => input.value)
    .filter(Boolean);
  const u = await fetch(`/api/rooms/${roomState.activeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skills }),
  }).then(x => x.json());
  if (u.ok) {
    roomState.activeRoom = u.room;
    renderRoomSkillBindings(u.room);
  } else {
    toast('Skill 绑定失败：' + (u.error || ''), 'error');
    if (roomState.activeRoom) renderRoomSkillBindings(roomState.activeRoom);
  }
}

function renderRoomMembers(room) {
  const wrap = $('#roomMembers');
  if (!wrap) return;
  if (!roomAgentProfilesLoaded) {
    refreshRoomAgentProfiles().then(() => {
      if (roomState.activeRoom?.id === room?.id) renderRoomMembers(roomState.activeRoom);
    });
  }
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
    let agentSel = null;
    if (roomAgentProfilesCache.length > 0) {
      agentSel = document.createElement('select');
      agentSel.title = '绑定 Xike Agent Profile（默认按角色自动匹配）';
      agentSel.className = 'room-member-agent';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = 'auto profile';
      agentSel.appendChild(auto);
      const currentAgentProfileId = m.agentProfileId || m.profileId || m.agentId || '';
      for (const profile of roomAgentProfilesCache) {
        const o = document.createElement('option');
        o.value = profile.id;
        o.textContent = profile.id;
        o.title = profile.title;
        if (profile.id === currentAgentProfileId) o.selected = true;
        agentSel.appendChild(o);
      }
      agentSel.addEventListener('change', () => updateMember(idx, { agentProfileId: agentSel.value }));
    }
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'room-member-toggle';
    toggleBtn.textContent = m.enabled === false ? '✓' : '✕';
    toggleBtn.title = m.enabled === false ? '启用' : '关闭';
    toggleBtn.addEventListener('click', () => updateMember(idx, { enabled: !(m.enabled !== false) }));
    const roleBadge = m.role ? `<span class="room-member-role ${m.role}">${m.role}</span>` : '';
    chip.innerHTML = `${roleBadge}<span>${escapeHtml(m.displayName)}</span>`;
    chip.appendChild(adapterSel);
    chip.appendChild(select);
    if (agentSel) chip.appendChild(agentSel);
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
  if (u.ok) {
    roomState.activeRoom = u.room;
    renderRoomMembers(u.room);
  }
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
  if (u.ok) {
    roomState.activeRoom = u.room;
    renderRoomMembers(u.room);
  }
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
  if (u.ok) {
    roomState.activeRoom = u.room;
    renderRoomMembers(u.room);
  }
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
    btn.addEventListener('click', async () => {
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
  roomState.activeRoom = null;
  $('#roomDebate').style.display = 'none';
  $('.room-empty').style.display = '';
  renderRoomLineage(null);
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
    if (r.ok && r.room) {
      roomState.activeRoom = r.room;
      renderRoomLineage(r.room);
    }
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

async function delegateActiveRoom() {
  if (!roomState.activeId) { toast('先选一个房间', 'warn'); return; }
  let room = roomState.activeRoom;
  if (!room || room.id !== roomState.activeId) {
    const r = await fetch(`/api/rooms/${roomState.activeId}`).then(x => x.json());
    if (!r.ok) { toast('读取房间失败：' + (r.error || 'unknown'), 'error'); return; }
    room = r.room;
    roomState.activeRoom = room;
  }
  const defaultTitle = room.objective?.title || room.topic?.slice(0, 80) || room.name || '委派任务';
  const title = await promptModal({
    title: '创建跨房间委派',
    message: '给目标房间一个明确任务标题。',
    value: defaultTitle,
    placeholder: '例：把方案拆成可执行开发任务',
  });
  if (!title) return;
  const instructions = await promptModal({
    title: '委派说明',
    message: '写清楚目标房间要做什么；会自动带上来源房间、目标和 lineage。',
    value: room.finalConsensus || room.topic || room.objective?.description || '',
    placeholder: '例：基于当前共识，拆出 P0/P1 任务并给出验收标准。',
    multiline: true,
  });
  if (!instructions) return;
  const targetMode = await promptModal({
    title: '目标房间模式',
    message: '输入 chat / debate / squad / arena。Free 版如果没有 squad/arena 权限，会由后端拒绝并保留委派记录。',
    value: 'debate',
    placeholder: 'debate',
  });
  if (!targetMode) return;
  try {
    const created = await api('/api/delegations', {
      method: 'POST',
      body: JSON.stringify({
        sourceRoomId: room.id,
        sourceTaskId: room.lineage?.taskId || null,
        targetMode,
        title,
        instructions,
        payload: {
          acceptanceCriteria: room.objective?.acceptanceCriteria || [],
        },
      }),
    });
    const executed = await api(`/api/delegations/${encodeURIComponent(created.delegation.id)}/execute`, { method: 'POST' });
    toast('已创建委派房间', 'success', 2000);
    await loadRooms();
    if (executed.room?.id) selectRoom(executed.room.id);
  } catch (e) {
    toast('委派失败：' + e.message, 'error', 6000);
  }
}

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
$('#btnDelegateRoom')?.addEventListener('click', delegateActiveRoom);

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
const pluginState = createPanelMirroredState('plugin', _pluginStateRaw);

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
  } catch {
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
async function openRoomAdaptersModal() {
  try {
    const r = await fetch('/api/room-adapters').then(x => x.json());
    if (!r?.ok) { toast('加载配置失败：' + (r?.error || ''), 'error'); return; }
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
  const path = '/api/room-adapters';
  const opts = { method: 'PUT', body: JSON.stringify(body) };
  const onSaved = async (r) => {
    setAdapterSaveStatus(`已保存。当前可用 adapter：${(r?.activeProviders || []).join(' / ')}`, 'success');
    await refreshRoomProviders();
    // 若已开房间，刷新成员区让新 adapter 可选
    if (roomState.activeId) {
      const rr = await fetch(`/api/rooms/${roomState.activeId}`).then(x => x.json());
      if (rr?.ok) renderRoomMembers(rr.room);
    }
  };
  try {
    const result = await requestWithApproval(path, opts);
    if (result.status === 'approval_required') setAdapterSaveStatus('写入 provider 配置需人工批准', '');
    await handleApprovalFlow(result, path, opts, {
      actionLabel: '写入 Provider 配置',
      onOk: async (r) => { await onSaved(r.body); },
      onDenied: (r) => setAdapterSaveStatus('写入被拒绝：' + (r.permissionDecision?.reason || 'permission denied'), 'error'),
      onError: (r) => setAdapterSaveStatus('保存失败：' + (r.error || 'unknown'), 'error'),
    });
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
function fmtBudgetMetric(metric, value) {
  const n = Number(value) || 0;
  if (metric === 'usd') return '$' + n.toFixed(4);
  if (metric === 'tokens') return fmtBigInt(n) + ' tokens';
  if (metric === 'calls') return fmtBigInt(n) + ' calls';
  return String(n);
}
function fmtBudgetTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '-';
  try {
    return new Date(n).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '-';
  }
}
function budgetScopeLabel(scopeType, scopeId) {
  const labels = { project: '项目', room: '房间', session: '会话', adapter: '模型', task: '任务' };
  return `${labels[scopeType] || scopeType}:${scopeId || '-'}`;
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
    const [ov, ts, ba, health, budgetIncidents, budgetPolicies, governance] = await Promise.all([
      fetch('/api/metrics/overview').then(r => r.json()).catch(() => ({})),
      fetch('/api/metrics/timeseries?from=' + encodeURIComponent(fromIso) + '&bucket=' + bucket).then(r => r.json()).catch(() => ({})),
      fetch('/api/metrics/by-adapter?from=' + encodeURIComponent(fromIso)).then(r => r.json()).catch(() => ({})),
      fetch('/api/metrics/health').then(r => r.json()).catch(() => ({})),
      fetch('/api/budgets/incidents?status=open&limit=20').then(r => r.json()).catch(() => ({})),
      fetch('/api/budgets/policies?activeOnly=true&limit=50').then(r => r.json()).catch(() => ({})),
      fetch('/api/governance/summary').then(r => r.json()).catch(() => ({})),
    ]);
    renderOverviewBlockA(ov);
    await renderOverviewBlockB(ts);
    await renderOverviewBlockC(ba);
    renderOverviewBlockD(health);
    renderOverviewBlockE({
      incidents: budgetIncidents?.incidents || [],
      policies: budgetPolicies?.policies || [],
    });
    renderOverviewBlockF(governance);
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

function renderOverviewBlockE(budget) {
  const summary = $('#ovBudgetSummary');
  const root = $('#ovBudgetIncidents');
  if (!root) return;
  const incidents = Array.isArray(budget?.incidents) ? budget.incidents : [];
  const policies = Array.isArray(budget?.policies) ? budget.policies : [];
  const hardStops = incidents.filter(i => i.thresholdType === 'hard_stop').length;
  const warnings = incidents.filter(i => i.thresholdType === 'warning').length;

  if (summary) {
    summary.innerHTML = `<span class="overview-budget-summary">
      <span class="overview-budget-pill ${hardStops ? 'is-hard' : ''}">hard-stop ${hardStops}</span>
      <span class="overview-budget-pill ${warnings ? 'is-warn' : ''}">warning ${warnings}</span>
      <span class="overview-budget-pill">active policy ${policies.length}</span>
    </span>`;
  }

  if (incidents.length === 0) {
    root.innerHTML = '<div class="overview-budget-empty">当前没有未处理预算事件。</div>';
    return;
  }

  root.innerHTML = incidents.map(i => {
    const hard = i.thresholdType === 'hard_stop';
    const kind = hard ? 'Hard stop' : 'Warning';
    const usage = `${fmtBudgetMetric(i.metric, i.observedAmount)} / ${fmtBudgetMetric(i.metric, i.limitAmount)}`;
    const pct = i.limitAmount > 0 ? Math.round((i.observedAmount / i.limitAmount) * 100) : 0;
    const scope = budgetScopeLabel(i.scopeType, i.scopeId);
    return `<div class="overview-budget-incident ${hard ? 'is-hard' : 'is-warn'}" data-incident-id="${escapeHtml(i.id)}">
      <div>
        <div class="kind">${kind}</div>
        <div class="meta">${escapeHtml(i.windowKind || '-')} · ${fmtBudgetTime(i.createdAt)}</div>
      </div>
      <div class="scope" title="${escapeHtml(scope)}">
        作用域 <code>${escapeHtml(scope)}</code>
      </div>
      <div class="usage">
        <strong>${escapeHtml(usage)}</strong> · ${pct}%
      </div>
      <div class="actions">
        <button class="cxbtn cxbtn-secondary cxbtn-sm" data-budget-resolve="${escapeHtml(i.id)}">标记已处理</button>
      </div>
    </div>`;
  }).join('');

  root.querySelectorAll('[data-budget-resolve]').forEach(btn => {
    btn.addEventListener('click', () => resolveBudgetIncident(btn.dataset.budgetResolve));
  });
}

async function resolveBudgetIncident(id) {
  if (!id) return;
  try {
    const r = await fetch(`/api/budgets/incidents/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).then(x => x.json());
    if (!r.ok) {
      toast('处理失败：' + (r.error || 'unknown'), 'error');
      return;
    }
    toast('预算事件已处理', 'success', 1500);
    refreshOverview();
  } catch (e) {
    toast('处理失败：' + e.message, 'error');
  }
}

function governanceKindLabel(kind) {
  return ({
    approval: '审批',
    budget: '预算',
    delegation: '委派',
    autopilot_job: '调度',
  })[kind] || kind || '事件';
}

function governanceTarget(kind) {
  if (kind === 'approval') return () => openApprovalModal();
  if (kind === 'budget') return () => showOverviewArea();
  if (kind === 'delegation') return () => openDelegationModal();
  if (kind === 'autopilot_job') return () => openAutopilotModal();
  return null;
}

function renderOverviewBlockF(governance) {
  const summary = $('#ovGovernanceSummary');
  const root = $('#ovGovernanceList');
  if (!root) return;
  const counts = governance?.counts || {};
  const blockers = Array.isArray(governance?.blockers) ? governance.blockers : [];
  if (summary) {
    summary.innerHTML = `<span class="overview-governance-summary">
      <span class="overview-governance-pill ${counts.hardBlockers ? 'is-hard' : ''}">hard ${counts.hardBlockers || 0}</span>
      <span class="overview-governance-pill ${counts.attention ? 'is-warn' : ''}">attention ${counts.attention || 0}</span>
      <span class="overview-governance-pill">open ${counts.totalOpen || 0}</span>
    </span>`;
  }
  if (!blockers.length) {
    root.innerHTML = '<div class="overview-governance-empty">当前没有待处理治理事项。</div>';
    return;
  }
  root.innerHTML = blockers.slice(0, 12).map(b => {
    const sev = safeClassToken(b.severity || 'info');
    const title = String(b.title || b.id || '').slice(0, 160);
    return `<button class="overview-governance-item sev-${sev}" data-governance-kind="${escapeHtml(b.kind)}">
      <span class="kind">${escapeHtml(governanceKindLabel(b.kind))}</span>
      <span class="title" title="${escapeHtml(title)}">${escapeHtml(title || b.id)}</span>
      <span class="status">${escapeHtml(b.status || '-')}</span>
    </button>`;
  }).join('');
  root.querySelectorAll('[data-governance-kind]').forEach(btn => {
    const open = governanceTarget(btn.dataset.governanceKind);
    if (open) btn.addEventListener('click', open);
  });
}

// ========== P0 Governance Center — 统一治理入口 ==========
const governanceCenterState = {
  summary: null,
  queue: null,
  loading: false,
  error: '',
};

// P5：工作队列状态机——五态及推进顺序（done 为终态）
const GOV_QUEUE_STATE_LABELS = {
  pending_review: '待审批',
  pending_verify: '待验证',
  pending_archive: '待归档',
  pending_fix: '待修复',
  done: '已处理',
};
const GOV_QUEUE_NEXT_STATE = {
  pending_review: 'pending_verify',
  pending_verify: 'pending_archive',
  pending_archive: 'done',
  pending_fix: 'done',
};

function governanceCenterTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '-';
  try { return new Date(n).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return '-'; }
}

function governanceCenterSeverityClass(severity) {
  return safeClassToken(severity || 'info');
}

function governanceCenterMetric(n) {
  return String(Number(n) || 0);
}

async function openGovernanceCenterModal() {
  $('#governanceCenterModal').style.display = 'flex';
  await refreshGovernanceCenter();
}

function closeGovernanceCenterModal() {
  $('#governanceCenterModal').style.display = 'none';
}

async function refreshGovernanceCenter() {
  const root = $('#governanceCenterBody');
  if (!root) return;
  governanceCenterState.loading = true;
  governanceCenterState.error = '';
  root.innerHTML = '<div class="muted small" style="padding:20px;">加载中…</div>';
  try {
    governanceCenterState.summary = await api('/api/governance/summary');
    // 工作队列与 summary 并行口径：派生失败不阻断主看板
    try { governanceCenterState.queue = await api('/api/governance/queue'); }
    catch { governanceCenterState.queue = null; }
  } catch (e) {
    governanceCenterState.error = e.message || '加载治理中心失败';
  } finally {
    governanceCenterState.loading = false;
    renderGovernanceCenter();
  }
}

// 推进队列项到下一状态
async function advanceGovernanceQueueItem(id, nextState, btn = null) {
  if (!id || !nextState) return;
  if (btn) btn.disabled = true;
  try {
    await api(`/api/governance/queue/${encodeURIComponent(id)}/state`, {
      method: 'POST',
      body: JSON.stringify({ state: nextState }),
    });
    toast(`已推进到「${GOV_QUEUE_STATE_LABELS[nextState] || nextState}」`, 'success', 1500);
    await refreshGovernanceCenter();
  } catch (e) {
    toast('推进失败：' + (e.message || e), 'error');
    if (btn) btn.disabled = false;
  }
}

function renderGovernanceCenterQueue(queue) {
  const grouped = queue && queue.queue && !Array.isArray(queue.queue) ? queue.queue : null;
  const order = ['pending_review', 'pending_verify', 'pending_fix', 'pending_archive', 'done'];
  const cols = order.map((state) => {
    const items = (grouped && grouped[state]) || [];
    const cards = items.length
      ? items.map((it) => {
        const next = GOV_QUEUE_NEXT_STATE[it.queueState];
        const btn = next
          ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-gov-queue-advance="${escapeHtml(it.id)}" data-gov-queue-next="${escapeHtml(next)}">→ ${escapeHtml(GOV_QUEUE_STATE_LABELS[next] || next)}</button>`
          : '';
        return `<div class="gov-queue-item" data-gov-queue-id="${escapeHtml(it.id)}">
          <div class="gov-queue-item-title">${escapeHtml(it.title || it.sourceId || it.sourceKind || '-')}</div>
          <div class="gov-queue-item-meta"><span>${escapeHtml(it.sourceKind || '-')}</span>${btn}</div>
        </div>`;
      }).join('')
      : '<div class="muted small">—</div>';
    return `<div class="gov-queue-col" data-gov-queue-col="${state}">
      <div class="gov-queue-col-head">${escapeHtml(GOV_QUEUE_STATE_LABELS[state] || state)} <span>${items.length}</span></div>
      ${cards}
    </div>`;
  }).join('');
  return `<section class="governance-center-section" data-gov-center-queue>
    <h4>工作队列</h4>
    <div class="gov-queue-board">${cols}</div>
  </section>`;
}

function governanceActionLabel(action = {}) {
  return action.label || ({
    review_pending_approvals: 'Review pending approvals',
    resolve_budget_hard_stop: 'Resolve budget hard stop',
    inspect_failed_delegation: 'Inspect failed delegation',
    inspect_running_autopilot: 'Inspect running Autopilot',
    inspect_deferred_agent_run: 'Inspect deferred Agent Run',
  })[action.type] || action.type || 'Inspect governance item';
}

function renderGovernanceCenterCards(counts = {}) {
  const items = [
    { label: '待审批', value: counts.pendingApprovals, severity: counts.pendingApprovals ? 'warn' : 'info', target: 'approval' },
    { label: '预算事件', value: counts.openBudgetIncidents, severity: counts.openBudgetIncidents ? 'warn' : 'info', target: 'budget' },
    { label: '委派队列', value: (counts.queuedDelegations || 0) + (counts.failedDelegations || 0), severity: counts.failedDelegations ? 'error' : 'info', target: 'delegation' },
    { label: '自驾任务', value: (counts.queuedAutopilotJobs || 0) + (counts.runningAutopilotJobs || 0), severity: counts.runningAutopilotJobs ? 'warn' : 'info', target: 'autopilot_job' },
    { label: '治理 Run', value: counts.governedAgentRuns, severity: counts.governedAgentRuns ? 'info' : 'info', target: 'agent_run' },
    { label: '硬阻塞', value: counts.hardBlockers, severity: counts.hardBlockers ? 'error' : 'info', target: 'blockers' },
  ];
  return `<section class="governance-center-kpis">
    ${items.map(item => `<button class="governance-center-kpi sev-${governanceCenterSeverityClass(item.severity)}" data-gov-center-target="${escapeHtml(item.target)}">
      <span class="k">${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(governanceCenterMetric(item.value))}</strong>
    </button>`).join('')}
  </section>`;
}

function renderGovernanceCenterNextActions(actions = []) {
  if (!actions.length) {
    return `<section class="governance-center-section">
      <h3>Next Actions</h3>
      <div class="governance-center-empty">当前没有阻塞性治理动作。</div>
    </section>`;
  }
  return `<section class="governance-center-section">
    <h3>Next Actions</h3>
    <div class="governance-center-action-list">
      ${actions.map(action => `<button class="governance-center-action sev-${governanceCenterSeverityClass(action.severity)}" data-gov-center-open="${escapeHtml(action.targetKind || '')}" data-gov-center-id="${escapeHtml(action.targetId || '')}">
        <span>${escapeHtml(governanceActionLabel(action))}</span>
        <code>${escapeHtml(action.targetId || action.targetKind || '-')}</code>
      </button>`).join('')}
    </div>
  </section>`;
}

function renderGovernanceCenterBlockers(blockers = []) {
  if (!blockers.length) {
    return `<section class="governance-center-section">
      <h3>Open Items</h3>
      <div class="governance-center-empty">没有待处理审批、预算、委派或调度事项。</div>
    </section>`;
  }
  return `<section class="governance-center-section">
    <h3>Open Items</h3>
    <div class="governance-center-item-list">
      ${blockers.map(item => `<button class="governance-center-item sev-${governanceCenterSeverityClass(item.severity)}" data-gov-center-open="${escapeHtml(item.kind || '')}" data-gov-center-id="${escapeHtml(item.id || '')}">
        <span class="kind">${escapeHtml(governanceKindLabel(item.kind))}</span>
        <span class="title" title="${escapeHtml(item.title || item.id || '')}">${escapeHtml(item.title || item.id || '-')}</span>
        <span class="status">${escapeHtml(item.status || '-')}</span>
      </button>`).join('')}
    </div>
  </section>`;
}

function governanceCenterBytes(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function governanceShortHash(value) {
  const text = String(value || '');
  return text ? text.slice(0, 10) : '-';
}

function stagedDiffReviewText(diff = {}) {
  const summary = diff?.summary || {};
  if (!diff?.id && !diff?.sha256 && !summary.fileCount) return '';
  return `+${Number(summary.totalAdditions || 0)}/-${Number(summary.totalRemovals || 0)} · ${Number(summary.newFileCount || 0)} new · ${Number(summary.existingFileCount || 0)} existing · ${Number(summary.verificationCoveredFileCount || 0)}/${Number(summary.fileCount || 0)} verified · ${Number(summary.uncoveredFileCount || 0)} uncovered · ${Number(summary.highRiskFileCount || 0)} high risk · ${governanceShortHash(diff.sha256 || diff.id)}`;
}

function stagedDiffFileMeta(file = {}) {
  const coverage = file.commandCoverage || {};
  const status = file.coverageStatus || coverage.status || '-';
  const verifyCount = Number(file.verificationCommandCount ?? coverage.verificationCommandCount ?? 0)
    + Number(file.projectWideVerificationCommandCount ?? coverage.projectWideVerificationCommandCount ?? 0);
  const evidenceCount = Number(file.workEvidenceCommandCount ?? coverage.workEvidenceCommandCount ?? 0)
    + Number(file.projectWideWorkEvidenceCommandCount ?? coverage.projectWideWorkEvidenceCommandCount ?? 0);
  const risk = `${file.riskLevel || '-'}#${Number(file.riskRank || 0) || '-'} score ${Number(file.riskScore || 0)}`;
  return `coverage ${status} · verify ${verifyCount} · evidence ${evidenceCount} · risk ${risk}`;
}

function governanceCommandKey(command = '') {
  const text = String(command || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `cmd-${(hash >>> 0).toString(16)}`;
}

function governanceCommandChips(file = {}) {
  const coverage = file.commandCoverage || {};
  const items = [
    ...(Array.isArray(coverage.verificationCommands) ? coverage.verificationCommands.map(command => ({ kind: 'verify', command })) : []),
    ...(Array.isArray(coverage.projectWideVerificationCommands) ? coverage.projectWideVerificationCommands.map(command => ({ kind: 'verify-all', command })) : []),
    ...(Array.isArray(coverage.workEvidenceCommands) ? coverage.workEvidenceCommands.map(command => ({ kind: 'evidence', command })) : []),
    ...(Array.isArray(coverage.projectWideWorkEvidenceCommands) ? coverage.projectWideWorkEvidenceCommands.map(command => ({ kind: 'evidence-all', command })) : []),
  ].filter(item => item.command?.command);
  if (!items.length) return '';
  return `<div class="governance-center-command-links">
    ${items.map(item => `<button type="button" class="governance-center-command-chip" data-gov-center-command-jump="${escapeHtml(governanceCommandKey(item.command.command))}" title="${escapeHtml(item.command.command)}">${escapeHtml(item.kind)}</button>`).join('')}
  </div>`;
}

function governanceRiskReasons(file = {}) {
  const reasons = Array.isArray(file.riskReasons) ? file.riskReasons : [];
  if (!reasons.length) return '';
  return `<details class="governance-center-risk-explain">
    <summary>Risk reasons</summary>
    <div>${reasons.map(item => `<span>+${Number(item.points || 0)} ${escapeHtml(item.reason || '')}</span>`).join('')}</div>
  </details>`;
}

function governanceCoverageExplanations(file = {}) {
  const coverage = file.commandCoverage || {};
  const explanations = Array.isArray(file.coverageExplanations)
    ? file.coverageExplanations
    : Array.isArray(coverage.coverageExplanations) ? coverage.coverageExplanations : [];
  if (!explanations.length) return '';
  return `<details class="governance-center-coverage-explain">
    <summary>Coverage explanation</summary>
    <div>${explanations.map(item => `<span><b>${escapeHtml(item.kind || 'coverage')}</b> ${escapeHtml(item.status || '-')} ${item.command ? `<code>${escapeHtml(item.command)}</code>` : ''} ${escapeHtml(item.reason || '')}</span>`).join('')}</div>
  </details>`;
}

function orderedGovernanceReviewFiles(files = [], stagedDiff = {}) {
  const rankMap = new Map((stagedDiff.prioritizedFiles || []).map((item, index) => [`${item.operation || ''}:${item.path || ''}`, Number(item.riskRank || index + 1)]));
  return [...files].sort((a, b) => {
    const ar = Number(a.riskRank || rankMap.get(`${a.operation || ''}:${a.path || ''}`) || 999);
    const br = Number(b.riskRank || rankMap.get(`${b.operation || ''}:${b.path || ''}`) || 999);
    return ar - br || String(a.path || '').localeCompare(String(b.path || ''));
  });
}

function renderGovernanceCoverageFilter(files = []) {
  const statuses = ['verified', 'project_wide_verified', 'evidence_only', 'uncovered', 'blocked'];
  const counts = files.reduce((acc, file) => {
    const status = file.coverageStatus || file.commandCoverage?.status || 'uncovered';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  return `<div class="governance-center-coverage-filter" data-gov-center-coverage-filter>
    <span>Coverage filter</span>
    <button type="button" class="is-active" data-gov-center-coverage-status="all">All ${files.length}</button>
    ${statuses.map(status => `<button type="button" data-gov-center-coverage-status="${escapeHtml(status)}">${escapeHtml(status)} ${counts[status] || 0}</button>`).join('')}
  </div>`;
}

function renderGovernanceResumeReview(approval = {}) {
  const review = approval.resumeReview;
  if (!approval.canApproveResume || !review) return '';
  const stagedDiff = review.stagedDiffReview || review.diffReview || {};
  const files = orderedGovernanceReviewFiles(Array.isArray(review.fileChanges) ? review.fileChanges : [], stagedDiff);
  const commands = Array.isArray(review.commands) ? review.commands : [];
  const workCommands = Array.isArray(review.workEvidenceCommands) ? review.workEvidenceCommands : [];
  const risks = Array.isArray(review.risks) ? review.risks : [];
  const gate = review.gate || {};
  const stagedDiffText = stagedDiffReviewText(stagedDiff);
  return `<div class="governance-center-resume-review" data-gov-center-resume-review="${escapeHtml(approval.id)}">
    <div class="governance-center-review-head">
      <span>Preflight Review</span>
      <span class="${review.safeToResume ? 'sev-info' : 'sev-error'}">${review.safeToResume ? 'safe manifest' : 'needs attention'}</span>
    </div>
    <div class="governance-center-review-stats">
      <span>${Number(review.fileChangeCount || files.length)} files</span>
      <span>${Number(review.commandCount || commands.length)} verify cmds</span>
      <span>${Number(review.workEvidenceCommandCount || workCommands.length)} evidence cmds</span>
      <span>Gate ${escapeHtml(gate.id || review.reviewGateId || '-')}</span>
    </div>
    ${stagedDiffText ? `<div class="governance-center-review-diff" data-gov-center-staged-diff="${escapeHtml(stagedDiff.id || '')}">
      <strong>Staged Diff</strong>
      <span>${escapeHtml(stagedDiffText)}</span>
    </div>` : ''}
    ${renderGovernanceCoverageFilter(files)}
    <div class="governance-center-review-note" data-gov-center-coverage-empty hidden>No files match this coverage filter.</div>
    ${files.map(file => `<details class="governance-center-review-file" data-gov-center-review-file="${escapeHtml(file.path || '')}" data-gov-center-coverage="${escapeHtml(file.coverageStatus || file.commandCoverage?.status || 'uncovered')}" open>
      <summary class="governance-center-review-file-row">
        <span class="op">${escapeHtml(file.operation || '-')}</span>
        <span class="risk ${escapeHtml(safeClassToken(file.riskLevel || 'low'))}">#${Number(file.riskRank || 0) || '-'} ${escapeHtml(file.riskLevel || 'low')}</span>
        <code>${escapeHtml(file.path || '-')}</code>
        ${file.diffStats ? `<span>+${Number(file.diffStats.additions || 0)}/-${Number(file.diffStats.removals || 0)}</span>` : ''}
        <span>${governanceCenterBytes(file.contentBytes)}</span>
        <span>sha ${escapeHtml(governanceShortHash(file.contentSha256))}</span>
      </summary>
      ${Array.isArray(file.attentionFlags) && file.attentionFlags.length
        ? `<div class="governance-center-review-note">flags ${file.attentionFlags.map(escapeHtml).join(' · ')}</div>`
        : ''}
      ${file.coverageStatus || file.commandCoverage ? `<div class="governance-center-review-note">${escapeHtml(stagedDiffFileMeta(file))}</div>` : ''}
      ${governanceCoverageExplanations(file)}
      ${governanceCommandChips(file)}
      ${governanceRiskReasons(file)}
      ${file.summary ? `<div class="governance-center-review-note">${escapeHtml(file.summary)}</div>` : ''}
      ${file.reason && !file.ok ? `<div class="governance-center-review-risk">${escapeHtml(file.reason)}</div>` : ''}
      ${Array.isArray(file.previewLines) && file.previewLines.length
        ? `<pre class="governance-center-diff-preview">${file.previewLines.map(line => escapeHtml(line)).join('\n')}</pre>`
        : `<div class="governance-center-review-note">${escapeHtml(file.previewSkipped || 'No preview lines')}</div>`}
    </details>`).join('')}
    ${commands.length || workCommands.length ? `<div class="governance-center-review-commands">
      ${[...workCommands, ...commands].map(cmd => `<code class="${cmd.ok ? '' : 'is-risk'}" data-gov-center-command-id="${escapeHtml(governanceCommandKey(cmd.command || ''))}" title="${escapeHtml(cmd.reason || '')}">${escapeHtml(cmd.command || '')}</code>`).join('')}
    </div>` : ''}
    ${risks.length ? `<div class="governance-center-review-risk">${risks.map(escapeHtml).join(' · ')}</div>` : ''}
  </div>`;
}

function renderGovernanceCenterApprovals(approvals = []) {
  if (!approvals.length) {
    return `<section class="governance-center-section">
      <h3>Approval Actions</h3>
      <div class="governance-center-empty">当前没有 pending approval。</div>
    </section>`;
  }
  return `<section class="governance-center-section">
    <h3>Approval Actions</h3>
    <div class="governance-center-approval-list">
      ${approvals.map((approval) => {
        const reviewGate = approval.resumeReview?.gate || {};
        const canResumeWithGate = approval.canApproveResume
          && approval.resumeReview?.safeToResume !== false
          && Boolean(reviewGate.id || approval.resumeReview?.reviewGateId);
        return `<div class="governance-center-approval ${approval.canApproveResume ? 'sev-warn' : ''}">
        <button class="governance-center-approval-main" data-gov-center-open="approval" data-gov-center-id="${escapeHtml(approval.id)}">
          <span class="title">${escapeHtml(approval.title || approval.type || approval.id)}</span>
          <span class="meta">${escapeHtml(approval.type || '-')} · ${escapeHtml(approval.action || 'manual')} · ${escapeHtml(approval.resumeRunId || approval.agentRunId || '-')}</span>
        </button>
        ${approval.canApproveResume ? `<button class="cxbtn cxbtn-primary cxbtn-sm" data-gov-center-approve-resume="${escapeHtml(approval.id)}" data-gov-center-run="${escapeHtml(approval.resumeRunId)}" data-gov-center-review-gate="${escapeHtml(reviewGate.id || approval.resumeReview?.reviewGateId || '')}" data-gov-center-review-sha="${escapeHtml(reviewGate.sha256 || approval.resumeReview?.reviewSha256 || '')}" ${canResumeWithGate ? '' : 'disabled'}>批准并续跑</button>` : `<button class="cxbtn cxbtn-secondary cxbtn-sm" data-gov-center-open="approval" data-gov-center-id="${escapeHtml(approval.id)}">打开审批</button>`}
        ${renderGovernanceResumeReview(approval)}
      </div>`;
      }).join('')}
    </div>
  </section>`;
}

function renderGovernanceCenterBudgetIncidents(incidents = []) {
  if (!incidents.length) {
    return `<section class="governance-center-section">
      <h3>Budget Actions</h3>
      <div class="governance-center-empty">当前没有 open budget incident。</div>
    </section>`;
  }
  return `<section class="governance-center-section">
    <h3>Budget Actions</h3>
    <div class="governance-center-budget-list">
      ${incidents.map(incident => {
        const usage = `${fmtBudgetMetric(incident.metric, incident.observedAmount)} / ${fmtBudgetMetric(incident.metric, incident.limitAmount)}`;
        const scope = budgetScopeLabel(incident.scopeType, incident.scopeId);
        const hard = incident.thresholdType === 'hard_stop';
        return `<div class="governance-center-budget ${hard ? 'sev-error' : 'sev-warn'}">
          <button class="governance-center-budget-main" data-gov-center-open="budget" data-gov-center-id="${escapeHtml(incident.id)}">
            <span class="title">${escapeHtml(scope)}</span>
            <span class="meta">${escapeHtml(incident.thresholdType || '-')} · ${escapeHtml(usage)}</span>
          </button>
          <button class="cxbtn cxbtn-secondary cxbtn-sm" data-gov-center-resolve-budget="${escapeHtml(incident.id)}">标记已处理</button>
        </div>`;
      }).join('')}
    </div>
  </section>`;
}

function renderGovernanceCenterRuns(runs = []) {
  if (!runs.length) {
    return `<section class="governance-center-section">
      <h3>Agent Runs</h3>
      <div class="governance-center-empty">最近没有带治理链路的 Agent Run。</div>
    </section>`;
  }
  return `<section class="governance-center-section">
    <h3>Agent Runs</h3>
    <div class="governance-center-run-list">
      ${runs.map(run => `<button class="governance-center-run" data-gov-center-open="agent_run" data-gov-center-id="${escapeHtml(run.id)}">
        <span class="title">${escapeHtml(run.taskId || run.id)}</span>
        <span class="meta">${escapeHtml(run.status || '-')} · ${escapeHtml(run.sourceType || '-')} · ${escapeHtml(run.deferReason || 'no defer')}</span>
        <span class="ids">${[run.approvalId, run.budgetIncidentId, run.delegationId].filter(Boolean).map(escapeHtml).join(' · ') || '-'}</span>
      </button>`).join('')}
    </div>
  </section>`;
}

function renderGovernanceCenterActivity(events = []) {
  if (!events.length) {
    return `<section class="governance-center-section">
      <h3>Recent Activity</h3>
      <div class="governance-center-empty">最近没有治理审计事件。</div>
    </section>`;
  }
  return `<section class="governance-center-section">
    <h3>Recent Activity</h3>
    <div class="governance-center-activity-list">
      ${events.map(event => `<button class="governance-center-activity" data-gov-center-open="${event.agentRunId ? 'agent_run' : 'activity'}" data-gov-center-id="${escapeHtml(event.agentRunId || event.entityId || event.id || '')}">
        <span class="action">${escapeHtml(event.action || '-')}</span>
        <span class="meta">${escapeHtml(event.entityType || '-')} · ${escapeHtml(event.entityId || '-')} · ${governanceCenterTime(event.ts)}</span>
      </button>`).join('')}
    </div>
  </section>`;
}

function renderGovernanceCenter() {
  const root = $('#governanceCenterBody');
  if (!root) return;
  if (governanceCenterState.error) {
    root.innerHTML = `<div class="muted small" style="padding:20px;color:var(--color-danger-alt);">加载失败：${escapeHtml(governanceCenterState.error)}</div>`;
    return;
  }
  const summary = governanceCenterState.summary || {};
  const counts = summary.counts || {};
  const sections = summary.sections || {};
  root.innerHTML = `
    <div class="governance-center-toolbar">
      <div>
        <strong>本地治理总控</strong>
        <span>${summary.generatedAt ? `更新于 ${governanceCenterTime(summary.generatedAt)}` : '等待数据'}</span>
      </div>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnGovernanceCenterRefresh">刷新</button>
    </div>
    ${renderGovernanceCenterCards(counts)}
    ${renderGovernanceCenterQueue(governanceCenterState.queue)}
    <div class="governance-center-grid">
      ${renderGovernanceCenterNextActions(summary.nextActions || [])}
      ${renderGovernanceCenterApprovals(sections.approvals || [])}
      ${renderGovernanceCenterBudgetIncidents(sections.budgetIncidents || [])}
      ${renderGovernanceCenterBlockers(summary.blockers || [])}
      ${renderGovernanceCenterRuns(sections.agentRuns || [])}
      ${renderGovernanceCenterActivity(sections.activityEvents || [])}
    </div>
  `;
  $('#btnGovernanceCenterRefresh')?.addEventListener('click', refreshGovernanceCenter);
  root.querySelectorAll('[data-gov-queue-advance]').forEach(btn => {
    btn.addEventListener('click', () => advanceGovernanceQueueItem(btn.dataset.govQueueAdvance, btn.dataset.govQueueNext, btn));
  });
  root.querySelectorAll('[data-gov-center-open]').forEach(btn => {
    btn.addEventListener('click', () => openGovernanceCenterTarget(btn.dataset.govCenterOpen, btn.dataset.govCenterId));
  });
  root.querySelectorAll('[data-gov-center-target]').forEach(btn => {
    btn.addEventListener('click', () => openGovernanceCenterTarget(btn.dataset.govCenterTarget, ''));
  });
  root.querySelectorAll('[data-gov-center-resolve-budget]').forEach(btn => {
    btn.addEventListener('click', () => resolveGovernanceCenterBudgetIncident(btn.dataset.govCenterResolveBudget, btn));
  });
  root.querySelectorAll('[data-gov-center-approve-resume]').forEach(btn => {
    btn.addEventListener('click', () => approveAndResumeGovernanceRun(btn.dataset.govCenterApproveResume, btn.dataset.govCenterRun, btn, {
      reviewGateId: btn.dataset.govCenterReviewGate,
      reviewSha256: btn.dataset.govCenterReviewSha,
    }));
  });
  root.querySelectorAll('[data-gov-center-command-jump]').forEach(btn => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      const id = btn.dataset.govCenterCommandJump;
      const target = id ? root.querySelector(`[data-gov-center-command-id="${CSS.escape(id)}"]`) : null;
      if (!target) return;
      root.querySelectorAll('.governance-center-review-commands code.is-highlighted')
        .forEach(node => node.classList.remove('is-highlighted'));
      target.classList.add('is-highlighted');
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  });
  root.querySelectorAll('[data-gov-center-coverage-filter]').forEach(filter => {
    filter.addEventListener('click', (event) => {
      const btn = event.target?.closest?.('[data-gov-center-coverage-status]');
      if (!btn) return;
      const status = btn.dataset.govCenterCoverageStatus || 'all';
      const review = filter.closest('[data-gov-center-resume-review]');
      if (!review) return;
      filter.querySelectorAll('[data-gov-center-coverage-status]').forEach(node => node.classList.toggle('is-active', node === btn));
      const files = [...review.querySelectorAll('[data-gov-center-review-file]')];
      let visible = 0;
      for (const file of files) {
        const matches = status === 'all' || file.dataset.govCenterCoverage === status;
        file.hidden = !matches;
        if (matches) visible += 1;
      }
      const empty = review.querySelector('[data-gov-center-coverage-empty]');
      if (empty) empty.hidden = visible > 0;
    });
  });
}

async function approveAndResumeGovernanceRun(approvalId, runId, btn = null, options = {}) {
  if (!approvalId || !runId) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '续跑中…';
  }
  try {
    const preview = await api(`/api/agent-runs/${encodeURIComponent(runId)}/approval-resume-preview?approvalId=${encodeURIComponent(approvalId)}`);
    const currentGate = preview.resumeReviewGate || preview.resumeReview?.gate || {};
    if (!currentGate.id || !currentGate.sha256) {
      throw new Error('Preflight review gate missing');
    }
    if (preview.resumeReview?.safeToResume === false || currentGate.safeToResume === false) {
      throw new Error('Preflight review is not safe to resume');
    }
    if ((options.reviewGateId && options.reviewGateId !== currentGate.id)
      || (options.reviewSha256 && options.reviewSha256 !== currentGate.sha256)) {
      throw new Error('Preflight review gate changed; refresh and review again');
    }
    await api(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Governance Center approve and resume' }),
    });
    const result = await api(`/api/agent-runs/${encodeURIComponent(runId)}/approval-resume`, {
      method: 'POST',
      body: JSON.stringify({
        approvalId,
        requestedBy: 'owner',
        reviewGateId: currentGate.id,
        reviewSha256: currentGate.sha256,
      }),
    });
    toast(result.archive?.summary || '审批已通过，Agent Run 已续跑', 'success', 2200);
    closeGovernanceCenterModal();
    await openAgentRunFromActivity(runId);
  } catch (e) {
    toast('批准续跑失败：' + (e.message || e), 'error', 3500);
    await refreshGovernanceCenter();
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || '批准并续跑';
    }
  }
}

async function resolveGovernanceCenterBudgetIncident(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '处理中…';
  }
  try {
    await api(`/api/budgets/incidents/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ source: 'governance_center' }),
    });
    toast('预算事件已处理', 'success', 1500);
    await refreshGovernanceCenter();
    if (overviewState.shown) refreshOverview();
  } catch (e) {
    toast('处理失败：' + e.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || '标记已处理';
    }
  }
}

async function openGovernanceCenterTarget(kind, id = '') {
  closeGovernanceCenterModal();
  if (kind === 'approval') return openApprovalModal(id || null);
  if (kind === 'budget' || kind === 'blockers') return showOverviewArea();
  if (kind === 'delegation') {
    if (id && typeof delegationState !== 'undefined') delegationState.activeId = id;
    return openDelegationModal();
  }
  if (kind === 'autopilot_job') return openAutopilotModal();
  if (kind === 'agent_run' && id) return openAgentRunFromActivity(id);
  if (kind === 'activity') return openActivityModal(id ? { entityId: id } : {});
  return openActivityModal({ q: id || kind || '' });
}

$('#btnGovernance')?.addEventListener('click', () => openGovernanceCenterModal());
document.querySelectorAll('[data-close-governance-center]').forEach(el => el.addEventListener('click', closeGovernanceCenterModal));

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
    const ws = new WebSocket(wsUrl('/ws/global'));
    globalWsState.ws = ws;
    ws.onopen = () => { globalWsState.reconnectAttempts = 0; };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // 报告生成结果分发：activeJob 在 ws.onmessage 这层路由，重连后新 ws 也能正确投递
        const job = reportState.activeJob;
        if (job && msg.jobId === job.jobId) {
          if (msg.type === 'report_done') { try { job.onDone?.(msg); } catch {} }
          else if (msg.type === 'report_error') { try { job.onError?.(msg); } catch {} }
        }
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
  const path = isNew ? '/api/webhooks' : '/api/webhooks/' + encodeURIComponent(idOrNull);
  const opts = { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(body) };
  const onSaved = async (label, r) => {
    toast(label, 'success', 1800);
    webhookState.isNew = false;
    webhookState.activeId = r?.webhook?.id || webhookState.activeId;
    await refreshWebhookList();
  };
  const result = await requestWithApproval(path, opts);
  await handleApprovalFlow(result, path, opts, {
    actionLabel: isNew ? '创建 Webhook' : '更新 Webhook',
    onOk: async (r) => { await onSaved(isNew ? '已创建' : '已保存', r.body); },
    onError: (r) => toast('保存失败：' + (r.error || 'unknown'), 'error'),
  });
}

async function testWebhookById(id) {
  const path = `/api/webhooks/${encodeURIComponent(id)}/test`;
  const opts = { method: 'POST' };
  const result = await requestWithApproval(path, opts);
  await handleApprovalFlow(result, path, opts, {
    actionLabel: '发送测试推送',
    onOk: async () => { toast('测试推送成功 ✓ 查看目标平台确认收到', 'success', 3000); await refreshWebhookList(); },
    onError: (r) => toast('测试推送失败：' + (r.error || 'unknown'), 'error', 5000),
  });
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
const archiveState = createPanelMirroredState('archive', _archiveStateRaw);

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
        <input id="arRootPath" maxlength="1024" value="${escapeHtml(cfg.rootPath || '')}" placeholder="~/Documents/xikelab-archive" />
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
  const path = isNew ? '/api/mcp/servers' : `/api/mcp/servers/${encodeURIComponent(nameOrNull)}`;
  const opts = { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(body) };
  const onSaved = async (label, r) => {
    toast(label, 'success', 1800);
    mcpState.isNew = false;
    mcpState.activeName = r?.server?.name || mcpState.activeName;
    await refreshMcpList();
  };
  const result = await requestWithApproval(path, opts);
  await handleApprovalFlow(result, path, opts, {
    actionLabel: isNew ? '创建 MCP server' : '更新 MCP server',
    onOk: async (r) => { await onSaved(isNew ? '已创建' : '已保存', r.body); },
    onError: (r) => toast('保存失败：' + (r.error || 'unknown'), 'error'),
  });
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
  const renderTools = async (body) => {
    const tools = body?.tools || [];
    toolsArea.innerHTML = `
      <div class="mcp-form-row">
        <label>✓ 连接成功 · ${tools.length} tools · ${body?.resourcesCount} resources · ${body?.promptsCount} prompts</label>
        <div class="mcp-tools-list">
          ${tools.length === 0 ? '<div class="muted small">此 server 未声明 tool</div>' :
            tools.map(t => `<div class="mcp-tool-item"><div class="tname">${escapeHtml(t.name)}</div>${t.description ? `<div class="tdesc">${escapeHtml(t.description.slice(0, 200))}</div>` : ''}</div>`).join('')}
        </div>
      </div>
    `;
    await refreshMcpList();
  };
  const path = `/api/mcp/servers/${encodeURIComponent(name)}/test`;
  const opts = { method: 'POST' };
  const result = await requestWithApproval(path, opts);
  await handleApprovalFlow(result, path, opts, {
    actionLabel: '连接测试 MCP server',
    onOk: async (r) => { await renderTools(r.body); },
    onError: (r) => { toolsArea.innerHTML = window.UI.EmptyState({ kind: 'error', icon: '❌', text: '连接失败：' + (r.error || 'unknown') }); },
    onDenied: (r) => { toolsArea.innerHTML = window.UI.EmptyState({ kind: 'error', icon: '❌', text: '测试被拒绝：' + (r.permissionDecision?.reason || 'denied') }); },
  });
}

async function deleteMcp(name) {
  const ok = await confirmModal({ title: '删除 MCP server', message: `要删除「${name}」吗？相关连接会立即断开。`, confirmLabel: '删除', cancelLabel: '取消' });
  if (!ok) return;
  const path = `/api/mcp/servers/${encodeURIComponent(name)}`;
  const opts = { method: 'DELETE' };
  const onDeleted = async () => {
    toast('已删除', 'success', 1500);
    mcpState.activeName = null;
    await refreshMcpList();
  };
  const result = await requestWithApproval(path, opts);
  await handleApprovalFlow(result, path, opts, {
    actionLabel: '删除 MCP server',
    onOk: async () => { await onDeleted(); },
    onError: (r) => toast('删除失败：' + (r.error || 'unknown'), 'error'),
  });
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
const autopilotState = createPanelMirroredState('autopilot', _autopilotStateRaw);

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

// ========== Agent 图谱 ==========
const agentRegistryState = {
  activeTab: 'dispatch',
  snapshot: null,
  classification: null,
  text: '重构多 Agent 架构，并用浏览器测试预算治理和审批流程。',
  affectedFiles: 'src/agents/AgentSkillRegistry.js\npublic/app.js\ntests/unit/agent-skill-registry.test.js',
  changedFilesInfo: null,
  codeContextEvidence: [],
  codeContextGraph: null,
  codebaseMap: null,
  codebaseQuestionAnswer: null,
  memberRole: 'dev',
  runs: [],
  runsLoading: false,
  runTimeline: null,
  runError: '',
  activeRunId: '',
  runFilters: {
    status: '',
    roomId: '',
    sessionId: '',
    agentProfileId: '',
    sourceType: '',
    approvalId: '',
    delegationId: '',
    budgetIncidentId: '',
    deferReason: '',
    approvalResumeGateId: '',
    approvalResumeGateSha256: '',
    hasGovernance: false,
  },
  modelSkillCenter: {
    providersLoaded: false,
    skillsLoaded: false,
  },
};
const AGENT_POLICY_OPTIONS = {
  budgetTier: ['low', 'standard', 'high', 'restricted'],
  commandGuard: ['standard', 'strict'],
  approvalPolicy: [
    'read_only',
    'plan_changes_only',
    'dangerous_commands',
    'architecture_changes',
    'final_decision',
    'release_and_destructive_actions',
    'asset_export_changes',
  ],
  auditLevel: ['standard', 'full'],
};

async function openAgentRegistryModal() {
  $('#agentRegistryModal').style.display = 'flex';
  await refreshAgentRegistry();
}
function closeAgentRegistryModal() { $('#agentRegistryModal').style.display = 'none'; }

async function refreshAgentRegistry() {
  const root = $('#agentRegistryModalBody');
  if (!root) return;
  root.innerHTML = '<div class="muted small" style="padding:20px;">加载中…</div>';
  try {
    agentRegistryState.snapshot = await api('/api/agent-registry');
    renderAgentRegistryModal();
  } catch (e) {
    root.innerHTML = `<div class="muted small" style="padding:20px;color:var(--color-danger-alt);">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderAgentRegistryModal() {
  const root = $('#agentRegistryModalBody');
  const snapshot = agentRegistryState.snapshot;
  if (!root || !snapshot) return;
  root.innerHTML = `
    ${renderAgentRegistrySummary(snapshot)}
    ${renderAgentRegistryTabs()}
    <div class="agent-registry-panel">
      ${renderAgentRegistryActiveTab(snapshot)}
    </div>
  `;
  bindAgentRegistryModalEvents();
}

function renderAgentRegistrySummary(snapshot) {
  const missing = snapshot.missingSkillNames || [];
  return `<div class="agent-registry-summary">
    <span><strong>${snapshot.counts?.profiles || 0}</strong> profiles</span>
    <span><strong>${snapshot.counts?.rules || 0}</strong> dispatch rules</span>
    <span><strong>${snapshot.counts?.installedSkills || 0}</strong> installed skills</span>
    <span class="${missing.length ? 'is-warn' : ''}"><strong>${missing.length}</strong> missing bindings</span>
    <button class="cxbtn cxbtn-secondary cxbtn-sm" id="agentRegistryRefresh">刷新</button>
  </div>`;
}

function renderAgentRegistryTabs() {
  const tabs = [
    ['profiles', 'Profiles'],
    ['dispatch', 'Dispatch'],
    ['models', 'Models/Skills'],
    ['runs', 'Runs'],
    ['policies', 'Policies'],
  ];
  return `<div class="agent-registry-tabs" role="tablist">
    ${tabs.map(([id, label]) => `<button class="agent-registry-tab ${agentRegistryState.activeTab === id ? 'is-active' : ''}" data-agent-tab="${id}" type="button">${label}</button>`).join('')}
  </div>`;
}

function renderAgentRegistryActiveTab(snapshot) {
  if (agentRegistryState.activeTab === 'profiles') return renderAgentProfilesTab(snapshot);
  if (agentRegistryState.activeTab === 'models') return renderAgentModelSkillCenterTab(snapshot);
  if (agentRegistryState.activeTab === 'runs') return renderAgentRunsTab();
  if (agentRegistryState.activeTab === 'policies') return renderAgentPoliciesTab(snapshot);
  return renderAgentDispatchTab(snapshot);
}

function renderAgentProfilesTab(snapshot) {
  const profiles = snapshot.profiles || [];
  return `<section class="agent-registry-section">
    <h3>Profiles</h3>
    <div class="agent-profile-grid">
      ${profiles.map(profile => renderAgentProfileCard(profile, { showPolicyEditor: false })).join('') || '<div class="agent-empty">No profiles.</div>'}
    </div>
  </section>`;
}

function renderAgentDispatchTab(snapshot) {
  const rules = snapshot.rules || [];
  return `<div class="agent-registry-layout agent-registry-layout-dispatch">
    <section class="agent-registry-rules">
      <h3>Dispatch Rules</h3>
      <div class="agent-rule-list">
        ${rules.map(renderAgentRule).join('') || '<div class="agent-empty">No dispatch rules.</div>'}
      </div>
    </section>
    <section class="agent-registry-lab">
      <h3>Dispatch Preview</h3>
      ${renderAgentDispatchWorkflow()}
      <div class="agent-preview-form">
        <select id="agentPreviewRole" aria-label="预演角色">
          ${['pm', 'dev', 'qa', 'architect', 'judge', 'shipper', 'designer', 'observer'].map(role => `<option value="${role}" ${agentRegistryState.memberRole === role ? 'selected' : ''}>${role}</option>`).join('')}
        </select>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="agentPreviewLoadChanged">当前变更</button>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="agentPreviewLoadCodebase">工程地图</button>
        <button class="cxbtn cxbtn-primary cxbtn-sm" id="agentPreviewRun">预演分派</button>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="agentPreviewCreateRun">创建 Run Draft</button>
      </div>
      <textarea id="agentPreviewText" rows="5" placeholder="输入一个任务，查看会命中哪些 tag、profile 和 skill">${escapeHtml(agentRegistryState.text)}</textarea>
      <textarea id="agentPreviewFiles" rows="4" placeholder="可选：粘贴受影响文件路径，每行一个；用于观察工程上下文如何影响分派">${escapeHtml(agentRegistryState.affectedFiles)}</textarea>
      <div id="agentPreviewFilesInfo" class="agent-preview-files-info">${renderAgentChangedFilesInfo(agentRegistryState.changedFilesInfo)}</div>
      <div id="agentPreviewQuestionInfo">${renderAgentCodebaseQuestionAnswer(agentRegistryState.codebaseQuestionAnswer)}</div>
      <div id="agentPreviewResult" class="agent-preview-result">
        ${agentRegistryState.classification ? renderAgentClassification(agentRegistryState.classification) : '<div class="agent-empty">输入任务后点击预演。</div>'}
      </div>
    </section>
  </div>`;
}

function renderAgentPoliciesTab(snapshot) {
  const profiles = snapshot.profiles || [];
  return `<section class="agent-registry-section">
    <h3>Policies</h3>
    <div class="agent-profile-grid">
      ${profiles.map(profile => renderAgentProfileCard(profile, { showPolicyEditor: true })).join('') || '<div class="agent-empty">No policies.</div>'}
    </div>
  </section>`;
}

function modelSkillProviderRole(providerId = '') {
  const id = String(providerId || '').toLowerCase();
  if (id.includes('codex')) return 'implementation / verification';
  if (id.includes('claude') || id === 'ccr') return 'planning / architecture review';
  if (id.includes('ollama')) return 'local privacy / offline checks';
  if (id.includes('gemini')) return 'research / large context';
  if (id.includes('minimax')) return 'Chinese writing / draft review';
  return 'custom local adapter';
}

function renderModelOptionChips(providerId = '') {
  const options = (MODEL_OPTIONS[providerId] || [])
    .filter(Boolean)
    .slice(0, 5);
  if (options.length === 0) return '<span class="missing">custom model</span>';
  return options.map(option => `<span>${escapeHtml(option)}</span>`).join('');
}

function modelSkillModelCount(providerId = '') {
  return (MODEL_OPTIONS[providerId] || []).filter(Boolean).length;
}

function modelSkillPreferredModel(providerId = '') {
  return (MODEL_OPTIONS[providerId] || []).find(Boolean) || 'adapter default';
}

function modelSkillPickProvider(providers = [], preferred = []) {
  for (const key of preferred) {
    const found = providers.find(provider => String(provider.id || '').toLowerCase().includes(key));
    if (found) return found;
  }
  return providers[0] || null;
}

function buildModelSkillRecommendations(providers = []) {
  const cases = [
    ['implementation', ['codex', 'claude'], 'source changes and local verification'],
    ['verification', ['codex', 'gemini-cli', 'ollama'], 'tests, diff checks and repeatable evidence'],
    ['architecture', ['claude', 'codex'], 'cross-file design review and tradeoffs'],
    ['governance', ['codex', 'claude'], 'approval, budget, audit and gate reasoning'],
    ['research', ['gemini-cli', 'gemini', 'claude'], 'large-context local research support'],
    ['privacy/local', ['ollama'], 'offline or local-only checks when configured'],
  ];
  return cases.map(([label, preferred, reason]) => {
    const provider = modelSkillPickProvider(providers, preferred);
    return {
      label,
      provider,
      model: provider ? modelSkillPreferredModel(provider.id) : 'no active provider',
      reason,
      source: provider ? 'active adapter + local model list' : 'no matching active adapter',
    };
  });
}

function buildSkillSourceRows(profiles = [], rules = []) {
  const installed = new Map((roomSkillsCache || []).map(skill => [skill.name, skill]));
  const rows = new Map();
  function ensure(name) {
    if (!rows.has(name)) {
      const skill = installed.get(name) || {};
      rows.set(name, {
        name,
        displayName: skill.displayName || name,
        bodyLen: Number(skill.bodyLen || 0),
        updatedAt: skill.updatedAt || '',
        installed: installed.has(name),
        profileIds: [],
        dispatchTags: [],
      });
    }
    return rows.get(name);
  }
  for (const profile of profiles) {
    for (const skill of profile.skillCoverage || []) {
      ensure(skill.name).profileIds.push(profile.id);
    }
  }
  for (const rule of rules) {
    for (const name of rule.skillHints || []) {
      ensure(name).dispatchTags.push(rule.tag);
    }
  }
  for (const skill of roomSkillsCache || []) ensure(skill.name);
  return [...rows.values()].sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? 1 : -1;
    const ar = a.profileIds.length + a.dispatchTags.length;
    const br = b.profileIds.length + b.dispatchTags.length;
    return br - ar || a.name.localeCompare(b.name);
  });
}

function skillSourceRiskLabels(row = {}) {
  const risks = [];
  const sourceCount = (row.profileIds || []).length + (row.dispatchTags || []).length;
  if (!row.installed) risks.push(['missing', 'missing']);
  if (sourceCount === 0) risks.push(['missing', 'not injected']);
  if (sourceCount >= 5) risks.push(['missing', 'multi-source']);
  if (Number(row.bodyLen || 0) > 50_000) risks.push(['missing', 'large prompt']);
  if (risks.length === 0) risks.push(['ok', 'ok']);
  return risks;
}

function renderAgentModelSkillCenterTab(snapshot) {
  if (!agentRegistryState.modelSkillCenter.providersLoaded) {
    agentRegistryState.modelSkillCenter.providersLoaded = true;
    refreshRoomProviders().then(() => {
      if (agentRegistryState.activeTab === 'models') renderAgentRegistryModal();
    });
  }
  if (!agentRegistryState.modelSkillCenter.skillsLoaded) {
    agentRegistryState.modelSkillCenter.skillsLoaded = true;
    refreshRoomSkills().then(() => {
      if (agentRegistryState.activeTab === 'models') renderAgentRegistryModal();
    });
  }

  const profiles = snapshot.profiles || [];
  const rules = snapshot.rules || [];
  const providers = roomProvidersCache || [];
  const activeProviderIds = new Set(providers.map(provider => provider.id).filter(Boolean));
  const knownProviders = Object.keys(MODEL_OPTIONS);
  const availableProviderIds = knownProviders.filter(id => !activeProviderIds.has(id));
  const installedSkillNames = new Set((roomSkillsCache || []).map(skill => skill.name));
  const missingSkillNames = snapshot.missingSkillNames || [];
  const dispatchSkillHints = [...new Set(rules.flatMap(rule => rule.skillHints || []))].sort();
  const missingDispatchHints = dispatchSkillHints.filter(name => !installedSkillNames.has(name));
  const boundSkillCount = profiles.reduce((sum, profile) => sum + (profile.skillCoverage || []).length, 0);
  const installedBoundSkillCount = profiles.reduce(
    (sum, profile) => sum + (profile.skillCoverage || []).filter(skill => skill.installed && skill.enabled).length,
    0,
  );
  const recommendations = buildModelSkillRecommendations(providers);
  const skillSourceRows = buildSkillSourceRows(profiles, rules);
  const sourceRiskCount = skillSourceRows.filter(row => skillSourceRiskLabels(row).some(([cls]) => cls === 'missing')).length;

  return `<section class="agent-registry-section agent-model-skill-center" data-agent-model-center>
    <div class="agent-model-center-head">
      <div>
        <h3>Model / Skill Center</h3>
        <p>Local status only · no secrets shown · provider config is read-only here</p>
      </div>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="agentModelSkillRefresh" type="button">刷新状态</button>
    </div>
    <div class="agent-model-kpis">
      <span><strong>${providers.length}</strong> active providers</span>
      <span><strong>${knownProviders.length}</strong> local model lists</span>
      <span><strong>${roomSkillsCache.length}</strong> enabled skills</span>
      <span class="${missingSkillNames.length ? 'is-warn' : ''}"><strong>${missingSkillNames.length}</strong> missing bindings</span>
      <span class="${missingDispatchHints.length ? 'is-warn' : ''}"><strong>${missingDispatchHints.length}</strong> missing dispatch hints</span>
      <span class="${sourceRiskCount ? 'is-warn' : ''}"><strong>${sourceRiskCount}</strong> skill source risks</span>
    </div>
    <div class="agent-model-grid">
      <section class="agent-model-panel">
        <h4>Provider Model Status</h4>
        <div class="agent-provider-list">
          ${providers.length ? providers.map(provider => `
            <article class="agent-provider-row is-active">
              <div class="agent-provider-head">
                <strong>${escapeHtml(provider.displayName || provider.id)}</strong>
                <code>${escapeHtml(provider.id)}</code>
              </div>
              <div class="agent-provider-meta">
                <span>active local adapter</span>
                <span>${escapeHtml(modelSkillProviderRole(provider.id))}</span>
                <span>${modelSkillModelCount(provider.id)} local model hints</span>
                <span>No live ping</span>
              </div>
              <div class="agent-model-chip-list">${renderModelOptionChips(provider.id)}</div>
            </article>
          `).join('') : '<div class="agent-empty">No active providers reported by local room adapter pool.</div>'}
        </div>
        ${availableProviderIds.length ? `
          <div class="agent-provider-available">
            <h5>Configured option lists</h5>
            <div class="agent-model-chip-list">
              ${availableProviderIds.map(id => `<span title="${escapeHtml(modelSkillProviderRole(id))}">${escapeHtml(id)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
      </section>
      <section class="agent-model-panel">
        <h4>Model Recommendations</h4>
        <div class="agent-model-recommendation-list">
          ${recommendations.map(item => `
            <article class="agent-model-recommendation-row ${item.provider ? '' : 'is-missing'}">
              <div class="agent-provider-head">
                <strong>${escapeHtml(item.label)}</strong>
                <code>${escapeHtml(item.provider?.id || 'inactive')}</code>
              </div>
              <div class="agent-provider-meta">
                <span>${escapeHtml(item.provider?.displayName || 'no active provider')}</span>
                <span>${escapeHtml(item.model)}</span>
                <span>source: ${escapeHtml(item.source)}</span>
              </div>
              <p>${escapeHtml(item.reason)}</p>
            </article>
          `).join('')}
        </div>
      </section>
      <section class="agent-model-panel">
        <h4>Skill Injection Matrix</h4>
        <div class="agent-skill-matrix-summary">
          <span>${installedBoundSkillCount}/${boundSkillCount} bound skills installed</span>
          <span>${dispatchSkillHints.length} dispatch hints</span>
        </div>
        <div class="agent-skill-matrix">
          ${profiles.map(profile => renderAgentSkillMatrixRow(profile)).join('') || '<div class="agent-empty">No profiles.</div>'}
        </div>
        <div class="agent-skill-gap-list">
          <h5>Missing bindings</h5>
          <div class="agent-model-chip-list">
            ${missingSkillNames.length ? missingSkillNames.map(name => `<span class="missing">${escapeHtml(name)}</span>`).join('') : '<span class="ok">none</span>'}
          </div>
          <h5>Missing dispatch hints</h5>
          <div class="agent-model-chip-list">
            ${missingDispatchHints.length ? missingDispatchHints.map(name => `<span class="missing">${escapeHtml(name)}</span>`).join('') : '<span class="ok">none</span>'}
          </div>
        </div>
      </section>
      <section class="agent-model-panel agent-skill-source-panel">
        <h4>Skill Source & Risk</h4>
        <div class="agent-skill-matrix-summary">
          <span>${skillSourceRows.length} tracked skills</span>
          <span>${sourceRiskCount} source risks</span>
          <span>explicit conflict metadata not exposed by list API</span>
        </div>
        <div class="agent-skill-source-list">
          ${skillSourceRows.map(row => renderSkillSourceRiskRow(row)).join('') || '<div class="agent-empty">No skills reported by local registry.</div>'}
        </div>
      </section>
    </div>
  </section>`;
}

function renderSkillSourceRiskRow(row) {
  const profileText = (row.profileIds || []).slice(0, 6).join(', ') || 'none';
  const tagText = (row.dispatchTags || []).slice(0, 8).join(', ') || 'none';
  return `<article class="agent-skill-source-row" data-agent-skill-source="${escapeHtml(row.name)}">
    <div class="agent-skill-matrix-head">
      <strong>${escapeHtml(row.displayName || row.name)}</strong>
      <code>${escapeHtml(row.name)}</code>
    </div>
    <div class="agent-provider-meta">
      <span>profiles: ${escapeHtml(profileText)}</span>
      <span>dispatch: ${escapeHtml(tagText)}</span>
      <span>${Number(row.bodyLen || 0)} chars</span>
    </div>
    <div class="agent-model-chip-list">
      ${skillSourceRiskLabels(row).map(([cls, label]) => `<span class="${cls}">${escapeHtml(label)}</span>`).join('')}
    </div>
  </article>`;
}

function renderAgentSkillMatrixRow(profile) {
  const coverage = profile.skillCoverage || [];
  const installed = coverage.filter(skill => skill.installed && skill.enabled).length;
  const missing = coverage.filter(skill => !skill.installed || !skill.enabled);
  const policy = profile.governance || {};
  return `<article class="agent-skill-matrix-row" data-agent-skill-profile="${escapeHtml(profile.id)}">
    <div class="agent-skill-matrix-head">
      <strong>${escapeHtml(profile.title || profile.id)}</strong>
      <code>${escapeHtml(profile.id)}</code>
    </div>
    <div class="agent-provider-meta">
      ${(profile.roles || []).map(role => `<span>${escapeHtml(role)}</span>`).join('') || '<span>role fallback</span>'}
      <span>${installed}/${coverage.length} skills</span>
      <span>${escapeHtml(policy.approvalPolicy || 'approval inherited')}</span>
    </div>
    <div class="agent-model-chip-list">
      ${coverage.length ? coverage.map(skill => `<span class="${skill.installed && skill.enabled ? 'ok' : 'missing'}">${escapeHtml(skill.name)}</span>`).join('') : '<span class="missing">no bound skills</span>'}
    </div>
    ${missing.length ? `<div class="agent-skill-matrix-note">${missing.length} missing or disabled skill bindings need local registry attention.</div>` : ''}
  </article>`;
}

function bindAgentRegistryModalEvents() {
  const root = $('#agentRegistryModalBody');
  $('#agentRegistryRefresh')?.addEventListener('click', refreshAgentRegistry);
  $('#agentModelSkillRefresh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '刷新中…';
    agentRegistryState.modelSkillCenter.providersLoaded = true;
    agentRegistryState.modelSkillCenter.skillsLoaded = true;
    roomSkillsLoaded = false;
    await Promise.all([refreshRoomProviders(), refreshRoomSkills()]);
    renderAgentRegistryModal();
  });
  document.querySelectorAll('[data-agent-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setAgentRegistryTab(btn.dataset.agentTab));
  });
  $('#agentPreviewRole')?.addEventListener('change', (e) => {
    agentRegistryState.memberRole = e.target.value;
    agentRegistryState.classification = null;
    refreshAgentDispatchWorkflow();
  });
  $('#agentPreviewText')?.addEventListener('input', (e) => {
    agentRegistryState.text = e.target.value;
    agentRegistryState.classification = null;
    refreshAgentDispatchWorkflow();
  });
  $('#agentPreviewFiles')?.addEventListener('input', (e) => {
    agentRegistryState.affectedFiles = e.target.value;
    agentRegistryState.changedFilesInfo = null;
    agentRegistryState.codeContextEvidence = [];
    agentRegistryState.codeContextGraph = null;
    agentRegistryState.codebaseMap = null;
    agentRegistryState.codebaseQuestionAnswer = null;
    agentRegistryState.classification = null;
    const info = $('#agentPreviewFilesInfo');
    if (info) info.innerHTML = '';
    const questionInfo = $('#agentPreviewQuestionInfo');
    if (questionInfo) questionInfo.innerHTML = '';
    refreshAgentDispatchWorkflow();
  });
  $('#agentPreviewLoadChanged')?.addEventListener('click', (e) => loadAgentChangedFiles(e.currentTarget));
  $('#agentPreviewLoadCodebase')?.addEventListener('click', (e) => loadAgentCodebaseMap(e.currentTarget));
  $('#agentPreviewRun')?.addEventListener('click', runAgentPreview);
  $('#agentPreviewCreateRun')?.addEventListener('click', (e) => createAgentRunFromIdea(e.currentTarget));
  root.querySelectorAll('[data-agent-policy-save]').forEach((btn) => {
    btn.addEventListener('click', () => saveAgentPolicy(btn.dataset.agentPolicySave, btn));
  });
  root.querySelectorAll('[data-agent-policy-reset]').forEach((btn) => {
    btn.addEventListener('click', () => resetAgentPolicy(btn.dataset.agentPolicyReset, btn));
  });
  bindAgentRunsEvents(root);
}

function setAgentRegistryTab(tab) {
  agentRegistryState.activeTab = tab || 'dispatch';
  renderAgentRegistryModal();
  if (agentRegistryState.activeTab === 'runs' && !agentRegistryState.runsLoading && agentRegistryState.runs.length === 0) {
    refreshAgentRuns();
  }
}

function renderAgentRunsTab() {
  const f = agentRegistryState.runFilters;
  const runs = agentRegistryState.runs || [];
  const active = agentRegistryState.runTimeline?.run || runs.find(run => run.id === agentRegistryState.activeRunId) || null;
  return `<section class="agent-registry-section agent-runs-section">
    <div class="agent-runs-toolbar">
      <select id="agentRunStatusFilter" aria-label="Run status">
        ${['', 'queued', 'running', 'succeeded', 'failed', 'deferred', 'cancelled'].map(status => `<option value="${status}" ${f.status === status ? 'selected' : ''}>${status || 'all status'}</option>`).join('')}
      </select>
      <input id="agentRunRoomFilter" type="text" placeholder="roomId" value="${escapeHtml(f.roomId)}" />
      <input id="agentRunSessionFilter" type="text" placeholder="sessionId" value="${escapeHtml(f.sessionId)}" />
      <input id="agentRunProfileFilter" type="text" placeholder="agentProfileId" value="${escapeHtml(f.agentProfileId)}" />
      <input id="agentRunSourceFilter" type="text" placeholder="sourceType" value="${escapeHtml(f.sourceType)}" />
      <input id="agentRunApprovalFilter" type="text" placeholder="approvalId" value="${escapeHtml(f.approvalId)}" />
      <input id="agentRunDelegationFilter" type="text" placeholder="delegationId" value="${escapeHtml(f.delegationId)}" />
      <input id="agentRunBudgetFilter" type="text" placeholder="budgetIncidentId" value="${escapeHtml(f.budgetIncidentId)}" />
      <input id="agentRunDeferFilter" type="text" placeholder="deferReason" value="${escapeHtml(f.deferReason)}" />
      <input id="agentRunGateFilter" type="text" placeholder="reviewGateId" value="${escapeHtml(f.approvalResumeGateId)}" />
      <input id="agentRunGateShaFilter" type="text" placeholder="reviewSha256" value="${escapeHtml(f.approvalResumeGateSha256)}" />
      <label class="agent-run-toggle"><input id="agentRunGovernanceFilter" type="checkbox" ${f.hasGovernance ? 'checked' : ''} /><span>治理链</span></label>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="agentRunsClear">清空</button>
      <button class="cxbtn cxbtn-primary cxbtn-sm" id="agentRunsRefresh">${agentRegistryState.runsLoading ? '加载中…' : '刷新 Runs'}</button>
    </div>
    ${agentRegistryState.runError ? `<div class="agent-empty error">${escapeHtml(agentRegistryState.runError)}</div>` : ''}
    <div class="agent-runs-layout">
      <div class="agent-run-list">
        ${runs.length ? runs.map(renderAgentRunRow).join('') : `<div class="agent-empty">${agentRegistryState.runsLoading ? '加载中…' : '暂无 Agent Run。'}</div>`}
      </div>
      <div class="agent-run-detail">
        ${active ? renderAgentRunDetail(active, agentRegistryState.runTimeline) : '<div class="agent-empty">选择一个 run 查看 timeline、messages 和 tool results。</div>'}
      </div>
    </div>
  </section>`;
}

function agentRunMetricText(run = {}) {
  const d = run.details || {};
  const tokens = (Number(d.tokensIn) || 0) + (Number(d.tokensOut) || 0);
  const parts = [];
  if (tokens) parts.push(`${fmtBigInt(tokens)} tok`);
  if (Number(d.estCostUSD)) parts.push(fmtUSD(Number(d.estCostUSD)));
  if (Number(d.latencyMs)) parts.push(fmtMs(Number(d.latencyMs)));
  return parts.join(' · ') || '-';
}

function agentRunDiagnosticsCount(run = {}) {
  return Array.isArray(run.details?.diagnostics) ? run.details.diagnostics.length : 0;
}

function renderAgentRunRow(run) {
  const active = agentRegistryState.activeRunId === run.id;
  const diagnostics = agentRunDiagnosticsCount(run);
  const lineage = run.lineageSummary || {};
  const governanceParts = [
    lineage.approvalCount ? `${lineage.approvalCount} approval` : '',
    lineage.delegationCount ? `${lineage.delegationCount} delegation` : '',
    lineage.budgetIncidentCount ? `${lineage.budgetIncidentCount} budget` : '',
    lineage.blockerCount ? `${lineage.blockerCount} blocker` : '',
  ].filter(Boolean).join(' · ');
  return `<button class="agent-run-row ${active ? 'is-active' : ''}" data-agent-run-id="${escapeHtml(run.id)}" type="button">
    <span class="agent-run-status status-${escapeHtml(run.status || 'unknown')}">${escapeHtml(run.status || '-')}</span>
    <strong>${escapeHtml(run.taskId || run.sourceType || run.id)}</strong>
    <em>${escapeHtml(run.agentProfileId || '-')} · ${escapeHtml(run.roomId || '-')}</em>
    <span>${escapeHtml(agentRunMetricText(run))}${diagnostics ? ` · ${diagnostics} diagnostics` : ''}${governanceParts ? ` · ${escapeHtml(governanceParts)}` : ''}</span>
    <small>${activityTime(run.updatedAt || run.createdAt)}</small>
  </button>`;
}

function renderWorkflowStep(label, status, meta = '') {
  return `<div class="agent-workflow-step is-${escapeHtml(status || 'pending')}">
    <strong>${escapeHtml(label)}</strong>
    <span>${escapeHtml(meta || status || '-')}</span>
  </div>`;
}

function renderAgentDispatchWorkflow() {
  const hasIdea = Boolean((agentRegistryState.text || '').trim());
  const hasContext = Boolean((agentRegistryState.affectedFiles || '').trim() || agentRegistryState.codebaseMap || agentRegistryState.codebaseQuestionAnswer);
  const hasPreview = Boolean(agentRegistryState.classification);
  const profile = agentRegistryState.classification?.profile?.id || '-';
  const next = !hasIdea ? '输入一句任务目标'
    : !hasPreview ? '预演分派'
      : '创建 Run Draft';
  return `<div class="agent-main-path" data-agent-main-path="dispatch">
    <div class="agent-main-path-head">
      <strong>Idea-to-Archive Path</strong>
      <span>Next: ${escapeHtml(next)}</span>
    </div>
    <div class="agent-workflow-steps">
      ${renderWorkflowStep('Idea', hasIdea ? 'done' : 'current', hasIdea ? 'ready' : 'input')}
      ${renderWorkflowStep('Code Context', hasContext ? 'done' : 'pending', hasContext ? 'local evidence' : 'optional')}
      ${renderWorkflowStep('Dispatch Preview', hasPreview ? 'done' : (hasIdea ? 'current' : 'pending'), hasPreview ? profile : 'agent/skill')}
      ${renderWorkflowStep('Run Draft', hasPreview ? 'current' : 'pending', 'governed run')}
    </div>
  </div>`;
}

function refreshAgentDispatchWorkflow() {
  const node = document.querySelector('[data-agent-main-path="dispatch"]');
  if (node) node.outerHTML = renderAgentDispatchWorkflow();
}

function latestIdeaRunStage(timeline = null, stage = '') {
  const archives = Array.isArray(timeline?.archives) ? timeline.archives : [];
  return archives.some((archive) => archive.evidence?.external?.stage === stage);
}

function latestIdeaRunArchive(timeline = null, stage = '') {
  const archives = Array.isArray(timeline?.archives) ? timeline.archives : [];
  for (const archive of archives.slice().reverse()) {
    if (!stage || archive.evidence?.external?.stage === stage) return archive;
  }
  return null;
}

function ideaRunArchiveSummary(archive = null, artifacts = []) {
  if (!archive) return null;
  const external = archive.evidence?.external || {};
  const fileCount = Array.isArray(external.fileChanges)
    ? external.fileChanges.length
    : Array.isArray(archive.evidence?.files) ? archive.evidence.files.length : 0;
  const blockers = archive.governance?.summary?.blockerCount ?? archive.governance?.blockers?.length ?? 0;
  return {
    id: archive.id || '',
    status: archive.status || 'archived',
    summary: archive.summary || archive.id || 'Execution archive recorded.',
    toolResultCount: Number(archive.verification?.toolResultCount || 0),
    fileCount: Number(fileCount || 0),
    artifactCount: Array.isArray(artifacts) ? artifacts.length : 0,
    blockerCount: Number(blockers || 0),
  };
}

function ideaRunWorkflowState(run = {}, timeline = null) {
  const messages = Array.isArray(timeline?.messages) ? timeline.messages : [];
  const toolResults = Array.isArray(timeline?.toolResults) ? timeline.toolResults : [];
  const archives = Array.isArray(timeline?.archives) ? timeline.archives : [];
  const artifacts = Array.isArray(timeline?.artifacts) ? timeline.artifacts : [];
  const manifestDraft = latestIdeaRunManifestDraft(timeline);
  const hasManifestDraft = Boolean(manifestDraft);
  const hasPatchDraft = Boolean(manifestDraft?.patchQuality || messages.some((message) => message.payload?.manifestDraft?.patchQuality));
  const hasApproval = Boolean(run.approvalId || run.details?.approvalId);
  const deferReason = run.deferReason || run.details?.deferReason || '';
  const isDeferredApproval = run.status === 'deferred' && (/approval/i.test(deferReason) || hasApproval);
  const hasGate = Boolean(run.details?.approvalResumeGateAudit);
  const finalArchive = latestIdeaRunArchive(timeline, 'idea_final_archive') || (['succeeded', 'failed', 'cancelled'].includes(run.status) ? latestIdeaRunArchive(timeline) : null);
  const hasFinalArchive = Boolean(finalArchive) || latestIdeaRunStage(timeline, 'idea_final_archive') || ['succeeded', 'failed', 'cancelled'].includes(run.status);
  const hasVerification = toolResults.length > 0 || archives.some((archive) => Number(archive.verification?.toolResultCount) > 0);
  const hasArtifacts = artifacts.length > 0;
  const dispatchMeta = run.agentProfileId || (run.skills || []).join(', ') || 'profile';
  const finished = ['succeeded', 'failed', 'cancelled'].includes(run.status);
  const nextLabel = isDeferredApproval
    ? 'Preflight Review 等待审批续跑'
    : !hasManifestDraft && !hasFinalArchive
      ? 'Generate Manifest 或 Generate Patch'
      : hasManifestDraft && !hasFinalArchive
        ? 'Auto Work + Verify'
        : hasGate
          ? 'Gate Audit Report / Archive Report'
          : 'Archive evidence ready';
  return {
    hasManifestDraft,
    hasPatchDraft,
    hasApproval,
    isDeferredApproval,
    hasGate,
    hasFinalArchive,
    hasVerification,
    hasArtifacts,
    dispatchMeta,
    nextLabel,
    finished,
    runId: run.id,
    approvalId: run.approvalId || run.details?.approvalId || '',
    archiveSummary: ideaRunArchiveSummary(finalArchive, artifacts),
    steps: [
      { label: 'Idea', status: 'done', meta: run.taskId || run.sourceId || 'captured' },
      { label: 'Dispatch', status: 'done', meta: dispatchMeta },
      { label: 'Manifest/Patch', status: hasManifestDraft || hasFinalArchive ? 'done' : 'current', meta: hasPatchDraft ? 'patch quality' : (hasManifestDraft ? 'manifest draft' : 'draft needed') },
      { label: 'Work + Verify', status: hasFinalArchive ? 'done' : (hasManifestDraft && !isDeferredApproval ? 'current' : 'pending'), meta: hasVerification ? 'verification evidence' : 'local verify' },
      { label: 'Preflight', status: hasGate ? 'done' : (isDeferredApproval ? 'current' : 'pending'), meta: hasGate ? 'gate accepted' : (isDeferredApproval ? 'approval required' : 'if needed') },
      { label: 'Archive', status: hasFinalArchive ? 'done' : 'pending', meta: hasArtifacts ? 'artifacts linked' : 'final evidence' },
    ],
  };
}

function ideaRunWorkflowActions(state = {}) {
  const runId = state.runId || '';
  const actions = { primary: null, secondary: [] };
  if (!runId) return actions;
  const action = (label, attrs = {}, variant = 'secondary') => ({ label, attrs, variant });
  if (state.isDeferredApproval) {
    actions.primary = action('Open Preflight Review', { 'data-agent-run-governance-review': runId }, 'primary');
    if (state.approvalId) actions.secondary.push(action('打开审批', { 'data-agent-run-approval': state.approvalId }, 'tertiary'));
    actions.secondary.push(action('Activity', { 'data-agent-run-activity': runId }, 'tertiary'));
    return actions;
  }
  if (!state.hasManifestDraft && !state.finished) {
    actions.primary = action('Generate Manifest', { 'data-agent-run-idea-generate-manifest': runId }, 'primary');
    actions.secondary.push(action('Generate Patch', { 'data-agent-run-idea-generate-patch': runId }, 'secondary'));
    actions.secondary.push(action('Run Custom Manifest', { 'data-agent-run-idea-manifest': runId }, 'secondary'));
    actions.secondary.push(action('Auto Work + Verify', { 'data-agent-run-idea-auto': runId }, 'secondary'));
    actions.secondary.push(action('Record Completion', { 'data-agent-run-idea-complete': runId }, 'tertiary'));
    return actions;
  }
  if (state.hasManifestDraft && !state.finished) {
    actions.primary = action('Auto Work + Verify', { 'data-agent-run-idea-auto': runId }, 'primary');
    actions.secondary.push(action('Edit Manifest', { 'data-agent-run-idea-manifest': runId }, 'secondary'));
    actions.secondary.push(action('Record Completion', { 'data-agent-run-idea-complete': runId }, 'tertiary'));
    return actions;
  }
  if (state.hasGate) {
    actions.primary = action('Gate Audit Report', { 'data-agent-run-gate-audit': runId }, 'primary');
    actions.secondary.push(action('Archive Report', { 'data-agent-run-gate-audit-archive': runId }, 'secondary'));
    actions.secondary.push(action('Activity', { 'data-agent-run-activity': runId }, 'tertiary'));
    return actions;
  }
  actions.primary = action('Review Archive', { 'data-agent-run-review-archive': runId }, 'primary');
  if (state.hasArtifacts) actions.secondary.push(action('Open Artifacts', { 'data-agent-run-open-artifacts': runId }, 'secondary'));
  actions.secondary.push(action('Add Archive Note', { 'data-agent-run-archive': runId }, 'secondary'));
  actions.secondary.push(action('Activity', { 'data-agent-run-activity': runId }, 'tertiary'));
  return actions;
}

function renderAgentWorkflowButton(action = null, options = {}) {
  if (!action) return '';
  const attrs = Object.entries(action.attrs || {})
    .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
    .join(' ');
  const marker = options.primary ? 'data-agent-main-next="true"' : 'data-agent-main-secondary="true"';
  const variant = action.variant === 'primary' ? 'cxbtn-primary'
    : action.variant === 'tertiary' ? 'cxbtn-tertiary'
      : 'cxbtn-secondary';
  return `<button class="cxbtn ${variant} cxbtn-sm ${options.primary ? 'agent-main-next-btn' : ''}" ${marker} ${attrs}>${escapeHtml(action.label || 'Open')}</button>`;
}

function renderIdeaRunWorkflow(run = {}, timeline = null) {
  if (run.sourceType !== 'idea_to_archive') return '';
  const state = ideaRunWorkflowState(run, timeline);
  const actions = ideaRunWorkflowActions(state);
  const archiveSummary = state.archiveSummary;
  return `<div class="agent-run-block agent-main-path" data-agent-main-path="run">
    <div class="agent-main-path-head">
      <strong>Idea-to-Archive Path</strong>
      <span>Next: ${escapeHtml(state.nextLabel)}</span>
    </div>
    <div class="agent-workflow-steps">
      ${state.steps.map((step) => renderWorkflowStep(step.label, step.status, step.meta)).join('')}
    </div>
    ${archiveSummary ? `<div class="agent-main-archive-summary" data-agent-main-archive-summary>
      <div>
        <strong>Final archive</strong>
        <span>${escapeHtml(archiveSummary.summary)}</span>
      </div>
      <div class="agent-main-archive-stats">
        <span>${escapeHtml(archiveSummary.status)}</span>
        <span>${escapeHtml(archiveSummary.toolResultCount)} tools</span>
        <span>${escapeHtml(archiveSummary.fileCount)} files</span>
        <span>${escapeHtml(archiveSummary.artifactCount)} artifacts</span>
        <span>${escapeHtml(archiveSummary.blockerCount)} blockers</span>
      </div>
    </div>` : ''}
    <div class="agent-main-path-actions">
      <span class="agent-main-path-action-label">Recommended next</span>
      ${renderAgentWorkflowButton(actions.primary, { primary: true })}
      ${actions.secondary.length ? `<span class="agent-main-path-action-label">Other actions</span>${actions.secondary.map(item => renderAgentWorkflowButton(item)).join('')}` : ''}
    </div>
  </div>`;
}

function renderAgentRunDetail(run, timeline = null) {
  const messages = timeline?.messages || [];
  const toolResults = timeline?.toolResults || [];
  const activityEvents = timeline?.activityEvents || [];
  const governanceLineage = timeline?.governanceLineage || null;
  const archives = timeline?.archives || messages.filter(message => message.kind === 'archive' && message.payload?.archive).map(message => ({ ...message.payload.archive, messageId: message.id }));
  const artifacts = timeline?.artifacts || [];
  const diagnostics = run.details?.diagnostics || [];
  const budgetIncidentId = run.budgetIncidentId || run.details?.budgetIncidentId || governanceLineage?.budgetIncidents?.[0]?.id || '';
  const isIdeaRun = run.sourceType === 'idea_to_archive';
  return `<div class="agent-run-detail-inner">
    <div class="agent-run-detail-head">
      <div>
        <span class="agent-run-status status-${escapeHtml(run.status || 'unknown')}">${escapeHtml(run.status || '-')}</span>
        <strong>${escapeHtml(run.id)}</strong>
      </div>
      <span>${escapeHtml(agentRunMetricText(run))}</span>
    </div>
    <div class="agent-run-meta-grid">
      <div><b>Room</b><code>${escapeHtml(run.roomId || '-')}</code></div>
      <div><b>Session</b><code>${escapeHtml(run.sessionId || '-')}</code></div>
      <div><b>Profile</b><code>${escapeHtml(run.agentProfileId || '-')}</code></div>
      <div><b>Adapter</b><code>${escapeHtml(run.adapterId || '-')}</code></div>
      <div><b>Model</b><code>${escapeHtml(run.modelId || '-')}</code></div>
      <div><b>Source</b><code>${escapeHtml(run.sourceType || '-')} / ${escapeHtml(run.sourceId || '-')}</code></div>
      <div><b>Defer</b><code>${escapeHtml(run.deferReason || run.details?.deferReason || '-')}</code></div>
      <div><b>Approval</b><code>${escapeHtml(run.approvalId || run.details?.approvalId || '-')}</code></div>
      <div><b>Delegation</b><code>${escapeHtml(run.delegationId || run.details?.delegationId || '-')}</code></div>
      <div><b>Budget</b><code>${escapeHtml(budgetIncidentId || '-')}</code></div>
      <div><b>Next</b><code>${escapeHtml(governanceLineage?.nextAction?.type || run.lineageSummary?.nextActionType || '-')}</code></div>
    </div>
    <div class="agent-run-actions">
      ${run.approvalId || run.details?.approvalId ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-approval="${escapeHtml(run.approvalId || run.details?.approvalId)}">打开审批</button>` : ''}
      ${run.delegationId || run.details?.delegationId ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-delegation="${escapeHtml(run.delegationId || run.details?.delegationId)}">打开委派</button>` : ''}
      ${budgetIncidentId ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-budget="${escapeHtml(budgetIncidentId)}">预算 Activity</button>` : ''}
      <button class="cxbtn cxbtn-secondary cxbtn-sm" data-agent-run-replay="${escapeHtml(run.id)}">Replay Plan</button>
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-replay-result="${escapeHtml(run.id)}">Replay Result</button>
      ${!isIdeaRun ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-archive="${escapeHtml(run.id)}">Archive Run</button>` : ''}
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-activity="${escapeHtml(run.id)}">Activity</button>
    </div>
    ${governanceLineage ? renderAgentRunLineage(governanceLineage) : ''}
    ${renderIdeaRunWorkflow(run, timeline)}
    ${renderAgentRunApprovalResumeGate(run.details?.approvalResumeGateAudit, run.id)}
    ${renderAgentRunSessionSummary(timeline?.sessionTimeline)}
    ${renderAgentCodebaseQuestionAnswer(run.details?.codebaseQuestionAnswer)}
    ${archives.length ? renderAgentRunArchives(archives) : ''}
    ${artifacts.length ? renderAgentRunArtifacts(artifacts, run.id) : ''}
    ${diagnostics.length ? `<div class="agent-run-block"><h4>Diagnostics</h4>${diagnostics.slice(0, 6).map(item => `<div class="agent-run-line"><strong>${escapeHtml(item.code || 'diagnostic')}</strong><span>${escapeHtml(item.message || '')}</span></div>`).join('')}</div>` : ''}
    <div class="agent-run-block"><h4>Messages</h4>${messages.length ? messages.slice(-12).map(renderAgentRunMessage).join('') : '<div class="agent-empty">No messages.</div>'}</div>
    <div class="agent-run-block"><h4>Tool Results</h4>${toolResults.length ? toolResults.slice(-8).map(renderAgentRunToolResult).join('') : '<div class="agent-empty">No tool results.</div>'}</div>
    <div class="agent-run-block"><h4>Activity</h4>${activityEvents.length ? activityEvents.slice(-10).map(renderAgentRunActivity).join('') : '<div class="agent-empty">No related activity loaded.</div>'}</div>
  </div>`;
}

function renderAgentRunSessionSummary(sessionTimeline = null) {
  if (!sessionTimeline?.counts?.runs) return '';
  const counts = sessionTimeline.counts || {};
  const governance = sessionTimeline.governance || {};
  const evidenceChain = sessionTimeline.evidenceChain || {};
  const chainSummary = evidenceChain.summary || {};
  const statusText = Object.entries(sessionTimeline.statusCounts || {})
    .map(([key, value]) => `${key}:${value}`)
    .join(', ') || '-';
  const sourceText = Object.entries(sessionTimeline.sourceTypeCounts || {})
    .map(([key, value]) => `${key}:${value}`)
    .join(', ') || '-';
  const blockers = (governance.blockers || [])
    .slice(0, 4)
    .map(item => `${item.runId || '-'} ${item.kind}:${item.id || '-'}`)
    .join('; ') || '-';
  const nextActions = (governance.nextActions || [])
    .slice(0, 4)
    .map(item => `${item.runId || '-'} ${item.type || '-'}`)
    .join('; ') || '-';
  const recentRuns = (sessionTimeline.runs || []).slice(-6).reverse();
  const evidenceItems = (evidenceChain.items || []).slice(-8).reverse();
  const evidenceKindText = Object.entries(chainSummary.kindCounts || {})
    .map(([key, value]) => `${key}:${value}`)
    .join(', ') || '-';
  return `<div class="agent-run-block agent-run-session">
    <div class="agent-run-block-head">
      <h4>Session Timeline</h4>
      <span>
        <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-session-export="${escapeHtml(sessionTimeline.sessionId || '')}" type="button">Export Session</button>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" data-agent-run-session-archive="${escapeHtml(sessionTimeline.sessionId || '')}" type="button">Archive Session</button>
      </span>
    </div>
    <div class="agent-run-line"><strong>session</strong><span>${escapeHtml(sessionTimeline.sessionId || '-')}</span></div>
    <div class="agent-run-line"><strong>counts</strong><span>${counts.runs || 0} runs · ${counts.messages || 0} messages · ${counts.toolResults || 0} tools · ${counts.archives || 0} archives · ${counts.activityEvents || 0} activity</span></div>
    <div class="agent-run-line"><strong>status</strong><span>${escapeHtml(statusText)}</span></div>
    <div class="agent-run-line"><strong>source</strong><span>${escapeHtml(sourceText)}</span></div>
    <div class="agent-run-line"><strong>blockers</strong><span>${escapeHtml(blockers)}</span></div>
    <div class="agent-run-line"><strong>next</strong><span>${escapeHtml(nextActions)}</span></div>
    <div class="agent-run-line"><strong>evidence</strong><span>${chainSummary.itemCount || 0} items · ${chainSummary.codebaseQuestionCount || 0} code answers · ${chainSummary.approvalResumeGateCount || 0} gates</span></div>
    <div class="agent-run-line"><strong>evidence kinds</strong><span>${escapeHtml(evidenceKindText)}</span></div>
    <div class="agent-run-session-list">
      ${recentRuns.map(run => `<button class="agent-run-session-chip ${agentRegistryState.activeRunId === run.id ? 'is-active' : ''}" data-agent-run-id="${escapeHtml(run.id)}" type="button">
        <span>${escapeHtml(run.status || '-')}</span>
        <strong>${escapeHtml(run.taskId || run.sourceType || run.id)}</strong>
      </button>`).join('')}
    </div>
    ${evidenceItems.length ? `<div class="agent-run-evidence-chain">
      <h5>Session Evidence Chain</h5>
      ${evidenceItems.map(item => `<div class="agent-run-evidence-item">
        <code>#${item.sequence || '-'}</code>
        <strong>${escapeHtml(item.kind || '-')}</strong>
        <span>${escapeHtml(item.title || item.id || '-')}</span>
        <em>${escapeHtml(item.status || item.subkind || '-')}</em>
      </div>`).join('')}
    </div>` : ''}
  </div>`;
}

function renderAgentRunArchives(archives = []) {
  return `<div class="agent-run-block agent-run-archive">
    <h4>Execution Archive</h4>
    ${archives.slice(-3).map((archive) => {
      const blockers = (archive.governance?.blockers || []).map(item => `${item.kind}:${item.id || '-'}`).join(', ') || '-';
      const tools = archive.verification?.toolResultCount || 0;
      const external = archive.evidence?.external || {};
      const fileChanges = Array.isArray(external.fileChanges) ? external.fileChanges.length : 0;
      const artifacts = Array.isArray(external.evidenceArtifacts) ? external.evidenceArtifacts.length : 0;
      return `<div class="agent-run-line">
        <strong>${escapeHtml(archive.status || 'archived')}</strong>
        <span>${escapeHtml(archive.summary || archive.id || '-')} · tools ${tools} · file changes ${fileChanges} · artifacts ${artifacts} · blockers ${escapeHtml(blockers)}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderAgentRunArtifacts(artifacts = [], runId = '') {
  return `<div class="agent-run-block agent-run-artifacts">
    <div class="agent-run-block-head">
      <h4>Execution Artifacts</h4>
      <span>${artifacts.length} recorded</span>
    </div>
    <div class="agent-run-artifact-list">
      ${artifacts.slice(-8).reverse().map((artifact) => {
        const size = artifact.size ? governanceCenterBytes(artifact.size) : '-';
        const hash = artifact.sha256 ? String(artifact.sha256).slice(0, 12) : '-';
        const ownerRunId = artifact.runId || runId;
        return `<div class="agent-run-artifact-row">
          <div>
            <strong>${escapeHtml(artifact.kind || 'artifact')}</strong>
            <code>${escapeHtml(artifact.path || '-')}</code>
            <span>${escapeHtml(size)} · sha ${escapeHtml(hash)}${artifact.sessionId ? ` · session ${escapeHtml(artifact.sessionId)}` : ''}${artifact.gateId ? ` · gate ${escapeHtml(artifact.gateId)}` : ''}</span>
          </div>
          <div class="agent-run-artifact-actions">
            <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-artifact-copy="${escapeHtml(artifact.path || '')}" type="button">Copy Path</button>
            ${artifact.downloadable ? `<button class="cxbtn cxbtn-secondary cxbtn-sm" data-agent-run-artifact-download="${escapeHtml(artifact.id || '')}" data-agent-run-artifact-run="${escapeHtml(ownerRunId || '')}" type="button">Open Artifact</button>` : '<span class="agent-run-artifact-muted">not downloadable</span>'}
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderAgentRunLineage(lineage = {}) {
  const renderItems = (label, items) => {
    const text = (items || []).map(item => `${item.id}${item.status ? `:${item.status}` : ''}`).join(', ') || '-';
    return `<div class="agent-run-line"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(text)}</span></div>`;
  };
  const blockers = (lineage.blockers || []).map(item => `${item.kind}:${item.id || '-'} · ${item.reason || ''}`).join('; ') || '-';
  return `<div class="agent-run-block agent-run-lineage">
    <h4>Governance Chain</h4>
    ${renderItems('approvals', lineage.approvals)}
    ${renderItems('delegations', lineage.delegations)}
    ${renderItems('budget', lineage.budgetIncidents)}
    ${renderItems('autopilot', lineage.autopilotJobs)}
    <div class="agent-run-line"><strong>blockers</strong><span>${escapeHtml(blockers)}</span></div>
    <div class="agent-run-line"><strong>next</strong><span>${escapeHtml(lineage.nextAction?.label || lineage.nextAction?.type || '-')}</span></div>
  </div>`;
}

function renderAgentRunApprovalResumeGate(audit = null, runId = '') {
  if (!audit || typeof audit !== 'object') return '';
  const counts = audit.counts || {};
  const files = Array.isArray(audit.files) ? audit.files : [];
  const commands = Array.isArray(audit.commands) ? audit.commands : [];
  const workCommands = Array.isArray(audit.workEvidenceCommands) ? audit.workEvidenceCommands : [];
  const stagedDiffText = stagedDiffReviewText(audit.stagedDiffReview || audit.diffReview || {});
  return `<div class="agent-run-block agent-run-approval-gate" data-agent-run-approval-gate>
    <h4>Approval Resume Gate</h4>
    <div class="agent-run-line"><strong>${escapeHtml(audit.status || 'reviewed')}</strong><span>${escapeHtml(audit.id || '-')} · ${escapeHtml((audit.sha256 || '').slice(0, 12) || '-')} · approval ${escapeHtml(audit.approvalId || '-')}</span></div>
    <div class="agent-run-line"><strong>counts</strong><span>${escapeHtml(counts.fileChanges || 0)} files · ${escapeHtml(counts.commands || 0)} verify · ${escapeHtml(counts.workEvidenceCommands || 0)} evidence · ${escapeHtml(counts.risks || 0)} risks</span></div>
    ${stagedDiffText ? `<div class="agent-run-line"><strong>staged diff</strong><span>${escapeHtml(stagedDiffText)}</span></div>` : ''}
    ${files.length ? `<div class="agent-run-line"><strong>files</strong><span>${escapeHtml(files.map(file => `${file.operation || '-'} ${file.path || '-'}`).join('; '))}</span></div>` : ''}
    ${commands.length || workCommands.length ? `<div class="agent-run-line"><strong>commands</strong><span>${escapeHtml([...commands, ...workCommands].map(item => item.command).filter(Boolean).join('; '))}</span></div>` : ''}
    ${runId ? `<div class="agent-run-line"><strong>audit</strong><span><button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-gate-audit="${escapeHtml(runId)}">Gate Audit Report</button> <button class="cxbtn cxbtn-secondary cxbtn-sm" data-agent-run-gate-audit-archive="${escapeHtml(runId)}">Archive Report</button></span></div>` : ''}
  </div>`;
}

function renderAgentRunMessage(message) {
  return `<div class="agent-run-line">
    <strong>${escapeHtml(message.kind || message.role || 'message')}</strong>
    <span>${escapeHtml(message.summary || message.content || JSON.stringify(message.payload || {}).slice(0, 180))}</span>
  </div>`;
}

function renderAgentRunToolResult(result) {
  return `<div class="agent-run-line">
    <strong>${escapeHtml(result.toolName || 'tool')}</strong>
    <span>${escapeHtml(result.status || '-')}${result.outputSummary ? ` · ${escapeHtml(result.outputSummary)}` : ''}${Number(result.costUsd) ? ` · ${fmtUSD(Number(result.costUsd))}` : ''}</span>
  </div>`;
}

function renderAgentRunActivity(event) {
  return `<div class="agent-run-line">
    <strong>${escapeHtml(event.action || event.tag || 'activity')}</strong>
    <span>${escapeHtml(event.status || '')} ${activityTime(event.ts || event.createdAt)}</span>
  </div>`;
}

function bindAgentRunsEvents(root) {
  if (!root) return;
  $('#agentRunStatusFilter')?.addEventListener('change', (e) => {
    agentRegistryState.runFilters.status = e.target.value;
    refreshAgentRuns();
  });
  $('#agentRunRoomFilter')?.addEventListener('change', (e) => {
    agentRegistryState.runFilters.roomId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunSessionFilter')?.addEventListener('change', (e) => {
    agentRegistryState.runFilters.sessionId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunProfileFilter')?.addEventListener('change', (e) => {
    agentRegistryState.runFilters.agentProfileId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunSourceFilter')?.addEventListener('change', (e) => {
    agentRegistryState.runFilters.sourceType = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunApprovalFilter')?.addEventListener('change', (e) => {
    agentRegistryState.runFilters.approvalId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunDelegationFilter')?.addEventListener('change', (e) => {
    agentRegistryState.runFilters.delegationId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunBudgetFilter')?.addEventListener('change', (e) => {
    agentRegistryState.runFilters.budgetIncidentId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunDeferFilter')?.addEventListener('change', (e) => {
    agentRegistryState.runFilters.deferReason = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunGateFilter')?.addEventListener('change', (e) => {
    agentRegistryState.runFilters.approvalResumeGateId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunGateShaFilter')?.addEventListener('change', (e) => {
    agentRegistryState.runFilters.approvalResumeGateSha256 = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunGovernanceFilter')?.addEventListener('change', (e) => {
    agentRegistryState.runFilters.hasGovernance = e.target.checked;
    refreshAgentRuns();
  });
  $('#agentRunsClear')?.addEventListener('click', () => {
    agentRegistryState.runFilters = {
      status: '',
      roomId: '',
      sessionId: '',
      agentProfileId: '',
      sourceType: '',
      approvalId: '',
      delegationId: '',
      budgetIncidentId: '',
      deferReason: '',
      approvalResumeGateId: '',
      approvalResumeGateSha256: '',
      hasGovernance: false,
    };
    refreshAgentRuns();
  });
  $('#agentRunsRefresh')?.addEventListener('click', () => refreshAgentRuns());
  root.querySelectorAll('[data-agent-run-id]').forEach((btn) => {
    btn.addEventListener('click', () => loadAgentRunDetail(btn.dataset.agentRunId));
  });
  root.querySelectorAll('[data-agent-run-approval]').forEach((btn) => {
    btn.addEventListener('click', () => openApprovalModal(btn.dataset.agentRunApproval));
  });
  root.querySelectorAll('[data-agent-run-delegation]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (typeof delegationState !== 'undefined') delegationState.activeId = btn.dataset.agentRunDelegation;
      openDelegationModal();
    });
  });
  root.querySelectorAll('[data-agent-run-budget]').forEach((btn) => {
    btn.addEventListener('click', () => openActivityModal({ q: btn.dataset.agentRunBudget }));
  });
  root.querySelectorAll('[data-agent-run-replay]').forEach((btn) => {
    btn.addEventListener('click', () => planAgentRunReplay(btn.dataset.agentRunReplay, btn));
  });
  root.querySelectorAll('[data-agent-run-replay-result]').forEach((btn) => {
    btn.addEventListener('click', () => archiveAgentRunReplayResult(btn.dataset.agentRunReplayResult, btn));
  });
  root.querySelectorAll('[data-agent-run-idea-auto]').forEach((btn) => {
    btn.addEventListener('click', () => autoVerifyIdeaRun(btn.dataset.agentRunIdeaAuto, btn));
  });
  root.querySelectorAll('[data-agent-run-idea-generate-manifest]').forEach((btn) => {
    btn.addEventListener('click', () => generateIdeaRunManifest(btn.dataset.agentRunIdeaGenerateManifest, btn));
  });
  root.querySelectorAll('[data-agent-run-idea-generate-patch]').forEach((btn) => {
    btn.addEventListener('click', () => generateIdeaRunPatchManifest(btn.dataset.agentRunIdeaGeneratePatch, btn));
  });
  root.querySelectorAll('[data-agent-run-idea-manifest]').forEach((btn) => {
    btn.addEventListener('click', () => editIdeaRunManifest(btn.dataset.agentRunIdeaManifest, btn));
  });
  root.querySelectorAll('[data-agent-run-idea-complete]').forEach((btn) => {
    btn.addEventListener('click', () => completeIdeaRunExecution(btn.dataset.agentRunIdeaComplete, btn));
  });
  root.querySelectorAll('[data-agent-run-governance-review]').forEach((btn) => {
    btn.addEventListener('click', () => openGovernanceCenterForAgentRun(btn.dataset.agentRunGovernanceReview, btn));
  });
  root.querySelectorAll('[data-agent-run-review-archive]').forEach((btn) => {
    btn.addEventListener('click', () => focusAgentRunBlock('.agent-run-archive', btn, 'Execution Archive'));
  });
  root.querySelectorAll('[data-agent-run-open-artifacts]').forEach((btn) => {
    btn.addEventListener('click', () => focusAgentRunBlock('.agent-run-artifacts', btn, 'Execution Artifacts'));
  });
  root.querySelectorAll('[data-agent-run-archive]').forEach((btn) => {
    btn.addEventListener('click', () => archiveAgentRun(btn.dataset.agentRunArchive, btn));
  });
  root.querySelectorAll('[data-agent-run-gate-audit]').forEach((btn) => {
    btn.addEventListener('click', () => openAgentRunGateAuditReport(btn.dataset.agentRunGateAudit, btn));
  });
  root.querySelectorAll('[data-agent-run-gate-audit-archive]').forEach((btn) => {
    btn.addEventListener('click', () => archiveAgentRunGateAuditReport(btn.dataset.agentRunGateAuditArchive, btn));
  });
  root.querySelectorAll('[data-agent-run-activity]').forEach((btn) => {
    btn.addEventListener('click', () => openActivityModal({ agentOnly: true, agentRunId: btn.dataset.agentRunActivity }));
  });
  root.querySelectorAll('[data-agent-run-session-export]').forEach((btn) => {
    btn.addEventListener('click', () => openAgentRunSessionExport(btn.dataset.agentRunSessionExport, btn));
  });
  root.querySelectorAll('[data-agent-run-session-archive]').forEach((btn) => {
    btn.addEventListener('click', () => archiveAgentRunSessionEvidence(btn.dataset.agentRunSessionArchive, btn));
  });
  root.querySelectorAll('[data-agent-run-artifact-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const path = btn.dataset.agentRunArtifactCopy || '';
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(path).then(() => toast('Artifact path copied', 'success', 1400)).catch(() => fallbackCopy(path));
      } else {
        fallbackCopy(path);
      }
    });
  });
  root.querySelectorAll('[data-agent-run-artifact-download]').forEach((btn) => {
    btn.addEventListener('click', () => openAgentRunArtifact(btn.dataset.agentRunArtifactRun, btn.dataset.agentRunArtifactDownload, btn));
  });
}

async function openAgentRunSessionExport(sessionId, btn = null) {
  if (!sessionId) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Exporting…';
  }
  try {
    const headers = { Accept: 'text/markdown' };
    const token = getOwnerToken();
    if (token) headers['X-Panel-Owner-Token'] = token;
    const response = await fetch(`/api/agent-runs/session/${encodeURIComponent(sessionId)}?format=markdown`, { headers });
    if (!response.ok) throw new Error(await response.text());
    const markdown = await response.text();
    await promptModal({
      title: 'Session Evidence Export',
      message: `Agent Run session ${sessionId}`,
      multiline: true,
      value: markdown,
      confirmLabel: '关闭',
    });
  } catch (e) {
    toast('Session evidence export 失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Export Session';
    }
  }
}

async function archiveAgentRunSessionEvidence(sessionId, btn = null) {
  if (!sessionId) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Archiving…';
  }
  try {
    const result = await api(`/api/agent-runs/session/${encodeURIComponent(sessionId)}/archive`, {
      method: 'POST',
      body: JSON.stringify({
        requestedBy: 'owner',
        runId: agentRegistryState.activeRunId || undefined,
      }),
    });
    toast(`Session evidence archived: ${result.artifact?.path || 'done'}`, 'success', 2200);
    await loadAgentRunDetail(result.run?.id || agentRegistryState.activeRunId);
  } catch (e) {
    toast('Session evidence 归档失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Archive Session';
    }
  }
}

async function openAgentRunGateAuditReport(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Loading…';
  }
  try {
    const headers = { Accept: 'text/markdown' };
    const token = getOwnerToken();
    if (token) headers['X-Panel-Owner-Token'] = token;
    const response = await fetch(`/api/agent-runs/${encodeURIComponent(id)}/approval-resume-gate-audit?format=markdown`, { headers });
    if (!response.ok) throw new Error(await response.text());
    const report = await response.text();
    await promptModal({
      title: 'Gate Audit Report',
      message: 'Approval resume gate 对账报告',
      multiline: true,
      value: report,
      confirmLabel: '关闭',
    });
  } catch (e) {
    toast('Gate audit report 加载失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Gate Audit Report';
    }
  }
}

async function archiveAgentRunGateAuditReport(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Archiving…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/approval-resume-gate-audit/archive`, {
      method: 'POST',
      body: JSON.stringify({ requestedBy: 'owner' }),
    });
    toast(`Gate audit report archived: ${result.artifact?.path || 'done'}`, 'success', 2200);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Gate audit report 归档失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Archive Report';
    }
  }
}

async function openAgentRunArtifact(runId, artifactId, btn = null) {
  if (!runId || !artifactId) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Opening…';
  }
  try {
    const headers = { Accept: 'text/markdown' };
    const token = getOwnerToken();
    if (token) headers['X-Panel-Owner-Token'] = token;
    const response = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/download`, { headers });
    if (!response.ok) throw new Error(await response.text());
    const artifactPath = response.headers.get('X-Xike-Artifact-Path') || '';
    const markdown = await response.text();
    await promptModal({
      title: 'Agent Run Artifact',
      message: artifactPath || `Agent Run ${runId}`,
      multiline: true,
      value: markdown,
      confirmLabel: '关闭',
    });
  } catch (e) {
    toast('Artifact 打开失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Open Artifact';
    }
  }
}

function focusAgentRunBlock(selector, btn = null, label = 'section') {
  const block = document.querySelector(selector);
  if (!block) {
    toast(`${label} 暂无可聚焦内容`, 'warning', 1800);
    return;
  }
  document.querySelectorAll('.agent-run-block.is-highlighted').forEach(node => node.classList.remove('is-highlighted'));
  block.classList.add('is-highlighted');
  block.scrollIntoView({ block: 'center', inline: 'nearest' });
  setTimeout(() => block.classList.remove('is-highlighted'), 2200);
  if (btn) btn.blur();
}

async function openGovernanceCenterForAgentRun(runId, btn = null) {
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Opening…';
  }
  try {
    await openGovernanceCenterModal();
    if (runId) {
      const target = document.querySelector(`#governanceCenterBody [data-gov-center-run="${CSS.escape(runId)}"]`)
        || document.querySelector(`#governanceCenterBody [data-gov-center-id="${CSS.escape(runId)}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        target.classList.add('is-highlighted');
        setTimeout(() => target.classList.remove('is-highlighted'), 2200);
      }
    }
  } catch (e) {
    toast('打开 Preflight Review 失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Open Preflight Review';
    }
  }
}

async function planAgentRunReplay(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Planning…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/replay-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'owner' }),
    });
    toast(result.replayPlan?.summary || 'Replay plan recorded', 'success', 1800);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Replay plan 失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Replay Plan';
    }
  }
}

async function archiveAgentRunReplayResult(id, btn = null) {
  if (!id) return;
  const summary = await promptModal({
    title: 'Replay Result',
    message: '结果摘要',
    multiline: true,
    value: 'Replay result recorded.',
    confirmLabel: '归档',
  });
  if (summary == null) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Archiving…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/replay-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'owner', status: 'recorded', summary }),
    });
    toast(result.replayResult?.summary || 'Replay result archived', 'success', 1800);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Replay result 失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Replay Result';
    }
  }
}

async function archiveAgentRun(id, btn = null) {
  if (!id) return;
  const summary = await promptModal({
    title: 'Archive Run',
    message: '阶段归档摘要',
    multiline: true,
    value: 'Execution archive recorded.',
    confirmLabel: '归档',
  });
  if (summary == null) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Archiving…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'owner', summary }),
    });
    toast(result.archive?.summary || 'Run archived', 'success', 1800);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Run archive 失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Archive Run';
    }
  }
}

async function completeIdeaRunExecution(id, btn = null) {
  if (!id) return;
  const summary = await promptModal({
    title: 'Complete Idea Run',
    message: '执行与验证摘要',
    multiline: true,
    value: 'Idea execution completed and verified.',
    confirmLabel: '完成',
  });
  if (summary == null) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Completing…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/idea-execution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestedBy: 'owner',
        status: 'succeeded',
        summary,
        verificationSummary: summary,
      }),
    });
    toast(result.archive?.summary || 'Idea Run completed', 'success', 1800);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Idea Run 完成失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Complete Idea Run';
    }
  }
}

async function autoVerifyIdeaRun(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Verifying…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/idea-auto-execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'owner' }),
    });
    toast(result.archive?.summary || 'Idea Run verified and archived', 'success', 2200);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('自动验证失败：' + (e.message || e), 'error', 3500);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Auto Work + Verify';
    }
  }
}

async function generateIdeaRunManifest(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/idea-manifest-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'owner' }),
    });
    toast(result.manifestDraft?.summary || 'Manifest draft generated', 'success', 2200);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Manifest 生成失败：' + (e.message || e), 'error', 3500);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Generate Manifest';
    }
  }
}

async function generateIdeaRunPatchManifest(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/idea-patch-manifest-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'owner', useModel: false }),
    });
    toast(result.manifestDraft?.summary || 'Patch manifest draft generated', 'success', 2200);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Patch Manifest 生成失败：' + (e.message || e), 'error', 3500);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Generate Patch';
    }
  }
}

function latestIdeaRunManifestDraft(timeline = null) {
  const messages = Array.isArray(timeline?.messages) ? timeline.messages : [];
  for (const message of messages.slice().reverse()) {
    const draft = message.payload?.manifestDraft;
    if (message.kind === 'manifest_draft' && draft?.manifest && typeof draft.manifest === 'object') return draft;
  }
  return null;
}

function defaultIdeaRunManifestText(run = null) {
  const timeline = agentRegistryState.runTimeline?.run?.id === run?.id ? agentRegistryState.runTimeline : null;
  const manifestDraft = latestIdeaRunManifestDraft(timeline);
  if (manifestDraft?.manifest) return JSON.stringify(manifestDraft.manifest, null, 2);
  const manifest = {
    fileChanges: [],
    workEvidenceCommands: [
      'git status --porcelain=v1',
      'git diff --stat',
    ],
    commands: [
      'git diff --check',
      'npm test',
    ],
    evidenceArtifacts: [],
  };
  const approvalId = run?.approvalId || run?.details?.approvalId;
  if (approvalId) manifest.approvalId = approvalId;
  return JSON.stringify(manifest, null, 2);
}

function parseIdeaRunManifestText(text) {
  const value = String(text || '').trim();
  if (!value) return {};
  const manifest = JSON.parse(value);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest must be a JSON object');
  }
  return manifest;
}

async function editIdeaRunManifest(id, btn = null) {
  if (!id) return;
  const manifestText = await promptModal({
    title: 'Idea Manifest',
    message: 'JSON manifest',
    multiline: true,
    value: defaultIdeaRunManifestText(agentRegistryState.runTimeline?.run?.id === id ? agentRegistryState.runTimeline.run : null),
    confirmLabel: 'Run Manifest',
  });
  if (manifestText == null) return;
  let manifest;
  try {
    manifest = parseIdeaRunManifestText(manifestText);
  } catch (e) {
    toast('Manifest JSON 无效：' + (e.message || e), 'error', 3500);
    return;
  }
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Running…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/idea-auto-execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...manifest, requestedBy: 'owner' }),
    });
    toast(result.archive?.summary || 'Idea manifest executed', 'success', 2200);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Manifest 执行失败：' + (e.message || e), 'error', 3500);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Edit Manifest';
    }
  }
}

async function refreshAgentRuns() {
  agentRegistryState.runsLoading = true;
  agentRegistryState.runError = '';
  renderAgentRegistryModal();
  try {
    const params = new URLSearchParams();
    params.set('limit', '80');
    const f = agentRegistryState.runFilters;
    if (f.status) params.set('status', f.status);
    if (f.roomId) params.set('roomId', f.roomId);
    if (f.sessionId) params.set('sessionId', f.sessionId);
    if (f.agentProfileId) params.set('agentProfileId', f.agentProfileId);
    if (f.sourceType) params.set('sourceType', f.sourceType);
    if (f.approvalId) params.set('approvalId', f.approvalId);
    if (f.delegationId) params.set('delegationId', f.delegationId);
    if (f.budgetIncidentId) params.set('budgetIncidentId', f.budgetIncidentId);
    if (f.deferReason) params.set('deferReason', f.deferReason);
    if (f.approvalResumeGateId) params.set('approvalResumeGateId', f.approvalResumeGateId);
    if (f.approvalResumeGateSha256) params.set('approvalResumeGateSha256', f.approvalResumeGateSha256);
    if (f.hasGovernance) params.set('hasGovernance', 'true');
    const result = await api('/api/agent-runs?' + params.toString());
    agentRegistryState.runs = result.runs || [];
    if (!agentRegistryState.activeRunId || !agentRegistryState.runs.some(run => run.id === agentRegistryState.activeRunId)) {
      agentRegistryState.activeRunId = agentRegistryState.runs[0]?.id || '';
      agentRegistryState.runTimeline = null;
    }
  } catch (e) {
    agentRegistryState.runError = e.message || '加载 Agent Runs 失败';
    agentRegistryState.runs = [];
  } finally {
    agentRegistryState.runsLoading = false;
    renderAgentRegistryModal();
  }
}

async function loadAgentRunDetail(id) {
  if (!id) return;
  agentRegistryState.activeRunId = id;
  agentRegistryState.runTimeline = null;
  renderAgentRegistryModal();
  try {
    agentRegistryState.runTimeline = await api(`/api/agent-runs/${encodeURIComponent(id)}?includeSession=true&sessionLimit=80`);
    const run = agentRegistryState.runTimeline?.run;
    if (run && !agentRegistryState.runs.some(item => item.id === run.id)) {
      agentRegistryState.runs = [run, ...agentRegistryState.runs].slice(0, 80);
    }
  } catch (e) {
    agentRegistryState.runError = e.message || '加载 Agent Run 失败';
  }
  renderAgentRegistryModal();
}

async function openAgentRunFromActivity(id) {
  if (!id) return;
  closeActivityModal();
  agentRegistryState.activeTab = 'runs';
  agentRegistryState.activeRunId = id;
  $('#agentRegistryModal').style.display = 'flex';
  if (!agentRegistryState.snapshot) {
    await refreshAgentRegistry();
  } else {
    renderAgentRegistryModal();
  }
  await loadAgentRunDetail(id);
}

function renderAgentProfileCard(profile, { showPolicyEditor = false } = {}) {
  const coverage = profile.skillCoverage || [];
  const installed = coverage.filter(skill => skill.installed && skill.enabled).length;
  return `
    <article class="agent-profile-card ${profile.governanceOverridden ? 'is-policy-overridden' : ''}" data-agent-profile-id="${escapeHtml(profile.id)}">
      <div class="agent-profile-head">
        <strong>${escapeHtml(profile.title || profile.id)}</strong>
        <code>${escapeHtml(profile.id)}</code>
      </div>
      <div class="agent-profile-meta">${(profile.roles || []).map(role => `<span>${escapeHtml(role)}</span>`).join('')}</div>
      ${renderAgentGovernance(profile.governance, { overridden: profile.governanceOverridden })}
      ${showPolicyEditor ? renderAgentPolicyEditor(profile) : ''}
      <p>${escapeHtml(profile.mission || '')}</p>
      <div class="agent-skill-strip" title="${installed}/${coverage.length} bound skills installed">
        ${coverage.map(skill => `<span class="${skill.installed && skill.enabled ? 'ok' : 'missing'}">${escapeHtml(skill.name)}</span>`).join('') || '<span class="missing">no skills</span>'}
      </div>
    </article>
  `;
}

function renderAgentRule(rule) {
  return `
    <div class="agent-rule-row">
      <div>
        <strong>${escapeHtml(rule.tag)}</strong>
        <span>${escapeHtml(rule.agentId)}</span>
      </div>
      <div class="agent-rule-keywords">${(rule.keywords || []).slice(0, 10).map(k => `<span>${escapeHtml(k)}</span>`).join('')}</div>
    </div>
  `;
}

function renderAgentGovernance(policy, options = {}) {
  if (!policy) return '';
  return `<div class="agent-governance-strip">
    ${options.overridden ? '<span class="agent-policy-override">local override</span>' : ''}
    <span>budget ${escapeHtml(policy.budgetTier || 'standard')}</span>
    <span>guard ${escapeHtml(policy.commandGuard || 'standard')}</span>
    <span>approval ${escapeHtml(policy.approvalPolicy || 'dangerous_commands')}</span>
    <span>audit ${escapeHtml(policy.auditLevel || 'standard')}</span>
  </div>`;
}

function renderAgentPolicyEditor(profile) {
  const policy = profile.governance || {};
  const select = (field, label) => `
    <label>
      <span>${label}</span>
      <select data-agent-policy-field="${field}">
        ${(AGENT_POLICY_OPTIONS[field] || []).map(value => `<option value="${escapeHtml(value)}" ${(policy[field] || '') === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}
      </select>
    </label>
  `;
  return `
    <div class="agent-policy-editor" data-agent-policy-editor="${escapeHtml(profile.id)}">
      ${select('budgetTier', 'Budget')}
      ${select('commandGuard', 'Guard')}
      ${select('approvalPolicy', 'Approval')}
      ${select('auditLevel', 'Audit')}
      <div class="agent-policy-actions">
        <button class="cxbtn cxbtn-secondary cxbtn-sm" data-agent-policy-reset="${escapeHtml(profile.id)}" ${profile.governanceOverridden ? '' : 'disabled'}>重置</button>
        <button class="cxbtn cxbtn-primary cxbtn-sm" data-agent-policy-save="${escapeHtml(profile.id)}">保存策略</button>
      </div>
    </div>
  `;
}

function getAgentPolicyEditor(profileId) {
  const id = window.CSS?.escape ? CSS.escape(profileId) : String(profileId).replace(/["\\]/g, '\\$&');
  return document.querySelector(`[data-agent-policy-editor="${id}"]`);
}

function readAgentPolicyEditor(profileId) {
  const editor = getAgentPolicyEditor(profileId);
  if (!editor) throw new Error('policy editor not found');
  const governance = {};
  editor.querySelectorAll('[data-agent-policy-field]').forEach((field) => {
    governance[field.dataset.agentPolicyField] = field.value;
  });
  governance.budgetScope = 'agent_profile';
  return governance;
}

async function saveAgentPolicy(profileId, button = null) {
  try {
    if (button) button.disabled = true;
    const governance = readAgentPolicyEditor(profileId);
    await api(`/api/agent-registry/profiles/${encodeURIComponent(profileId)}/governance`, {
      method: 'PUT',
      body: JSON.stringify({ governance }),
    });
    agentRegistryState.classification = null;
    toast('Agent 治理策略已保存', 'success', 1600);
    await refreshAgentRegistry();
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function resetAgentPolicy(profileId, button = null) {
  try {
    if (button) button.disabled = true;
    await api(`/api/agent-registry/profiles/${encodeURIComponent(profileId)}/governance`, {
      method: 'DELETE',
    });
    agentRegistryState.classification = null;
    toast('Agent 治理策略已重置', 'success', 1600);
    await refreshAgentRegistry();
  } catch (e) {
    toast('重置失败：' + e.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function runAgentPreview() {
  const root = $('#agentPreviewResult');
  const text = ($('#agentPreviewText')?.value || '').trim();
  const affectedFilesText = ($('#agentPreviewFiles')?.value || '').trim();
  const role = $('#agentPreviewRole')?.value || 'dev';
  agentRegistryState.text = text;
  agentRegistryState.affectedFiles = affectedFilesText;
  agentRegistryState.memberRole = role;
  if (!text) {
    root.innerHTML = '<div class="agent-empty">先输入任务文本。</div>';
    return null;
  }
  root.innerHTML = '<div class="muted small">预演中…</div>';
  try {
    const result = await api('/api/agent-registry/classify', {
      method: 'POST',
      body: JSON.stringify({
        text,
        codeContext: {
          affectedFiles: parseAgentPreviewFiles(affectedFilesText),
          evidence: agentRegistryState.codeContextEvidence || [],
          symbolGraph: agentRegistryState.codeContextGraph || {},
          codebaseQuestionAnswer: sanitizeCodebaseQuestionAnswer(agentRegistryState.codebaseQuestionAnswer),
        },
        member: { adapterId: 'preview', role, displayName: `Preview ${role}` },
        room: { name: 'Agent Preview', topic: text, skills: [] },
      }),
    });
    agentRegistryState.classification = result;
    if (result.codebaseQuestionAnswer) agentRegistryState.codebaseQuestionAnswer = result.codebaseQuestionAnswer;
    root.innerHTML = renderAgentClassification(result);
    refreshAgentDispatchWorkflow();
    return result;
  } catch (e) {
    root.innerHTML = `<div class="agent-empty error">预演失败：${escapeHtml(e.message)}</div>`;
    return null;
  }
}

async function createAgentRunFromIdea(button = null) {
  const text = ($('#agentPreviewText')?.value || '').trim();
  const affectedFilesText = ($('#agentPreviewFiles')?.value || '').trim();
  const role = $('#agentPreviewRole')?.value || 'dev';
  if (!text) {
    toast('先输入任务文本', 'warning', 1800);
    return null;
  }
  const oldText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Creating…';
  }
  try {
    const classification = agentRegistryState.classification || await runAgentPreview();
    if (!classification) throw new Error('分派预演失败，无法创建 Run Draft');
    const affectedFiles = parseAgentPreviewFiles(affectedFilesText);
    const result = await api('/api/agent-runs/idea', {
      method: 'POST',
      body: JSON.stringify({
        idea: text,
        role,
        affectedFiles,
        classification,
        roomId: roomState?.activeId || '',
        sessionId: state.activeId || '',
        agentProfileId: classification.profile?.id || '',
        agentProfileTitle: classification.profile?.title || '',
        codebaseQuestionAnswer: sanitizeCodebaseQuestionAnswer(agentRegistryState.codebaseQuestionAnswer || classification.codebaseQuestionAnswer),
      }),
    });
    toast('Idea-to-Archive Run Draft 已创建', 'success', 1800);
    agentRegistryState.activeTab = 'runs';
    agentRegistryState.activeRunId = result.run?.id || '';
    agentRegistryState.runTimeline = null;
    agentRegistryState.runs = result.run ? [result.run, ...agentRegistryState.runs.filter(run => run.id !== result.run.id)].slice(0, 80) : agentRegistryState.runs;
    renderAgentRegistryModal();
    if (result.run?.id) await loadAgentRunDetail(result.run.id);
    return result;
  } catch (e) {
    toast('创建 Run Draft 失败：' + (e.message || e), 'error', 3000);
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = oldText || '创建 Run Draft';
    }
  }
}

function agentPreviewCwd() {
  return roomState?.activeRoom?.cwd || state.activeCwd || '';
}

function renderAgentChangedFilesInfo(info = null) {
  if (!info) return '';
  if (info.error) return `<span class="error">${escapeHtml(info.error)}</span>`;
  const tags = Array.isArray(info.tags) && info.tags.length
    ? ` · ${info.tags.slice(0, 5).map(tag => `${escapeHtml(tag.tag)}:${escapeHtml(tag.score)}`).join(' ')}`
    : '';
  const evidence = info.evidenceSummary && info.evidenceSummary.fileCount
    ? ` · ${escapeHtml(info.evidenceSummary.symbolCount || 0)} symbols · ${escapeHtml(info.evidenceSummary.anchorCount || 0)} anchors`
    : '';
  if (info.mode === 'codebase-map') {
    return `<span>${escapeHtml(info.count || 0)} focus files from ${escapeHtml(info.scannedFileCount || 0)} scanned${tags}${evidence}</span>`;
  }
  return `<span>${escapeHtml(info.count || 0)} changed files${tags}${evidence}</span>`;
}

function sanitizeCodebaseQuestionAnswer(answer = null) {
  if (!answer || typeof answer !== 'object') return null;
  const citations = Array.isArray(answer.citations) ? answer.citations.slice(0, 6).map((item, index) => {
    const id = String(item.id || `C${index + 1}`).slice(0, 20).trim() || `C${index + 1}`;
    const path = String(item.path || '').slice(0, 300).trim();
    const line = Math.max(1, Number(item.line) || 1);
    const label = String(item.label || (path ? `${path}:${line}` : id)).slice(0, 340).trim();
    return {
      id,
      path,
      line,
      label,
      kind: String(item.kind || 'file').slice(0, 100).trim() || 'file',
      anchor: String(item.anchor || '').slice(0, 180).trim(),
      parser: String(item.parser || 'unknown').slice(0, 80).trim() || 'unknown',
      score: Number(item.score || 0),
      semanticScore: Number.isFinite(Number(item.semanticScore)) ? Number(item.semanticScore) : null,
      reasons: Array.isArray(item.reasons) ? item.reasons.map(reason => String(reason || '').slice(0, 120).trim()).filter(Boolean).slice(0, 4) : [],
      snippet: String(item.snippet || '').slice(0, 260).trim(),
      evidenceCount: Math.max(0, Number(item.evidenceCount) || 0),
      graphReferenceCount: Math.max(0, Number(item.graphReferenceCount) || 0),
      typeImplementationCount: Math.max(0, Number(item.typeImplementationCount) || 0),
      routeUsageCount: Math.max(0, Number(item.routeUsageCount) || 0),
      routeToTestChainCount: Math.max(0, Number(item.routeToTestChainCount) || 0),
      unresolvedReferenceCount: Math.max(0, Number(item.unresolvedReferenceCount) || 0),
      citationPathCount: Math.max(0, Number(item.citationPathCount) || 0),
    };
  }).filter(item => item.path || item.label) : [];
  const question = String(answer.question || '').slice(0, 500).trim();
  const text = String(answer.answer || '').slice(0, 1200).trim();
  if (!question && !text && !citations.length) return null;
  const coverage = answer.coverage && typeof answer.coverage === 'object' ? answer.coverage : {};
  return {
    ok: answer.ok !== false,
    mode: String(answer.mode || 'local-codebase-question').slice(0, 80),
    generatedBy: String(answer.generatedBy || 'CodebaseIndexStore').slice(0, 120),
    question,
    confidence: String(answer.confidence || 'unknown').slice(0, 40),
    answer: text,
    answerLines: Array.isArray(answer.answerLines) ? answer.answerLines.map(line => String(line || '').slice(0, 360).trim()).filter(Boolean).slice(0, 6) : [],
    citations,
    coverage: {
      resultCount: Math.max(0, Number(coverage.resultCount) || 0),
      citedResultCount: Math.max(0, Number(coverage.citedResultCount) || citations.length),
      uniqueFileCount: Math.max(0, Number(coverage.uniqueFileCount) || new Set(citations.map(item => item.path).filter(Boolean)).size),
      evidenceItemCount: Math.max(0, Number(coverage.evidenceItemCount) || 0),
      graphReferenceCount: Math.max(0, Number(coverage.graphReferenceCount) || 0),
      typeImplementationCount: Math.max(0, Number(coverage.typeImplementationCount) || 0),
      routeUsageCount: Math.max(0, Number(coverage.routeUsageCount) || 0),
      routeToTestChainCount: Math.max(0, Number(coverage.routeToTestChainCount) || 0),
      unresolvedReferenceCount: Math.max(0, Number(coverage.unresolvedReferenceCount) || 0),
      citationPathCount: Math.max(0, Number(coverage.citationPathCount) || 0),
    },
    nextActions: Array.isArray(answer.nextActions) ? answer.nextActions.map(item => String(item || '').slice(0, 180).trim()).filter(Boolean).slice(0, 6) : [],
    limitations: Array.isArray(answer.limitations) ? answer.limitations.map(item => String(item || '').slice(0, 180).trim()).filter(Boolean).slice(0, 6) : [],
  };
}

function renderAgentCodebaseQuestionAnswer(answer = null) {
  const item = sanitizeCodebaseQuestionAnswer(answer);
  if (!item) return '';
  const coverage = item.coverage || {};
  const citations = item.citations || [];
  const extra = [
    coverage.routeToTestChainCount ? `${coverage.routeToTestChainCount} route-test chains` : '',
    coverage.unresolvedReferenceCount ? `${coverage.unresolvedReferenceCount} unresolved refs` : '',
  ].filter(Boolean).join(' · ');
  return `<section class="agent-code-question-answer" data-agent-code-question-answer>
    <div class="agent-code-context-head">
      <strong>Code Question Answer</strong>
      <span>${escapeHtml(item.confidence)} confidence · ${escapeHtml(coverage.uniqueFileCount || 0)} files · ${escapeHtml(citations.length)} citations${extra ? ` · ${escapeHtml(extra)}` : ''}</span>
    </div>
    ${item.question ? `<div class="agent-code-question-text"><strong>Question</strong><span>${escapeHtml(item.question)}</span></div>` : ''}
    ${item.answer ? `<div class="agent-code-question-text"><strong>Answer</strong><span>${escapeHtml(item.answer)}</span></div>` : ''}
    ${item.limitations?.length ? `<div class="agent-code-question-text"><strong>Limits</strong><span>${escapeHtml(item.limitations.slice(0, 3).join(' · '))}</span></div>` : ''}
    ${citations.length ? `<div class="agent-code-question-citations">
      ${citations.slice(0, 6).map(citation => `<span title="${escapeHtml((citation.reasons || []).join(', '))}">${escapeHtml(citation.id)} ${escapeHtml(citation.label)}</span>`).join('')}
    </div>` : ''}
  </section>`;
}

async function loadAgentChangedFiles(button = null) {
  try {
    if (button) button.disabled = true;
    const cwd = agentPreviewCwd();
    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
    const result = await api('/api/agent-registry/changed-files' + qs);
    const paths = (result.files || []).map(file => file.path).filter(Boolean);
    agentRegistryState.affectedFiles = paths.join('\n');
    agentRegistryState.codeContextEvidence = result.codeContextEvidence || [];
    agentRegistryState.codeContextGraph = result.codeContextGraph || null;
    agentRegistryState.codebaseMap = null;
    agentRegistryState.codebaseQuestionAnswer = null;
    agentRegistryState.classification = null;
    agentRegistryState.changedFilesInfo = {
      count: paths.length,
      tags: result.codeContextSignals?.tags || [],
      evidenceSummary: result.codeContextEvidenceSummary || null,
    };
    const input = $('#agentPreviewFiles');
    if (input) input.value = agentRegistryState.affectedFiles;
    const info = $('#agentPreviewFilesInfo');
    if (info) info.innerHTML = renderAgentChangedFilesInfo(agentRegistryState.changedFilesInfo);
  } catch (e) {
    agentRegistryState.codeContextEvidence = [];
    agentRegistryState.codeContextGraph = null;
    agentRegistryState.changedFilesInfo = { error: e.message || '读取当前变更失败' };
    agentRegistryState.codebaseQuestionAnswer = null;
    agentRegistryState.classification = null;
    const info = $('#agentPreviewFilesInfo');
    if (info) info.innerHTML = renderAgentChangedFilesInfo(agentRegistryState.changedFilesInfo);
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadAgentCodebaseMap(button = null) {
  try {
    if (button) button.disabled = true;
    const cwd = agentPreviewCwd();
    const query = ($('#agentPreviewText')?.value || '').trim();
    const params = new URLSearchParams();
    if (cwd) params.set('cwd', cwd);
    if (query) params.set('q', query);
    params.set('limit', '24');
    const result = await api('/api/agent-registry/codebase-map?' + params.toString());
    const map = result || {};
    const paths = (map.focusFiles || []).map(file => file.path).filter(Boolean);
    agentRegistryState.affectedFiles = paths.join('\n');
    agentRegistryState.codeContextEvidence = map.evidence || [];
    agentRegistryState.codeContextGraph = map.symbolGraph || null;
    agentRegistryState.codebaseMap = map;
    agentRegistryState.codebaseQuestionAnswer = null;
    agentRegistryState.classification = null;
    agentRegistryState.changedFilesInfo = {
      mode: 'codebase-map',
      count: paths.length,
      scannedFileCount: map.scannedFileCount || 0,
      tags: map.codeContextSignals?.tags || [],
      evidenceSummary: map.evidenceSummary || null,
    };
    const input = $('#agentPreviewFiles');
    if (input) input.value = agentRegistryState.affectedFiles;
    const info = $('#agentPreviewFilesInfo');
    if (info) info.innerHTML = renderAgentChangedFilesInfo(agentRegistryState.changedFilesInfo);
  } catch (e) {
    agentRegistryState.codeContextEvidence = [];
    agentRegistryState.codeContextGraph = null;
    agentRegistryState.codebaseMap = null;
    agentRegistryState.codebaseQuestionAnswer = null;
    agentRegistryState.classification = null;
    agentRegistryState.changedFilesInfo = { error: e.message || '构建工程地图失败' };
    const info = $('#agentPreviewFilesInfo');
    if (info) info.innerHTML = renderAgentChangedFilesInfo(agentRegistryState.changedFilesInfo);
  } finally {
    if (button) button.disabled = false;
  }
}

function parseAgentPreviewFiles(text) {
  return String(text || '')
    .split(/[\n,]+/)
    .map(line => line.replace(/^[ MADRCU?!]{1,3}\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 40);
}

function renderAgentClassification(result) {
  const matches = result.matches || [];
  return `
    <div class="agent-preview-profile">
      <strong>${escapeHtml(result.profile?.title || 'No profile')}</strong>
      <code>${escapeHtml(result.profile?.id || '-')}</code>
    </div>
    ${renderAgentGovernance(result.governance || result.profile?.governance, { overridden: result.profile?.governanceOverridden })}
    <div class="agent-match-list">
      ${matches.length ? matches.map(match => `
        <div class="agent-match-row">
          <strong>${escapeHtml(match.tag)}</strong>
          <span>${escapeHtml(match.agentId)} · score ${escapeHtml(match.score)}${match.codeScore ? ` · code ${escapeHtml(match.codeScore)}` : ''}</span>
          <em>${renderAgentMatchEvidence(match)}</em>
        </div>
      `).join('') : '<div class="agent-empty">没有命中 tag，会走角色 fallback。</div>'}
    </div>
    ${renderAgentCodeContext(result.codeContextSignals)}
    ${renderAgentCodebaseQuestionAnswer(result.codebaseQuestionAnswer || agentRegistryState.codebaseQuestionAnswer)}
    ${renderAgentCodebaseMap(agentRegistryState.codebaseMap)}
    ${renderAgentSymbolGraph(result.codeContextGraph || agentRegistryState.codeContextGraph, result.codeContextGraphSummary || agentRegistryState.codebaseMap?.symbolGraphSummary)}
    ${renderAgentCodeEvidence(result.codeContextEvidence, result.codeContextEvidenceSummary)}
    <div class="agent-preview-skills">
      <div><b>Installed</b> ${renderAgentSkillBindingPills(result.installedSkillBindings, result.installedSkillNames, 'ok')}</div>
      <div><b>Missing</b> ${(result.missingSkillNames || []).map(s => `<span class="missing">${escapeHtml(s)}</span>`).join('') || '<span class="ok">none</span>'}</div>
    </div>
    ${renderAgentSkillDiagnostics(result.skillDiagnostics)}
    <pre class="agent-prompt-preview"><code>${escapeHtml(result.promptPreview || '')}</code></pre>
  `;
}

function renderAgentMatchEvidence(match) {
  const text = [];
  if ((match.matched || []).length) text.push(`text: ${(match.matched || []).join(', ')}`);
  if ((match.contextReasons || []).length) text.push(`code: ${(match.contextReasons || []).join(', ')}`);
  if ((match.contextPaths || []).length) text.push(`files: ${(match.contextPaths || []).slice(0, 3).join(', ')}`);
  return escapeHtml(text.join(' · ') || 'no keyword detail');
}

function renderAgentCodeContext(codeContextSignals = null) {
  const tags = Array.isArray(codeContextSignals?.tags) ? codeContextSignals.tags : [];
  if (tags.length === 0) return '';
  return `<div class="agent-code-context">
    <div class="agent-code-context-head">
      <strong>Code Context</strong>
      <span>${escapeHtml(codeContextSignals.signalFileCount || 0)}/${escapeHtml(codeContextSignals.fileCount || 0)} files signaled</span>
    </div>
    <div class="agent-code-context-list">
      ${tags.slice(0, 6).map(tag => `
        <div class="agent-code-context-row">
          <strong>${escapeHtml(tag.tag)}</strong>
          <span>score ${escapeHtml(tag.score)} · ${(tag.reasons || []).slice(0, 3).map(escapeHtml).join(', ') || 'path signal'}</span>
          <em>${(tag.paths || []).slice(0, 4).map(escapeHtml).join(', ')}</em>
        </div>
      `).join('')}
    </div>
  </div>`;
}

function renderAgentCodebaseMap(map = null) {
  if (!map || !Array.isArray(map.focusFiles) || map.focusFiles.length === 0) return '';
  const edges = Array.isArray(map.graph?.edges) ? map.graph.edges : [];
  const files = map.focusFiles.slice(0, 8);
  return `<div class="agent-codebase-map">
    <div class="agent-code-context-head">
      <strong>Codebase Map</strong>
      <span>${escapeHtml(map.scannedFileCount || 0)} scanned · ${escapeHtml(map.focusFileCount || files.length)} focus · ${escapeHtml(map.graph?.edgeCount || 0)} edges</span>
    </div>
    <div class="agent-codebase-focus">
      ${files.map(file => `<div class="agent-codebase-focus-row">
        <strong>${escapeHtml(file.path)}</strong>
        <span>score ${escapeHtml(file.score || 0)} · ${(file.reasons || []).slice(0, 4).map(escapeHtml).join(', ') || 'project priority'}</span>
      </div>`).join('')}
    </div>
    ${edges.length ? `<div class="agent-codebase-edges">
      ${edges.slice(0, 8).map(edge => `<span>${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</span>`).join('')}
    </div>` : ''}
  </div>`;
}

function renderAgentSymbolGraph(graph = null, summary = null) {
  const data = graph || {};
  const definitions = Array.isArray(data.definitions) ? data.definitions : [];
  const refs = Array.isArray(data.references) ? data.references : [];
  const routes = Array.isArray(data.routes) ? data.routes : [];
  const usages = Array.isArray(data.routeUsages) ? data.routeUsages : [];
  const routeChains = Array.isArray(data.routeTestChains) ? data.routeTestChains : [];
  const unresolved = Array.isArray(data.unresolvedReferences) ? data.unresolvedReferences : [];
  if (definitions.length === 0 && routes.length === 0) return '';
  const meta = summary || data;
  const topDefinitions = definitions
    .slice()
    .sort((a, b) => ((b.referenceCount || 0) + (b.callCount || 0)) - ((a.referenceCount || 0) + (a.callCount || 0)) || String(a.name).localeCompare(String(b.name)))
    .slice(0, 6);
  return `<div class="agent-symbol-graph">
    <div class="agent-code-context-head">
      <strong>Symbol Graph</strong>
      <span>${escapeHtml(meta.definitionCount || definitions.length)} defs · ${escapeHtml(meta.referenceCount || refs.length)} refs · ${escapeHtml(meta.callCount || refs.filter(item => item.kind === 'call').length)} calls · ${escapeHtml(meta.typeImplementationCount || refs.filter(item => item.kind === 'type-implementation').length)} type impl · ${escapeHtml(meta.routeUsageCount || usages.length)} route uses · ${escapeHtml(meta.routeToTestChainCount || routeChains.length)} route-test · ${escapeHtml(meta.unresolvedReferenceCount || unresolved.length)} unresolved</span>
    </div>
    <div class="agent-symbol-list">
      ${topDefinitions.map(item => `<div class="agent-symbol-row">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.type || 'symbol')} · ${escapeHtml(item.path)}:${escapeHtml(item.line)}</span>
        <em>${escapeHtml(item.referenceCount || 0)} refs · ${escapeHtml(item.callCount || 0)} calls</em>
      </div>`).join('')}
    </div>
    ${routes.length ? `<div class="agent-symbol-routes">
      ${routes.slice(0, 6).map(item => `<span>${escapeHtml(item.route)} · ${escapeHtml(item.usageCount || 0)} uses</span>`).join('')}
    </div>` : ''}
  </div>`;
}

function renderAgentCodeEvidence(evidence = [], summary = null) {
  const list = Array.isArray(evidence) ? evidence : [];
  const meta = summary || {};
  const visible = list.filter(file => (file.symbols || []).length || (file.anchors || []).length || (file.imports || []).length).slice(0, 6);
  if (visible.length === 0) return '';
  const parserCounts = meta.parserCounts && typeof meta.parserCounts === 'object' ? meta.parserCounts : {};
  const parserText = Object.entries(parserCounts)
    .filter(([, count]) => Number(count) > 0)
    .slice(0, 3)
    .map(([parser, count]) => `${parser}:${count}`)
    .join(' · ');
  return `<div class="agent-code-evidence">
    <div class="agent-code-context-head">
      <strong>Code Evidence</strong>
      <span>${escapeHtml(meta.symbolCount || 0)} symbols · ${escapeHtml(meta.anchorCount || 0)} anchors · ${escapeHtml(meta.importCount || 0)} imports · ${escapeHtml(meta.referenceCount || 0)} refs${parserText ? ` · ${escapeHtml(parserText)}` : ''}</span>
    </div>
    <div class="agent-code-evidence-list">
      ${visible.map(file => {
        const symbols = (file.symbols || []).slice(0, 5).map(item => `${item.name}:${item.line}`);
        const anchors = (file.anchors || []).slice(0, 4).map(item => `${item.kind}:${item.name}:${item.line}`);
        const imports = (file.imports || []).slice(0, 4).map(item => item.source);
        const parser = file.parser ? `/${file.parser}` : '';
        return `<div class="agent-code-evidence-row">
          <strong>${escapeHtml(file.path)}</strong>
          <span>${escapeHtml(`${file.language || 'text'}${parser}`)} · ${(symbols.length ? `symbols ${symbols.join(', ')}` : 'no symbols')}</span>
          <em>${escapeHtml([anchors.length ? `anchors ${anchors.join(', ')}` : '', imports.length ? `imports ${imports.join(', ')}` : ''].filter(Boolean).join(' · ') || 'no anchors')}</em>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderAgentSkillBindingPills(bindings = [], fallbackNames = [], cls = 'ok') {
  const list = Array.isArray(bindings) && bindings.length > 0
    ? bindings
    : (fallbackNames || []).map(name => ({ name, sources: [] }));
  if (list.length === 0) return '<span class="missing">none</span>';
  return list.map((binding) => {
    const sources = Array.isArray(binding.sources) ? binding.sources.filter(Boolean) : [];
    const sourceText = sources.join(' + ');
    return `<span class="${cls}" title="${escapeHtml(sourceText || 'source unknown')}">${escapeHtml(binding.name)}${sourceText ? `<em>${escapeHtml(sourceText)}</em>` : ''}</span>`;
  }).join('');
}

function renderAgentSkillDiagnostics(diagnostics = []) {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  if (list.length === 0) return '';
  return `<div class="agent-skill-diagnostics">
    ${list.map((item) => `
      <div class="agent-skill-diagnostic ${escapeHtml(item.severity || 'info')}">
        <strong>${escapeHtml(item.code || 'skill_diagnostic')}</strong>
        <span>${escapeHtml(item.message || '')}</span>
      </div>
    `).join('')}
  </div>`;
}

$('#btnAgentRegistry')?.addEventListener('click', openAgentRegistryModal);
document.querySelectorAll('[data-close-agent-registry]').forEach(el => el.addEventListener('click', closeAgentRegistryModal));

// ========== Codebase Center ==========
const codebaseCenterState = {
  status: null,
  results: [],
  query: 'Agent 图谱入口 DOM handler',
  error: '',
  loading: false,
  cwd: '',
  lastResult: null,
  questionAnswer: null,
};

function codebaseCenterCwd() {
  return codebaseCenterState.cwd || agentPreviewCwd() || state.activeCwd || '';
}

async function openCodebaseCenterModal() {
  codebaseCenterState.cwd = codebaseCenterCwd();
  if (!codebaseCenterState.query && agentRegistryState.text) codebaseCenterState.query = agentRegistryState.text;
  $('#codebaseCenterModal').style.display = 'flex';
  renderCodebaseCenter();
  await refreshCodebaseStatus();
}

function closeCodebaseCenterModal() {
  $('#codebaseCenterModal').style.display = 'none';
}

function codebaseStatusText(status = null) {
  if (!status || !status.indexedAt) return 'not indexed';
  const parts = [
    `${status.scannedFileCount || 0} scanned`,
    `${status.focusFileCount || 0} focus`,
  ];
  if (status.evidenceSummary?.symbolCount) parts.push(`${status.evidenceSummary.symbolCount} symbols`);
  if (status.evidenceSummary?.parserCounts) {
    const parsers = Object.entries(status.evidenceSummary.parserCounts)
      .filter(([, count]) => Number(count) > 0)
      .slice(0, 2)
      .map(([parser, count]) => `${parser}:${count}`)
      .join('/');
    if (parsers) parts.push(`parsers ${parsers}`);
  }
  if (status.symbolGraphSummary?.typeImplementationCount) parts.push(`${status.symbolGraphSummary.typeImplementationCount} type impl`);
  if (status.symbolGraphSummary?.routeUsageCount) parts.push(`${status.symbolGraphSummary.routeUsageCount} route uses`);
  if (status.symbolGraphSummary?.routeToTestChainCount) parts.push(`${status.symbolGraphSummary.routeToTestChainCount} route-test chains`);
  if (status.symbolGraphSummary?.unresolvedReferenceCount) parts.push(`${status.symbolGraphSummary.unresolvedReferenceCount} unresolved refs`);
  if (status.vectorSummary?.rowCount) parts.push(`${status.vectorSummary.rowCount} vectors`);
  return parts.join(' · ');
}

function renderCodebaseCenter() {
  const root = $('#codebaseCenterBody');
  if (!root) return;
  const status = codebaseCenterState.status;
  const results = codebaseCenterState.results || [];
  const answer = codebaseCenterState.questionAnswer;
  root.innerHTML = `
    <div class="codebase-center-head">
      <label>
        <span>Project</span>
        <input id="codebaseCenterCwd" type="text" value="${escapeHtml(codebaseCenterCwd())}" placeholder="留空 = 当前 panel cwd" />
      </label>
      <div class="codebase-index-status">
        <strong>${escapeHtml(status?.ok === false ? 'error' : 'ready')}</strong>
        <span>${escapeHtml(codebaseStatusText(status))}</span>
        <em>${status?.indexedAt ? escapeHtml(activityTime(status.indexedAt)) : '-'}</em>
      </div>
    </div>
    <div class="codebase-query-bar">
      <input id="codebaseQueryInput" type="search" value="${escapeHtml(codebaseCenterState.query)}" placeholder="查询代码问题，例如：RoomAdapter 在哪里处理预算？" />
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="codebaseRebuildBtn">${codebaseCenterState.loading === 'rebuild' ? '重建中…' : 'Rebuild'}</button>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="codebaseQuestionBtn">${codebaseCenterState.loading === 'question' ? '回答中…' : 'Answer'}</button>
      <button class="cxbtn cxbtn-primary cxbtn-sm" id="codebaseQueryBtn">${codebaseCenterState.loading === 'query' ? '查询中…' : 'Query'}</button>
    </div>
    ${codebaseCenterState.error ? `<div class="agent-empty error">${escapeHtml(codebaseCenterState.error)}</div>` : ''}
    ${answer ? renderCodebaseQuestionAnswer(answer) : ''}
    <div class="codebase-result-actions">
      <span>${escapeHtml(results.length)} results</span>
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" id="codebaseAddAll" ${results.length ? '' : 'disabled'}>添加结果到 Dispatch Preview</button>
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" id="codebaseOpenDispatch">打开 Dispatch Preview</button>
    </div>
    <div class="codebase-results">
      ${results.length ? results.map(renderCodebaseResult).join('') : `<div class="agent-empty">${codebaseCenterState.loading ? '等待索引结果…' : '输入问题后查询本地代码索引。'}</div>`}
    </div>
  `;
  bindCodebaseCenterEvents(root);
}

function renderCodebaseResult(item, idx) {
  const symbols = Array.isArray(item.symbols) ? item.symbols : [];
  const routes = Array.isArray(item.routes) ? item.routes : [];
  return `<article class="codebase-result-card">
    <div class="codebase-result-title">
      <strong>${escapeHtml(item.path || '-')}<span>:${escapeHtml(item.line || 1)}</span></strong>
      <em>score ${escapeHtml(item.score || 0)}${item.semanticScore !== undefined ? ` · vector ${escapeHtml(Number(item.semanticScore).toFixed(3))}` : ''} · ${escapeHtml(item.parser || 'unknown')}</em>
    </div>
    <div class="codebase-result-meta">
      <span>${escapeHtml(item.kind || 'file')}</span>
      ${item.anchor ? `<span>${escapeHtml(item.anchor)}</span>` : ''}
    </div>
    ${item.text ? `<pre class="codebase-result-snippet"><code>${escapeHtml(item.text)}</code></pre>` : ''}
    <div class="codebase-result-reasons">
      ${(item.reason || []).slice(0, 9).map(reason => `<span>${escapeHtml(reason)}</span>`).join('')}
    </div>
    ${symbols.length || routes.length ? `<div class="codebase-result-evidence">
      ${symbols.slice(0, 5).map(symbol => `<span>${escapeHtml(symbol.name)}:${escapeHtml(symbol.line || 1)}</span>`).join('')}
      ${routes.slice(0, 5).map(route => `<span>${escapeHtml(route.name || route.route || route.kind)}</span>`).join('')}
    </div>` : ''}
    <div class="codebase-result-footer">
      <button class="cxbtn cxbtn-secondary cxbtn-sm" data-codebase-add="${idx}">添加到 Dispatch Preview</button>
    </div>
  </article>`;
}

function renderCodebaseQuestionAnswer(answer = {}) {
  const citations = Array.isArray(answer.citations) ? answer.citations : [];
  const lines = Array.isArray(answer.answerLines) ? answer.answerLines : [];
  const coverage = answer.coverage || {};
  const limitations = Array.isArray(answer.limitations) ? answer.limitations : [];
  const chainText = coverage.routeToTestChainCount ? ` · ${Number(coverage.routeToTestChainCount || 0)} route-test chains` : '';
  const unresolvedText = coverage.unresolvedReferenceCount ? ` · ${Number(coverage.unresolvedReferenceCount || 0)} unresolved refs` : '';
  const pathText = coverage.citationPathCount ? ` · ${Number(coverage.citationPathCount || 0)} citation paths` : '';
  // P0-A 证据 summary：把 reference kind 计数渲染成标注 chips（callback-registration / object-property-flow 等）
  const refKindEntries = Object.entries(coverage.referenceKindCounts || {})
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => b[1] - a[1]);
  return `<section class="codebase-question-answer" data-codebase-question-answer>
    <div class="codebase-question-head">
      <strong>Local Code Answer</strong>
      <span>${escapeHtml(answer.confidence || 'unknown')} confidence</span>
      ${answer.weakEvidence ? '<span class="codebase-weak-evidence" title="无结构级证据或低置信——把引用当线索而非完整实现图">⚠ weak evidence</span>' : ''}
      <span>${Number(coverage.uniqueFileCount || 0)} files · ${Number(coverage.evidenceItemCount || 0)} evidence${coverage.typeImplementationCount ? ` · ${Number(coverage.typeImplementationCount || 0)} type impl` : ''}${chainText}${unresolvedText}${pathText}</span>
    </div>
    <p>${escapeHtml(answer.answer || '')}</p>
    ${refKindEntries.length ? `<div class="codebase-question-refkinds" data-codebase-refkinds>
      ${refKindEntries.slice(0, 8).map(([kind, n]) => `<span title="结构级引用证据">${escapeHtml(kind)} ${Number(n)}</span>`).join('')}
    </div>` : ''}
    ${limitations.length ? `<div class="codebase-question-limitations">${limitations.slice(0, 4).map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
    ${lines.length ? `<ol class="codebase-question-lines">
      ${lines.slice(0, 6).map(line => `<li>${escapeHtml(line)}</li>`).join('')}
    </ol>` : ''}
    ${citations.length ? `<div class="codebase-question-citations">
      ${citations.slice(0, 6).map(item => `<span title="${escapeHtml((item.reasons || []).join(', '))}">${escapeHtml(item.id)} ${escapeHtml(item.label)}</span>`).join('')}
    </div>` : ''}
  </section>`;
}

function bindCodebaseCenterEvents(root) {
  $('#codebaseCenterCwd')?.addEventListener('change', (e) => {
    codebaseCenterState.cwd = e.target.value.trim();
    refreshCodebaseStatus();
  });
  $('#codebaseQueryInput')?.addEventListener('input', (e) => {
    codebaseCenterState.query = e.target.value;
  });
  $('#codebaseQueryInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runCodebaseQuery();
  });
  $('#codebaseRebuildBtn')?.addEventListener('click', rebuildCodebaseIndex);
  $('#codebaseQuestionBtn')?.addEventListener('click', runCodebaseQuestion);
  $('#codebaseQueryBtn')?.addEventListener('click', runCodebaseQuery);
  $('#codebaseAddAll')?.addEventListener('click', () => addCodebaseResultsToDispatch(codebaseCenterState.results));
  $('#codebaseOpenDispatch')?.addEventListener('click', openDispatchPreviewFromCodebase);
  root.querySelectorAll('[data-codebase-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.codebaseAdd);
      const item = codebaseCenterState.results[idx];
      addCodebaseResultsToDispatch(item ? [item] : []);
    });
  });
}

async function refreshCodebaseStatus() {
  try {
    const params = new URLSearchParams();
    const cwd = codebaseCenterCwd();
    if (cwd) params.set('cwd', cwd);
    const result = await api('/api/codebase-index/status' + (params.toString() ? '?' + params.toString() : ''));
    codebaseCenterState.status = result.status || null;
    codebaseCenterState.error = '';
  } catch (e) {
    codebaseCenterState.error = e.message || '读取 Codebase Index 状态失败';
  }
  renderCodebaseCenter();
}

async function rebuildCodebaseIndex() {
  codebaseCenterState.loading = 'rebuild';
  codebaseCenterState.error = '';
  renderCodebaseCenter();
  try {
    const result = await api('/api/codebase-index/rebuild', {
      method: 'POST',
      body: JSON.stringify({
        cwd: codebaseCenterCwd(),
        query: codebaseCenterState.query,
        focusLimit: 24,
      }),
    });
    codebaseCenterState.status = result.status || null;
    codebaseCenterState.lastResult = result.map || null;
    codebaseCenterState.questionAnswer = null;
    toast('Codebase Index 已重建', 'success', 1600);
  } catch (e) {
    codebaseCenterState.error = e.message || '重建 Codebase Index 失败';
  } finally {
    codebaseCenterState.loading = false;
    renderCodebaseCenter();
  }
}

async function runCodebaseQuery() {
  const query = (codebaseCenterState.query || '').trim();
  if (!query) {
    codebaseCenterState.error = '请输入查询问题。';
    renderCodebaseCenter();
    return;
  }
  codebaseCenterState.loading = 'query';
  codebaseCenterState.error = '';
  codebaseCenterState.questionAnswer = null;
  renderCodebaseCenter();
  try {
    const result = await api('/api/codebase-index/query', {
      method: 'POST',
      body: JSON.stringify({
        cwd: codebaseCenterCwd(),
        query,
        maxResults: 20,
        focusLimit: 24,
      }),
    });
    codebaseCenterState.results = result.results || [];
    codebaseCenterState.status = result.status || codebaseCenterState.status;
    codebaseCenterState.lastResult = result;
  } catch (e) {
    codebaseCenterState.error = e.message || '查询 Codebase Index 失败';
    codebaseCenterState.results = [];
  } finally {
    codebaseCenterState.loading = false;
    renderCodebaseCenter();
  }
}

async function runCodebaseQuestion() {
  const question = (codebaseCenterState.query || '').trim();
  if (!question) {
    codebaseCenterState.error = '请输入代码问题。';
    renderCodebaseCenter();
    return;
  }
  codebaseCenterState.loading = 'question';
  codebaseCenterState.error = '';
  renderCodebaseCenter();
  try {
    const result = await api('/api/codebase-index/question', {
      method: 'POST',
      body: JSON.stringify({
        cwd: codebaseCenterCwd(),
        question,
        maxResults: 8,
        focusLimit: 24,
      }),
    });
    codebaseCenterState.results = result.results || [];
    codebaseCenterState.questionAnswer = result.answer || null;
    codebaseCenterState.status = result.status || codebaseCenterState.status;
    codebaseCenterState.lastResult = result;
  } catch (e) {
    codebaseCenterState.error = e.message || '回答代码问题失败';
    codebaseCenterState.questionAnswer = null;
    codebaseCenterState.results = [];
  } finally {
    codebaseCenterState.loading = false;
    renderCodebaseCenter();
  }
}

function codebaseResultToEvidence(item) {
  if (!item?.path) return null;
  return {
    path: item.path,
    language: item.path.endsWith('.css') ? 'css' : item.path.endsWith('.html') ? 'html' : item.path.endsWith('.md') ? 'markdown' : 'javascript',
    parser: item.parser || 'unknown',
    symbols: Array.isArray(item.symbols) ? item.symbols : [],
    imports: [],
    anchors: Array.isArray(item.routes) ? item.routes : [],
    snippets: item.text ? [{ line: item.line || 1, reason: (item.reason || []).slice(0, 3).join(', ') || 'codebase-query', text: item.text }] : [],
    references: [],
  };
}

function addCodebaseResultsToDispatch(items = [], options = {}) {
  const list = (items || []).filter(item => item?.path);
  if (!list.length) return;
  const questionAnswer = sanitizeCodebaseQuestionAnswer(options.questionAnswer || codebaseCenterState.questionAnswer);
  const existing = parseAgentPreviewFiles(agentRegistryState.affectedFiles);
  const paths = [...new Set([...existing, ...list.map(item => item.path)])].slice(0, 40);
  const evidenceByPath = new Map((agentRegistryState.codeContextEvidence || []).map(item => [item.path, item]));
  for (const item of list) {
    const evidence = codebaseResultToEvidence(item);
    if (evidence) evidenceByPath.set(evidence.path, evidence);
  }
  agentRegistryState.affectedFiles = paths.join('\n');
  agentRegistryState.codeContextEvidence = [...evidenceByPath.values()].slice(0, 24);
  agentRegistryState.codeContextGraph = null;
  agentRegistryState.codebaseMap = null;
  agentRegistryState.codebaseQuestionAnswer = questionAnswer;
  agentRegistryState.classification = null;
  agentRegistryState.changedFilesInfo = {
    mode: 'codebase-query',
    count: paths.length,
    evidenceSummary: {
      fileCount: agentRegistryState.codeContextEvidence.length,
      symbolCount: agentRegistryState.codeContextEvidence.reduce((sum, file) => sum + (file.symbols || []).length, 0),
      anchorCount: agentRegistryState.codeContextEvidence.reduce((sum, file) => sum + (file.anchors || []).length, 0),
    },
  };
  if (codebaseCenterState.query) agentRegistryState.text = codebaseCenterState.query;
  if ($('#agentRegistryModal')?.style.display === 'flex') renderAgentRegistryModal();
  toast(`已添加 ${list.length} 条代码证据到 Dispatch Preview`, 'success', 1800);
}

async function openDispatchPreviewFromCodebase() {
  codebaseCenterState.query = ($('#codebaseQueryInput')?.value || codebaseCenterState.query || '').trim();
  const questionAnswer = sanitizeCodebaseQuestionAnswer(codebaseCenterState.questionAnswer);
  if (questionAnswer) {
    agentRegistryState.codebaseQuestionAnswer = questionAnswer;
    agentRegistryState.classification = null;
  }
  if (codebaseCenterState.query) agentRegistryState.text = codebaseCenterState.query;
  closeCodebaseCenterModal();
  agentRegistryState.activeTab = 'dispatch';
  await openAgentRegistryModal();
}

$('#btnCodebaseCenter')?.addEventListener('click', openCodebaseCenterModal);
document.querySelectorAll('[data-close-codebase-center]').forEach(el => el.addEventListener('click', closeCodebaseCenterModal));

// ========== 知识库（证据 FTS 检索）P4/A2 ==========
// 跨 Agent Run / 工具结果 / 审计的本地证据全文检索；命中可跳到审计时间线。
// 复用 Codebase Center 的卡片/查询条样式类，避免新增 CSS。
const KNOWLEDGE_KIND_LABELS = {
  agent_message: 'Agent 消息',
  tool_result: '工具结果',
  activity: '审计事件',
};
const knowledgeCenterState = {
  query: '',
  kind: '',
  hits: [],
  indexed: 0,
  error: '',
  loading: false,
  searched: false,
};

// 结果区空态文案：区分「检索中 / 已搜 0 命中 / 空库 / 未搜」四态，避免 0 命中误显初始提示
function knowledgeEmptyText() {
  const s = knowledgeCenterState;
  if (s.loading === 'search') return '检索中…';
  if (s.searched) {
    const q = (s.query || '').trim();
    const head = `未找到匹配${q ? `「${escapeHtml(q)}」` : ''}的证据。`;
    return head + (s.indexed ? '换个关键词，或调整来源筛选。' : '知识库为空，先点「重建索引」。');
  }
  return s.indexed
    ? '输入关键词后检索本地证据（可按来源筛选）。'
    : '知识库为空，先点「重建索引」，从 Agent Run / 工具结果 / 审计派生本地证据。';
}

async function openKnowledgeCenterModal() {
  $('#knowledgeCenterModal').style.display = 'flex';
  renderKnowledgeCenter();
  await refreshKnowledgeStats();
}

function closeKnowledgeCenterModal() {
  $('#knowledgeCenterModal').style.display = 'none';
}

function renderKnowledgeCenter() {
  const root = $('#knowledgeCenterBody');
  if (!root) return;
  const hits = knowledgeCenterState.hits || [];
  const kind = knowledgeCenterState.kind;
  root.innerHTML = `
    <div class="codebase-index-status knowledge-center-status">
      <strong>本地证据知识库</strong>
      <span>已索引 ${escapeHtml(knowledgeCenterState.indexed)} 条（Agent 消息 / 工具结果 / 审计）</span>
    </div>
    <div class="codebase-query-bar">
      <input id="knowledgeQueryInput" type="search" value="${escapeHtml(knowledgeCenterState.query)}" placeholder="检索本地证据，例如：预算审批 / RoomAdapter 错误" />
      <select id="knowledgeKindSelect" class="cxbtn cxbtn-secondary cxbtn-sm">
        <option value="">全部来源</option>
        <option value="agent_message"${kind === 'agent_message' ? ' selected' : ''}>Agent 消息</option>
        <option value="tool_result"${kind === 'tool_result' ? ' selected' : ''}>工具结果</option>
        <option value="activity"${kind === 'activity' ? ' selected' : ''}>审计事件</option>
      </select>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="knowledgeReindexBtn">${knowledgeCenterState.loading === 'reindex' ? '索引中…' : '重建索引'}</button>
      <button class="cxbtn cxbtn-primary cxbtn-sm" id="knowledgeSearchBtn">${knowledgeCenterState.loading === 'search' ? '检索中…' : '检索'}</button>
    </div>
    ${knowledgeCenterState.error ? `<div class="agent-empty error">${escapeHtml(knowledgeCenterState.error)}</div>` : ''}
    <div class="codebase-result-actions"><span>${escapeHtml(hits.length)} 条命中</span></div>
    <div class="codebase-results">
      ${hits.length ? hits.map(renderKnowledgeHit).join('') : `<div class="agent-empty">${knowledgeEmptyText()}</div>`}
    </div>
  `;
  bindKnowledgeCenterEvents(root);
}

function renderKnowledgeHit(hit, idx) {
  const kindLabel = KNOWLEDGE_KIND_LABELS[hit.refKind] || hit.refKind || '证据';
  return `<article class="codebase-result-card">
    <div class="codebase-result-title">
      <strong>${escapeHtml(kindLabel)}</strong>
      <em title="按相关度排序">#${Number(idx) + 1}</em>
    </div>
    <div class="codebase-result-meta">
      <span>${escapeHtml(hit.refKind || '-')}:${escapeHtml(hit.refId || '-')}</span>
      ${hit.sessionId ? `<span>session ${escapeHtml(hit.sessionId)}</span>` : ''}
    </div>
    ${hit.snippet ? `<pre class="codebase-result-snippet"><code>${escapeHtml(hit.snippet)}</code></pre>` : ''}
    <div class="codebase-result-footer">
      <button class="cxbtn cxbtn-secondary cxbtn-sm" data-knowledge-open="${idx}">在审计中查看</button>
    </div>
  </article>`;
}

function bindKnowledgeCenterEvents(root) {
  $('#knowledgeQueryInput')?.addEventListener('input', (e) => {
    knowledgeCenterState.query = e.target.value;
    knowledgeCenterState.searched = false; // 改查询词回到中性提示，不再显示上次的「未找到」
  });
  $('#knowledgeQueryInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runKnowledgeSearch();
  });
  $('#knowledgeKindSelect')?.addEventListener('change', (e) => {
    knowledgeCenterState.kind = e.target.value;
    if ((knowledgeCenterState.query || '').trim()) runKnowledgeSearch(); // 已有查询词 → 按新来源即时重搜
  });
  $('#knowledgeReindexBtn')?.addEventListener('click', runKnowledgeReindex);
  $('#knowledgeSearchBtn')?.addEventListener('click', runKnowledgeSearch);
  root.querySelectorAll('[data-knowledge-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.knowledgeOpen);
      const hit = knowledgeCenterState.hits[idx];
      if (!hit) return;
      closeKnowledgeCenterModal();
      // F1：带 runId 的证据（agent_message/tool_result）直接开对应 Agent Run（最精准）；
      // E2 兜底：按 sessionId 落到该 run 的会话审计上下文；activity 命中按事件 id 检索。
      if (hit.runId) openAgentRunFromActivity(hit.runId);
      else if (hit.sessionId) openActivityModal({ sessionId: hit.sessionId });
      else openActivityModal({ q: hit.refId || hit.refKind || '' });
    });
  });
}

async function refreshKnowledgeStats() {
  try {
    const r = await api('/api/knowledge/evidence/stats');
    knowledgeCenterState.indexed = r.indexed || 0;
    knowledgeCenterState.error = '';
  } catch (e) {
    knowledgeCenterState.error = e.message || '读取证据知识库状态失败';
  }
  renderKnowledgeCenter();
}

async function runKnowledgeSearch() {
  const q = (knowledgeCenterState.query || '').trim();
  if (!q) {
    knowledgeCenterState.error = '请输入检索关键词。';
    renderKnowledgeCenter();
    return;
  }
  knowledgeCenterState.loading = 'search';
  knowledgeCenterState.error = '';
  renderKnowledgeCenter();
  try {
    const params = new URLSearchParams({ q });
    if (knowledgeCenterState.kind) params.set('kind', knowledgeCenterState.kind);
    params.set('limit', '30');
    const r = await api('/api/knowledge/evidence/search?' + params.toString());
    knowledgeCenterState.hits = r.hits || [];
    knowledgeCenterState.indexed = r.indexed ?? knowledgeCenterState.indexed;
  } catch (e) {
    knowledgeCenterState.error = e.message || '检索失败';
  } finally {
    knowledgeCenterState.loading = false;
    knowledgeCenterState.searched = true; // 标记已执行检索 → 0 命中显示「未找到」而非初始提示
    renderKnowledgeCenter();
  }
}

async function runKnowledgeReindex() {
  knowledgeCenterState.loading = 'reindex';
  knowledgeCenterState.error = '';
  renderKnowledgeCenter();
  try {
    const r = await api('/api/knowledge/evidence/reindex', {
      method: 'POST',
      body: JSON.stringify({ limit: 200 }),
    });
    knowledgeCenterState.indexed = r.total ?? knowledgeCenterState.indexed;
    toast(`证据知识库已索引（新增 ${r.indexed || 0}，跳过 ${r.skipped || 0}）`, 'success', 1800);
  } catch (e) {
    knowledgeCenterState.error = e.message || '重建索引失败';
  } finally {
    knowledgeCenterState.loading = false;
    renderKnowledgeCenter();
  }
}

$('#btnKnowledgeCenter')?.addEventListener('click', openKnowledgeCenterModal);
document.querySelectorAll('[data-close-knowledge-center]').forEach(el => el.addEventListener('click', closeKnowledgeCenterModal));

// ========== 本地审批中心 ==========
const approvalState = {
  status: 'pending',
  approvals: [],
  activeId: null,
};

function approvalTypeLabel(type) {
  return ({
    dangerous_command: '危险命令',
    budget_override: '预算覆盖',
    manual: '人工确认',
  })[type] || type || '审批';
}
function approvalTitle(a) {
  const p = a?.payload || {};
  if (a?.type === 'dangerous_command') return (p.command || '危险命令').slice(0, 90);
  return p.title || p.summary || approvalTypeLabel(a?.type);
}
function approvalTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '-';
  try { return new Date(n).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return '-'; }
}

async function openApprovalModal(focusId = null) {
  $('#approvalModal').style.display = 'flex';
  if (focusId) approvalState.activeId = focusId;
  await refreshApprovals();
}
function closeApprovalModal() { $('#approvalModal').style.display = 'none'; }

async function refreshApprovals() {
  try {
    const statusParam = approvalState.status ? `?status=${encodeURIComponent(approvalState.status)}&limit=100` : '?limit=100';
    const r = await api('/api/approvals' + statusParam);
    approvalState.approvals = r.approvals || [];
    if (!approvalState.activeId || !approvalState.approvals.some(a => a.id === approvalState.activeId)) {
      approvalState.activeId = approvalState.approvals[0]?.id || null;
    }
    renderApprovalModal();
  } catch (e) {
    $('#approvalModalBody').innerHTML = `<div class="muted small" style="padding:20px;color:var(--color-danger-alt);">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderApprovalModal() {
  const root = $('#approvalModalBody');
  if (!root) return;
  const approvals = approvalState.approvals || [];
  const active = approvals.find(a => a.id === approvalState.activeId) || null;
  root.innerHTML = `
    <section>
      <div class="approval-toolbar">
        <select id="approvalStatusFilter" aria-label="审批状态">
          <option value="pending" ${approvalState.status === 'pending' ? 'selected' : ''}>待处理</option>
          <option value="" ${approvalState.status === '' ? 'selected' : ''}>全部</option>
          <option value="approved" ${approvalState.status === 'approved' ? 'selected' : ''}>已批准</option>
          <option value="rejected" ${approvalState.status === 'rejected' ? 'selected' : ''}>已拒绝</option>
          <option value="cancelled" ${approvalState.status === 'cancelled' ? 'selected' : ''}>已取消</option>
        </select>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnApprovalRefresh">刷新</button>
      </div>
      <div class="approval-list">
        ${approvals.length ? approvals.map(a => `
          <div class="approval-item ${a.id === approvalState.activeId ? 'is-active' : ''}" data-approval-id="${escapeHtml(a.id)}">
            <div>
              <div class="title" title="${escapeHtml(approvalTitle(a))}">${escapeHtml(approvalTitle(a))}</div>
              <div class="meta">${escapeHtml(approvalTypeLabel(a.type))} · ${escapeHtml(a.requesterType || '-')}:${escapeHtml(a.requesterId || '-')} · ${approvalTime(a.createdAt)}</div>
            </div>
            <span class="approval-status ${escapeHtml(a.status)}">${escapeHtml(a.status)}</span>
          </div>
        `).join('') : '<div class="approval-empty">当前筛选条件下没有审批。</div>'}
      </div>
    </section>
    <section class="approval-detail">
      ${active ? renderApprovalDetail(active) : '<div class="approval-empty">选择左侧审批查看详情。</div>'}
    </section>
  `;

  $('#approvalStatusFilter')?.addEventListener('change', (e) => {
    approvalState.status = e.target.value;
    approvalState.activeId = null;
    refreshApprovals();
  });
  $('#btnApprovalRefresh')?.addEventListener('click', refreshApprovals);
  root.querySelectorAll('[data-approval-id]').forEach(el => {
    el.addEventListener('click', () => {
      approvalState.activeId = el.dataset.approvalId;
      renderApprovalModal();
    });
  });
  root.querySelectorAll('[data-approval-action]').forEach(btn => {
    btn.addEventListener('click', () => decideApproval(btn.dataset.approvalId, btn.dataset.approvalAction));
  });
}

function renderApprovalDetail(a) {
  const p = a.payload || {};
  const hits = Array.isArray(p.hits) ? p.hits : [];
  const isPending = a.status === 'pending';
  const command = p.command || '';
  return `
    <div class="approval-detail-grid">
      <div class="k">ID</div><div class="v">${escapeHtml(a.id)}</div>
      <div class="k">类型</div><div class="v">${escapeHtml(approvalTypeLabel(a.type))}</div>
      <div class="k">状态</div><div class="v"><span class="approval-status ${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></div>
      <div class="k">来源</div><div class="v">${escapeHtml(p.source || '-')}</div>
      <div class="k">目录</div><div class="v">${escapeHtml(p.cwd || '-')}</div>
      <div class="k">请求者</div><div class="v">${escapeHtml(a.requesterType || '-')} / ${escapeHtml(a.requesterId || '-')}</div>
      <div class="k">创建时间</div><div class="v">${approvalTime(a.createdAt)}</div>
      ${a.decidedAt ? `<div class="k">处理时间</div><div class="v">${approvalTime(a.decidedAt)} · ${escapeHtml(a.decisionBy || '-')}</div>` : ''}
      ${a.decisionReason ? `<div class="k">处理说明</div><div class="v">${escapeHtml(a.decisionReason)}</div>` : ''}
    </div>
    ${command ? `<div class="approval-command">${escapeHtml(command)}</div>` : ''}
    <div>
      ${hits.length ? hits.map(h => `<div class="approval-hit">
        <strong>${escapeHtml(h.severity || h.rule?.severity || 'risk')}</strong>
        ${escapeHtml(h.category || h.rule?.category || '')}
        <div class="muted small">${escapeHtml(h.advice || h.rule?.advice || h.snippet || '')}</div>
      </div>`).join('') : '<div class="approval-empty">没有附加风险规则详情。</div>'}
    </div>
    ${isPending ? `<div class="approval-actions">
      <button class="cxbtn cxbtn-secondary" data-approval-action="reject" data-approval-id="${escapeHtml(a.id)}">拒绝</button>
      <button class="cxbtn cxbtn-tertiary" data-approval-action="cancel" data-approval-id="${escapeHtml(a.id)}">取消审批</button>
      <button class="cxbtn cxbtn-danger" data-approval-action="approve" data-approval-id="${escapeHtml(a.id)}">批准</button>
    </div>` : ''}
  `;
}

async function decideApproval(id, action) {
  if (!id || !action) return;
  const label = action === 'approve' ? '批准' : (action === 'reject' ? '拒绝' : '取消');
  const reason = await promptModal({
    title: `${label}审批`,
    message: action === 'approve'
      ? '批准会记录人工决策；HTTP/API 操作可带 approvalId 重试同一动作，危险终端命令不会自动重放。'
      : '填写处理说明，留空也可以。',
    value: '',
    placeholder: '处理说明',
    confirmLabel: label,
  });
  if (reason === null) return;
  try {
    const r = await api(`/api/approvals/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ decisionBy: 'owner', reason }),
    });
    approvalState.activeId = r.approval?.id || id;
    toast(`审批已${label}`, 'success', 1500);
    refreshApprovals();
  } catch (e) {
    toast(`${label}失败：${e.message}`, 'error');
  }
}

function handleApprovalRequired(msg) {
  const approval = msg?.approval || null;
  const id = approval?.id || msg?.approvalId || null;
  toast(`危险操作已暂停等待审批${id ? '：' + id : ''}，批准后可重试原操作`, 'warn', 5000);
  if ($('#approvalModal')?.style.display === 'flex') {
    if (id) approvalState.activeId = id;
    refreshApprovals();
  }
}

$('#btnApprovals')?.addEventListener('click', () => openApprovalModal());
document.querySelectorAll('[data-close-approval]').forEach(el => el.addEventListener('click', closeApprovalModal));

// ========== 本地结构化审计时间线 ==========
const activityState = {
  events: [],
  activeId: null,
  filters: {
    q: '',
    action: '',
    roomId: '',
    sessionId: '',
    taskId: '',
    entityType: '',
    entityId: '',
    agentRunId: '',
    approvalResumeGateId: '',
    approvalResumeGateSha256: '',
    severity: '',
    status: '',
    agentOnly: false,
    agentProfileId: '',
    skillName: '',
    diagnosticCode: '',
    limit: 200,
  },
};

function activityTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '-';
  try { return new Date(n).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return '-'; }
}
function safeClassToken(value) {
  return String(value || 'none').replace(/[^a-z0-9_-]/gi, '-').slice(0, 40) || 'none';
}
function activityTitle(e) {
  return e.action || e.tag || `${e.entityType || 'event'}.${e.status || 'recorded'}`;
}
function activitySearchText(e) {
  return [
    e.id, e.action, e.tag, e.roomId, e.sessionId, e.taskId,
    e.actorType, e.actorId, e.entityType, e.entityId, e.severity, e.status,
    ...activityAgentRunIds(e),
    ...activityApprovalResumeGateIds(e),
    ...activityApprovalResumeGateSha256s(e),
    JSON.stringify(e.details || {}),
  ].filter(Boolean).join(' ').toLowerCase();
}
function activityScopeLine(e) {
  const parts = [];
  if (e.roomId) parts.push(`room:${e.roomId}`);
  if (e.sessionId) parts.push(`session:${e.sessionId}`);
  if (e.taskId) parts.push(`task:${e.taskId}`);
  if (e.entityType || e.entityId) parts.push(`${e.entityType || 'entity'}:${e.entityId || '-'}`);
  return parts.join(' · ') || 'global';
}
function activityAsArray(value) {
  if (value === null || value === undefined || value === '') return [];
  return Array.isArray(value) ? value : [value];
}
function activityCollectValues(value, out = []) {
  if (value === null || value === undefined || value === '') return out;
  if (Array.isArray(value)) {
    value.forEach(item => activityCollectValues(item, out));
    return out;
  }
  if (typeof value === 'object') {
    if (value.name) out.push(value.name);
    else if (value.id) out.push(value.id);
    return out;
  }
  out.push(value);
  return out;
}
function activityUniqueStrings(values) {
  return [...new Set(activityCollectValues(values).map(v => String(v).trim()).filter(Boolean))];
}
function activityAgentProfileIds(e) {
  const d = e.details || {};
  const ids = [];
  if (e.entityType === 'agent_profile' && e.entityId) ids.push(e.entityId);
  ids.push(d.agentProfileId, d.profileId, d.agentProfile?.id, d.agent?.profileId);
  return activityUniqueStrings(ids);
}
function activityAgentRunIds(e) {
  const d = e.details || {};
  const ids = [];
  if (e.entityType === 'agent_run' && e.entityId) ids.push(e.entityId);
  ids.push(d.agentRunId, d.runId, d.agentRun?.id, d.replayPlan?.runId, d.replayResult?.runId);
  return activityUniqueStrings(ids);
}
function activityApprovalResumeGateIds(e) {
  const d = e.details || {};
  return activityUniqueStrings([
    d.approvalResumeGateId,
    d.reviewGateId,
    d.resumeReviewGateId,
    d.approvalResumeReviewGateId,
    d.approvalResumeGateAudit?.id,
    d.resumeReviewGateAudit?.id,
    d.resumeReviewGate?.id,
    d.resumeReview?.gate?.id,
  ]);
}
function activityApprovalResumeGateSha256s(e) {
  const d = e.details || {};
  return activityUniqueStrings([
    d.approvalResumeGateSha256,
    d.reviewSha256,
    d.resumeReviewSha256,
    d.approvalResumeReviewSha256,
    d.approvalResumeGateAudit?.sha256,
    d.resumeReviewGateAudit?.sha256,
    d.resumeReviewGate?.sha256,
    d.resumeReview?.gate?.sha256,
  ]);
}
function activityApprovalResumeGateAudit(e) {
  const d = e.details || {};
  return d.approvalResumeGateAudit || d.resumeReviewGateAudit || d.resumeReviewGate || d.resumeReview?.gate || null;
}
function activitySkillBindings(e) {
  const d = e.details || {};
  return [...activityAsArray(d.agentSkillBindings), ...activityAsArray(d.skillBindings)]
    .filter(item => item && typeof item === 'object' && item.name);
}
function activitySkillNames(e) {
  const d = e.details || {};
  return activityUniqueStrings([
    d.agentSkillNames,
    d.skillNames,
    d.skills,
    d.agentSkillBindings,
    d.skillBindings,
  ]);
}
function activityDispatchTags(e) {
  const d = e.details || {};
  return activityUniqueStrings([d.agentDispatchTags, d.dispatchTags]);
}
function activityDiagnosticItems(e) {
  const d = e.details || {};
  return [...activityAsArray(d.diagnostics), ...activityAsArray(d.agentSkillDiagnostics)]
    .map(item => (typeof item === 'string' ? { code: item } : item))
    .filter(item => item && typeof item === 'object' && (item.code || item.message));
}
function activityArtifacts(e) {
  const d = e.details || {};
  return activityAsArray(d.artifacts)
    .filter(item => item && typeof item === 'object' && item.path)
    .slice(0, 12);
}
function isAgentActivityEvent(e) {
  const action = String(e.action || '');
  return action.startsWith('agent.')
    || activityAgentRunIds(e).length > 0
    || activityAgentProfileIds(e).length > 0
    || activityApprovalResumeGateIds(e).length > 0
    || activityApprovalResumeGateSha256s(e).length > 0
    || activitySkillNames(e).length > 0
    || activityDiagnosticItems(e).length > 0;
}
function filteredActivityEvents() {
  const q = (activityState.filters.q || '').trim().toLowerCase();
  if (!q) return activityState.events || [];
  return (activityState.events || []).filter(e => activitySearchText(e).includes(q));
}
function activityApiParams() {
  const f = activityState.filters;
  const params = new URLSearchParams();
  for (const key of ['action', 'roomId', 'sessionId', 'taskId', 'entityType', 'entityId', 'agentRunId', 'approvalResumeGateId', 'approvalResumeGateSha256', 'severity', 'status']) {
    if (f[key]) params.set(key, f[key]);
  }
  if (f.agentOnly) params.set('agentOnly', '1');
  for (const key of ['agentProfileId', 'skillName', 'diagnosticCode']) {
    if (f[key]) params.set(key, f[key]);
  }
  params.set('limit', String(Math.max(1, Math.min(1000, Number(f.limit) || 200))));
  return params.toString();
}

async function openActivityModal(seed = {}) {
  $('#activityModal').style.display = 'flex';
  if (seed.roomId) activityState.filters.roomId = seed.roomId;
  if (seed.sessionId) activityState.filters.sessionId = seed.sessionId;
  if (seed.taskId) activityState.filters.taskId = seed.taskId;
  if (seed.entityType) activityState.filters.entityType = seed.entityType;
  if (seed.entityId) activityState.filters.entityId = seed.entityId;
  if (seed.agentRunId) {
    activityState.filters.q = '';
    activityState.filters.entityType = '';
    activityState.filters.entityId = '';
    activityState.filters.agentRunId = seed.agentRunId;
  }
  if (seed.approvalResumeGateId || seed.reviewGateId) {
    activityState.filters.q = '';
    activityState.filters.approvalResumeGateId = seed.approvalResumeGateId || seed.reviewGateId;
  }
  if (seed.approvalResumeGateSha256 || seed.reviewSha256) {
    activityState.filters.q = '';
    activityState.filters.approvalResumeGateSha256 = seed.approvalResumeGateSha256 || seed.reviewSha256;
  }
  if (seed.agentOnly) activityState.filters.agentOnly = true;
  if (seed.agentProfileId) activityState.filters.agentProfileId = seed.agentProfileId;
  if (seed.skillName) activityState.filters.skillName = seed.skillName;
  if (seed.diagnosticCode) activityState.filters.diagnosticCode = seed.diagnosticCode;
  if (seed.q) activityState.filters.q = seed.q;
  await refreshActivity();
}
function closeActivityModal() { $('#activityModal').style.display = 'none'; }

async function refreshActivity() {
  const root = $('#activityModalBody');
  if (!root) return;
  root.innerHTML = '<div class="muted small" style="padding:20px;">加载中…</div>';
  try {
    const qs = activityApiParams();
    const r = await api('/api/activity' + (qs ? '?' + qs : ''));
    activityState.events = r.events || [];
    if (!activityState.activeId || !activityState.events.some(e => String(e.id) === String(activityState.activeId))) {
      activityState.activeId = activityState.events[0]?.id || null;
    }
    renderActivityModal();
  } catch (e) {
    root.innerHTML = `<div class="muted small" style="padding:20px;color:var(--color-danger-alt);">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderActivityModal() {
  const root = $('#activityModalBody');
  if (!root) return;
  const events = filteredActivityEvents();
  const active = events.find(e => String(e.id) === String(activityState.activeId)) || events[0] || null;
  if (active && String(active.id) !== String(activityState.activeId)) activityState.activeId = active.id;
  const errorCount = events.filter(e => ['error', 'warn', 'warning'].includes(String(e.severity || '').toLowerCase()) || String(e.status || '').toLowerCase().includes('error')).length;
  const roomCount = new Set(events.map(e => e.roomId).filter(Boolean)).size;
  const actionCount = new Set(events.map(e => e.action).filter(Boolean)).size;
  const agentCount = events.filter(isAgentActivityEvent).length;
  const diagnosticCount = events.reduce((sum, e) => sum + activityDiagnosticItems(e).length, 0);
  const currentRoomBtn = roomState.activeId
    ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" id="activityUseCurrentRoom">当前房间</button>`
    : '';
  const allPresetActive = !activityState.filters.agentOnly
    && !activityState.filters.action
    && !activityState.filters.agentProfileId
    && !activityState.filters.skillName
    && !activityState.filters.diagnosticCode
    && !activityState.filters.approvalResumeGateId
    && !activityState.filters.approvalResumeGateSha256;

  root.innerHTML = `
    <div class="activity-filter-presets">
      <button class="cxbtn cxbtn-tertiary cxbtn-sm ${allPresetActive ? 'is-active' : ''}" data-activity-preset="all">全部</button>
      <button class="cxbtn cxbtn-tertiary cxbtn-sm ${activityState.filters.agentOnly && !activityState.filters.action ? 'is-active' : ''}" data-activity-preset="agent">Agent/Skill</button>
      <button class="cxbtn cxbtn-tertiary cxbtn-sm ${activityState.filters.action === 'agent.skill_diagnostics' || activityState.filters.diagnosticCode ? 'is-active' : ''}" data-activity-preset="diagnostics">诊断</button>
      <button class="cxbtn cxbtn-tertiary cxbtn-sm ${activityState.filters.action === 'metrics.recorded' ? 'is-active' : ''}" data-activity-preset="metrics">Metrics</button>
      ${currentRoomBtn}
    </div>
    <div class="activity-toolbar">
      <input class="activity-search-field" id="activitySearch" type="search" placeholder="搜索 action / room / task / details" value="${escapeHtml(activityState.filters.q)}" />
      <input id="activityAction" type="text" placeholder="action 精确过滤" value="${escapeHtml(activityState.filters.action)}" />
      <input id="activityRoomId" type="text" placeholder="roomId" value="${escapeHtml(activityState.filters.roomId)}" />
      <input id="activitySessionId" type="text" placeholder="sessionId" value="${escapeHtml(activityState.filters.sessionId)}" />
      <input id="activityTaskId" type="text" placeholder="taskId" value="${escapeHtml(activityState.filters.taskId)}" />
      <input id="activityEntityType" type="text" placeholder="entityType" value="${escapeHtml(activityState.filters.entityType)}" />
      <input id="activityEntityId" type="text" placeholder="entityId" value="${escapeHtml(activityState.filters.entityId)}" />
      <input id="activityAgentRunId" type="text" placeholder="agentRunId" value="${escapeHtml(activityState.filters.agentRunId)}" />
      <input id="activityGateId" type="text" placeholder="reviewGateId" value="${escapeHtml(activityState.filters.approvalResumeGateId)}" />
      <input id="activityGateSha" type="text" placeholder="reviewSha256" value="${escapeHtml(activityState.filters.approvalResumeGateSha256)}" />
      <input id="activityAgentProfileId" type="text" placeholder="agentProfileId" value="${escapeHtml(activityState.filters.agentProfileId)}" />
      <input id="activitySkillName" type="text" placeholder="skill" value="${escapeHtml(activityState.filters.skillName)}" />
      <input id="activityDiagnosticCode" type="text" placeholder="diagnostic code" value="${escapeHtml(activityState.filters.diagnosticCode)}" />
      <select id="activitySeverity">
        <option value="" ${activityState.filters.severity === '' ? 'selected' : ''}>severity 全部</option>
        <option value="info" ${activityState.filters.severity === 'info' ? 'selected' : ''}>info</option>
        <option value="warn" ${activityState.filters.severity === 'warn' ? 'selected' : ''}>warn</option>
        <option value="error" ${activityState.filters.severity === 'error' ? 'selected' : ''}>error</option>
      </select>
      <input id="activityStatus" type="text" placeholder="status" value="${escapeHtml(activityState.filters.status)}" />
      <select id="activityLimit">
        ${[100, 200, 500, 1000].map(n => `<option value="${n}" ${Number(activityState.filters.limit) === n ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
      <label class="activity-toggle"><input id="activityAgentOnly" type="checkbox" ${activityState.filters.agentOnly ? 'checked' : ''} /><span>Agent/Skill</span></label>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="activityClearFilters">清空</button>
      <button class="cxbtn cxbtn-primary cxbtn-sm" id="activityRefresh">刷新</button>
    </div>
    <div class="activity-stats">
      <span><strong>${events.length}</strong> events</span>
      <span><strong>${actionCount}</strong> actions</span>
      <span><strong>${roomCount}</strong> rooms</span>
      <span><strong>${agentCount}</strong> agent/skill</span>
      <span class="${diagnosticCount ? 'is-warn' : ''}"><strong>${diagnosticCount}</strong> diagnostics</span>
      <span class="${errorCount ? 'is-warn' : ''}"><strong>${errorCount}</strong> warn/error</span>
    </div>
    <div class="activity-layout">
      <section class="activity-list">
        ${events.length ? events.map(e => renderActivityItem(e)).join('') : '<div class="activity-empty">当前筛选条件下没有审计事件。</div>'}
      </section>
      <section class="activity-detail">
        ${active ? renderActivityDetail(active) : '<div class="activity-empty">选择左侧事件查看结构化详情。</div>'}
      </section>
    </div>
  `;

  for (const [id, key] of [
    ['activitySearch', 'q'],
    ['activityAction', 'action'],
    ['activityRoomId', 'roomId'],
    ['activitySessionId', 'sessionId'],
    ['activityTaskId', 'taskId'],
    ['activityEntityType', 'entityType'],
    ['activityEntityId', 'entityId'],
    ['activityAgentRunId', 'agentRunId'],
    ['activityGateId', 'approvalResumeGateId'],
    ['activityGateSha', 'approvalResumeGateSha256'],
    ['activityAgentProfileId', 'agentProfileId'],
    ['activitySkillName', 'skillName'],
    ['activityDiagnosticCode', 'diagnosticCode'],
    ['activitySeverity', 'severity'],
    ['activityStatus', 'status'],
    ['activityLimit', 'limit'],
  ]) {
    const el = $('#' + id);
    if (!el) continue;
    const eventName = id === 'activitySearch' ? 'input' : 'change';
    el.addEventListener(eventName, () => {
      activityState.filters[key] = el.value.trim ? el.value.trim() : el.value;
      if (key === 'q') renderActivityModal();
      else refreshActivity();
    });
  }
  $('#activityAgentOnly')?.addEventListener('change', (e) => {
    activityState.filters.agentOnly = e.target.checked;
    activityState.activeId = null;
    refreshActivity();
  });
  $('#activityRefresh')?.addEventListener('click', refreshActivity);
  $('#activityClearFilters')?.addEventListener('click', () => {
    activityState.filters = { q: '', action: '', roomId: '', sessionId: '', taskId: '', entityType: '', entityId: '', agentRunId: '', approvalResumeGateId: '', approvalResumeGateSha256: '', severity: '', status: '', agentOnly: false, agentProfileId: '', skillName: '', diagnosticCode: '', limit: 200 };
    activityState.activeId = null;
    refreshActivity();
  });
  root.querySelectorAll('[data-activity-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.activityPreset;
      activityState.activeId = null;
      if (preset === 'all') {
        Object.assign(activityState.filters, { action: '', entityType: '', entityId: '', agentRunId: '', approvalResumeGateId: '', approvalResumeGateSha256: '', agentOnly: false, agentProfileId: '', skillName: '', diagnosticCode: '' });
      } else if (preset === 'agent') {
        Object.assign(activityState.filters, { action: '', approvalResumeGateId: '', approvalResumeGateSha256: '', agentOnly: true, diagnosticCode: '' });
      } else if (preset === 'diagnostics') {
        Object.assign(activityState.filters, { action: 'agent.skill_diagnostics', approvalResumeGateId: '', approvalResumeGateSha256: '', agentOnly: true });
      } else if (preset === 'metrics') {
        Object.assign(activityState.filters, { action: 'metrics.recorded', approvalResumeGateId: '', approvalResumeGateSha256: '', agentOnly: true, diagnosticCode: '' });
      }
      refreshActivity();
    });
  });
  $('#activityUseCurrentRoom')?.addEventListener('click', () => {
    activityState.filters.roomId = roomState.activeId || '';
    activityState.activeId = null;
    refreshActivity();
  });
  root.querySelectorAll('[data-activity-id]').forEach(el => {
    el.addEventListener('click', () => {
      activityState.activeId = Number(el.dataset.activityId) || el.dataset.activityId;
      renderActivityModal();
    });
  });
  root.querySelectorAll('[data-activity-open-room]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.activityOpenRoom;
      closeActivityModal();
      showRoomArea();
      await loadRooms();
      selectRoom(id);
    });
  });
  root.querySelectorAll('[data-activity-open-run]').forEach(btn => {
    btn.addEventListener('click', () => openAgentRunFromActivity(btn.dataset.activityOpenRun));
  });
  root.querySelectorAll('[data-activity-artifact-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const path = btn.dataset.activityArtifactCopy || '';
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(path).then(() => toast('Artifact path copied', 'success', 1400)).catch(() => fallbackCopy(path));
      } else {
        fallbackCopy(path);
      }
    });
  });
  root.querySelectorAll('[data-activity-artifact-download]').forEach(btn => {
    btn.addEventListener('click', () => openAgentRunArtifact(btn.dataset.activityArtifactRun, btn.dataset.activityArtifactDownload, btn));
  });
}

function renderActivityItem(e) {
  const active = String(e.id) === String(activityState.activeId);
  const sev = safeClassToken(e.severity || 'info');
  const agentHint = renderActivityItemAgentHint(e);
  return `<button class="activity-item ${active ? 'is-active' : ''} sev-${sev}" data-activity-id="${escapeHtml(e.id)}">
    <span class="activity-item-head">
      <strong>${escapeHtml(activityTitle(e))}</strong>
      <span>${activityTime(e.ts)}</span>
    </span>
    <span class="activity-item-meta">${escapeHtml(activityScopeLine(e))}</span>
    ${agentHint}
    <span class="activity-item-foot">
      <span class="activity-severity ${sev}">${escapeHtml(e.severity || 'info')}</span>
      ${e.status ? `<span>${escapeHtml(e.status)}</span>` : ''}
      <span>${escapeHtml(e.actorType || 'system')}</span>
    </span>
  </button>`;
}

function renderActivityItemAgentHint(e) {
  if (!isAgentActivityEvent(e)) return '';
  const run = activityAgentRunIds(e)[0];
  const profile = activityAgentProfileIds(e)[0];
  const gate = activityApprovalResumeGateIds(e)[0];
  const skillCount = activitySkillNames(e).length;
  const diagnosticCount = activityDiagnosticItems(e).length;
  const parts = [];
  if (run) parts.push(run);
  if (gate) parts.push(gate);
  if (profile) parts.push(profile);
  if (skillCount) parts.push(`${skillCount} skills`);
  if (diagnosticCount) parts.push(`${diagnosticCount} diagnostics`);
  return `<span class="activity-agent-hint">${parts.map(part => `<span>${escapeHtml(part)}</span>`).join('')}</span>`;
}

function renderActivityRunButtons(runIds = []) {
  return runIds.length
    ? `<span class="activity-chip-line">${runIds.map(id => `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-activity-open-run="${escapeHtml(id)}">${escapeHtml(id)}</button>`).join('')}</span>`
    : '';
}

function renderActivityApprovalResumeGatePanel(e) {
  const gateIds = activityApprovalResumeGateIds(e);
  const hashes = activityApprovalResumeGateSha256s(e);
  const audit = activityApprovalResumeGateAudit(e) || {};
  if (!gateIds.length && !hashes.length) return '';
  const counts = audit.counts || {};
  const countsText = [
    counts.fileChanges !== undefined ? `files ${counts.fileChanges}` : '',
    counts.commands !== undefined ? `commands ${counts.commands}` : '',
    counts.workEvidenceCommands !== undefined ? `evidence ${counts.workEvidenceCommands}` : '',
    counts.risks !== undefined ? `risks ${counts.risks}` : '',
  ].filter(Boolean).join(' · ') || '-';
  const safeText = audit.safeToResume === true ? 'safe' : (audit.safeToResume === false ? 'blocked' : '-');
  const statusText = [audit.status, safeText].filter(Boolean).join(' · ') || '-';
  const filePaths = activityAsArray(audit.files).map(file => file?.path).filter(Boolean).slice(0, 4);
  const commandNames = [
    ...activityAsArray(audit.commands),
    ...activityAsArray(audit.workEvidenceCommands),
  ].map(command => command?.command).filter(Boolean).slice(0, 4);
  const stagedDiffText = stagedDiffReviewText(audit.stagedDiffReview || audit.diffReview || {});
  return `
    <div class="activity-agent-panel">
      <div class="activity-agent-panel-head">
        <strong>Approval Resume Gate</strong>
        <span>${escapeHtml(statusText)}</span>
      </div>
      <div class="activity-agent-grid">
        <div class="k">Gate</div><div class="v">${gateIds.map(id => `<code>${escapeHtml(id)}</code>`).join(' ') || '-'}</div>
        <div class="k">SHA</div><div class="v">${hashes.map(sha => `<code>${escapeHtml(String(sha).slice(0, 16))}</code>`).join(' ') || '-'}</div>
        <div class="k">Runs</div><div class="v">${renderActivityRunButtons(activityAgentRunIds(e)) || '-'}</div>
        <div class="k">Counts</div><div class="v">${escapeHtml(countsText)}</div>
        ${stagedDiffText ? `<div class="k">Staged Diff</div><div class="v">${escapeHtml(stagedDiffText)}</div>` : ''}
        ${filePaths.length ? `<div class="k">Files</div><div class="v activity-chip-line">${filePaths.map(path => `<span>${escapeHtml(path)}</span>`).join('')}</div>` : ''}
        ${commandNames.length ? `<div class="k">Commands</div><div class="v activity-chip-line">${commandNames.map(command => `<span>${escapeHtml(command)}</span>`).join('')}</div>` : ''}
      </div>
    </div>
  `;
}

function renderActivityAgentPanel(e) {
  if (!isAgentActivityEvent(e)) return '';
  const runIds = activityAgentRunIds(e);
  const profiles = activityAgentProfileIds(e);
  const tags = activityDispatchTags(e);
  const skills = activitySkillNames(e);
  const bindings = activitySkillBindings(e);
  const diagnostics = activityDiagnosticItems(e);
  const profileText = profiles.join(', ') || '-';
  const tagsHtml = tags.length
    ? tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')
    : '<span>-</span>';
  const skillsHtml = skills.length
    ? skills.map(name => {
      const binding = bindings.find(item => item.name === name);
      const sources = Array.isArray(binding?.sources) ? binding.sources.filter(Boolean) : [];
      return `<span>${escapeHtml(name)}${sources.length ? `<em>${escapeHtml(sources.join('+'))}</em>` : ''}</span>`;
    }).join('')
    : '<span>-</span>';
  const diagnosticsHtml = diagnostics.length
    ? `<div class="activity-diagnostic-list">${diagnostics.map(item => {
      const sev = safeClassToken(item.severity || 'warn');
      const meta = [
        item.count !== undefined && item.limit !== undefined ? `${item.count}/${item.limit}` : '',
        Array.isArray(item.skills) && item.skills.length ? item.skills.join(', ') : '',
      ].filter(Boolean).join(' · ');
      return `<div class="activity-diagnostic-row ${sev}">
        <strong>${escapeHtml(item.code || 'diagnostic')}</strong>
        <span>${escapeHtml(item.message || meta || '-')}</span>
        ${meta && item.message ? `<em>${escapeHtml(meta)}</em>` : ''}
      </div>`;
    }).join('')}</div>`
    : '';
  return `
    <div class="activity-agent-panel">
      <div class="activity-agent-panel-head">
        <strong>Agent / Skill</strong>
        <span>${diagnostics.length ? `${diagnostics.length} diagnostics` : 'no diagnostics'}</span>
      </div>
      <div class="activity-agent-grid">
        <div class="k">Runs</div><div class="v">${renderActivityRunButtons(runIds) || '-'}</div>
        <div class="k">Profile</div><div class="v"><code>${escapeHtml(profileText)}</code></div>
        <div class="k">Tags</div><div class="v activity-chip-line">${tagsHtml}</div>
        <div class="k">Skills</div><div class="v activity-chip-line">${skillsHtml}</div>
      </div>
      ${diagnosticsHtml}
    </div>
  `;
}

function renderActivityArtifactPanel(e) {
  const artifacts = activityArtifacts(e);
  if (!artifacts.length) return '';
  const eventRunId = activityAgentRunIds(e)[0] || '';
  return `
    <div class="activity-agent-panel">
      <div class="activity-agent-panel-head">
        <strong>Archive Artifacts</strong>
        <span>${artifacts.length} recorded</span>
      </div>
      <div class="activity-artifact-list">
        ${artifacts.map((artifact) => {
          const runId = artifact.runId || eventRunId;
          const size = artifact.size ? governanceCenterBytes(artifact.size) : '-';
          const hash = artifact.sha256 ? String(artifact.sha256).slice(0, 12) : '-';
          return `<div class="activity-artifact-row">
            <div>
              <strong>${escapeHtml(artifact.kind || 'artifact')}</strong>
              <code>${escapeHtml(artifact.path || '-')}</code>
              <span>${escapeHtml(size)} · sha ${escapeHtml(hash)}${artifact.sessionId ? ` · session ${escapeHtml(artifact.sessionId)}` : ''}${artifact.gateId ? ` · gate ${escapeHtml(artifact.gateId)}` : ''}</span>
            </div>
            <div class="activity-artifact-actions">
              <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-activity-artifact-copy="${escapeHtml(artifact.path || '')}" type="button">Copy Path</button>
              ${artifact.downloadable && artifact.id && runId ? `<button class="cxbtn cxbtn-secondary cxbtn-sm" data-activity-artifact-download="${escapeHtml(artifact.id)}" data-activity-artifact-run="${escapeHtml(runId)}" type="button">Open Artifact</button>` : '<span>not downloadable</span>'}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

function renderActivityDetail(e) {
  const details = JSON.stringify(e.details || {}, null, 2);
  const runButtons = renderActivityRunButtons(activityAgentRunIds(e));
  return `
    <div class="activity-detail-grid">
      <div class="k">ID</div><div class="v">${escapeHtml(e.id)}</div>
      <div class="k">时间</div><div class="v">${activityTime(e.ts)}</div>
      <div class="k">Action</div><div class="v">${escapeHtml(activityTitle(e))}</div>
      <div class="k">严重度</div><div class="v"><span class="activity-severity ${safeClassToken(e.severity)}">${escapeHtml(e.severity || 'info')}</span></div>
      <div class="k">状态</div><div class="v">${escapeHtml(e.status || '-')}</div>
      <div class="k">Actor</div><div class="v">${escapeHtml(e.actorType || '-')} / ${escapeHtml(e.actorId || '-')}</div>
      <div class="k">Entity</div><div class="v">${escapeHtml(e.entityType || '-')} / ${escapeHtml(e.entityId || '-')}</div>
      <div class="k">Agent Run</div><div class="v">${runButtons || '-'}</div>
      <div class="k">Room</div><div class="v">${e.roomId ? `<code>${escapeHtml(e.roomId)}</code> <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-activity-open-room="${escapeHtml(e.roomId)}">打开房间</button>` : '-'}</div>
      <div class="k">Session</div><div class="v">${e.sessionId ? `<code>${escapeHtml(e.sessionId)}</code>` : '-'}</div>
      <div class="k">Task</div><div class="v">${e.taskId ? `<code>${escapeHtml(e.taskId)}</code>` : '-'}</div>
    </div>
    ${renderActivityApprovalResumeGatePanel(e)}
    ${renderActivityAgentPanel(e)}
    ${renderActivityArtifactPanel(e)}
    <pre class="activity-json"><code>${escapeHtml(details)}</code></pre>
  `;
}

$('#btnActivity')?.addEventListener('click', () => openActivityModal());
document.querySelectorAll('[data-close-activity]').forEach(el => el.addEventListener('click', closeActivityModal));

// ========== 委派中心 ==========
const delegationState = {
  list: [],
  activeId: null,
  status: '',
  sourceRoomId: '',
};

function delegationTime(ts) {
  return activityTime(ts);
}

async function openDelegationModal(seed = {}) {
  $('#delegationModal').style.display = 'flex';
  if (seed.sourceRoomId) delegationState.sourceRoomId = seed.sourceRoomId;
  await refreshDelegations();
}
function closeDelegationModal() { $('#delegationModal').style.display = 'none'; }

function delegationParams() {
  const params = new URLSearchParams();
  if (delegationState.status) params.set('status', delegationState.status);
  if (delegationState.sourceRoomId) params.set('sourceRoomId', delegationState.sourceRoomId);
  params.set('limit', '200');
  return params.toString();
}

async function refreshDelegations() {
  const root = $('#delegationModalBody');
  if (!root) return;
  root.innerHTML = '<div class="muted small" style="padding:20px;">加载中…</div>';
  try {
    const qs = delegationParams();
    const r = await api('/api/delegations' + (qs ? '?' + qs : ''));
    delegationState.list = r.delegations || [];
    if (!delegationState.activeId || !delegationState.list.some(d => d.id === delegationState.activeId)) {
      delegationState.activeId = delegationState.list[0]?.id || null;
    }
    renderDelegationModal();
  } catch (e) {
    root.innerHTML = `<div class="muted small" style="padding:20px;color:var(--color-danger-alt);">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderDelegationModal() {
  const root = $('#delegationModalBody');
  if (!root) return;
  const list = delegationState.list || [];
  const active = list.find(d => d.id === delegationState.activeId) || null;
  const queuedCount = list.filter(d => d.status === 'queued').length;
  const createdCount = list.filter(d => d.status === 'created').length;
  const failedCount = list.filter(d => d.status === 'failed').length;
  const currentRoomBtn = roomState.activeId
    ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" id="delegationUseCurrentRoom">当前房间</button>`
    : '';
  root.innerHTML = `
    <div class="delegation-toolbar">
      <select id="delegationStatusFilter">
        <option value="" ${delegationState.status === '' ? 'selected' : ''}>全部状态</option>
        <option value="queued" ${delegationState.status === 'queued' ? 'selected' : ''}>queued</option>
        <option value="created" ${delegationState.status === 'created' ? 'selected' : ''}>created</option>
        <option value="failed" ${delegationState.status === 'failed' ? 'selected' : ''}>failed</option>
        <option value="cancelled" ${delegationState.status === 'cancelled' ? 'selected' : ''}>cancelled</option>
      </select>
      <input id="delegationSourceRoom" type="text" placeholder="sourceRoomId" value="${escapeHtml(delegationState.sourceRoomId)}" />
      ${currentRoomBtn}
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="delegationClearFilters">清空</button>
      <button class="cxbtn cxbtn-primary cxbtn-sm" id="delegationRefresh">刷新</button>
    </div>
    <div class="delegation-stats">
      <span><strong>${list.length}</strong> delegations</span>
      <span><strong>${queuedCount}</strong> queued</span>
      <span><strong>${createdCount}</strong> created</span>
      <span class="${failedCount ? 'is-warn' : ''}"><strong>${failedCount}</strong> failed</span>
    </div>
    <div class="delegation-layout">
      <section class="delegation-list">
        ${list.length ? list.map(renderDelegationItem).join('') : '<div class="delegation-empty">当前筛选条件下没有委派记录。</div>'}
      </section>
      <section class="delegation-detail">
        ${active ? renderDelegationDetail(active) : '<div class="delegation-empty">选择左侧委派查看详情。</div>'}
      </section>
    </div>
  `;
  $('#delegationStatusFilter')?.addEventListener('change', (e) => {
    delegationState.status = e.target.value;
    delegationState.activeId = null;
    refreshDelegations();
  });
  $('#delegationSourceRoom')?.addEventListener('change', (e) => {
    delegationState.sourceRoomId = e.target.value.trim();
    delegationState.activeId = null;
    refreshDelegations();
  });
  $('#delegationUseCurrentRoom')?.addEventListener('click', () => {
    delegationState.sourceRoomId = roomState.activeId || '';
    delegationState.activeId = null;
    refreshDelegations();
  });
  $('#delegationClearFilters')?.addEventListener('click', () => {
    delegationState.status = '';
    delegationState.sourceRoomId = '';
    delegationState.activeId = null;
    refreshDelegations();
  });
  $('#delegationRefresh')?.addEventListener('click', refreshDelegations);
  root.querySelectorAll('[data-delegation-id]').forEach(el => {
    el.addEventListener('click', () => {
      delegationState.activeId = el.dataset.delegationId;
      renderDelegationModal();
    });
  });
  root.querySelectorAll('[data-delegation-execute]').forEach(btn => {
    btn.addEventListener('click', () => executeDelegation(btn.dataset.delegationExecute));
  });
  root.querySelectorAll('[data-delegation-cancel]').forEach(btn => {
    btn.addEventListener('click', () => cancelDelegation(btn.dataset.delegationCancel));
  });
  root.querySelectorAll('[data-delegation-autostart]').forEach(btn => {
    btn.addEventListener('click', () => queueDelegationAutostart(btn.dataset.delegationAutostart));
  });
  root.querySelectorAll('[data-delegation-open-room]').forEach(btn => {
    btn.addEventListener('click', () => openDelegationRoom(btn.dataset.delegationOpenRoom));
  });
}

function renderDelegationItem(d) {
  return `<button class="delegation-item ${d.id === delegationState.activeId ? 'is-active' : ''} status-${safeClassToken(d.status)}" data-delegation-id="${escapeHtml(d.id)}">
    <span class="delegation-item-head">
      <strong>${escapeHtml(d.title)}</strong>
      <span>${delegationTime(d.updatedAt || d.createdAt)}</span>
    </span>
    <span class="delegation-item-meta">source:${escapeHtml(shortLineageValue(d.sourceRoomId))}${d.sourceTaskId ? ' · task:' + escapeHtml(d.sourceTaskId) : ''}</span>
    <span class="delegation-item-foot">
      <span class="delegation-status ${safeClassToken(d.status)}">${escapeHtml(d.status)}</span>
      <span>${escapeHtml(d.targetMode)}</span>
    </span>
  </button>`;
}

function renderDelegationDetail(d) {
  return `
    <div class="delegation-detail-grid">
      <div class="k">ID</div><div class="v">${escapeHtml(d.id)}</div>
      <div class="k">状态</div><div class="v"><span class="delegation-status ${safeClassToken(d.status)}">${escapeHtml(d.status)}</span></div>
      <div class="k">标题</div><div class="v">${escapeHtml(d.title)}</div>
      <div class="k">模式</div><div class="v">${escapeHtml(d.targetMode)}</div>
      <div class="k">源房间</div><div class="v"><code>${escapeHtml(d.sourceRoomId)}</code> <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-delegation-open-room="${escapeHtml(d.sourceRoomId)}">打开源房</button></div>
      <div class="k">源任务</div><div class="v">${d.sourceTaskId ? `<code>${escapeHtml(d.sourceTaskId)}</code>` : '-'}</div>
      <div class="k">目标房间</div><div class="v">${d.targetRoomId ? `<code>${escapeHtml(d.targetRoomId)}</code> <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-delegation-open-room="${escapeHtml(d.targetRoomId)}">打开目标房</button>` : '-'}</div>
      <div class="k">创建时间</div><div class="v">${delegationTime(d.createdAt)}</div>
      <div class="k">执行时间</div><div class="v">${d.executedAt ? delegationTime(d.executedAt) : '-'}</div>
      ${d.error ? `<div class="k">错误</div><div class="v">${escapeHtml(d.error)}</div>` : ''}
    </div>
    <div class="delegation-instructions">${escapeHtml(d.instructions)}</div>
    <div class="delegation-actions">
      ${d.status === 'queued' || d.status === 'failed' ? `<button class="cxbtn cxbtn-primary" data-delegation-autostart="${escapeHtml(d.id)}">审批后自启动</button>` : ''}
      ${d.status === 'queued' || d.status === 'failed' ? `<button class="cxbtn cxbtn-primary" data-delegation-execute="${escapeHtml(d.id)}">执行委派</button>` : ''}
      ${d.status === 'queued' || d.status === 'failed' ? `<button class="cxbtn cxbtn-secondary" data-delegation-cancel="${escapeHtml(d.id)}">取消委派</button>` : ''}
    </div>
  `;
}

async function queueDelegationAutostart(id) {
  if (!id) return;
  try {
    const r = await api(`/api/delegations/${encodeURIComponent(id)}/autostart`, {
      method: 'POST',
      body: JSON.stringify({
        requireApproval: true,
        autoStart: true,
        budgetEstimate: { estimateCalls: 1 },
      }),
    });
    const approvalHint = r.approval?.id ? `，审批 ${r.approval.id}` : '';
    toast(`已加入 Autopilot 自启动队列${approvalHint}`, 'success', 2500);
    await refreshDelegations();
    if (r.approval?.status === 'pending') {
      closeDelegationModal();
      openApprovalModal({ status: 'pending' });
    }
  } catch (e) {
    toast('加入自启动队列失败：' + e.message, 'error', 6000);
    refreshDelegations();
  }
}

async function executeDelegation(id) {
  if (!id) return;
  try {
    const r = await api(`/api/delegations/${encodeURIComponent(id)}/execute`, { method: 'POST' });
    delegationState.activeId = r.delegation?.id || id;
    toast('委派已执行', 'success', 1500);
    await refreshDelegations();
    await loadRooms();
  } catch (e) {
    toast('执行委派失败：' + e.message, 'error', 6000);
    refreshDelegations();
  }
}

async function cancelDelegation(id) {
  if (!id) return;
  const reason = await promptModal({
    title: '取消委派',
    message: '填写取消原因，留空也可以。',
    value: '',
    placeholder: '取消原因',
  });
  if (reason === null) return;
  try {
    const r = await api(`/api/delegations/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    delegationState.activeId = r.delegation?.id || id;
    toast('委派已取消', 'success', 1500);
    refreshDelegations();
  } catch (e) {
    toast('取消委派失败：' + e.message, 'error');
  }
}

async function openDelegationRoom(id) {
  if (!id) return;
  closeDelegationModal();
  showRoomArea();
  await loadRooms();
  selectRoom(id);
}

$('#btnDelegations')?.addEventListener('click', () => openDelegationModal());
document.querySelectorAll('[data-close-delegation]').forEach(el => el.addEventListener('click', closeDelegationModal));

$('#btnMcpNew')?.addEventListener('click', () => {
  mcpState.isNew = true;
  mcpState.activeName = null;
  renderMcpList();
  renderMcpDetail({ name: '', type: 'stdio', command: '', args: [], env: {}, enabled: true });
});
// S18-3：data-close-mcp 全局绑定由 Modal event delegation 接管

// ========== v0.54 Sprint 9 — 📝 生成总结报告 ==========
// activeJob 让 ws.onmessage 按 jobId 分发回调，WS 重连后旧 listener 失效的问题靠这个绕开
const reportState = { lastResult: null, activeJob: null };

function openReportModal() {
  if (!roomState.activeId) { toast('先选一个房间', 'warn'); return; }
  $('#reportModal').style.display = 'flex';
  renderReportForm();
}
function closeReportModal() {
  $('#reportModal').style.display = 'none';
  reportState.lastResult = null;
  // 关 modal 视为放弃当前生成任务：清掉 activeJob + 超时定时器，避免事件到达时往隐藏 modal 里写
  if (reportState.activeJob?.timer) { clearTimeout(reportState.activeJob.timer); }
  if (reportState.activeJob?.pollTimer) { clearTimeout(reportState.activeJob.pollTimer); }
  reportState.activeJob = null;
}

function getAvailableAdapters() {
  // 从 roomState 当前房的 members 拿默认 adapter，加上常见 fallback
  const members = (roomState.rooms || []).find(r => r.id === roomState.activeId)?.members || [];
  const ids = new Set(members.map(m => m.adapterId));
  // 加常见 fallback（即使本房没用过这个 adapter，也可能用来跑报告）
  ['claude', 'codex', 'gemini-cli', 'minimax'].forEach(id => ids.add(id));
  return Array.from(ids);
}

// 各 adapter 的可选 model 列表 + 默认推荐（数组首项为预选）
// 第一项 = 该 adapter 当家最强模型（生成报告时优先用），其后按降级排
const REPORT_MODEL_OPTIONS = {
  claude: [
    { value: 'claude-opus-4-7', label: 'claude-opus-4-7（最强 · 推荐）' },
    { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6（平衡 · CLI 默认）' },
    { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5（快·便宜）' },
    { value: '', label: '（留空 / 让 CLI 自己选）' },
  ],
  codex: [
    { value: 'gpt-5.5', label: 'gpt-5.5（最强 · CLI 默认）' },
    { value: '', label: '（留空 / 让 CLI 自己选）' },
  ],
  'gemini-cli': [
    { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro（最强 · 推荐）' },
    { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash（快 · CLI 默认）' },
    { value: '', label: '（留空 / 让 CLI 自己选）' },
  ],
};
// __custom__ 哨兵 → 切换到手填文本框，覆盖 select 的预定义项
const REPORT_MODEL_CUSTOM = '__custom__';

function getReportModelOptions(adapterId) {
  return REPORT_MODEL_OPTIONS[adapterId] || null;
}

/** 根据当前 adapter 渲染 model 选择区（已知 adapter → select；未知 → input） */
function renderReportModelArea() {
  const area = document.getElementById('rpModelArea');
  if (!area) return;
  const adapter = document.getElementById('rpAdapter')?.value || '';
  const opts = getReportModelOptions(adapter);

  if (!opts) {
    // 未知 adapter（如用户自定义的 OpenAI 兼容条目）→ 纯文本输入兜底
    area.innerHTML = `
      <input id="rpModelCustom" maxlength="100" placeholder="如 deepseek-v3 / 留空走默认" />
      <input type="hidden" id="rpModelSelect" value="${REPORT_MODEL_CUSTOM}" />
      <div class="help">该 adapter 无预设 model 列表，可手填具体型号或留空。</div>
    `;
    return;
  }
  const selectHtml = opts.map((o, i) => `<option value="${escapeHtml(o.value)}" ${i === 0 ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  area.innerHTML = `
    <select id="rpModelSelect">
      ${selectHtml}
      <option value="${REPORT_MODEL_CUSTOM}">自定义（手填型号名）...</option>
    </select>
    <input id="rpModelCustom" maxlength="100" placeholder="自定义型号名" style="display:none;margin-top:6px;" />
    <div class="help">报告浓缩任务推荐用最强模型；快/便宜模型可能漏掉细节。</div>
  `;
  const sel = document.getElementById('rpModelSelect');
  const cus = document.getElementById('rpModelCustom');
  sel?.addEventListener('change', () => {
    if (sel.value === REPORT_MODEL_CUSTOM) {
      cus.style.display = '';
      cus.focus();
    } else {
      cus.style.display = 'none';
      cus.value = '';
    }
  });
}

/** runReport 取最终 model：自定义 → 文本框值；预设 → select 值 */
function getReportModelValue() {
  const sel = document.getElementById('rpModelSelect');
  const cus = document.getElementById('rpModelCustom');
  if (!sel) return (cus?.value || '').trim();
  if (sel.value === REPORT_MODEL_CUSTOM) return (cus?.value || '').trim();
  return (sel.value || '').trim();
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
      <label>具体型号</label>
      <div id="rpModelArea"></div>
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
  // adapter 切换时重渲染 model 区域；初次进入也渲一次
  $('#rpAdapter')?.addEventListener('change', renderReportModelArea);
  renderReportModelArea();
}

async function runReport() {
  const adapterId = $('#rpAdapter').value;
  const model = getReportModelValue();
  const outputPath = ($('#rpOutputPath').value || '').trim();
  const autoPath = $('#rpAutoPath').checked;

  // 渲染 progress
  const root = $('#reportModalBody');
  root.innerHTML = `
    <div class="report-progress" data-started-at="${Date.now()}">
      <span class="spinner"></span>
      正在让 ${escapeHtml(adapterId)} 总结全房聊天 — 长聊天可能 30s~5min，结果通过 WS 推送回来…
      <div style="margin-top:6px;"><span data-elapsed="1" data-label="生成中">⏳ 生成中… 00:00</span></div>
      <div class="muted small" id="rpJobMeta" style="margin-top:10px;font-family:ui-monospace,monospace;font-size:11px;"></div>
    </div>
  `;
  startElapsedTicker();

  // v0.55 Sprint 14 F1：改异步 job 模式（修 Safari fetch 60s timeout 报 "Load failed"）
  // 1) POST 立即返 jobId
  // 2) 注册到 reportState.activeJob，ws.onmessage 按 jobId 分发（WS 重连免疫）
  let jobId = null;
  let resolved = false;
  let pollTimer = null;

  function cleanup() {
    if (reportState.activeJob?.timer) { clearTimeout(reportState.activeJob.timer); }
    if (reportState.activeJob?.pollTimer) { clearTimeout(reportState.activeJob.pollTimer); }
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    reportState.activeJob = null;
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

  function reportDataFromJob(job) {
    return {
      content: job.content, path: job.path,
      tokensIn: job.tokensIn, tokensOut: job.tokensOut,
      elapsedMs: job.elapsedMs, truncated: job.truncated,
    };
  }

  function updateJobMeta(text) {
    const meta = $('#rpJobMeta');
    if (meta) meta.textContent = text;
  }

  function scheduleReportPoll(delay = 2000) {
    if (resolved || !jobId) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (resolved || !jobId) return;
      try {
        const resp = await fetch(`/api/reports/${encodeURIComponent(jobId)}`);
        const r = await resp.json().catch(() => ({}));
        if (!resp.ok || !r.ok) {
          if (resp.status === 404) fail('报告任务状态不存在，可能 panel 已重启或任务缓存过期');
          else scheduleReportPoll(5000);
          return;
        }
        const job = r.job || {};
        if (job.status === 'done') {
          succeed(reportDataFromJob(job));
          return;
        }
        if (job.status === 'error') {
          fail(job.error || 'unknown');
          return;
        }
        updateJobMeta(`jobId: ${jobId}（${job.status || 'queued'}，WS + 轮询双通道等待 AI 返回）`);
        scheduleReportPoll(2500);
      } catch {
        scheduleReportPoll(5000);
      }
    }, delay);
    if (reportState.activeJob) reportState.activeJob.pollTimer = pollTimer;
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
    updateJobMeta(`jobId: ${jobId}（已排队，WS + 轮询双通道等待 AI 返回）`);
  } catch (e) {
    fail('提交任务异常：' + e.message);
    return;
  }

  // 注册 jobId 回调到 reportState.activeJob，ws.onmessage 按 jobId 路由
  reportState.activeJob = {
    jobId,
    onDone: (msg) => {
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
    },
    onError: (msg) => { fail(msg.error || 'unknown'); },
    timer: setTimeout(() => fail('超时 10 分钟未收到 AI 响应；可能 adapter 配置错或 LLM 卡了'), 10 * 60 * 1000),
    pollTimer: null,
  };
  scheduleReportPoll(500);
}

function renderReportPreview(r) {
  const root = $('#reportModalBody');
  const tokens = `${r.tokensIn || 0} in / ${r.tokensOut || 0} out`;
  const elapsed = (r.elapsedMs / 1000).toFixed(1) + 's';
  const pathLine = r.path
    ? `<div>📂 已保存到：<code>${escapeHtml(r.path)}</code></div>`
    : `<div class="muted">未保存到磁盘（仅在此处预览，可点下方"💾 下载"保存）</div>`;
  const truncated = r.truncated ? '<div style="color:#c15f3c;">⚠️ 原内容超过 1.5M 字符上限，末尾已截断（后续 turn 未喂给 AI）</div>' : '';
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
    // 外部 JS 改 value 后请 dispatchEvent('input')，不再轮询 — 见 renderRoomDetail
  });
})();

// B-004 v0.9: 选中文字浮层（学 Cherry Studio 划词助手）
(function initSelectionPopover() {
  if (typeof window === 'undefined') return;
  let popover = null;
  const MIN_LEN = 5;     // 最少选 5 字符
  const MAX_LEN = 4000;  // 超长不弹（防误触）

  function hide() {
    if (popover) { try { popover.remove(); } catch {} popover = null; }
  }

  function show(text, rect) {
    hide();
    popover = document.createElement('div');
    popover.className = 'selection-popover';
    popover.innerHTML = `
      <button data-act="explain" title="把选中文字作为 prompt 加到对话框 + 加'解释一下'前缀">🔍 解释</button>
      <button data-act="translate" title="翻译这段">🌐 翻译</button>
      <button data-act="rewrite" title="改写优化">✍️ 改写</button>
      <button data-act="to-input" title="加到当前输入框">📥 加到输入</button>
    `;
    // 定位在选中区右上方
    const top = Math.max(8, rect.top - 44);
    const left = Math.min(window.innerWidth - 280, Math.max(8, rect.right - 280));
    popover.style.top = top + 'px';
    popover.style.left = left + 'px';
    document.body.appendChild(popover);

    popover.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());  // 防失焦
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        applyAction(btn.dataset.act, text);
        hide();
      });
    });
  }

  function applyAction(act, text) {
    const prefixes = {
      explain: '请详细解释下面这段文字：\n\n',
      translate: '请把下面这段翻译成中文（如果已是中文则翻译成英文）：\n\n',
      rewrite: '请帮我改写下面这段，更通顺/精炼：\n\n',
      'to-input': '',
    };
    const prefix = prefixes[act] || '';
    const payload = prefix + text;
    // 优先找：聊天室 chat → chat input → topic
    const targets = ['#chatRoomInput', '#chatInput', '#roomTopicInput'];
    for (const sel of targets) {
      const ta = document.querySelector(sel);
      if (ta && ta.offsetParent !== null) {
        ta.value = (ta.value ? ta.value + '\n\n' : '') + payload;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
        if (typeof toast === 'function') toast(`✓ 已加到 ${sel.slice(1)}（${text.length} 字）`, 'success', 2000);
        return;
      }
    }
    if (typeof toast === 'function') toast('没找到可见输入框，请先打开一个房间', 'warn', 3000);
  }

  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
      hide();
      return;
    }
    const text = sel.toString().trim();
    if (text.length < MIN_LEN || text.length > MAX_LEN) {
      hide();
      return;
    }
    // 不在 input/textarea/cmdk modal 内的选区才弹（防嵌套）
    const anchor = sel.anchorNode?.parentElement;
    if (!anchor) return;
    if (anchor.closest('input, textarea, .cmdk-modal, .confirm-modal, .selection-popover')) {
      hide();
      return;
    }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    show(text, rect);
  });

  document.addEventListener('mousedown', (e) => {
    if (popover && !popover.contains(e.target)) hide();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
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
    const icon = btn.querySelector('.nav-icon');
    if (icon) icon.textContent = hidden ? '⇤' : '⇥';
    else btn.textContent = hidden ? '⇤' : '⇥';
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
