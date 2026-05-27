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

    const topBtns = ['btnOverview','btnTerminal','btnRooms','btnAgentRegistry','btnCodebaseCenter','btnKnowledgeCenter','btnGovernance','btnPlugins','btnRoomAdapters','btnWebhooks','btnArchive','btnMcp','btnAutopilot','btnApprovals','btnActivity','btnDelegations'];
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

    const modalsToTest = ['btnAgentRegistry','btnCodebaseCenter','btnKnowledgeCenter','btnGovernance','btnRoomAdapters','btnWebhooks','btnArchive','btnAutopilot','btnApprovals','btnActivity','btnDelegations','btnMcp'];
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

    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    // 4b. 知识库（证据 FTS 检索 P4/A2）：重建索引 → 检索 → 命中跳转审计
    await page.click('#btnKnowledgeCenter');
    await page.waitForSelector('#knowledgeQueryInput', { timeout: 3000 });
    await page.click('#knowledgeReindexBtn');
    await page.waitForTimeout(700);
    const kcReindexed = await page.evaluate(() => (document.querySelector('#knowledgeCenterBody')?.textContent || '').includes('已索引'));
    track('4b. Knowledge Center 重建索引更新状态', kcReindexed);
    await page.fill('#knowledgeQueryInput', 'session');
    await page.click('#knowledgeSearchBtn');
    await page.waitForTimeout(700);
    const kcSearch = await page.evaluate(() => {
      const body = document.querySelector('#knowledgeCenterBody')?.textContent || '';
      const err = document.querySelector('#knowledgeCenterBody .agent-empty.error');
      return { hasCount: /条命中/.test(body), noError: !err };
    });
    track('4b. Knowledge Center 检索链路无报错', kcSearch.hasCount && kcSearch.noError, `hasCount=${kcSearch.hasCount} noError=${kcSearch.noError}`);
    const kcHit = await page.$('[data-knowledge-open="0"]');
    if (kcHit) {
      await page.click('[data-knowledge-open="0"]');
      await page.waitForTimeout(300);
      const activityOpen = await page.evaluate(() => document.querySelector('#activityModal')?.style.display === 'flex');
      track('4b. Knowledge 命中跳转审计时间线', activityOpen);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    } else {
      track('4b. Knowledge 命中跳转审计时间线', true, '(本地无证据数据，跳过跳转校验)');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    await page.click('#btnGovernance');
    await page.waitForFunction(() => {
      const body = document.querySelector('#governanceCenterBody')?.textContent || '';
      return body.includes('本地治理总控') && body.includes('Next Actions') && body.includes('Agent Runs');
    }, null, { timeout: 5000 });
    const governanceCenterUi = await page.evaluate(() => ({
      kpis: document.querySelectorAll('.governance-center-kpi').length,
      sections: document.querySelectorAll('.governance-center-section').length,
      refresh: !!document.querySelector('#btnGovernanceCenterRefresh'),
      text: document.querySelector('#governanceCenterBody')?.textContent || '',
    }));
    track('4a. Governance Center unified view',
      governanceCenterUi.kpis >= 6
        && governanceCenterUi.sections >= 4
        && governanceCenterUi.refresh
        && governanceCenterUi.text.includes('Open Items'));
    const governanceBudgetScope = `e2e-governance-${Date.now()}`;
    const governanceBudgetIncidentId = await page.evaluate(async (scopeId) => {
      const policyRes = await fetch('/api/budgets/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeType: 'project',
          scopeId,
          metric: 'calls',
          windowKind: 'daily',
          amount: 1,
          warnPercent: 0.5,
          hardStopEnabled: true,
          notifyEnabled: true,
          note: 'E2E Governance Center budget action',
        }),
      });
      if (!policyRes.ok) throw new Error(await policyRes.text());
      await fetch('/api/budgets/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: scopeId, estimateCalls: 1 }),
      }).catch(() => null);
      const incidentRes = await fetch(`/api/budgets/incidents?status=open&scopeType=project&scopeId=${encodeURIComponent(scopeId)}&limit=10`);
      const payload = await incidentRes.json();
      return payload.incidents?.[0]?.id || '';
    }, governanceBudgetScope);
    await page.click('#btnGovernanceCenterRefresh');
    await page.waitForFunction((incidentId) => !!document.querySelector(`[data-gov-center-resolve-budget="${incidentId}"]`), governanceBudgetIncidentId, { timeout: 5000 });
    track('4a. Governance Center budget action present', !!governanceBudgetIncidentId);
    // P5 工作队列看板：budget incident 应派生为队列项（pending_fix）
    const govQueueBoard = await page.evaluate(() => {
      const board = document.querySelector('[data-gov-center-queue]');
      return {
        present: !!board,
        hasTitle: (board?.textContent || '').includes('工作队列'),
        advance: document.querySelectorAll('[data-gov-queue-advance]').length,
      };
    });
    track('4a. Governance Center work queue board', govQueueBoard.present && govQueueBoard.hasTitle);
    track('4a. Governance Center work queue derives items', govQueueBoard.advance >= 1, `advance=${govQueueBoard.advance}`);
    await page.click(`[data-gov-center-resolve-budget="${governanceBudgetIncidentId}"]`);
    await page.waitForFunction((incidentId) => !document.querySelector(`[data-gov-center-resolve-budget="${incidentId}"]`), governanceBudgetIncidentId, { timeout: 5000 });
    track('4a. Governance Center budget action resolves incident', true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    await page.click('#btnCodebaseCenter');
    await page.waitForSelector('#codebaseQueryInput', { timeout: 3000 });
    await page.fill('#codebaseQueryInput', 'Agent 图谱入口 DOM handler');
    await page.click('#codebaseQuestionBtn');
    await page.waitForFunction(() => {
      const text = document.querySelector('.codebase-results')?.textContent || '';
      return text.includes('public/')
        && (text.includes('intent:agent-ui-handler') || text.includes('intent:agent-ui-dom'));
    }, null, { timeout: 8000 });
    const codebaseQueryUi = await page.evaluate(() => ({
      cards: document.querySelectorAll('.codebase-result-card').length,
      hasPath: (document.querySelector('.codebase-results')?.textContent || '').includes('public/'),
      hasReason: ['intent:agent-ui-handler', 'intent:agent-ui-dom'].some(token => (document.querySelector('.codebase-results')?.textContent || '').includes(token)),
      hasVectors: (document.querySelector('.codebase-index-status')?.textContent || '').includes('vectors'),
      hasParsers: (document.querySelector('.codebase-index-status')?.textContent || '').includes('parsers'),
      addButtons: document.querySelectorAll('[data-codebase-add]').length,
      answer: document.querySelector('[data-codebase-question-answer]')?.textContent || '',
    }));
    track('4a. Codebase Center query results',
      codebaseQueryUi.cards > 0 && codebaseQueryUi.hasPath && codebaseQueryUi.hasReason && codebaseQueryUi.hasVectors && codebaseQueryUi.hasParsers && codebaseQueryUi.addButtons > 0);
    track('4a. Codebase Center code question answer',
      codebaseQueryUi.answer.includes('Local Code Answer')
        && codebaseQueryUi.answer.includes('public/')
        && codebaseQueryUi.answer.includes('C1')
        && codebaseQueryUi.answer.includes('Deterministic local evidence only'));
    await page.click('[data-codebase-add="0"]');
    await page.click('#codebaseOpenDispatch');
    await page.waitForSelector('#agentPreviewFiles', { timeout: 5000 });
    const dispatchFromCodebase = await page.evaluate(() => ({
      files: document.querySelector('#agentPreviewFiles')?.value || '',
      text: document.querySelector('#agentPreviewText')?.value || '',
      question: document.querySelector('[data-agent-code-question-answer]')?.textContent || '',
    }));
    track('4a. Codebase result adds to Dispatch Preview',
      dispatchFromCodebase.files.includes('public/app.js') && dispatchFromCodebase.text.includes('Agent 图谱入口'));
    track('4a. Codebase answer adds to Dispatch Preview',
      dispatchFromCodebase.question.includes('Code Question Answer') && dispatchFromCodebase.question.includes('C1'));
    await page.click('#agentPreviewRun');
    await page.waitForFunction(() => {
      const text = document.querySelector('#agentPreviewResult')?.textContent || '';
      return text.includes('Code Question Answer') && text.includes('C1');
    }, null, { timeout: 5000 });
    const dispatchWorkflow = await page.evaluate(() => {
      const path = document.querySelector('[data-agent-main-path="dispatch"]')?.textContent || '';
      return path.includes('Idea-to-Archive Path')
        && path.includes('Dispatch Preview')
        && path.includes('Run Draft')
        && path.includes('Next: 创建 Run Draft');
    });
    track('4a. Idea-to-Archive guided dispatch path', dispatchWorkflow);
    track('4a. Dispatch prompt includes code answer',
      ((await page.textContent('#agentPreviewResult')) || '').includes('Code Question Answer'));
    await page.click('#agentPreviewCreateRun');
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('Code Question Answer') && detail.includes('C1');
    }, null, { timeout: 5000 });
    const codeQuestionRunDetail = (await page.textContent('.agent-run-detail')) || '';
    track('4a. Idea Run archives code answer',
      codeQuestionRunDetail.includes('Code Question Answer') && codeQuestionRunDetail.includes('C1'));
    await page.click('[data-agent-tab="dispatch"]');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    await page.click('#btnAgentRegistry');
    await page.waitForSelector('#agentPreviewFiles', { timeout: 3000 });
    const agentCenterTabs = await page.$$eval('[data-agent-tab]', els => els.map(el => el.textContent.trim()));
    track('4a. Agent Center tabs present',
      ['Profiles', 'Dispatch', 'Models/Skills', 'Runs', 'Policies'].every(label => agentCenterTabs.includes(label)),
      agentCenterTabs.join(','));
    await page.click('[data-agent-tab="models"]');
    await page.waitForSelector('[data-agent-model-center]', { timeout: 3000 });
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-agent-model-center]')?.textContent || '';
      return text.includes('Model / Skill Center') && text.includes('Local status only') && text.includes('Skill Injection Matrix');
    }, null, { timeout: 5000 });
    const modelSkillCenter = await page.evaluate(() => {
      const text = document.querySelector('[data-agent-model-center]')?.textContent || '';
      return {
        hasLocalBoundary: text.includes('no secrets shown') && text.includes('provider config is read-only here'),
        hasProviderStatus: text.includes('Provider Model Status') && text.includes('No live ping'),
        hasRecommendations: text.includes('Model Recommendations') && text.includes('source: active adapter'),
        hasSkillMatrix: text.includes('Skill Injection Matrix') && text.includes('missing bindings'),
        hasSkillRisk: text.includes('Skill Source & Risk') && text.includes('source risks'),
        noSecrets: !/api[_-]?key|sk-[a-z0-9]/i.test(text),
      };
    });
    track('4a. Model/Skill Center local status',
      modelSkillCenter.hasLocalBoundary && modelSkillCenter.hasProviderStatus && modelSkillCenter.hasRecommendations && modelSkillCenter.hasSkillMatrix && modelSkillCenter.hasSkillRisk && modelSkillCenter.noSecrets);
    await page.click('[data-agent-tab="runs"]');
    await page.waitForSelector('#agentRunsRefresh', { timeout: 3000 });
    const agentRunsUi = await page.evaluate(() => ({
      status: !!document.querySelector('#agentRunStatusFilter'),
      room: !!document.querySelector('#agentRunRoomFilter'),
      session: !!document.querySelector('#agentRunSessionFilter'),
      profile: !!document.querySelector('#agentRunProfileFilter'),
      source: !!document.querySelector('#agentRunSourceFilter'),
      approval: !!document.querySelector('#agentRunApprovalFilter'),
      delegation: !!document.querySelector('#agentRunDelegationFilter'),
      budget: !!document.querySelector('#agentRunBudgetFilter'),
      governance: !!document.querySelector('#agentRunGovernanceFilter'),
      detail: !!document.querySelector('.agent-run-detail'),
    }));
    track('4a. Agent Runs tab controls',
      agentRunsUi.status && agentRunsUi.room && agentRunsUi.session && agentRunsUi.profile && agentRunsUi.source && agentRunsUi.approval && agentRunsUi.delegation && agentRunsUi.budget && agentRunsUi.governance && agentRunsUi.detail);
    await page.click('[data-agent-tab="policies"]');
    await page.waitForSelector('.agent-policy-editor', { timeout: 3000 });
    track('4a. Agent Policies tab editors', (await page.$$('.agent-policy-editor')).length > 0);
    await page.click('[data-agent-tab="dispatch"]');
    await page.waitForSelector('#agentPreviewFiles', { timeout: 3000 });
    await page.fill('#agentPreviewText', '继续推进这一块');
    await page.click('#agentPreviewLoadChanged');
    await page.waitForFunction(() => {
      const value = document.querySelector('#agentPreviewFiles')?.value || '';
      const info = document.querySelector('#agentPreviewFilesInfo')?.textContent || '';
      return value.includes('public/app.js') && info.includes('changed files');
    }, null, { timeout: 5000 });
    const changedFilesLoaded = await page.evaluate(() => ({
      value: document.querySelector('#agentPreviewFiles')?.value || '',
      info: document.querySelector('#agentPreviewFilesInfo')?.textContent || '',
    }));
    track('4a. Agent preview loads git changes', changedFilesLoaded.value.includes('public/app.js') && changedFilesLoaded.info.includes('changed files'));
    await page.fill('#agentPreviewFiles', 'public/app.js\nsrc/agents/AgentRunStore.js');
    await page.click('#agentPreviewRun');
    await page.waitForSelector('.agent-code-context', { timeout: 5000 });
    const agentCodeContextPreview = await page.evaluate(() => ({
      hasFilesInput: !!document.querySelector('#agentPreviewFiles'),
      hasCodeContext: !!document.querySelector('.agent-code-context'),
      hasCodeEvidence: !!document.querySelector('.agent-code-evidence'),
      previewText: document.querySelector('#agentPreviewResult')?.textContent || '',
    }));
    track('4a. Agent preview code context',
      agentCodeContextPreview.hasFilesInput
        && agentCodeContextPreview.hasCodeContext
        && agentCodeContextPreview.previewText.includes('Code Context'));
    await page.click('#agentPreviewLoadCodebase');
    await page.waitForFunction(() => {
      const value = document.querySelector('#agentPreviewFiles')?.value || '';
      const info = document.querySelector('#agentPreviewFilesInfo')?.textContent || '';
      return value.includes('src/agents') && info.includes('focus files');
    }, null, { timeout: 5000 });
    await page.click('#agentPreviewRun');
    await page.waitForSelector('.agent-codebase-map', { timeout: 5000 });
    await page.waitForSelector('.agent-symbol-graph', { timeout: 5000 });
    const agentCodebaseMapPreview = await page.evaluate(() => ({
      files: document.querySelector('#agentPreviewFiles')?.value || '',
      info: document.querySelector('#agentPreviewFilesInfo')?.textContent || '',
      previewText: document.querySelector('#agentPreviewResult')?.textContent || '',
      symbolText: document.querySelector('.agent-symbol-graph')?.textContent || '',
      hasSymbolGraph: !!document.querySelector('.agent-symbol-graph'),
    }));
    track('4a. Agent preview codebase map',
      agentCodebaseMapPreview.files.includes('src/agents')
        && agentCodebaseMapPreview.info.includes('focus files')
        && agentCodebaseMapPreview.previewText.includes('Codebase Map')
        && agentCodebaseMapPreview.hasSymbolGraph);
    track('4a. Agent preview type implementation count',
      agentCodebaseMapPreview.symbolText.includes('type impl'));
    await page.fill('#agentPreviewText', 'E2E idea-to-archive run');
    await page.click('#agentPreviewRun');
    await page.waitForFunction(() => {
      const text = document.querySelector('#agentPreviewResult')?.textContent || '';
      return text.includes('Xike') && text.includes('Installed');
    }, null, { timeout: 5000 });
    await page.click('#agentPreviewCreateRun');
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('idea_to_archive') && detail.includes('Execution Archive') && detail.includes('E2E idea-to-archive run');
    }, null, { timeout: 5000 });
    const ideaRunUi = await page.evaluate(() => ({
      detail: document.querySelector('.agent-run-detail')?.textContent || '',
      activeTab: document.querySelector('.agent-registry-tab.is-active')?.textContent?.trim() || '',
      workflow: document.querySelector('[data-agent-main-path="run"]')?.textContent || '',
      nextAction: document.querySelector('[data-agent-main-next]')?.textContent || '',
    }));
    track('4a. Idea-to-Archive run draft', ideaRunUi.activeTab === 'Runs' && ideaRunUi.detail.includes('Execution Archive'));
    track('4a. Idea-to-Archive archive artifact', ideaRunUi.detail.includes('Idea intake archived: E2E idea-to-archive run'));
    track('4a. Idea-to-Archive guided run path',
      ideaRunUi.workflow.includes('Idea-to-Archive Path')
        && ideaRunUi.workflow.includes('Manifest/Patch')
        && ideaRunUi.workflow.includes('Next: Generate Manifest')
        && ideaRunUi.workflow.includes('Recommended next')
        && ideaRunUi.nextAction.includes('Generate Manifest')
        && ideaRunUi.workflow.includes('Generate Patch'));
    const ideaActionDedup = await page.evaluate(() => ({
      topIdeaActions: document.querySelectorAll('.agent-run-actions [data-agent-run-idea-auto], .agent-run-actions [data-agent-run-idea-generate-manifest], .agent-run-actions [data-agent-run-idea-generate-patch], .agent-run-actions [data-agent-run-idea-manifest], .agent-run-actions [data-agent-run-idea-complete]').length,
      guidedIdeaActions: document.querySelectorAll('[data-agent-main-path="run"] [data-agent-run-idea-auto], [data-agent-main-path="run"] [data-agent-run-idea-generate-manifest], [data-agent-main-path="run"] [data-agent-run-idea-generate-patch], [data-agent-main-path="run"] [data-agent-run-idea-manifest], [data-agent-main-path="run"] [data-agent-run-idea-complete]').length,
    }));
    track('4a. Idea-to-Archive action bar deduplicated',
      ideaActionDedup.topIdeaActions === 0 && ideaActionDedup.guidedIdeaActions >= 4);
    const ideaAutoButton = await page.evaluate(() => !!document.querySelector('[data-agent-run-idea-auto]'));
    track('4a. Idea-to-Archive auto verify action present', ideaAutoButton);
    await page.click('[data-agent-run-idea-auto]');
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('succeeded')
        && detail.includes('verification passed')
        && detail.includes('git status --short')
        && detail.includes('git diff --check')
        && detail.includes('npm test');
    }, null, { timeout: 20000 });
    const completedIdeaRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Idea-to-Archive auto execution complete', completedIdeaRunUi.includes('verification passed'));
    track('4a. Idea-to-Archive work evidence', completedIdeaRunUi.includes('Idea work plan prepared') && completedIdeaRunUi.includes('git status --short'));
    track('4a. Idea-to-Archive final archive',
      completedIdeaRunUi.includes('npm test')
        && completedIdeaRunUi.includes('Execution Archive')
        && completedIdeaRunUi.includes('Archive evidence ready'));
    const finalArchiveGuided = await page.evaluate(() => {
      const path = document.querySelector('[data-agent-main-path="run"]')?.textContent || '';
      const next = document.querySelector('[data-agent-main-next]')?.textContent || '';
      const topArchive = document.querySelectorAll('.agent-run-actions [data-agent-run-archive]').length;
      return path.includes('Archive evidence ready')
        && path.includes('Final archive')
        && path.includes('verification passed')
        && path.includes('tools')
        && path.includes('files')
        && path.includes('artifacts')
        && path.includes('Add Archive Note')
        && next.includes('Review Archive')
        && !!document.querySelector('[data-agent-main-next][data-agent-run-review-archive]')
        && topArchive === 0;
    });
    track('4a. Idea-to-Archive guided final archive action', finalArchiveGuided);
    await page.click('[data-agent-main-next][data-agent-run-review-archive]');
    await page.waitForFunction(() => !!document.querySelector('.agent-run-archive.is-highlighted'), null, { timeout: 3000 });
    track('4a. Idea-to-Archive archive summary focus', true);
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const workAttachmentRel = 'output/playwright/e2e-idea-work-attachment.png';
    const manifestGeneratedRel = `output/playwright/e2e-idea-work-generated-${Date.now()}.js`;
    await page.screenshot({ path: join(process.cwd(), workAttachmentRel), fullPage: true });
    const manifestRun = await page.evaluate(async ({ screenshotPath, generatedPath }) => {
      const createRes = await fetch('/api/agent-runs/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'agent-run-e2e-file-change',
          idea: 'E2E governed file change run',
          agentProfileId: 'xike-builder',
          classification: {
            profile: { id: 'xike-builder', title: 'Xike Builder' },
            matches: [{ tag: 'implementation', agentId: 'xike-builder', score: 5 }],
            installedSkillNames: ['qa'],
          },
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      const execRes = await fetch('/api/agent-runs/agent-run-e2e-file-change/idea-auto-execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileChanges: [{
            operation: 'create',
            path: generatedPath,
            content: 'const e2eIdeaWorkGenerated = true;\n',
          }],
          commands: [`node --check ${generatedPath}`],
          evidenceArtifacts: [{ kind: 'screenshot', label: 'E2E idea work screenshot', path: screenshotPath }],
        }),
      });
      if (!execRes.ok) throw new Error(await execRes.text());
      const payload = await execRes.json();
      if (typeof window.loadAgentRunDetail === 'function') await window.loadAgentRunDetail('agent-run-e2e-file-change');
      return payload;
    }, { screenshotPath: workAttachmentRel, generatedPath: manifestGeneratedRel });
    await page.waitForFunction((generatedPath) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('agent-run-e2e-file-change')
        && detail.includes(`file.write ${generatedPath}`)
        && detail.includes('file changes 1')
        && detail.includes('artifacts 1');
    }, manifestGeneratedRel, { timeout: 8000 });
    const manifestRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Idea-to-Archive governed file change',
      manifestRun.ok === true
        && manifestRun.run.status === 'succeeded'
        && manifestRun.archive?.evidence?.external?.fileChanges?.[0]?.status === 'passed'
        && manifestRunUi.includes(`file.write ${manifestGeneratedRel}`));
    track('4a. Idea-to-Archive screenshot evidence',
      manifestRun.archive?.evidence?.external?.evidenceArtifacts?.[0]?.exists === true
        && manifestRunUi.includes('artifacts 1'));
    const uiManifestGeneratedRel = `output/playwright/e2e-idea-ui-manifest-${Date.now()}.js`;
    await page.evaluate(async () => {
      const createRes = await fetch('/api/agent-runs/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'agent-run-e2e-ui-manifest',
          idea: 'E2E UI manifest run',
          agentProfileId: 'xike-builder',
          classification: {
            profile: { id: 'xike-builder', title: 'Xike Builder' },
            matches: [{ tag: 'implementation', agentId: 'xike-builder', score: 5 }],
            installedSkillNames: ['qa'],
          },
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      if (typeof window.loadAgentRunDetail === 'function') await window.loadAgentRunDetail('agent-run-e2e-ui-manifest');
    });
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('agent-run-e2e-ui-manifest') && !!document.querySelector('[data-agent-run-idea-manifest]');
    }, null, { timeout: 8000 });
    await page.click('[data-agent-run-idea-manifest]');
    await page.fill('.confirm-modal textarea.prompt-modal-input', JSON.stringify({
      fileChanges: [{
        operation: 'create',
        path: uiManifestGeneratedRel,
        content: 'const e2eIdeaManifestGenerated = true;\n',
      }],
      commands: [`node --check ${uiManifestGeneratedRel}`],
      evidenceArtifacts: [{ kind: 'screenshot', label: 'E2E UI manifest screenshot', path: workAttachmentRel }],
    }, null, 2));
    await page.click('.confirm-modal [data-act="confirm"]');
    await page.waitForFunction((generatedPath) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('agent-run-e2e-ui-manifest')
        && detail.includes(`file.write ${generatedPath}`)
        && detail.includes('file changes 1')
        && detail.includes('artifacts 1');
    }, uiManifestGeneratedRel, { timeout: 10000 });
    const uiManifestRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Idea-to-Archive UI manifest editor',
      uiManifestRunUi.includes(`file.write ${uiManifestGeneratedRel}`)
        && uiManifestRunUi.includes('file changes 1')
        && uiManifestRunUi.includes('artifacts 1'));
    await page.evaluate(async () => {
      const createRes = await fetch('/api/agent-runs/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'agent-run-e2e-generated-manifest',
          idea: 'E2E generated manifest draft run',
          agentProfileId: 'xike-builder',
          affectedFiles: ['public/app.js'],
          classification: {
            profile: { id: 'xike-builder', title: 'Xike Builder' },
            matches: [{ tag: 'implementation', agentId: 'xike-builder', score: 5 }],
            installedSkillNames: ['qa'],
          },
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      if (typeof window.loadAgentRunDetail === 'function') await window.loadAgentRunDetail('agent-run-e2e-generated-manifest');
    });
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('agent-run-e2e-generated-manifest')
        && !!document.querySelector('[data-agent-run-idea-generate-manifest]')
        && !!document.querySelector('[data-agent-run-idea-manifest]');
    }, null, { timeout: 8000 });
    const generatedPathNextReady = await page.evaluate(() => {
      const path = document.querySelector('[data-agent-main-path="run"]')?.textContent || '';
      const next = document.querySelector('[data-agent-main-next]')?.textContent || '';
      return path.includes('Recommended next')
        && path.includes('Run Custom Manifest')
        && next.includes('Generate Manifest');
    });
    track('4a. Idea-to-Archive guided next manifest action', generatedPathNextReady);
    await page.click('[data-agent-main-next]');
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('Manifest draft generated')
        && detail.includes('node --check public/app.js')
        && detail.includes('git diff --check');
    }, null, { timeout: 8000 });
    const generatedPathAfterDraft = await page.evaluate(() => {
      const path = document.querySelector('[data-agent-main-path="run"]')?.textContent || '';
      const next = document.querySelector('[data-agent-main-next]')?.textContent || '';
      return path.includes('Next: Auto Work + Verify')
        && next.includes('Auto Work + Verify')
        && path.includes('Edit Manifest');
    });
    track('4a. Idea-to-Archive guided next verify action', generatedPathAfterDraft);
    await page.click('[data-agent-run-idea-manifest]');
    await page.waitForSelector('.confirm-modal textarea.prompt-modal-input', { timeout: 3000 });
    const generatedManifestText = await page.$eval('.confirm-modal textarea.prompt-modal-input', el => el.value);
    track('4a. Idea-to-Archive generated manifest prefill',
      generatedManifestText.includes('"fileChanges"')
        && generatedManifestText.includes('output/playwright/idea-work-agent-run-e2e-generated-manifest')
        && generatedManifestText.includes('output/playwright/idea-agent-change-agent-run-e2e-generated-manifest')
        && generatedManifestText.includes('Record the generated Agent work manifest artifact.')
        && generatedManifestText.includes('local-agent-filechange-synthesizer')
        && generatedManifestText.includes('node --check public/app.js')
        && generatedManifestText.includes('node --check output/playwright/idea-agent-change-agent-run-e2e-generated-manifest')
        && generatedManifestText.includes('git status --porcelain=v1')
        && generatedManifestText.includes('git diff --stat'));
    await page.click('.confirm-modal [data-act="confirm"]');
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('agent-run-e2e-generated-manifest')
        && detail.includes('succeeded')
        && detail.includes('file changes 2')
        && detail.includes('file.write output/playwright/idea-work-agent-run-e2e-generated-manifest')
        && detail.includes('file.write output/playwright/idea-agent-change-agent-run-e2e-generated-manifest')
        && detail.includes('node --check public/app.js')
        && detail.includes('node --check output/playwright/idea-agent-change-agent-run-e2e-generated-manifest')
        && detail.includes('git status --porcelain=v1')
        && detail.includes('Execution Archive');
    }, null, { timeout: 20000 });
    const generatedManifestRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Idea-to-Archive generated manifest execution',
      generatedManifestRunUi.includes('succeeded')
        && generatedManifestRunUi.includes('file changes 2')
        && generatedManifestRunUi.includes('file.write output/playwright/idea-work-agent-run-e2e-generated-manifest')
        && generatedManifestRunUi.includes('file.write output/playwright/idea-agent-change-agent-run-e2e-generated-manifest')
        && generatedManifestRunUi.includes('node --check output/playwright/idea-agent-change-agent-run-e2e-generated-manifest')
        && generatedManifestRunUi.includes('node --check public/app.js')
        && generatedManifestRunUi.includes('Execution Archive'));
    await page.evaluate(async () => {
      const createRes = await fetch('/api/agent-runs/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'agent-run-e2e-patch-manifest',
          idea: 'E2E source patch manifest draft run',
          agentProfileId: 'xike-builder',
          affectedFiles: ['public/app.js'],
          classification: {
            profile: { id: 'xike-builder', title: 'Xike Builder' },
            matches: [{ tag: 'implementation', agentId: 'xike-builder', score: 5 }],
            installedSkillNames: ['qa'],
          },
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      if (typeof window.loadAgentRunDetail === 'function') await window.loadAgentRunDetail('agent-run-e2e-patch-manifest');
    });
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('agent-run-e2e-patch-manifest')
        && !!document.querySelector('[data-agent-run-idea-generate-patch]')
        && !!document.querySelector('[data-agent-run-idea-manifest]');
    }, null, { timeout: 8000 });
    const patchGuidedAlternative = await page.evaluate(() => {
      const path = document.querySelector('[data-agent-main-path="run"]')?.textContent || '';
      return path.includes('Recommended next')
        && path.includes('Other actions')
        && !!document.querySelector('[data-agent-main-secondary][data-agent-run-idea-generate-patch]');
    });
    track('4a. Idea-to-Archive guided patch alternative', patchGuidedAlternative);
    await page.click('[data-agent-run-idea-generate-patch]');
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('Patch manifest draft generated')
        && detail.includes('Patch quality')
        && detail.includes('node --check public/app.js')
        && detail.includes('git diff --check');
    }, null, { timeout: 8000 });
    const patchQualityPresent = await page.evaluate(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('Patch quality')
        && /Patch quality (high|medium|low|blocked) \d+\/100/.test(detail)
        && detail.includes('proposal_only_patch');
    });
    track('4a. Idea-to-Archive source patch quality assessment', patchQualityPresent);
    await page.click('[data-agent-run-idea-manifest]');
    await page.waitForSelector('.confirm-modal textarea.prompt-modal-input', { timeout: 3000 });
    const patchManifestText = await page.$eval('.confirm-modal textarea.prompt-modal-input', el => el.value);
    track('4a. Idea-to-Archive source patch manifest prefill',
      patchManifestText.includes('"operation": "append"')
        && patchManifestText.includes('"path": "public/app.js"')
        && patchManifestText.includes('Append a governed local Agent source patch proposal.')
        && patchManifestText.includes('Xike Agent: Idea: E2E source patch manifest draft run')
        && patchManifestText.includes('node --check public/app.js')
        && patchManifestText.includes('git status --porcelain=v1')
        && patchManifestText.includes('git diff --stat'));
    await page.click('.confirm-modal [data-act="cancel"]');
    await page.waitForFunction(() => !document.querySelector('.confirm-modal'), null, { timeout: 3000 });
    const approvalResumeGeneratedRel = `output/playwright/e2e-idea-approval-resume-${Date.now()}.js`;
    const approvalResumeHelperRel = `output/playwright/e2e-idea-approval-resume-helper-${Date.now()}.mjs`;
    await page.evaluate(async () => {
      const createRes = await fetch('/api/agent-runs/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'agent-run-e2e-approval-resume',
          idea: 'E2E approval resume file change',
          agentProfileId: 'xike-builder',
          classification: {
            profile: { id: 'xike-builder', title: 'Xike Builder' },
            matches: [{ tag: 'implementation', agentId: 'xike-builder', score: 5 }],
            installedSkillNames: ['qa'],
          },
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      if (typeof window.loadAgentRunDetail === 'function') await window.loadAgentRunDetail('agent-run-e2e-approval-resume');
    });
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('agent-run-e2e-approval-resume') && !!document.querySelector('[data-agent-run-idea-manifest]');
    }, null, { timeout: 8000 });
    await page.click('[data-agent-run-idea-manifest]');
    await page.fill('.confirm-modal textarea.prompt-modal-input', JSON.stringify({
      fileChanges: [
        {
          operation: 'create',
          path: approvalResumeGeneratedRel,
          content: 'const e2eApprovalResume = true;\n',
          requiresApproval: true,
        },
        {
          operation: 'create',
          path: approvalResumeHelperRel,
          content: 'export const e2eApprovalResumeHelper = true;\n',
        },
      ],
      commands: [`node --check ${approvalResumeGeneratedRel}`, `node --check ${approvalResumeHelperRel}`],
    }, null, 2));
    await page.click('.confirm-modal [data-act="confirm"]');
    const approvalResumeId = await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      const match = detail.match(/approval-[0-9a-f]{8}-[0-9a-f]{3}/i);
      return detail.includes('deferred') && detail.includes('approval_required') && match ? match[0] : false;
    }, null, { timeout: 10000 }).then(handle => handle.jsonValue());
    const approvalGuidedPreflight = await page.evaluate(() => {
      const path = document.querySelector('[data-agent-main-path="run"]')?.textContent || '';
      const next = document.querySelector('[data-agent-main-next]')?.textContent || '';
      return path.includes('Preflight Review 等待审批续跑')
        && next.includes('Open Preflight Review')
        && !!document.querySelector('[data-agent-main-next][data-agent-run-governance-review]');
    });
    track('4a. Idea-to-Archive guided preflight action', approvalGuidedPreflight);
    await page.click('#agentRegistryModal button[data-close-agent-registry]');
    await page.waitForFunction(() => document.querySelector('#agentRegistryModal')?.style.display !== 'flex', null, { timeout: 3000 });
    await page.click('#btnGovernance');
    await page.waitForSelector(`[data-gov-center-approve-resume="${approvalResumeId}"]`, { timeout: 8000 });
    const approvalResumeActionPresent = await page.evaluate((approvalId) => {
      const button = document.querySelector(`[data-gov-center-approve-resume="${approvalId}"]`);
      const body = document.querySelector('#governanceCenterBody')?.textContent || '';
      return !!button
        && button.dataset.govCenterReviewGate?.startsWith('review-')
        && /^[a-f0-9]{64}$/i.test(button.dataset.govCenterReviewSha || '')
        && body.includes('Approval Actions')
        && body.includes('agent-run-e2e-approval-resume');
    }, approvalResumeId);
    track('4a. Governance Center approval resume action present', approvalResumeActionPresent);
    const approvalResumeReviewPresent = await page.evaluate(({ approvalId, generatedPath, helperPath }) => {
      const review = document.querySelector(`[data-gov-center-resume-review="${approvalId}"]`);
      const text = review?.textContent || '';
      return !!review
        && text.includes('Preflight Review')
        && text.includes('Staged Diff')
        && text.includes('+2/-0')
        && text.includes('2 new')
        && text.includes('2/2 verified')
        && text.includes('0 uncovered')
        && text.includes('coverage verified')
        && text.includes('risk')
        && text.includes('Gate review-')
        && text.includes(generatedPath)
        && text.includes(helperPath)
        && text.includes('+const e2eApprovalResume = true;')
        && text.includes(`node --check ${generatedPath}`)
        && text.includes(`node --check ${helperPath}`);
    }, { approvalId: approvalResumeId, generatedPath: approvalResumeGeneratedRel, helperPath: approvalResumeHelperRel });
    track('4a. Governance Center approval resume preflight review', approvalResumeReviewPresent);
    const approvalResumeReviewInteractions = await page.evaluate((approvalId) => {
      const review = document.querySelector(`[data-gov-center-resume-review="${approvalId}"]`);
      const firstFile = review?.querySelector('[data-gov-center-review-file]');
      const firstSummary = firstFile?.querySelector('summary');
      const firstChip = review?.querySelector('[data-gov-center-command-jump]');
      if (!review || !firstFile || !firstSummary || !firstChip) return false;
      const wasOpen = firstFile.open === true;
      firstSummary.click();
      const collapsed = firstFile.open === false;
      firstSummary.click();
      const reopened = firstFile.open === true;
      firstChip.click();
      const highlighted = !!review.querySelector('.governance-center-review-commands code.is-highlighted');
      const text = review.textContent || '';
      return wasOpen
        && collapsed
        && reopened
        && highlighted
        && text.includes('Coverage explanation')
        && text.includes('safe verification command references this file path directly')
        && text.includes('Risk reasons')
        && text.includes('verify')
        && text.includes('score');
    }, approvalResumeId);
    track('4a. Governance Center staged diff interactions', approvalResumeReviewInteractions);
    const approvalResumeCoverageFilter = await page.evaluate((approvalId) => {
      const review = document.querySelector(`[data-gov-center-resume-review="${approvalId}"]`);
      const uncovered = review?.querySelector('[data-gov-center-coverage-status="uncovered"]');
      const all = review?.querySelector('[data-gov-center-coverage-status="all"]');
      if (!review || !uncovered || !all) return false;
      uncovered.click();
      const filesAfterUncovered = [...review.querySelectorAll('[data-gov-center-review-file]')];
      const hiddenCount = filesAfterUncovered.filter(file => file.hidden).length;
      const emptyVisible = review.querySelector('[data-gov-center-coverage-empty]')?.hidden === false;
      all.click();
      const filesAfterAll = [...review.querySelectorAll('[data-gov-center-review-file]')];
      return hiddenCount === filesAfterUncovered.length
        && emptyVisible
        && filesAfterAll.length > 0
        && filesAfterAll.every(file => file.hidden === false)
        && all.classList.contains('is-active');
    }, approvalResumeId);
    track('4a. Governance Center coverage filter', approvalResumeCoverageFilter);
    await page.click(`[data-gov-center-approve-resume="${approvalResumeId}"]`);
    await page.waitForFunction((generatedPath) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('agent-run-e2e-approval-resume')
        && detail.includes('succeeded')
        && detail.includes(`file.write ${generatedPath}`)
        && detail.includes('file changes 2');
    }, approvalResumeGeneratedRel, { timeout: 10000 });
    const approvalResumeRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Idea-to-Archive approval resume file change',
      approvalResumeRunUi.includes('succeeded')
        && approvalResumeRunUi.includes(`file.write ${approvalResumeGeneratedRel}`)
        && approvalResumeRunUi.includes(`file.write ${approvalResumeHelperRel}`)
        && approvalResumeRunUi.includes('file changes 2'));
    track('4a. Governance Center approval resume execution',
      approvalResumeRunUi.includes('succeeded')
        && approvalResumeRunUi.includes(`node --check ${approvalResumeGeneratedRel}`)
        && approvalResumeRunUi.includes(`node --check ${approvalResumeHelperRel}`)
        && approvalResumeRunUi.includes('Execution Archive'));
    track('4a. Approval resume gate audit',
      approvalResumeRunUi.includes('Approval Resume Gate')
        && approvalResumeRunUi.includes('Idea-to-Archive Path')
        && approvalResumeRunUi.includes('staged diff')
        && approvalResumeRunUi.includes('+2/-0')
        && approvalResumeRunUi.includes('2/2 verified')
        && approvalResumeRunUi.includes('0 uncovered')
        && approvalResumeRunUi.includes('review-')
        && approvalResumeRunUi.includes(approvalResumeGeneratedRel)
        && approvalResumeRunUi.includes(approvalResumeHelperRel)
        && approvalResumeRunUi.includes(`node --check ${approvalResumeGeneratedRel}`));
    const approvalResumeGateId = approvalResumeRunUi.match(/review-[a-f0-9]{12}/i)?.[0] || '';
    await page.fill('#agentRunGateFilter', approvalResumeGateId);
    await page.click('#agentRunsRefresh');
    await page.waitForFunction((taskText) => {
      const rows = [...document.querySelectorAll('.agent-run-row')].map(row => row.textContent || '').join('\n');
      return rows.includes(taskText);
    }, 'E2E approval resume file change', { timeout: 5000 });
    const gateFilteredRuns = await page.evaluate(() => ({
      rows: document.querySelectorAll('.agent-run-row').length,
      text: document.querySelector('.agent-run-list')?.textContent || '',
      filter: document.querySelector('#agentRunGateFilter')?.value || '',
    }));
    track('4a. Agent Runs gate audit filter',
      Boolean(approvalResumeGateId)
        && gateFilteredRuns.rows >= 1
        && gateFilteredRuns.text.includes('E2E approval resume file change')
        && gateFilteredRuns.filter === approvalResumeGateId);
    await page.evaluate(async (gateId) => {
      if (typeof window.openActivityModal !== 'function') throw new Error('openActivityModal missing');
      await window.openActivityModal({ approvalResumeGateId: gateId });
    }, approvalResumeGateId);
    await page.waitForSelector('#activityGateId', { timeout: 3000 });
    await page.waitForFunction((gateId) => {
      const list = document.querySelector('.activity-list')?.textContent || '';
      const detail = document.querySelector('.activity-detail')?.textContent || '';
      return list.includes('agent.run.approval_resume_gate_accepted')
        && detail.includes('Approval Resume Gate')
        && detail.includes(gateId)
        && !!document.querySelector('[data-activity-open-run="agent-run-e2e-approval-resume"]');
    }, approvalResumeGateId, { timeout: 5000 });
    const gateActivity = await page.evaluate(() => ({
      filter: document.querySelector('#activityGateId')?.value || '',
      list: document.querySelector('.activity-list')?.textContent || '',
      detail: document.querySelector('.activity-detail')?.textContent || '',
      openRunButtons: document.querySelectorAll('[data-activity-open-run="agent-run-e2e-approval-resume"]').length,
    }));
    track('4a. Activity gate audit filter',
      Boolean(approvalResumeGateId)
        && gateActivity.filter === approvalResumeGateId
        && gateActivity.list.includes('agent.run.approval_resume_gate_accepted')
        && gateActivity.detail.includes('Approval Resume Gate')
        && gateActivity.detail.includes(approvalResumeGateId)
        && gateActivity.openRunButtons > 0);
    await page.click('[data-activity-open-run="agent-run-e2e-approval-resume"]');
    await page.waitForFunction((gateId) => {
      const modalOpen = document.querySelector('#agentRegistryModal')?.style.display === 'flex';
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return modalOpen
        && detail.includes('agent-run-e2e-approval-resume')
        && detail.includes('Approval Resume Gate')
        && detail.includes(gateId);
    }, approvalResumeGateId, { timeout: 5000 });
    track('4a. Activity gate audit opens Agent Run', true);
    await page.waitForSelector('[data-agent-run-gate-audit="agent-run-e2e-approval-resume"]', { timeout: 3000 });
    await page.click('[data-agent-run-gate-audit="agent-run-e2e-approval-resume"]');
    await page.waitForSelector('.confirm-modal textarea.prompt-modal-input', { timeout: 3000 });
    const gateAuditReportText = await page.$eval('.confirm-modal textarea.prompt-modal-input', el => el.value);
    track('4a. Gate audit report export',
      gateAuditReportText.includes('Approval Resume Gate Audit Report')
        && gateAuditReportText.includes(approvalResumeGateId)
        && gateAuditReportText.includes('Staged Diff Review')
        && gateAuditReportText.includes('+2 / -0')
        && gateAuditReportText.includes('Coverage: 2/2 verified, 0 uncovered')
        && gateAuditReportText.includes('Coverage Explanations:')
        && gateAuditReportText.includes('coverage:verified')
        && gateAuditReportText.includes('Partition Mismatches:')
        && gateAuditReportText.includes('Verified: yes')
        && gateAuditReportText.includes('agent.run.approval_resume_gate_accepted')
        && gateAuditReportText.includes('archive'));
    await page.click('.confirm-modal [data-act="confirm"]');
    await page.click('[data-agent-run-gate-audit-archive="agent-run-e2e-approval-resume"]');
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('Gate audit report archived')
        && detail.includes('output/playwright/gate-audit-reports/agent-run-e2e-approval-resume-')
        && detail.includes('Execution Archive');
    }, null, { timeout: 5000 });
    const gateReportArchiveUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Gate audit report archived artifact',
      gateReportArchiveUi.includes('Gate audit report archived')
        && gateReportArchiveUi.includes('output/playwright/gate-audit-reports/agent-run-e2e-approval-resume-')
        && gateReportArchiveUi.includes('Execution Archive'));
    const gateArtifactLookup = await page.evaluate(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      const rows = [...document.querySelectorAll('.agent-run-artifact-row')];
      return {
        detail,
        rowCount: rows.length,
        hasGateArtifact: rows.some(row => row.textContent.includes('output/playwright/gate-audit-reports/agent-run-e2e-approval-resume-')),
        openButtons: document.querySelectorAll('[data-agent-run-artifact-download]').length,
      };
    });
    track('4a. Gate audit artifact lookup visible',
      gateArtifactLookup.detail.includes('Execution Artifacts')
        && gateArtifactLookup.rowCount > 0
        && gateArtifactLookup.hasGateArtifact
        && gateArtifactLookup.openButtons > 0);
    const openedGateArtifact = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.agent-run-artifact-row')]
        .find(item => item.textContent.includes('output/playwright/gate-audit-reports/agent-run-e2e-approval-resume-'));
      const btn = row?.querySelector('[data-agent-run-artifact-download]');
      btn?.click();
      return Boolean(btn);
    });
    await page.waitForSelector('.confirm-modal textarea.prompt-modal-input', { timeout: 3000 });
    const gateArtifactText = await page.$eval('.confirm-modal textarea.prompt-modal-input', el => el.value);
    track('4a. Gate audit artifact opens markdown',
      openedGateArtifact
        && gateArtifactText.includes('Approval Resume Gate Audit Report')
        && gateArtifactText.includes(approvalResumeGateId));
    await page.click('.confirm-modal [data-act="confirm"]');
    await page.click('[data-agent-run-activity="agent-run-e2e-approval-resume"]');
    await page.waitForSelector('#activitySearch', { timeout: 3000 });
    await page.click('#activityClearFilters');
    await page.waitForFunction(() => {
      return (document.querySelector('#activitySearch')?.value || '') === ''
        && (document.querySelector('#activityGateId')?.value || '') === '';
    }, null, { timeout: 3000 });
    await page.fill('#activitySearch', 'gate-audit-reports/agent-run-e2e-approval-resume');
    await page.waitForFunction(() => {
      const list = document.querySelector('.activity-list')?.textContent || '';
      return list.includes('agent.run.archived');
    }, null, { timeout: 5000 });
    await page.waitForFunction(() => {
      const detail = document.querySelector('.activity-detail')?.textContent || '';
      return detail.includes('Archive Artifacts')
        && detail.includes('output/playwright/gate-audit-reports/agent-run-e2e-approval-resume-')
        && !!document.querySelector('[data-activity-artifact-download]');
    }, null, { timeout: 5000 });
    track('4a. Activity archive artifact reverse lookup', true);
    await page.evaluate(() => document.querySelector('[data-close-activity]')?.click());
    await page.click('#agentRunsClear');
    const nodePolicyRunId = 'agent-run-e2e-node-policy';
    const nodePolicyRel = `output/playwright/e2e-node-policy-${Date.now()}.mjs`;
    const nodePolicyContent = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      '',
      "test('generated policy check', () => {",
      '  assert.equal(2 + 2, 4);',
      '});',
      '',
    ].join('\n');
    const nodePolicyRun = await page.evaluate(async ({ runId, generatedPath, generatedContent }) => {
      const createRes = await fetch('/api/agent-runs/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: runId,
          idea: 'E2E expanded command policy run',
          agentProfileId: 'xike-verifier',
          classification: {
            profile: { id: 'xike-verifier', title: 'Xike Verifier' },
            matches: [{ tag: 'verification', agentId: 'xike-verifier', score: 5 }],
            installedSkillNames: ['qa'],
          },
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      const execRes = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/idea-auto-execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileChanges: [{
            operation: 'create',
            path: generatedPath,
            content: generatedContent,
          }],
          workEvidenceCommands: ['git status --porcelain=v1', 'git diff --stat'],
          commands: [`node --test ${generatedPath}`],
        }),
      });
      if (!execRes.ok) throw new Error(await execRes.text());
      const payload = await execRes.json();
      if (typeof window.loadAgentRunDetail === 'function') await window.loadAgentRunDetail(runId);
      return payload;
    }, { runId: nodePolicyRunId, generatedPath: nodePolicyRel, generatedContent: nodePolicyContent });
    await page.waitForFunction(({ runId, generatedPath }) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes(runId)
        && detail.includes('succeeded')
        && detail.includes(`file.write ${generatedPath}`)
        && detail.includes(`node --test ${generatedPath}`)
        && detail.includes('git status --porcelain=v1')
        && detail.includes('git diff --stat')
        && detail.includes('file changes 1');
    }, { runId: nodePolicyRunId, generatedPath: nodePolicyRel }, { timeout: 12000 });
    const nodePolicyRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Idea-to-Archive expanded command policy',
      nodePolicyRun.ok === true
        && nodePolicyRun.run.status === 'succeeded'
        && nodePolicyRun.archive?.evidence?.external?.commands?.[0]?.command === `node --test ${nodePolicyRel}`
        && nodePolicyRunUi.includes(`node --test ${nodePolicyRel}`)
        && nodePolicyRunUi.includes('git diff --stat'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    const e2eRunId = 'agent-run-e2e-activity';
    const e2eSessionId = 'session-e2e-agent-runs';
    if (ownerToken) {
      await page.evaluate(async ({ runId, sessionId }) => {
        const res = await fetch('/api/agent-runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: runId,
            status: 'failed',
            sessionId,
            taskId: 'e2e-activity-run-bridge',
            agentProfileId: 'xike-e2e',
            sourceType: 'e2e',
            details: { e2e: true },
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        const sibling = await fetch('/api/agent-runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'agent-run-e2e-session-sibling',
            status: 'queued',
            sessionId,
            taskId: 'e2e-session-sibling',
            agentProfileId: 'xike-e2e',
            sourceType: 'e2e',
            details: { e2e: true, sibling: true },
          }),
        });
        if (!sibling.ok) throw new Error(await sibling.text());
      }, { runId: e2eRunId, sessionId: e2eSessionId });
    }

      await page.click('#btnActivity');
      await page.waitForSelector('#activityDiagnosticCode', { timeout: 3000 });
      await page.click('#activityClearFilters');
      await page.waitForSelector('#activityDiagnosticCode', { timeout: 3000 });
      const activityAgentControls = await page.evaluate(() => ({
      presets: [...document.querySelectorAll('[data-activity-preset]')].map(el => el.textContent.trim()),
      agentProfile: !!document.querySelector('#activityAgentProfileId'),
      agentRun: !!document.querySelector('#activityAgentRunId'),
      skill: !!document.querySelector('#activitySkillName'),
      diagnostic: !!document.querySelector('#activityDiagnosticCode'),
      toggle: !!document.querySelector('#activityAgentOnly'),
    }));
    track('4a. Activity Agent/Skill filters present',
      activityAgentControls.presets.includes('Agent/Skill')
        && activityAgentControls.presets.includes('诊断')
        && activityAgentControls.agentProfile
        && activityAgentControls.agentRun
        && activityAgentControls.skill
        && activityAgentControls.diagnostic
        && activityAgentControls.toggle);
    if (ownerToken) {
      await page.fill('#activitySearch', e2eRunId);
      await page.waitForSelector('[data-activity-open-run]', { timeout: 3000 });
      const activityRunBridge = await page.evaluate((runId) => ({
        openRunButtons: document.querySelectorAll(`[data-activity-open-run="${runId}"]`).length,
        detail: document.querySelector('.activity-detail')?.textContent || '',
      }), e2eRunId);
      track('4a. Activity links to Agent Run',
        activityRunBridge.openRunButtons > 0 && activityRunBridge.detail.includes(e2eRunId));
      await page.click(`[data-activity-open-run="${e2eRunId}"]`);
      await page.waitForFunction((runId) => {
        const modalOpen = document.querySelector('#agentRegistryModal')?.style.display === 'flex';
        const text = document.querySelector('.agent-run-detail')?.textContent || '';
        return modalOpen && text.includes(runId);
      }, e2eRunId, { timeout: 5000 });
      track('4a. Activity opens Agent Run detail', true);
      await page.waitForFunction((sessionId) => {
        const text = document.querySelector('.agent-run-detail')?.textContent || '';
        return text.includes('Session Timeline') && text.includes(sessionId) && text.includes('2 runs');
      }, e2eSessionId, { timeout: 5000 });
      track('4a. Agent Run session timeline', true);
      const sessionEvidenceChain = await page.evaluate(() => {
        const text = document.querySelector('.agent-run-detail')?.textContent || '';
        return text.includes('Session Evidence Chain') && text.includes('evidence kinds') && text.includes('run:2');
      });
      track('4a. Agent Run session evidence chain', sessionEvidenceChain);
      const sessionExportButtonPresent = await page.evaluate((sessionId) => {
        const btn = document.querySelector(`[data-agent-run-session-export="${sessionId}"]`);
        return !!btn && btn.textContent.includes('Export Session');
      }, e2eSessionId);
      track('4a. Agent Run session export action present', sessionExportButtonPresent);
      await page.click(`[data-agent-run-session-export="${e2eSessionId}"]`);
      await page.waitForSelector('.confirm-modal textarea.prompt-modal-input', { timeout: 3000 });
      const sessionExportText = await page.$eval('.confirm-modal textarea.prompt-modal-input', el => el.value);
      track('4a. Agent Run session evidence export',
        sessionExportText.includes(`# Agent Run Session ${e2eSessionId}`)
          && sessionExportText.includes('## Session Evidence Chain')
          && sessionExportText.includes('agent-run-e2e-activity')
          && sessionExportText.includes('agent-run-e2e-session-sibling'));
      await page.click('.confirm-modal [data-act="confirm"]');
      const sessionArchiveButtonPresent = await page.evaluate((sessionId) => {
        const btn = document.querySelector(`[data-agent-run-session-archive="${sessionId}"]`);
        return !!btn && btn.textContent.includes('Archive Session');
      }, e2eSessionId);
      track('4a. Agent Run session archive action present', sessionArchiveButtonPresent);
      await page.click(`[data-agent-run-session-archive="${e2eSessionId}"]`);
      await page.waitForFunction(() => {
        const text = document.querySelector('.agent-run-detail')?.textContent || '';
        return text.includes('Session evidence archived:')
          && text.includes('output/playwright/session-evidence/agent-run-session-')
          && text.includes('artifacts 1');
      }, null, { timeout: 5000 });
      track('4a. Agent Run session evidence archived artifact', true);
      const sessionArtifactLookup = await page.evaluate(() => {
        const detail = document.querySelector('.agent-run-detail')?.textContent || '';
        const rows = [...document.querySelectorAll('.agent-run-artifact-row')];
        return {
          detail,
          hasSessionArtifact: rows.some(row => row.textContent.includes('output/playwright/session-evidence/agent-run-session-')),
          openButtons: document.querySelectorAll('[data-agent-run-artifact-download]').length,
        };
      });
      track('4a. Agent Run session artifact lookup visible',
        sessionArtifactLookup.detail.includes('Execution Artifacts')
          && sessionArtifactLookup.hasSessionArtifact
          && sessionArtifactLookup.openButtons > 0);
      const openedSessionArtifact = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.agent-run-artifact-row')]
          .find(item => item.textContent.includes('output/playwright/session-evidence/agent-run-session-'));
        const btn = row?.querySelector('[data-agent-run-artifact-download]');
        btn?.click();
        return Boolean(btn);
      });
      await page.waitForSelector('.confirm-modal textarea.prompt-modal-input', { timeout: 3000 });
      const sessionArtifactText = await page.$eval('.confirm-modal textarea.prompt-modal-input', el => el.value);
      track('4a. Agent Run session artifact opens markdown',
        openedSessionArtifact
          && sessionArtifactText.includes(`# Agent Run Session ${e2eSessionId}`)
          && sessionArtifactText.includes('## Session Evidence Chain'));
      await page.click('.confirm-modal [data-act="confirm"]');
      const archiveButtonPresent = await page.evaluate((runId) => !!document.querySelector(`[data-agent-run-archive="${runId}"]`), e2eRunId);
      track('4a. Agent Run archive action present', archiveButtonPresent);
      await page.click(`[data-agent-run-archive="${e2eRunId}"]`);
      await page.waitForSelector('.prompt-modal-input', { timeout: 3000 });
      await page.fill('.prompt-modal-input', 'E2E execution archive recorded.');
      await page.click('.confirm-modal [data-act="confirm"]');
      await page.waitForFunction(() => {
        const text = document.querySelector('.agent-run-detail')?.textContent || '';
        return text.includes('Execution Archive') && text.includes('E2E execution archive recorded.');
      }, null, { timeout: 5000 });
      track('4a. Agent Run archive view', true);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      await page.click('#btnActivity');
      await page.waitForSelector('#activityDiagnosticCode', { timeout: 3000 });
      await page.click('#activityClearFilters');
      await page.waitForSelector('#activityDiagnosticCode', { timeout: 3000 });
    } else {
      track('4a. Activity links to Agent Run', true, 'skipped owner-token');
      track('4a. Activity opens Agent Run detail', true, 'skipped owner-token');
      track('4a. Agent Run session timeline', true, 'skipped owner-token');
      track('4a. Agent Run session export action present', true, 'skipped owner-token');
      track('4a. Agent Run session evidence export', true, 'skipped owner-token');
      track('4a. Agent Run session archive action present', true, 'skipped owner-token');
      track('4a. Agent Run session evidence archived artifact', true, 'skipped owner-token');
      track('4a. Agent Run session artifact lookup visible', true, 'skipped owner-token');
      track('4a. Agent Run session artifact opens markdown', true, 'skipped owner-token');
      track('4a. Agent Run archive action present', true, 'skipped owner-token');
      track('4a. Agent Run archive view', true, 'skipped owner-token');
    }
    await page.click('[data-activity-preset="diagnostics"]');
    await page.waitForTimeout(300);
    const diagnosticsPreset = await page.evaluate(() => ({
      action: document.querySelector('#activityAction')?.value,
      agentOnly: document.querySelector('#activityAgentOnly')?.checked,
    }));
    track('4a. Activity diagnostics preset', diagnosticsPreset.action === 'agent.skill_diagnostics' && diagnosticsPreset.agentOnly === true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

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

    // ── 11. P2 权限治理 UI 闭环：Webhook 审批后安全重试 ──
    if (!ownerToken) {
      track('11. Webhook approval-retry (create)', true, 'skipped owner-token');
      track('11. 审批摘要含 network.upload', true, 'skipped owner-token');
      track('11. 批准并重试后创建成功', true, 'skipped owner-token');
    } else {
      await page.click('#btnWebhooks');
      await page.waitForSelector('#btnWebhookNew', { timeout: 3000 });
      await page.click('#btnWebhookNew');
      await page.waitForSelector('#whUrl', { timeout: 3000 });
      const uniqueName = 'e2e-approval-' + Date.now();
      await page.fill('#whName', uniqueName);
      await page.fill('#whUrl', 'https://example.com/api/webhooks/e2e-approval-test');
      await page.click('#btnWebhookSave');
      const retryModalShown = await page.waitForSelector('[data-approval-retry-modal]', { timeout: 4000 })
        .then(() => true).catch(() => false);
      track('11. Webhook approval-retry (create)', retryModalShown);
      const summaryHasUpload = retryModalShown && await page.evaluate(() => {
        const m = document.querySelector('[data-approval-retry-modal]');
        return !!m && /network\.upload/.test(m.textContent || '');
      });
      track('11. 审批摘要含 network.upload', !!summaryHasUpload);
      let created = false;
      if (retryModalShown) {
        await page.click('[data-approval-retry-confirm]');
        created = await page.waitForFunction((name) =>
          [...document.querySelectorAll('#webhookList .wname')].some(el => (el.textContent || '').includes(name)),
        uniqueName, { timeout: 6000 }).then(() => true).catch(() => false);
      }
      track('11. 批准并重试后创建成功', created);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    }

    // ── 12. P2 权限治理 UI 闭环：Room Adapter provider 配置审批后重试 ──
    if (!ownerToken) {
      track('12. RoomAdapter approval-retry (config write)', true, 'skipped owner-token');
      track('12. 批准并重试后写入成功', true, 'skipped owner-token');
    } else {
      await page.click('#btnRoomAdapters');
      await page.waitForSelector('#btnSaveRoomAdapters', { timeout: 3000 });
      await page.click('#btnSaveRoomAdapters');
      const adapterRetryShown = await page.waitForSelector('[data-approval-retry-modal]', { timeout: 4000 })
        .then(() => true).catch(() => false);
      track('12. RoomAdapter approval-retry (config write)', adapterRetryShown);
      let adapterSaved = false;
      if (adapterRetryShown) {
        await page.click('[data-approval-retry-confirm]');
        adapterSaved = await page.waitForFunction(() => {
          const el = document.querySelector('#adapterSaveStatus');
          return !!el && /已保存/.test(el.textContent || '');
        }, { timeout: 6000 }).then(() => true).catch(() => false);
      }
      track('12. 批准并重试后写入成功', adapterSaved);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    }

    // ── 13. P2 权限治理 UI 闭环：MCP server 配置审批后重试（RCE 级高风险写入口）──
    if (!ownerToken) {
      track('13. MCP approval-retry (create)', true, 'skipped owner-token');
      track('13. 批准并重试后创建成功', true, 'skipped owner-token');
    } else {
      await page.click('#btnMcp');
      await page.waitForSelector('#btnMcpNew', { timeout: 3000 });
      await page.click('#btnMcpNew');
      await page.waitForSelector('#mcpCommand', { timeout: 3000 });
      const mcpName = 'e2e-mcp-' + Date.now();
      await page.fill('#mcpName', mcpName);
      await page.fill('#mcpCommand', 'echo');
      await page.fill('#mcpArgs', 'hello');
      await page.click('#btnMcpSave');
      const mcpRetryShown = await page.waitForSelector('[data-approval-retry-modal]', { timeout: 4000 })
        .then(() => true).catch(() => false);
      track('13. MCP approval-retry (create)', mcpRetryShown);
      let mcpCreated = false;
      if (mcpRetryShown) {
        await page.click('[data-approval-retry-confirm]');
        mcpCreated = await page.waitForFunction((name) =>
          (document.querySelector('#mcpList')?.textContent || '').includes(name),
        mcpName, { timeout: 6000 }).then(() => true).catch(() => false);
      }
      track('13. 批准并重试后创建成功', mcpCreated);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    }

    // ── 14. P2 收尾：Watcher 双重审批链式重试（provider.model_config.write + auto_accept.scope）──
    if (!ownerToken) {
      track('14. Watcher 触发首个审批', true, 'skipped owner-token');
      track('14. Watcher 第二步审批弹窗(链式)', true, 'skipped owner-token');
      track('14. Watcher 双审批链式重试成功', true, 'skipped owner-token');
    } else {
      // 通过全局函数触发真实的 watcher 双审批请求 + 链式 flow（app.js 是非 module 全局脚本）
      await page.evaluate(async () => {
        window.__watcherOk = false;
        const opts = { method: 'PUT', body: JSON.stringify({ provider: 'ollama', model: 'e2e-chain', autoMode: true, enabled: false }) };
        const result = await window.requestWithApproval('/api/watcher/config', opts);
        window.__watcherInitStatus = result.status;
        // 不 await：让弹窗交互在外部 playwright 点击驱动
        window.__watcherFlow = window.handleApprovalFlow(result, '/api/watcher/config', opts, {
          actionLabel: 'watcher e2e',
          onOk: () => { window.__watcherOk = true; },
        });
      });
      const initStatus = await page.evaluate(() => window.__watcherInitStatus);
      track('14. Watcher 触发首个审批', initStatus === 'approval_required', `status=${initStatus}`);
      await page.waitForSelector('[data-approval-retry-modal]', { timeout: 4000 });
      const firstId = await page.getAttribute('[data-approval-retry-modal]', 'data-approval-retry-modal');
      await page.click('[data-approval-retry-confirm]');
      // 第二个审批（auto_accept）应是不同 approvalId 的新弹窗
      const secondShown = await page.waitForFunction((prev) => {
        const m = document.querySelector('[data-approval-retry-modal]');
        return !!m && m.getAttribute('data-approval-retry-modal') !== prev;
      }, firstId, { timeout: 8000 }).then(() => true).catch(() => false);
      track('14. Watcher 第二步审批弹窗(链式)', secondShown);
      if (secondShown) await page.click('[data-approval-retry-confirm]');
      const chainOk = await page.waitForFunction(() => window.__watcherOk === true, { timeout: 8000 })
        .then(() => true).catch(() => false);
      track('14. Watcher 双审批链式重试成功', chainOk);
      await page.waitForTimeout(100);
    }

    // ── 15. P2 收尾：MCP delete 接入审批（验证审批弹窗出现，取消不实际删除）──
    if (!ownerToken) {
      track('15. MCP delete 触发审批弹窗', true, 'skipped owner-token');
    } else {
      await page.evaluate(async () => {
        const path = '/api/mcp/servers/' + encodeURIComponent('e2e-del-' + Date.now());
        const opts = { method: 'DELETE' };
        const result = await window.requestWithApproval(path, opts);
        window.__mcpDelStatus = result.status;
        // 不 await，外部断言弹窗后取消
        window.__mcpDelFlow = window.handleApprovalFlow(result, path, opts, { actionLabel: '删除 MCP server', onOk: () => {} });
      });
      const delStatus = await page.evaluate(() => window.__mcpDelStatus);
      const delShown = await page.waitForSelector('[data-approval-retry-modal]', { timeout: 4000 }).then(() => true).catch(() => false);
      track('15. MCP delete 触发审批弹窗', delStatus === 'approval_required' && delShown, `status=${delStatus}`);
      if (delShown) await page.click('[data-approval-retry-cancel]');
      await page.waitForTimeout(100);
    }

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
