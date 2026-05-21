// public/src/web/i18n.js — v1.0 Task 1.4 轻量 i18n
// 不依赖 i18next（panel 前端 IIFE 不便 import 大包）
// 30 行实现：fetch JSON + key → value + 占位符替换
// 用法：t('common.save') 或 t('rooms.delete_confirm', { name: 'X' })

const LOCALES_BASE = '/locales';
const STORAGE_KEY = 'panel:lang';

let _locale = 'zh';
let _dict = {};
const _subscribers = new Set();

export function detectLocale() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'zh' || saved === 'en') return saved;
  const nav = (navigator.language || 'zh').toLowerCase();
  return nav.startsWith('en') ? 'en' : 'zh';
}

export async function loadLocale(locale) {
  if (locale !== 'zh' && locale !== 'en') locale = 'zh';
  try {
    const r = await fetch(`${LOCALES_BASE}/${locale}.json`);
    if (!r.ok) throw new Error('locale load failed');
    _dict = await r.json();
    _locale = locale;
    localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.setAttribute('lang', locale);
    for (const cb of _subscribers) { try { cb(locale); } catch {} }
  } catch (e) {
    console.warn('[i18n] load failed:', e.message);
  }
}

/** key 支持点路径如 'common.save'；vars 用 {{name}} 替换 */
export function t(key, vars = {}) {
  const parts = String(key).split('.');
  let cur = _dict;
  for (const p of parts) {
    if (cur == null) break;
    cur = cur[p];
  }
  let val = typeof cur === 'string' ? cur : key;  // fallback 显示 key 让 dev 知道哪里漏
  for (const [k, v] of Object.entries(vars)) {
    val = val.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), v);
  }
  return val;
}

export function getLocale() { return _locale; }

export function subscribe(cb) {
  _subscribers.add(cb);
  return () => _subscribers.delete(cb);
}

// 初始化（main.js 调）
export async function initI18n() {
  await loadLocale(detectLocale());
}
