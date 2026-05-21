// public/src/web/onboarding.js — v1.0 Task 1.5 新手 walkthrough
// 不用 shepherd.js（30KB+），自实现轻量 100 行版本
// 6 步引导：欢迎页 / 顶栏 / sidebar / CTA / inspector / 完成

const STORAGE_KEY = 'panel:onboarding:v1';

const STEPS = [
  {
    target: '.brand',
    title: '👋 欢迎使用 Claude Panel',
    body: 'panel 是你的多 AI 工作台。\n\n这里是品牌区。下面是 11 个功能图标，从左到右分别是总览/终端/聊天室/插件/配置等。',
    position: 'right',
  },
  {
    target: '.brand-actions',
    title: '🎛 顶栏 11 个图标',
    body: '点 💬 进多 AI 聊天室；🔌 配 MCP 服务器；🤖 配 autopilot；⚙️ 配 adapter（API key）。\n\n每个按钮 hover 看完整说明。',
    position: 'right',
  },
  {
    target: '#btnNew',
    title: '＋ 新建会话',
    body: '点这里开新的 Claude Code session（PTY 终端，跟你直接在 terminal 跑 claude 一样，但多窗口管理）。',
    position: 'right',
  },
  {
    target: '.empty-cta-grid',
    title: '🎯 6 张快速卡片',
    body: '不知道从哪开始？直接点这 6 张卡：\n• 💬 单聊 / 🥊 辩论 / 👥 团队 / 🌐 联网核对（4 种 AI 协作模式）\n• ＋ 新建会话（开 Claude Code）\n• 💻 终端（任意命令）',
    position: 'top',
  },
  {
    target: '.inspector',
    title: '🔬 右侧 inspector',
    body: '6 个 tab：信息/事实/🛑安全/项目/文件/帮助。还有 🔬 Debate tab 看辩论实时进度。\n\n可拖左边竖条调宽度；点顶栏 ⇥ 折叠。',
    position: 'left',
  },
  {
    target: '#statusKbBtn',
    title: '⌨️ 全部快捷键',
    body: 'panel 有 8+ 快捷键（⌘N 新建/⌘K 命令面板/⌘D 切主题/⌘? 帮助/⌘1-9 切 session/⌘↵ 发送）。\n\n点底栏 ⌨️ 看完整列表。',
    position: 'top',
  },
];

let _currentStep = -1;
let _tooltip = null;
let _backdrop = null;

function isDone() {
  return localStorage.getItem(STORAGE_KEY) === '1';
}

function markDone() {
  localStorage.setItem(STORAGE_KEY, '1');
}

function clearStep() {
  if (_tooltip) { _tooltip.remove(); _tooltip = null; }
  if (_backdrop) { _backdrop.remove(); _backdrop = null; }
}

function showStep(idx) {
  clearStep();
  if (idx < 0 || idx >= STEPS.length) {
    markDone();
    return;
  }
  _currentStep = idx;
  const step = STEPS[idx];
  const target = document.querySelector(step.target);
  if (!target) {
    // target 不存在跳过
    return showStep(idx + 1);
  }
  const rect = target.getBoundingClientRect();

  // backdrop（半透明遮罩，target 区域镂空）
  _backdrop = document.createElement('div');
  _backdrop.className = 'onboarding-backdrop';
  Object.assign(_backdrop.style, {
    position: 'fixed', inset: '0',
    background: 'rgba(0,0,0,0.5)',
    zIndex: '10800',
    pointerEvents: 'none',
  });
  document.body.appendChild(_backdrop);

  // 高亮 target 区域（不真镂空，加边框光晕）
  const highlight = document.createElement('div');
  Object.assign(highlight.style, {
    position: 'fixed',
    left: (rect.left - 4) + 'px',
    top: (rect.top - 4) + 'px',
    width: (rect.width + 8) + 'px',
    height: (rect.height + 8) + 'px',
    border: '2px solid var(--orange, #C15F3C)',
    borderRadius: '8px',
    boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)',
    zIndex: '10801',
    pointerEvents: 'none',
    transition: 'all 220ms',
  });
  _backdrop.appendChild(highlight);

  // tooltip
  _tooltip = document.createElement('div');
  _tooltip.className = 'onboarding-tooltip';
  _tooltip.innerHTML = `
    <h3 style="margin:0 0 6px;font-size:14px;font-weight:600;">${step.title}</h3>
    <div style="font-size:12.5px;line-height:1.55;color:var(--color-text-foreground-secondary, #555);margin-bottom:12px;white-space:pre-wrap;min-width:0;word-break:break-word;">${step.body}</div>
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="font-size:11px;color:var(--gray-mid);">${idx + 1} / ${STEPS.length}</span>
      <button data-act="skip" style="margin-left:auto;background:transparent;border:none;color:var(--gray-mid);font-size:12px;cursor:pointer;">跳过</button>
      ${idx > 0 ? '<button data-act="prev" style="background:var(--bg-top);border:1px solid var(--color-border-light);border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;">上一步</button>' : ''}
      <button data-act="next" style="background:var(--orange, #C15F3C);color:#fff;border:none;border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer;font-weight:600;">${idx === STEPS.length - 1 ? '完成 ✓' : '下一步 →'}</button>
    </div>
  `;
  Object.assign(_tooltip.style, {
    position: 'fixed',
    background: 'var(--bg-surface, #fff)',
    border: '1px solid var(--color-border-heavy, #ddd)',
    borderRadius: '10px',
    padding: '12px 14px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
    width: '320px',
    maxWidth: '92vw',
    zIndex: '10802',
    fontSize: '13px',
  });

  // 定位（智能避边）
  const tw = 320, th = 180;  // 估算
  let left = rect.left, top = rect.bottom + 8;
  if (step.position === 'right') { left = rect.right + 12; top = rect.top; }
  else if (step.position === 'left') { left = rect.left - tw - 12; top = rect.top; }
  else if (step.position === 'top') { top = rect.top - th - 12; }
  // 视口边界 clip
  left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
  top = Math.max(8, Math.min(window.innerHeight - th - 8, top));
  _tooltip.style.left = left + 'px';
  _tooltip.style.top = top + 'px';

  document.body.appendChild(_tooltip);

  _tooltip.querySelector('[data-act="next"]').addEventListener('click', () => showStep(idx + 1));
  _tooltip.querySelector('[data-act="prev"]')?.addEventListener('click', () => showStep(idx - 1));
  _tooltip.querySelector('[data-act="skip"]').addEventListener('click', () => {
    clearStep();
    markDone();
  });
}

export function startOnboarding({ force = false } = {}) {
  if (!force && isDone()) return;
  // 等 DOM 稳定（modal portal 完成等）
  setTimeout(() => showStep(0), 500);
}

export function resetOnboarding() {
  localStorage.removeItem(STORAGE_KEY);
}
