// public/src/web/onboarding.js — v1.0 Task 1.5 新手 walkthrough
// 不用 shepherd.js（30KB+），自实现轻量 100 行版本
// 6 步引导：欢迎页 / 顶栏 / sidebar / CTA / inspector / 完成

const STORAGE_KEY = 'panel:onboarding:v1';

const STEPS = [
  {
    target: '.brand',
    title: '👋 欢迎使用 Xikely',
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

/**
 * v1.1 Task 2.2: telemetry 同意 modal（首次访问触发，独立于 walkthrough）
 */
const TELEMETRY_KEY = 'panel:telemetry:asked';

export async function askTelemetry({ force = false } = {}) {
  if (!force && localStorage.getItem(TELEMETRY_KEY) === '1') return;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal telemetry-consent';
    overlay.innerHTML = `
      <div class="confirm-modal-bg"></div>
      <div class="confirm-modal-body" style="width:480px;max-width:92vw;">
        <h3 class="confirm-modal-title">📊 错误上报与产品分析（完全可选）</h3>
        <div class="confirm-modal-message" style="font-size:13px;line-height:1.7;">
panel 是开源软件，开发者用<b>你自己的 Sentry / PostHog 账号</b>收集崩溃报告和使用数据来改进 panel。

<b>会发什么</b>：
• 崩溃时 → 错误堆栈（path 自动 mask 到 ~，API key 自动 redact）
• 使用时 → 事件名（如 room_created）+ 维度（mode/count），<b>不含 prompt 内容</b>

<b>不会发什么</b>：
• 你的对话内容
• API key / token / 密码
• 个人识别信息

<b>默认关闭</b>。你随时可在「设置」里改。
        </div>
        <div class="confirm-modal-actions" style="gap:8px;">
          <button class="cxbtn cxbtn-secondary" data-act="decline">不参与</button>
          <button class="cxbtn cxbtn-primary" data-act="accept">同意并配置</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const finish = (action) => {
      localStorage.setItem(TELEMETRY_KEY, '1');
      overlay.remove();
      resolve(action);
      if (action === 'accept') {
        // 弹第二步：让用户填 DSN / Analytics Key
        showTelemetryConfigDialog();
      } else {
        // 用户拒绝 → 调 decline API
        fetch('/api/telemetry/decline', { method: 'POST' }).catch(() => {});
      }
    };
    overlay.querySelector('.confirm-modal-bg').addEventListener('click', () => finish('decline'));
    overlay.querySelector('[data-act="decline"]').addEventListener('click', () => finish('decline'));
    overlay.querySelector('[data-act="accept"]').addEventListener('click', () => finish('accept'));
  });
}

function showTelemetryConfigDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-modal';
  overlay.innerHTML = `
    <div class="confirm-modal-bg"></div>
    <div class="confirm-modal-body" style="width:520px;max-width:92vw;">
      <h3 class="confirm-modal-title">📡 填写 Sentry DSN + PostHog（都可选）</h3>
      <div class="confirm-modal-message" style="font-size:12.5px;line-height:1.6;">
都<b>留空</b>表示同意 telemetry 框架但不发任何数据（等你以后想发再来配）。

填了才会真发。
      </div>
      <div style="margin:12px 0;">
        <label style="display:block;font-size:12px;color:var(--gray-mid);margin-bottom:4px;">Sentry DSN（如 https://xxx@o0.ingest.sentry.io/0）</label>
        <input id="tlmDsn" type="text" placeholder="留空 = 不上报崩溃" style="width:100%;padding:6px 10px;border:1px solid var(--color-border-light);border-radius:6px;font-family:var(--mono);font-size:12px;" />
      </div>
      <div style="margin:12px 0;">
        <label style="display:block;font-size:12px;color:var(--gray-mid);margin-bottom:4px;">PostHog Host + Key（如 https://app.posthog.com）</label>
        <input id="tlmHost" type="text" placeholder="留空 = 不发分析" style="width:100%;padding:6px 10px;border:1px solid var(--color-border-light);border-radius:6px;font-family:var(--mono);font-size:12px;margin-bottom:6px;" />
        <input id="tlmKey" type="text" placeholder="API Key (phc_...)" style="width:100%;padding:6px 10px;border:1px solid var(--color-border-light);border-radius:6px;font-family:var(--mono);font-size:12px;" />
      </div>
      <div class="confirm-modal-actions">
        <button class="cxbtn cxbtn-tertiary" data-act="skip">先空着</button>
        <button class="cxbtn cxbtn-primary" data-act="save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('[data-act="skip"]').addEventListener('click', async () => {
    await fetch('/api/telemetry/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).catch(() => {});
    close();
  });
  overlay.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const dsn = overlay.querySelector('#tlmDsn').value.trim();
    const host = overlay.querySelector('#tlmHost').value.trim();
    const key = overlay.querySelector('#tlmKey').value.trim();
    try {
      if (dsn) await fetch('/api/telemetry/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dsn }) });
      if (host && key) await fetch('/api/analytics/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, key }) });
      close();
      if (typeof toast === 'function') toast('✓ 已保存遥测配置', 'success', 2000);
    } catch (e) {
      if (typeof toast === 'function') toast('保存失败：' + e.message, 'error');
    }
  });
}

export function resetOnboarding() {
  localStorage.removeItem(STORAGE_KEY);
}
