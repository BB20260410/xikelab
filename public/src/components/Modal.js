// Claude Panel — Modal 组件（S18-3）
// 统一处理 open/close API + onOpen/onClose hook + event delegation + focus trap
// 不重做：portal（app.js 顶部 IIFE 已自动）、ESC 关（closeTopOverlay 全局已有）、
//        modal-bg 双击关（app.js 全局 mousedown+mouseup 已有，但要让它感知 Modal）
// 当前 app.js 非 module，本文件用 IIFE 暴露 window.Modal。S18-1 改 module 时再升级
(function () {
  if (window.Modal) return;

  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const registry = new Map();
  const openStack = [];
  let lastFocused = null;

  function getEl(id) {
    const el = document.getElementById(id);
    if (!el) console.warn('[Modal] #' + id + ' not found in DOM');
    return el;
  }

  function visibleFocusables(modal) {
    return Array.from(modal.querySelectorAll(FOCUSABLE)).filter(function (el) {
      if (el.hasAttribute('disabled')) return false;
      // offsetParent null 通常代表 display:none；modal 本身 display:flex 可见
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
      return true;
    });
  }

  function trapKey(modal, e, id) {
    if (e.key !== 'Tab') return;
    // 嵌套 modal 安全：只让最上层 modal 的 trap 生效，否则底下 modal 的 handler 会抢 focus
    if (openStack[openStack.length - 1] !== id) return;
    const list = visibleFocusables(modal);
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !modal.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function defaultCloseSelector(id) {
    // webhookModal -> [data-close-webhook]；archiveModal -> [data-close-archive]
    const base = id.replace(/Modal$/, '').toLowerCase();
    return '[data-close-' + base + ']';
  }

  function register(id, opts) {
    opts = opts || {};
    if (registry.has(id)) {
      // 允许覆盖 onOpen/onClose（用于 hot-swap），但不重绑事件
      const existing = registry.get(id);
      if (opts.onOpen) existing.onOpen = opts.onOpen;
      if (opts.onClose) existing.onClose = opts.onClose;
      return;
    }
    const modal = getEl(id);
    if (!modal) return;

    const cfg = {
      id: id,
      modal: modal,
      closeSelector: opts.closeSelector || defaultCloseSelector(id),
      onOpen: opts.onOpen || null,
      onClose: opts.onClose || null,
      trapHandler: null,
    };
    registry.set(id, cfg);

    // event delegation：modal 内任意 closeSelector 匹配的点击都关
    // 排除 .modal-bg（由全局 mousedown+mouseup 处理，避免双触发）
    modal.addEventListener('click', function (e) {
      const closer = e.target.closest(cfg.closeSelector);
      if (!closer) return;
      if (closer === modal) return;
      if (closer.classList && closer.classList.contains('modal-bg')) return;
      close(id);
    });

    // 给 modal 打个标记，让 app.js 全局 mouseup 关闭时能走 Modal.close（触发 onClose hook）
    modal.setAttribute('data-modal-managed', '1');
  }

  function open(id) {
    let cfg = registry.get(id);
    const modal = getEl(id);
    if (!modal) return;
    if (!cfg) {
      register(id);
      cfg = registry.get(id);
    }
    if (!cfg) return;
    if (openStack.includes(id)) return; // 已开

    if (openStack.length === 0) lastFocused = document.activeElement;
    modal.style.display = 'flex';
    openStack.push(id);

    cfg.trapHandler = function (e) { trapKey(modal, e, id); };
    document.addEventListener('keydown', cfg.trapHandler);

    const focusFirst = function () {
      const list = visibleFocusables(modal);
      // 跳过头部 ✕ 按钮，优先 focus 第一个表单/可操作元素
      const skip = modal.querySelector('.project-modal-head .btn-icon');
      const target = list.find(function (el) { return el !== skip; }) || list[0];
      if (target) try { target.focus(); } catch (e) {}
    };

    let r = null;
    try {
      r = cfg.onOpen ? cfg.onOpen() : null;
    } catch (e) { console.warn('[Modal#' + id + ' onOpen]', e); }
    // onOpen 异步时，等 render 完成再 focus；否则下一帧立即 focus
    if (r && typeof r.then === 'function') {
      r.then(function () { requestAnimationFrame(focusFirst); })
       .catch(function (err) {
         console.warn('[Modal#' + id + ' onOpen]', err);
         requestAnimationFrame(focusFirst);
       });
    } else {
      requestAnimationFrame(focusFirst);
    }
  }

  function close(id) {
    if (!openStack.includes(id)) return; // 幂等
    const cfg = registry.get(id);
    const modal = getEl(id);
    if (!modal) return;

    modal.style.display = 'none';
    const idx = openStack.lastIndexOf(id);
    if (idx >= 0) openStack.splice(idx, 1);

    if (cfg && cfg.trapHandler) {
      document.removeEventListener('keydown', cfg.trapHandler);
      cfg.trapHandler = null;
    }

    try { if (cfg && cfg.onClose) cfg.onClose(); }
    catch (e) { console.warn('[Modal#' + id + ' onClose]', e); }

    if (openStack.length === 0 && lastFocused && typeof lastFocused.focus === 'function') {
      try { lastFocused.focus(); } catch (e) {}
      lastFocused = null;
    }
  }

  function isOpen(id) { return openStack.includes(id); }
  function isManaged(id) { return registry.has(id); }

  window.Modal = {
    register: register,
    open: open,
    close: close,
    isOpen: isOpen,
    isManaged: isManaged,
    _registry: registry,
    _openStack: openStack,
  };
})();
