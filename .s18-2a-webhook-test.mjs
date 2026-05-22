// S18-2a webhook routes unit test（panel 项目内运行以解析 express）
// 跑：cd panel && node .s18-2a-webhook-test.mjs
import express from 'express';
import { registerWebhookRoutes } from './src/server/routes/webhook.js';

const tests = [];
const t = (n, ok, d) => tests.push({ n, ok, d: d || '' });

// === 1. 用 mock deps 注册 routes ===
const calls = [];
const mockStore = {
  list: (opts) => { calls.push(['list', opts]); return [{ id: 'w1', url: 'http://x' }]; },
  create: (b) => { calls.push(['create', b]); return { id: 'wnew', url: 'http://new' }; },
  update: (id, b) => { calls.push(['update', id, b]); return id === 'missing' ? null : { id, url: 'http://upd' }; },
  delete: (id) => { calls.push(['delete', id]); return id !== 'missing'; },
  get: (id) => { calls.push(['get', id]); return id === 'missing' ? null : { id, url: 'http://test' }; },
  bumpStats: (id, ok, err) => { calls.push(['bumpStats', id, ok, err]); },
};
let testWebhookShouldThrow = false;
const mockMask = (u) => '[masked:' + (u || '') + ']';
const mockTest = async (_w) => {
  if (testWebhookShouldThrow) throw new Error('mock test failed');
  return true;
};

const app = express();
app.use(express.json());
registerWebhookRoutes(app, { webhookStore: mockStore, maskWebhookUrl: mockMask, testWebhook: mockTest });

// === 2. 检查 5 个 routes 注册到 router ===
const routes = app._router.stack
  .filter(l => l.route)
  .map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
const expected = [
  'GET /api/webhooks',
  'POST /api/webhooks',
  'PUT /api/webhooks/:id',
  'DELETE /api/webhooks/:id',
  'POST /api/webhooks/:id/test',
];
for (const e of expected) t(`route ${e} 已注册`, routes.includes(e), 'actual=' + routes.join(', '));

// === 3. 启动临时 server 在 51736 端口跑 HTTP 测试 ===
const server = app.listen(51736);
await new Promise(rs => setTimeout(rs, 50));
const base = 'http://127.0.0.1:51736';

async function tryHttp(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

// 3.1 GET /api/webhooks
calls.length = 0;
let r = await tryHttp('GET', '/api/webhooks');
t('GET /api/webhooks → ok:true + webhooks 数组',
  r.status === 200 && r.body.ok === true && Array.isArray(r.body.webhooks),
  JSON.stringify(r));
t('GET 调用 store.list({mask:true})',
  calls.length === 1 && calls[0][0] === 'list' && calls[0][1] && calls[0][1].mask === true);

// 3.2 POST /api/webhooks
calls.length = 0;
r = await tryHttp('POST', '/api/webhooks', { url: 'https://discord.com/api/webhooks/x', name: 'test' });
t('POST /api/webhooks → ok:true + 返回 masked URL',
  r.status === 200 && r.body.ok === true && r.body.webhook.url === '[masked:http://new]',
  JSON.stringify(r));

// 3.3 POST /api/webhooks 超长 body 返回 413
r = await tryHttp('POST', '/api/webhooks', { name: 'x'.repeat(20000) });
t('POST 超长 body → 413', r.status === 413, JSON.stringify(r));

// 3.4 PUT /api/webhooks/:id 存在
calls.length = 0;
r = await tryHttp('PUT', '/api/webhooks/w1', { name: 'updated' });
t('PUT 存在 → ok:true + masked URL',
  r.status === 200 && r.body.ok === true && r.body.webhook.url === '[masked:http://upd]');

// 3.5 PUT /api/webhooks/missing → 404
r = await tryHttp('PUT', '/api/webhooks/missing', { name: 'x' });
t('PUT 不存在 → 404 + not found',
  r.status === 404 && r.body.error === 'not found');

// 3.6 DELETE 存在 → 200
r = await tryHttp('DELETE', '/api/webhooks/w1');
t('DELETE 存在 → ok:true', r.status === 200 && r.body.ok === true);

// 3.7 DELETE missing → 404
r = await tryHttp('DELETE', '/api/webhooks/missing');
t('DELETE 不存在 → 404', r.status === 404);

// 3.8 POST /test → 200 + bumpStats(true) 调用
calls.length = 0;
testWebhookShouldThrow = false;
r = await tryHttp('POST', '/api/webhooks/w1/test');
t('POST /test 成功 → ok:true', r.status === 200 && r.body.ok === true);
t('POST /test 调用 bumpStats(id, true)',
  calls.find(c => c[0] === 'bumpStats' && c[2] === true) !== undefined,
  JSON.stringify(calls));

// 3.9 POST /test 失败 → 502 + bumpStats(false, error)
calls.length = 0;
testWebhookShouldThrow = true;
r = await tryHttp('POST', '/api/webhooks/w1/test');
t('POST /test testWebhook throw → 502', r.status === 502, JSON.stringify(r));
t('POST /test 失败 时 bumpStats(id, false, error)',
  calls.find(c => c[0] === 'bumpStats' && c[2] === false && c[3]) !== undefined);

// 3.10 POST /test missing → 404
r = await tryHttp('POST', '/api/webhooks/missing/test');
t('POST /test 不存在 → 404', r.status === 404);

server.close();

const pass = tests.filter(x => x.ok).length;
const fail = tests.filter(x => !x.ok).length;
for (const x of tests) console.log(`${x.ok ? '✓' : '✗'} ${x.n}${x.d ? ' — ' + x.d : ''}`);
console.log(`\n${pass}/${tests.length} passed${fail > 0 ? ', ' + fail + ' FAILED' : ''}`);
process.exit(fail > 0 ? 1 : 0);
