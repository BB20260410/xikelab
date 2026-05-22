// panel ESLint 9 flat config — 落地自 Phase 5 PoC 02（已修复全量扫描问题）
// 不强制风格，只检查「真正可能导致 bug」的规则。
//
// 作用域拆分（按代码实际运行环境）：
//   - server  : src/**/*.js, scripts/**/*.{js,mjs}, tests/**/*.{js,mjs}, 仓库根 *.{js,mjs,cjs}
//                Node ESM，runtime 是 Node 22+
//   - browser-script : public/*.js（除 public/main.js）
//                浏览器 script 标签直接加载，非 module
//   - browser-module : public/main.js + public/src/web/*.js
//                浏览器 ESM（<script type="module">）
//   - puppeteer-eval : scripts/{register-github,auto-create-ls-product}.mjs
//                Node 脚本但内部用 page.evaluate(() => document.xxx)
//                ESLint 不会跟进 evaluate 回调上下文 → 用 file override 把 DOM 全局放进来

const serverGlobals = {
  // Node runtime
  process: 'readonly', Buffer: 'readonly', console: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', global: 'readonly',
  // timers
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  // Web-compatible APIs（Node 18+ 原生）
  URL: 'readonly', URLSearchParams: 'readonly',
  AbortController: 'readonly', AbortSignal: 'readonly',
  fetch: 'readonly', Request: 'readonly', Response: 'readonly', Headers: 'readonly',
  TextDecoder: 'readonly', TextEncoder: 'readonly',
  crypto: 'readonly', structuredClone: 'readonly',
  performance: 'readonly',
  Blob: 'readonly', FormData: 'readonly',
};

const browserGlobals = {
  // DOM / BOM
  window: 'readonly', document: 'readonly',
  location: 'readonly', navigator: 'readonly', history: 'readonly',
  HTMLElement: 'readonly', Element: 'readonly', Node: 'readonly',
  Event: 'readonly', CustomEvent: 'readonly', MouseEvent: 'readonly', KeyboardEvent: 'readonly',
  CSS: 'readonly', getComputedStyle: 'readonly',
  // Network / Storage
  fetch: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly',
  WebSocket: 'readonly', EventSource: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly',
  AbortController: 'readonly', AbortSignal: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly',
  Blob: 'readonly', FormData: 'readonly', File: 'readonly', FileReader: 'readonly',
  // 编解码 / 加密
  TextDecoder: 'readonly', TextEncoder: 'readonly',
  crypto: 'readonly', structuredClone: 'readonly',
  atob: 'readonly', btoa: 'readonly',
  // Timer / animation
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  queueMicrotask: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  requestIdleCallback: 'readonly', cancelIdleCallback: 'readonly',
  // 用户交互 / 反馈
  alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
  Notification: 'readonly',
  // 观察者 / 性能
  ResizeObserver: 'readonly', MutationObserver: 'readonly', IntersectionObserver: 'readonly',
  performance: 'readonly', console: 'readonly',
};

// panel 内部跨文件全局：toast(msg, kind, ms) 由 app.js/clis.html/squad.html 各自定义；
// 在「ESM module 子作用域」声明为 writable，避免 public/src/web/*.js 调用时 no-undef。
// 故意不加到 browser-script 那一组：那里 public/app.js 自带 `function toast`，加了会触发 redeclare。
const moduleExtraGlobals = {
  toast: 'writable',
};

const baseRules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-redeclare': 'error',
  'no-const-assign': 'error',
  'no-debugger': 'warn',
  'no-async-promise-executor': 'error',
  'no-misleading-character-class': 'error',
  'no-prototype-builtins': 'off',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-self-assign': 'error',
  'no-fallthrough': 'error',
  'no-unreachable': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-cond-assign': 'error',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
};

export default [
  // 1) server / 脚本侧（Node ESM）
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.js', 'tests/**/*.mjs', '*.js', '*.mjs', '*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: serverGlobals,
    },
    rules: baseRules,
  },
  // 2) Puppeteer / browser-context 注册脚本：用 page.evaluate(() => document...) 操作 DOM
  //    ESLint 看不进 evaluate 回调，只能在这两个文件里把 DOM 全局也加上
  {
    files: ['scripts/register-github.mjs', 'scripts/auto-create-ls-product.mjs', 'tests/e2e/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // panel app.js 在浏览器侧暴露的页面级 SSOT 变量（puppeteer.evaluate 注入页面执行）
      globals: { ...serverGlobals, ...browserGlobals, archiveState: 'readonly' },
    },
    rules: baseRules,
  },
  // 3) public/ 浏览器侧 script 加载（非 module）
  {
    files: ['public/*.js'],
    ignores: ['public/main.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: browserGlobals,
    },
    rules: baseRules,
  },
  // 4) public/ 浏览器侧 ESM：main.js + 所有 public/src/web/*.js
  {
    files: ['public/main.js', 'public/src/web/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...browserGlobals, ...moduleExtraGlobals },
    },
    rules: baseRules,
  },
  // 5) 全局忽略：HTML（内嵌 script 无法用 JS parser）、构建产物、第三方
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'build/**',
      '*.min.js',
      'public/vendor/**',
      '**/*.html',
      'eslint-report.json',
    ],
  },
];
