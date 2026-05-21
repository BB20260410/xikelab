// Claude Panel — ES module 主入口 (S18-1 已激活)
// 已通过 index.html `<script type="module" src="/main.js">` 加载（defer，在 app.js 之后跑）
// 桥接策略：挂 window.PanelUtils 让 app.js（IIFE）有渐进迁移路径
// 下个 sprint：把 app.js 顶层符号（state/$/$$/etc）逐步迁入 src/web/ module，app.js 改用 window.PanelUtils.*

import { escapeHtml, escapeHtmlMl, safeSlice, shortenPath, formatSize, formatElapsed } from './src/web/utils.js';
// S18-5 激活：统一 store
import * as Store from './src/web/state.js';
// S29 starter：dialog 模块
import { confirmModal as _confirmModal, promptModal as _promptModal } from './src/web/dialog.js';
// v0.80 真做：cmdk commands 静态声明拆分
import { matchCommands as _matchCmdk, resolveAction as _resolveCmdkAction, BUILTIN_COMMANDS as _CMDK_BUILTIN } from './src/web/cmdk-commands.js';
// v0.80 真做：inspector 控件拆分
import { initInspectorResize as _initInspResize, initInspectorToggle as _initInspToggle, initDebateStateClear as _initDebateClear } from './src/web/inspector.js';
// v0.80 真做：WS helpers
import { buildWsUrl as _buildWsUrl, backoffDelay as _backoffDelay, createWsDispatcher as _createWsDisp, createReconnectingWs as _createReconnWs } from './src/web/ws-helpers.js';
// v1.0 Task 1.4: i18n
import { initI18n as _initI18n, t as _t, loadLocale as _loadLocale, getLocale as _getLocale, subscribe as _subI18n } from './src/web/i18n.js';

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
  // S29 starter：PanelDialog 桥接（让 app.js 内 wrapper delegate 过来）
  window.PanelDialog = { confirmModal: _confirmModal, promptModal: _promptModal };
  // S18-5：PanelStore.get/set/subscribe/persist/restore；app.js 顶层 const state 暂未迁移
  window.PanelStore = Store;
  // v0.80 真做：window.PanelCmdk 暴露
  window.PanelCmdk = { matchCommands: _matchCmdk, resolveAction: _resolveCmdkAction, BUILTIN_COMMANDS: _CMDK_BUILTIN };
  // v0.80 真做：inspector 控件 - 但 app.js 已有 IIFE 调过，这里只暴露给外部脚本调
  window.PanelInspector = { initInspectorResize: _initInspResize, initInspectorToggle: _initInspToggle, initDebateStateClear: _initDebateClear };
  // v0.80 真做：WS helpers
  window.PanelWs = { buildWsUrl: _buildWsUrl, backoffDelay: _backoffDelay, createWsDispatcher: _createWsDisp, createReconnectingWs: _createReconnWs };
  // v1.0 Task 1.4: i18n
  window.PanelI18n = { init: _initI18n, t: _t, loadLocale: _loadLocale, getLocale: _getLocale, subscribe: _subI18n };
  // 启动自动加载 locale
  _initI18n().catch(() => {});
  // 启动时从 localStorage 恢复
  try { Store.restore(); } catch (e) { console.warn('[main.js] Store.restore', e); }
}

console.log('[main.js] S18-1/S18-5/v0.80 loaded; window.PanelUtils + PanelStore + PanelCmdk ready');
