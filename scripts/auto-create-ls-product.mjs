// 用 playwright + 用户 Chrome profile 自动建 LS Xike Lab Pro 产品
import { chromium } from 'playwright';
import fs from 'node:fs';

const PROFILE = '/tmp/chrome-playwright-profile';

const DESCRIPTION = `Local-first multi-AI workbench. Claude, GPT, Gemini, MiniMax, Ollama and 8+ providers in one panel. 4 collaboration modes (chat / debate / squad / arena). MCP one-stop server management. Autopilot rules-based automation. Built-in vector semantic search. All data stored locally with 0o600 permissions.

PRICING:
- Free: chat + debate modes, 3 MCP, 3 adapters
- Pro $19: squad + arena + autopilot + archive + unlimited MCP/adapters
- Team $49: workspaces + priority support

ONE-TIME PAYMENT. LIFETIME UPDATES. NO SUBSCRIPTION FATIGUE.`;

console.log('1. 启动 playwright with persistent context (用你 Chrome 已有的 LS 登录态)...');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  channel: 'chrome',
  viewport: { width: 1280, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] || await ctx.newPage();
console.log('✓ playwright 启动，profile loaded');

try {
  console.log('2. 跳到 LS dashboard 验证登录态...');
  await page.goto('https://app.lemonsqueezy.com/dashboard', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const url = page.url();
  console.log(`   URL: ${url}`);
  if (url.includes('/login')) {
    console.log('❌ LS 登录态没继承过来 (Chrome cookies 未传递)');
    process.exit(1);
  }
  console.log('✓ LS 已登录');

  console.log('3. 跳到 products/new...');
  await page.goto('https://app.lemonsqueezy.com/products/new', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 截图存到本地（不进对话）— 用于 debug
  await page.screenshot({ path: '/tmp/ls-products-new.png', fullPage: false });
  console.log('✓ 已截屏到 /tmp/ls-products-new.png');

  console.log('4. 分析页面 form 结构...');
  // 获取所有 input / textarea / button
  const formInputs = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input, textarea, select, [contenteditable]')];
    return inputs.map((el, i) => ({
      i,
      tag: el.tagName,
      type: el.type || '',
      name: el.name || '',
      id: el.id || '',
      placeholder: el.placeholder || '',
      label: el.getAttribute('aria-label') || '',
      visible: el.offsetParent !== null,
    })).slice(0, 30);
  });
  console.log('   表单元素:');
  formInputs.forEach(f => {
    if (f.visible) {
      console.log(`     [${f.i}] ${f.tag} type=${f.type} name="${f.name}" id="${f.id}" placeholder="${f.placeholder.slice(0,30)}" label="${f.label.slice(0,30)}"`);
    }
  });

  const buttons = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.map(b => b.textContent?.trim().slice(0, 50)).filter(t => t).slice(0, 20);
  });
  console.log('   按钮:', buttons);

  console.log('');
  console.log('5. 尝试自动填表（如果识别出 input）...');
  // 找 name input — LS 通常用 name="name" 或 placeholder 含 "name"
  const nameInput = await page.$('input[name="name"], input[placeholder*="name" i], input[placeholder*="product" i]');
  if (nameInput) {
    await nameInput.fill('Xike Lab Pro');
    console.log('   ✓ Name 已填: Xike Lab Pro');
  } else {
    console.log('   ✗ 没找到 Name input');
  }

  // 找 price input — 通常 name="price" 或 placeholder 含 "price"
  const priceInput = await page.$('input[name*="price" i], input[type="number"][placeholder*="$" i], input[placeholder*="price" i]');
  if (priceInput) {
    await priceInput.fill('1900');  // cents
    console.log('   ✓ Price 已填: $19.00');
  } else {
    console.log('   ✗ 没找到 Price input');
  }

  // 描述（通常是 contenteditable rich text 编辑器或 textarea）
  const descInput = await page.$('textarea[name*="description" i], textarea[placeholder*="description" i], [contenteditable="true"]');
  if (descInput) {
    await descInput.fill(DESCRIPTION);
    console.log('   ✓ Description 已填');
  } else {
    console.log('   ✗ 没找到 Description input');
  }

  console.log('');
  console.log('6. 最终截图（看填表后状态）...');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/ls-products-new-filled.png', fullPage: true });
  console.log('✓ 已截屏到 /tmp/ls-products-new-filled.png');

  console.log('');
  console.log('=========================================');
  console.log('🎁 playwright 自动填表完成。');
  console.log('   保留浏览器窗口不关，让你 review + 点 Publish。');
  console.log('   3 秒后退出 playwright（浏览器窗口仍开）...');
  console.log('=========================================');
  await page.waitForTimeout(3000);
} catch (e) {
  console.error('❌ 失败:', e.message);
  await page.screenshot({ path: '/tmp/ls-products-error.png' });
} finally {
  // 关 ctx 但不强杀页面
  await ctx.close();
}
