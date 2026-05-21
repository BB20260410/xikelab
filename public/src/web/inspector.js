// public/src/web/inspector.js — v0.80 真做拆模块第 2 个：inspector 控件
// 含 resize（左侧 5px 拖动）+ toggle（折叠/展开右栏）
// app.js 仍有占位调用，main.js 桥接 window.PanelInspector

/**
 * 初始化 inspector 拖动 resize 控件
 * 持久化宽度到 localStorage 'panel:inspectorW'
 */
export function initInspectorResize() {
  const resizer = document.querySelector('#inspectorResizer');
  if (!resizer) return null;
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
  resizer.addEventListener('dblclick', () => {
    document.documentElement.style.setProperty('--inspector-w', DEFAULT + 'px');
    localStorage.setItem(KEY, String(DEFAULT));
  });
  return { MIN, MAX, DEFAULT };
}

/**
 * 初始化 inspector 折叠 toggle 按钮
 */
export function initInspectorToggle() {
  const btn = document.querySelector('#btnInspectorToggle');
  if (!btn) return null;
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
  return { apply };
}

/**
 * 初始化 debate-state tab 的 clear 按钮（v0.70.2 W5+W6 配套）
 */
export function initDebateStateClear() {
  const btn = document.querySelector('#btnDebateStateClear');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const log = document.querySelector('#debateStateLog');
    if (log) log.innerHTML = '<div class="muted small">— 等待 debate_state_meta WS 事件 —</div>';
  });
}

/**
 * 一次性初始化所有 inspector 控件
 */
export function initInspector() {
  initInspectorResize();
  initInspectorToggle();
  initDebateStateClear();
}
