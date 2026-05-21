// S18-2 routes smoke — 每个子 module 跑：注册数 + 关键 endpoint
// 跑：cd panel && node .s18-2-routes-smoke.mjs
import express from 'express';

const tests = [];
const t = (n, ok, d) => tests.push({ n, ok, d: d || '' });
const routesOf = (app) => app._router.stack.filter(l => l.route)
  .map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);

// === S18-2a webhook (5 routes) — 已有 .s18-2a-webhook-test.mjs 详细测过，这里只 sanity check ===
{
  const { registerWebhookRoutes } = await import('./src/server/routes/webhook.js');
  const app = express();
  app.use(express.json());
  registerWebhookRoutes(app, {
    webhookStore: { list:()=>[], create:()=>({}), update:()=>({}), delete:()=>true, get:()=>({}), bumpStats:()=>{} },
    maskWebhookUrl: x => x,
    testWebhook: async () => {},
  });
  const r = routesOf(app);
  t('S18-2a webhook 5 routes', r.length === 5,
    'count=' + r.length + ', got=' + r.join(', '));
}

// === S18-2b archive (4 routes) ===
{
  const { registerArchiveRoutes } = await import('./src/server/routes/archive.js');
  const app = express();
  app.use(express.json());
  registerArchiveRoutes(app, {
    archiveStore: {
      getConfig:()=>({rootPath:''}),
      updateConfig:b=>b,
      archiveRoom:()=>({ok:true,dir:'/x',files:[]}),
      listArchives:()=>({items:[]}),
    },
    safeResolveFsPath: p => p,
    roomStore: { get:id => id === 'missing' ? null : { id } },
  });
  const r = routesOf(app);
  t('S18-2b archive 4 routes', r.length === 4,
    'count=' + r.length + ', got=' + r.join(', '));
  t('archive 含 GET /api/archive/config',
    r.includes('GET /api/archive/config'));
  t('archive 含 POST /api/archive/rooms/:id',
    r.includes('POST /api/archive/rooms/:id'));

  // 启 51736 测一个关键路径：POST /api/archive/rooms/missing → 404
  const server = app.listen(51736);
  await new Promise(rs => setTimeout(rs, 50));
  try {
    const resp = await fetch('http://127.0.0.1:51736/api/archive/rooms/missing', { method: 'POST' });
    const body = await resp.json();
    t('archive POST rooms/missing → 404 + room not found',
      resp.status === 404 && body.error === 'room not found',
      JSON.stringify({ s: resp.status, b: body }));
  } finally { server.close(); }
}

// === S18-2d autopilot (6 routes) ===
{
  const { registerAutopilotRoutes } = await import('./src/server/routes/autopilot.js');
  const app = express();
  app.use(express.json());
  registerAutopilotRoutes(app, {
    autopilotStore: {
      getConfig:()=>({enabled:false}), setEnabled:()=>{}, isEnabled:()=>false,
      setMaxHops:()=>{}, upsertRule:b=>b, deleteRule:id=>id!=='missing', recentLogs:()=>[],
    },
  });
  const r = routesOf(app);
  t('S18-2d autopilot 7 routes', r.length === 7, 'count=' + r.length);   // v0.70 s2: +dry-run
  t('autopilot 含 GET /api/autopilot/config + DELETE /api/autopilot/rules/:id',
    r.includes('GET /api/autopilot/config') && r.includes('DELETE /api/autopilot/rules/:id'));
}

// === S18-2e2 rooms 5 主 CRUD (list/create/get/delete/patch) ===
{
  const { registerRoomsRoutes } = await import('./src/server/routes/rooms.js');
  const app = express();
  app.use(express.json());
  const mockAbort = { abort: () => {} };
  registerRoomsRoutes(app, {
    roomStore: {
      list: () => [{ id: 'r1' }, { id: 'r2' }],
      listArchived: () => [{ id: 'ar1' }],
      get: id => id === 'missing' ? null : { id, mode: 'debate' },
      create: b => ({ id: 'new', ...b }),
      update: (id, p) => ({ id, ...p }),
      delete: id => id !== 'missing',
    },
    safeResolveFsPath: p => p,
    safeSlice: (s, n) => String(s).slice(0, n),
    roomAdapterPool: { has: () => true, get: () => ({ displayName: 'mock' }) },
    debateDispatcher: mockAbort,
    squadDispatcher: mockAbort,
    arenaDispatcher: mockAbort,
    soloChatDispatcher: mockAbort,
    roomWsClients: new Map(),
    MAX_ROOMS: 5,
  });
  const r = routesOf(app);
  t('S18-2e2 rooms 5 routes', r.length === 5, 'count=' + r.length + ', got=' + r.join(', '));

  // 真 HTTP 测试关键路径
  const server = app.listen(51738);
  await new Promise(rs => setTimeout(rs, 50));
  try {
    // 1. GET /api/rooms → ok:true + rooms 数组
    let resp = await fetch('http://127.0.0.1:51738/api/rooms');
    let body = await resp.json();
    t('rooms GET /api/rooms → ok:true + 2 rooms',
      resp.status === 200 && body.ok === true && body.rooms.length === 2);

    // 2. GET /api/rooms?archived=1
    resp = await fetch('http://127.0.0.1:51738/api/rooms?archived=1');
    body = await resp.json();
    t('rooms GET /api/rooms?archived=1 → 1 archived',
      resp.status === 200 && body.rooms.length === 1);

    // 3. GET /api/rooms/missing → 404
    resp = await fetch('http://127.0.0.1:51738/api/rooms/missing');
    body = await resp.json();
    t('rooms GET /api/rooms/missing → 404', resp.status === 404 && body.error === 'not found');

    // 4. POST /api/rooms → ok:true + room
    resp = await fetch('http://127.0.0.1:51738/api/rooms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', mode: 'debate' }),
    });
    body = await resp.json();
    t('rooms POST → ok:true + 默认 debate mode',
      resp.status === 200 && body.ok === true && body.room && body.room.mode === 'debate',
      JSON.stringify(body));

    // 5. DELETE /api/rooms/missing → 404
    resp = await fetch('http://127.0.0.1:51738/api/rooms/missing', { method: 'DELETE' });
    body = await resp.json();
    t('rooms DELETE missing → 404', resp.status === 404);

    // 6. DELETE /api/rooms/r1 → ok
    resp = await fetch('http://127.0.0.1:51738/api/rooms/r1', { method: 'DELETE' });
    body = await resp.json();
    t('rooms DELETE r1 → ok', resp.status === 200 && body.ok === true);

    // 7. PATCH /api/rooms/r1 with debateRounds=invalid → 422
    resp = await fetch('http://127.0.0.1:51738/api/rooms/r1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ debateRounds: 99 }),
    });
    body = await resp.json();
    t('rooms PATCH debateRounds=99 → 422', resp.status === 422 && /1-10/.test(body.error));
  } finally { server.close(); }
}

