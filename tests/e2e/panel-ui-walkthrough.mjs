#!/usr/bin/env node
// panel-ui-walkthrough.mjs — v0.9 真测：playwright 全功能 walkthrough
/* global pluginState, autopilotState */

import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PANEL = process.env.PANEL_URL || 'http://localhost:51735';
const results = [];
const consoleErrors = [];
const ARTIFACT_DIR = join(process.cwd(), 'output', 'playwright');

function track(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name} ${detail}`);
}

function readOwnerToken() {
  try {
    const token = readFileSync(join(homedir(), '.claude-panel', 'owner-token.txt'), 'utf8').trim();
    return token.length >= 32 ? token : '';
  } catch {
    return '';
  }
}

async function saveFailureArtifact(page, label = 'panel-ui-walkthrough') {
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const out = join(ARTIFACT_DIR, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log(`  📸 failure screenshot: ${out}`);
  } catch (e) {
    console.log(`  ⚠️ failed to capture screenshot: ${e.message}`);
  }
}

(async () => {
  console.log('🎭 panel UI walkthrough 开始');
  const ownerToken = readOwnerToken();
  console.log(ownerToken ? '🔐 owner-token loaded for protected APIs' : '⚠️ owner-token missing; protected API checks may fail');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) consoleErrors.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`));

  try {
    // 提前注入 localStorage（防 telemetry/onboarding modal 拦截点击）
    await page.addInitScript((token) => {
      if (token) sessionStorage.setItem('panel-owner-token', token);
      localStorage.setItem('panel:telemetry:asked', '1');
      localStorage.setItem('panel:onboarding:v1', '1');
    }, ownerToken);
    await page.goto(PANEL, { waitUntil: 'networkidle', timeout: 10000 });
    const title = await page.title();
    track('1. 首页加载', title === 'Xike Lab', `title="${title}"`);

    const topBtns = ['btnOverview','btnTerminal','btnRooms','btnPlugins','btnRoomAdapters','btnWebhooks','btnArchive','btnMcp','btnAutopilot','btnApprovals','btnActivity','btnDelegations'];
    for (const id of topBtns) {
      const btn = await page.$(`#${id}`);
      const visible = btn ? await btn.isVisible() : false;
      track(`2. 顶栏 #${id}`, !!btn && visible);
    }

    const modules = await page.evaluate(() => ({
      Store: !!window.PanelStore, Cmdk: !!window.PanelCmdk, Inspector: !!window.PanelInspector,
      Ws: !!window.PanelWs, Dialog: !!window.PanelDialog, Utils: !!window.PanelUtils,
    }));
    for (const [k, v] of Object.entries(modules)) {
      track(`3. window.Panel${k}`, v);
    }

    const modalsToTest = ['btnRoomAdapters','btnWebhooks','btnArchive','btnAutopilot','btnApprovals','btnActivity','btnDelegations','btnMcp'];
    for (const id of modalsToTest) {
      await page.click(`#${id}`);
      await page.waitForTimeout(300);
      const anyOpen = await page.evaluate(() => [...document.querySelectorAll('.modal')].some(m => m.style.display === 'flex'));
      track(`4. ${id} → modal open`, anyOpen);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      const allClosed = await page.evaluate(() => [...document.querySelectorAll('.modal')].every(m => m.style.display !== 'flex'));
      track(`4. ESC 关 ${id}`, allClosed);
    }

    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(150);
    const cmdkOpen = await page.evaluate(() => document.querySelector('#cmdkModal')?.style.display === 'flex');
    track('5. ⌘K cmdk open', cmdkOpen);
    const cmdkItems = await page.$$eval('.cmdk-item', els => els.length);
    track('5. cmdk 含 ≥4 items', cmdkItems >= 4, `items=${cmdkItems}`);
    await page.keyboard.press('Escape');

    await page.click('[data-tab="debate-state"]');
    await page.waitForTimeout(100);
    const debateLogShown = await page.evaluate(() => document.querySelector('[data-content="debate-state"]')?.style.display !== 'none');
    track('6. 切到 🔬 Debate tab', debateLogShown);

    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        space: cs.getPropertyValue('--space-2').trim(),
        zToast: cs.getPropertyValue('--z-toast').trim(),
        danger: cs.getPropertyValue('--color-danger').trim(),
      };
    });
    track('7. CSS token --space-2', tokens.space === '8px');
    track('7. CSS token --z-toast', tokens.zToast === '10000');
    track('7. CSS token --color-danger', tokens.danger === '#dc2626');

    const mirrors = await page.evaluate(() => {
      const out = {};
      out.pendingFlushed = Array.isArray(window.__panelPendingStateMirrors) && window.__panelPendingStateMirrors.length === 0;
      if (typeof archiveState !== 'undefined') {
        archiveState.list = ['e2e-test'];
        out.archive = JSON.stringify(window.PanelStore.get('archive.list')) === '["e2e-test"]';
      }
      if (typeof pluginState !== 'undefined') {
        pluginState.activeId = 'e2e-plugin';
        out.plugin = window.PanelStore.get('plugin.activeId') === 'e2e-plugin';
      }
      if (typeof autopilotState !== 'undefined') {
        autopilotState.logs = [{ id: 'e2e-log' }];
        out.autopilot = JSON.stringify(window.PanelStore.get('autopilot.logs')) === '[{"id":"e2e-log"}]';
      }
      return out;
    });
    track('8. pending SSOT mirror queue flushed', mirrors.pendingFlushed);
    track('8. archiveState → SSOT mirror', mirrors.archive);
    track('8. pluginState → SSOT mirror', mirrors.plugin);
    track('8. autopilotState → SSOT mirror', mirrors.autopilot);

    await page.click('#themeToggle');
    await page.waitForTimeout(200);
    const darkApplied = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    track('9. 暗黑模式切换', darkApplied);
    await page.click('#themeToggle');
    await page.waitForTimeout(200);

    const footerFs = await page.evaluate(() => {
      const f = document.querySelector('.status-bar');
      return f ? getComputedStyle(f).fontSize : null;
    });
    track('10. footer fontSize 12px', footerFs === '12px');

  } catch (e) {
    track('FATAL', false, e.message);
    await saveFailureArtifact(page, 'fatal');
  } finally {
    if (consoleErrors.length) {
      console.log('\nConsole warnings/errors:');
      for (const line of consoleErrors.slice(0, 20)) console.log(`  ${line}`);
    }
    if (results.some(r => !r.pass)) await saveFailureArtifact(page);
    await browser.close();
  }

  const passed = results.filter(r => r.pass).length;
  console.log(`\n🏁 e2e: ${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
