// cmdk-commands.js — cmdk 命令面板的 COMMANDS 静态定义（v0.80 真迁第一步）
// 学自 W6 LangGraph 显式编排：把"命令"声明化分离出来，让未来加新命令零侵入

/**
 * 命令注册表 — 静态可声明
 * 每个命令格式：
 *   {
 *     id: 唯一标识
 *     icon: 图标 emoji
 *     title: 显示标题
 *     subtitle: 副标题（通常是快捷键）
 *     actionRef: 'openModal' / 'toggleTheme' / ... 字符串引用 app.js 内函数（避免循环依赖）
 *   }
 */
export const BUILTIN_COMMANDS = [
  { id: 'new-session',  icon: '＋', title: '新建会话',              subtitle: '⌘N',         actionRef: 'openModal' },
  { id: 'toggle-theme', icon: '🌓', title: '切换主题（暗/亮）',      subtitle: '⌘D',         actionRef: 'toggleTheme' },
  { id: 'handoff',      icon: '🔄', title: '为当前会话接力',         subtitle: '需先选中会话', actionRef: 'btnHandoff' },
  { id: 'external',     icon: '⤴', title: '在 Terminal 打开当前会话', subtitle: '',           actionRef: 'btnExternal' },
];

/**
 * 把 BUILTIN_COMMANDS 和 user query 匹配
 */
export function matchCommands(query) {
  const q = String(query || '').trim().toLowerCase();
  return BUILTIN_COMMANDS
    .filter(c => !q || c.title.toLowerCase().includes(q) || c.id.includes(q))
    .map(c => ({ type: 'cmd', ...c }));
}

/**
 * 解析 actionRef 字符串 → 真函数（在 app.js 上下文执行）
 * 调用方：app.js 注入 actionDispatcher 映射表
 */
export function resolveAction(cmd, dispatcher) {
  if (!cmd || !cmd.actionRef) return null;
  return dispatcher?.[cmd.actionRef] || null;
}