// === S18-2e1 room-templates (3 routes, rooms 子集) ===
{
  const { registerRoomTemplatesRoutes } = await import('./src/server/routes/roomTemplates.js');
  const app = express();
  app.use(express.json());
  registerRoomTemplatesRoutes(app, {
    roomTemplatesStore: { list:()=>[], create:b=>b, delete:id=>!id.startsWith('builtin:') && id !== 'missing' },
  });
  t('S18-2e1 room-templates 3 routes', routesOf(app).length === 3, 'count=' + routesOf(app).length);

  // 关键：DELETE builtin:* → 403
  const server = app.listen(51737);
  await new Promise(rs => setTimeout(rs, 50));
  try {
    const resp = await fetch('http://127.0.0.1:51737/api/room-templates/builtin:debate', { method: 'DELETE' });
    const body = await resp.json();
    t('room-templates DELETE builtin:* → 403',
      resp.status === 403 && body.error === '内置模板不可删',
      JSON.stringify({ s: resp.status, b: body }));
  } finally { server.close(); }
}

// === S18-2f skills (6 routes) ===
{
  const { registerSkillsRoutes } = await import('./src/server/routes/skills.js');
  const app = express();
  app.use(express.json());
  registerSkillsRoutes(app, {
    skillStore: { list:()=>[], get:n=>n==='missing'?null:{name:n}, upsert:b=>b, delete:n=>n!=='missing', reload:()=>{} },
  });
  t('S18-2f skills 6 routes', routesOf(app).length === 6, 'count=' + routesOf(app).length);
}

// === S18-2g knowledge (7 routes) ===
{
  const { registerKnowledgeRoutes } = await import('./src/server/routes/knowledge.js');
  const app = express();
  app.use(express.json());
  registerKnowledgeRoutes(app, {
    knowledgeStore: {
      list:()=>[], get:n=>n==='missing'?null:{name:n}, create:b=>b, delete:n=>n!=='missing',
      addDocument:async()=>({id:'d1'}), removeDocument:()=>true, search:async()=>[]
    },
  });
  t('S18-2g knowledge 8 routes', routesOf(app).length === 8, 'count=' + routesOf(app).length);   // v0.9.x B-020: +context endpoint
}

// === S18-2c mcp (6 routes) ===
{
  const { registerMcpRoutes } = await import('./src/server/routes/mcp.js');
  const app = express();
  app.use(express.json());
  const ret = registerMcpRoutes(app, {
    mcpStore: { list:()=>[], create:b=>b, update:(name,b)=>name === 'missing' ? null : { name, ...b }, delete:n=>n!=='missing', get:()=>null },
  });
  const r = routesOf(app);
  t('S18-2c mcp 9 routes', r.length === 9,    // v0.70.3-t3 +call-history; B-013 +resources/prompts
    'count=' + r.length);
  t('mcp 返回 mcpClientManager 实例（server shutdown 用）',
    ret && ret.mcpClientManager && typeof ret.mcpClientManager.disconnect === 'function');
}

const pass = tests.filter(x => x.ok).length;
const fail = tests.filter(x => !x.ok).length;
for (const x of tests) console.log(`${x.ok ? '✓' : '✗'} ${x.n}${x.d ? ' — ' + x.d : ''}`);
console.log(`\n${pass}/${tests.length} passed${fail > 0 ? ', ' + fail + ' FAILED' : ''}`);
process.exit(fail > 0 ? 1 : 0);
