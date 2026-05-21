// Roundtable — Dialog module (S29 starter)
// confirmModal + promptModal 主实现挪到 ES module
// app.js 内同名函数现为 thin wrapper delegate 到 window.PanelDialog.*

import { escapeHtmlEarly } from './utils.js';

// ─── v0.8 ConfirmModal（替代 confirm()）─────
// Promise<boolean> — true=确认 / false=取消
// opts: { title, message, confirmLabel='确认', cancelLabel='取消', danger=false }
export function confirmModal(opts, maybeTitle) {
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
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !opts.danger) { e.preventDefault(); finish(true); }
    };
    overlay.querySelector('.confirm-modal-bg').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-act="confirm"]').addEventListener('click', () => finish(true));
    document.addEventListener('keydown', keyHandler);
    document.body.appendChild(overlay);
    setTimeout(() => overlay.querySelector(opts.danger ? '[data-act="cancel"]' : '[data-act="confirm"]').focus(), 30);
  });
}

// ─── v0.9 PromptModal（替代 prompt()）─────
export function promptModal(opts, maybeDefault) {
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
