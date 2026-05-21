// S18-7 panel smoke — 5 个核心用户流程覆盖
// 不依赖 @playwright/test（避免装新依赖）；用 Node fetch + 静态 HTML 解析
// 跑：cd panel && node .s18-7-panel-smoke.mjs
//
// 跑过的 panel 当前在 127.0.0.1:51735 → 跑旧 server（S18-2 重启前）
// 重启后该脚本可重跑验证新 server.js 行为一致

const BASE = 'http://127.0.0.1:51735';
const tests = [];
const t = (n, ok, d) => tests.push({ n, ok, d: d || '' });

async function getJSON(path) {
  const r = await fetch(BASE + path);
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
async function getText(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, text: await r.text() };
}

// === 流程 1: 主页加载 + 标题正确 + 引用关键资源 ===
{
  const r = await getText('/');
  t('流程 1.1 GET / → 200', r.status === 200);
  t('流程 1.2 标题正确', r.text.includes('<title>Roundtable</title>'));
  t('流程 1.3 引用 Modal.js + UI.js（S18-3/S18-4）',
    r.text.includes('/src/components/Modal.js') && r.text.includes('/src/components/UI.js'));
  t('流程 1.4 引用 app.js', r.text.includes('/app.js'));
}

// === 流程 2: 静态资源 200 ===
{
  for (const p of ['/style.css', '/app.js', '/src/components/Modal.js', '/src/components/UI.js']) {
    const r = await fetch(BASE + p);
    t(`流程 2 GET ${p} → 200`, r.status === 200, 'status=' + r.status);
  }
}

// === 流程 3: 会话 API（核心 panel 功能）===
{
  const r = await getJSON('/api/sessions');
  t('流程 3.1 GET /api/sessions → 200 + 数组',
    r.status === 200 && Array.isArray(r.body),
    'status=' + r.status);
  const r2 = await getJSON('/api/sessions?archived=1');
  t('流程 3.2 GET /api/sessions?archived=1 → 200 + 数组',
    r2.status === 200 && Array.isArray(r2.body));
}

// === 流程 4: webhook API（S18-2a 提取，验证行为不变）===
{
  const r = await getJSON('/api/webhooks');
  t('流程 4.1 GET /api/webhooks → ok:true + webhooks 数组',
    r.status === 200 && r.body && r.body.ok === true && Array.isArray(r.body.webhooks),
    JSON.stringify(r));
  // 测 PUT 不存在 → 404
  const r2 = await fetch(BASE + '/api/webhooks/__nonexistent__', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://localhost/x', name: 'x', format: 'json' }),
  });
  const body2 = await r2.json();
  t('流程 4.2 PUT /api/webhooks/missing → 404 + not found',
    r2.status === 404 && body2.error === 'not found',
    JSON.stringify({s: r2.status, b: body2}));
}

// === 流程 5: rooms / archive / mcp / autopilot / skills / knowledge 各 LIST 200 ===
{
  const endpoints = [
    '/api/rooms',
    '/api/archive/config',
    '/api/archive/list',
    '/api/mcp/servers',
    '/api/autopilot/config',
    '/api/skills',
    '/api/knowledge',
    '/api/room-templates',
  ];
  for (const ep of endpoints) {
    const r = await getJSON(ep);
    t(`流程 5 GET ${ep} → 200`, r.status === 200, 'status=' + r.status);
  }
}

const pass = tests.filter(x => x.ok).length;
const fail = tests.filter(x => !x.ok).length;
for (const x of tests) console.log(`${x.ok ? '✓' : '✗'} ${x.n}${x.d ? ' — ' + x.d : ''}`);
console.log(`\n${pass}/${tests.length} passed${fail > 0 ? ', ' + fail + ' FAILED' : ''}`);
process.exit(fail > 0 ? 1 : 0);
