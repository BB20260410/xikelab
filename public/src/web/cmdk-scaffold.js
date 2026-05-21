// v0.80 starter: cmdk 命令面板模块拆分骨架
// 完整迁移需 sprint 级独立设计（涉及 app.js cmdk selector 50+ 处）
// 本 starter 仅提供 wrapper / placeholder，等待未来真迁

export function openCmdK() {
  if (typeof window.openCmdK === 'function') return window.openCmdK();
  document.querySelector('#cmdkModal')?.click();
}

export function closeCmdK() {
  if (typeof window.closeCmdK === 'function') return window.closeCmdK();
  const m = document.querySelector('#cmdkModal');
  if (m) m.style.display = 'none';
}

// 未来迁移清单（grep app.js 'cmdk' 12 处）：
//   - 状态：cmdkState{ items, query, selectedIdx }
//   - 命令注册：registerCmd(name, handler, hotkey)
//   - 搜索 fuzzy match
//   - 键盘 ↑↓⏎ESC 导航
//   - 历史 recent commands
