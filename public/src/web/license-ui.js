// panel v1.5/v2.0 — License + Workspace 状态 UI
// 在 panel 顶栏左下角加 license 徽章 + workspace 切换器
// 点徽章 → 弹激活/管理 modal

(function () {
  const API = '';

  async function fetchJSON(path, opts) {
    const r = await fetch(API + path, opts);
    return r.json();
  }

  // === License 徽章 ===
  function renderLicenseBadge(status) {
    const el = document.getElementById('licenseBadge');
    if (!el) return;
    const tier = status.tier || 'free';
    const colorMap = { free: '#888', pro: '#10b981', team: '#8b5cf6' };
    const labelMap = { free: 'Free', pro: 'Pro ✓', team: 'Team ⭐' };
    el.style.background = colorMap[tier] || '#888';
    el.textContent = labelMap[tier] || tier;
    el.title = status.email ? `${tier.toUpperCase()} · ${status.email} · 到期：${status.expiresAtLabel}` : '点击激活 license';
  }

  async function refreshLicense() {
    try {
      const status = await fetchJSON('/api/license/status');
      renderLicenseBadge(status);
      return status;
    } catch (e) {
      console.warn('[license] fetch failed', e);
    }
  }

  // === Workspace 切换器 ===
  async function refreshWorkspace() {
    try {
      const r = await fetchJSON('/api/workspaces');
      const sel = document.getElementById('workspaceSel');
      if (!sel) return;
      sel.innerHTML = '';
      for (const ws of r.workspaces) {
        const opt = document.createElement('option');
        opt.value = ws.name;
        opt.textContent = ws.name + (ws.builtin ? ' (默认)' : '');
        if (ws.name === r.active) opt.selected = true;
        sel.appendChild(opt);
      }
      if (r.canCreate) {
        const opt = document.createElement('option');
        opt.value = '__new__';
        opt.textContent = '+ 新建 workspace…';
        sel.appendChild(opt);
      }
      sel.onchange = async () => {
        if (sel.value === '__new__') {
          const name = prompt('workspace 名（a-z 0-9 _ - 1-32 字符）：');
          if (!name) { sel.value = r.active; return; }
          const cr = await fetchJSON('/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (cr.ok) {
            alert('✅ 创建成功，重启 panel 切换到此 workspace');
            location.reload();
          } else {
            alert('❌ ' + (cr.error || '未知错误'));
            sel.value = r.active;
          }
          return;
        }
        await fetchJSON('/api/workspaces/active', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: sel.value }),
        });
        if (confirm('已切换 workspace，需要重启 panel 才能生效。立即重启？')) {
          location.reload();
        }
      };
    } catch (e) {
      console.warn('[workspace] fetch failed', e);
    }
  }

  // === License 激活 modal ===
  function showActivateModal() {
    const bg = document.createElement('div');
    bg.className = 'license-modal-bg';
    bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center';
    bg.innerHTML = `
      <div class="license-modal" style="background:#1a1d23;padding:24px;border-radius:8px;max-width:500px;width:90%;color:#e8eaed">
        <h3 style="margin:0 0 16px">激活 Claude Panel Pro</h3>
        <p style="font-size:13px;color:#b3b7bd;margin-bottom:12px">
          粘贴你购买后收到的 license key（base64.base64 格式）。<br/>
          没有？<a href="https://panel.app/pricing" target="_blank" style="color:#10b981">在这里购买</a>
        </p>
        <textarea id="licInput" style="width:100%;height:120px;background:#0f1115;color:#e8eaed;border:1px solid #2a2e36;border-radius:4px;padding:8px;font-family:monospace;font-size:11px" placeholder="eyJ2ZXJzaW9uIjox..."></textarea>
        <div id="licMsg" style="margin-top:8px;font-size:12px;min-height:18px"></div>
        <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
          <button id="licCancel" style="padding:8px 16px;background:#2a2e36;color:#e8eaed;border:none;border-radius:4px;cursor:pointer">取消</button>
          <button id="licOk" style="padding:8px 16px;background:#10b981;color:#000;border:none;border-radius:4px;cursor:pointer;font-weight:600">激活</button>
        </div>
      </div>
    `;
    document.body.appendChild(bg);
    bg.querySelector('#licCancel').onclick = () => bg.remove();
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    bg.querySelector('#licOk').onclick = async () => {
      const lic = bg.querySelector('#licInput').value.trim();
      const msg = bg.querySelector('#licMsg');
      msg.textContent = '正在验证...';
      msg.style.color = '#888';
      try {
        const r = await fetchJSON('/api/license/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ license: lic }),
        });
        if (r.ok) {
          msg.textContent = `✅ 激活成功！tier: ${r.tier} · ${r.email}`;
          msg.style.color = '#10b981';
          await refreshLicense();
          setTimeout(() => { bg.remove(); location.reload(); }, 1500);
        } else {
          msg.textContent = '❌ ' + (r.error || '激活失败');
          msg.style.color = '#ef4444';
        }
      } catch (e) {
        msg.textContent = '❌ 网络错误';
        msg.style.color = '#ef4444';
      }
    };
  }

  // === 初始化 ===
  function init() {
    // 在 footer 或顶栏插入 license badge + workspace sel
    const host = document.getElementById('topbar') || document.getElementById('footer') || document.body;
    if (host && !document.getElementById('licenseBadge')) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:inline-flex;gap:8px;align-items:center;margin-left:auto;padding:4px 8px';
      wrap.innerHTML = `
        <select id="workspaceSel" style="background:#0f1115;color:#e8eaed;border:1px solid #2a2e36;border-radius:4px;padding:2px 6px;font-size:12px"></select>
        <span id="licenseBadge" style="background:#888;color:#fff;font-size:11px;padding:2px 8px;border-radius:10px;cursor:pointer;font-weight:600">Free</span>
      `;
      host.appendChild(wrap);
      wrap.querySelector('#licenseBadge').onclick = showActivateModal;
    }
    refreshLicense();
    refreshWorkspace();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 导出全局
  window.PanelLicense = { refresh: refreshLicense, showActivateModal };
  window.PanelWorkspace = { refresh: refreshWorkspace };
})();
