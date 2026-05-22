// public/src/web/ws-helpers.js — v0.80 真做拆模块第 3 个：WebSocket 通用 helpers
// 含：URL 构造 + 指数退避重连计算 + 通用 message dispatcher

/**
 * 构造 WS URL（自动 ws/wss + host）
 * @param {string} path  '/ws/global' 等
 */
export function buildWsUrl(path = '/ws/global') {
  if (typeof location === 'undefined') throw new Error('buildWsUrl needs location');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

/**
 * 指数退避重连延迟（800ms 起，2 倍递增，最大 8s，最多 8 次）
 * @param {number} attemptCount  从 1 开始
 * @returns {number|null}  ms / null 表示放弃
 */
export function backoffDelay(attemptCount, { max = 8, baseMs = 800, capMs = 8000 } = {}) {
  if (attemptCount > max) return null;
  return Math.min(capMs, baseMs * Math.pow(2, attemptCount - 1));
}

/**
 * 通用 WS message dispatcher 工厂
 * 用法：
 *   const dispatch = createWsDispatcher({
 *     metrics_update: (msg) => refreshOverview(),
 *     health_warning: (msg) => toast(...)
 *   });
 *   ws.onmessage = (e) => dispatch(e.data);
 * @param {Object<string, function>} handlers  type → handler
 * @returns {function(rawData: string): void}
 */
export function createWsDispatcher(handlers = {}) {
  return function dispatch(rawData) {
    try {
      const msg = JSON.parse(rawData);
      const h = handlers[msg.type];
      if (h) h(msg);
    } catch {
      // 静默吞，WS 消息格式错不应崩 panel
    }
  };
}

/**
 * 带自动重连的 WS 连接封装
 * @param {Object} opts
 * @param {string} opts.url
 * @param {Object<string, function>} opts.handlers   message type → handler
 * @param {function} [opts.onOpen]
 * @param {function} [opts.onClose]
 * @returns {{ ws: WebSocket|null, close: function, reconnectAttempts: number }}
 */
export function createReconnectingWs({ url, handlers, onOpen, onClose, maxAttempts = 8 }) {
  const state = { ws: null, reconnectAttempts: 0, reconnectTimer: null, closed: false };
  const dispatch = createWsDispatcher(handlers);

  function connect() {
    if (state.closed) return;
    if (state.ws && state.ws.readyState <= 1) return state.ws;
    try {
      const ws = new WebSocket(url);
      state.ws = ws;
      ws.onopen = () => {
        state.reconnectAttempts = 0;
        if (onOpen) try { onOpen(ws); } catch {}
      };
      ws.onmessage = (e) => dispatch(e.data);
      ws.onclose = () => {
        state.ws = null;
        if (state.closed) return;
        state.reconnectAttempts++;
        const delay = backoffDelay(state.reconnectAttempts, { max: maxAttempts });
        if (delay === null) {
          if (onClose) try { onClose('max-attempts-reached'); } catch {}
          return;
        }
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => {};
    } catch (e) {
      console.warn('[ws] connect failed:', url, e.message);
    }
    return state.ws;
  }

  return {
    connect,
    close() {
      state.closed = true;
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      if (state.ws) try { state.ws.close(); } catch {}
    },
    get ws() { return state.ws; },
    get reconnectAttempts() { return state.reconnectAttempts; },
  };
}
