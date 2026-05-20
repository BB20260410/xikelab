// Claude Panel — ES module 主入口 (S18-1 已激活)
// 已通过 index.html `<script type="module" src="/main.js">` 加载（defer，在 app.js 之后跑）
// 桥接策略：挂 window.PanelUtils 让 app.js（IIFE）有渐进迁移路径
// 下个 sprint：把 app.js 顶层符号（state/$/$$/etc）逐步迁入 src/web/ module，app.js 改用 window.PanelUtils.*

import { escapeHtml, escapeHtmlMl, safeSlice, shortenPath, formatSize, formatElapsed } from './src/web/utils.js';
// S18-5 激活：统一 store
import * as Store from './src/web/state.js';

// 下个 sprint 继续加：
// import { initWebSocket } from './src/web/ws.js';
// import { initRoomsView } from './src/web/rooms.js';
// import { initPluginView } from './src/web/plugin.js';
// import { initInspector } from './src/web/inspector.js';
// import { initCmdK } from './src/web/cmdk.js';

// === 桥接：让 app.js（IIFE）能用 module 内导出的 helper / store ===
// 注：app.js 顶层 escapeHtml/state 仍然定义，桥接是逐步迁移期的临时方案
if (typeof window !== 'undefined') {
  window.PanelUtils = { escapeHtml, escapeHtmlMl, safeSlice, shortenPath, formatSize, formatElapsed };
  // S18-5：PanelStore.get/set/subscribe/persist/restore；app.js 顶层 const state 暂未迁移
  window.PanelStore = Store;
  // 启动时从 localStorage 恢复
  try { Store.restore(); } catch (e) { console.warn('[main.js] Store.restore', e); }
}

console.log('[main.js] S18-1/S18-5 loaded; window.PanelUtils + window.PanelStore ready');
