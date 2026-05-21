// Xike Lab — 统一 state store ES module (S18-5 starter)
// 当前**未被任何代码使用**（app.js 仍用顶层 const state/roomState/pluginState 各自分散）
// 下次对话用户授权激活后：把 app.js 内散落的 state 对象合并到这里
//
// 设计：单一 root store + 命名空间分组 + persistent layer + subscribe pattern

const STORAGE_KEY = 'cp-panel-store-v1';

// 默认 state 结构（合并 app.js 各处 const state / roomState / pluginState 等）
const defaultStore = {
  // app.js 顶层 const state 的字段
  sessions: [],
  archivedSessions: [],
  activeId: null,
  ws: null,
  activeBusy: false,
  activeCwd: null,
  filePath: null,
  snapshotTimer: null,
  archivedExpanded: false,
  collapsedGroups: new Set(),
  streamingDivs: new Map(),
  stderrCurrentDiv: null,

  // S18-5 完成时合并：room / plugin / webhook / archive / mcp / autopilot / etc.
  // room: {},
  // plugin: {},
  // webhook: { items: [], activeId: null, isNew: false },
  // ...
};

// === subscribe pattern ===
const subscribers = new Set();

function notify(path, oldValue, newValue) {
  for (const cb of subscribers) {
    try { cb({ path, oldValue, newValue }); } catch (e) { console.warn('[state subscriber]', e); }
  }
}

// === public API ===
let _store = { ...defaultStore };

export function get(path) {
  if (!path) return _store;
  const parts = path.split('.');
  let cur = _store;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function set(path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  let cur = _store;
  for (const p of parts) {
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  const old = cur[last];
  cur[last] = value;
  notify(path, old, value);
}

export function subscribe(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function persist() {
  try {
    // Set / Map 不能直接 JSON 化，跳过
    const safe = JSON.parse(JSON.stringify(_store, (k, v) =>
      v instanceof Set ? [...v] : v instanceof Map ? Object.fromEntries(v) : v
    ));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch (e) { console.warn('[state.persist]', e); }
}

export function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    // 仅 merge 简单字段；Set/Map 需手动 reify
    Object.assign(_store, obj);
    if (Array.isArray(obj.collapsedGroups)) _store.collapsedGroups = new Set(obj.collapsedGroups);
  } catch (e) { console.warn('[state.restore]', e); }
}

// 调试出口
export function _debug() { return _store; }

// v0.84 starter: 5 个散落 state 的 schema 定义（未实际迁移）
/**
 * @typedef {Object} PanelStoreSchema
 * @property {Array} sessions               app.js:13 const state.sessions
 * @property {Array} archivedSessions       app.js:13 const state.archivedSessions
 * @property {string|null} activeId         app.js:13
 * @property {Object} roomState             app.js:2351 整个 roomState 命名空间
 * @property {Object} pluginState           app.js:3882 { list, activeId }
 * @property {Object} archiveState          app.js:5480 { config, list }
 * @property {Object} autopilotState        app.js:5908 { config, logs }
 */
