// Xike Lab — Cloudflare Worker (webhook 接收端 + LS license 中转)
//
// 功能：
//   1. POST /webhooks/lemon — 接收 Lemon Squeezy 订单事件
//      - HMAC-SHA256 验签（X-Signature header）
//      - 自动签发 license（或调用 LS license-keys API）
//      - 返回成功响应给 LS
//   2. GET /api/license/verify?key=... — panel 客户端验证 license 是否有效
//      - 调用 LS API /v1/license-keys 验证
//   3. GET /health — 健康检查
//
// 部署：wrangler deploy
// 必需 secrets (wrangler secret put):
//   LS_WEBHOOK_SECRET  — LS webhook signing secret
//   LS_API_TOKEN       — LS API token

async function verifyLemonSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const sigHex = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  // timing-safe compare
  const a = sigHex;
  const b = signature.replace(/^sha256=/i, '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleLemonWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Signature') || '';

  if (!env.LS_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: 'LS_WEBHOOK_SECRET not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }

  const ok = await verifyLemonSignature(rawBody, signature, env.LS_WEBHOOK_SECRET);
  if (!ok) {
    return new Response(JSON.stringify({ error: 'signature invalid' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return new Response('bad json', { status: 400 }); }

  const eventName = event?.meta?.event_name || 'unknown';
  const email = event?.data?.attributes?.user_email || event?.data?.attributes?.email;
  const productName = event?.data?.attributes?.first_order_item?.product_name
    || event?.data?.attributes?.product_name
    || '';

  // 记录到 Worker KV / D1（如果配了）
  // 目前简单 log + 返回
  console.log(`[lemon webhook] ${eventName} | ${email} | ${productName}`);

  // 关心的事件
  if (eventName === 'order_created' || eventName === 'subscription_created') {
    // LS 自己的 license-keys 系统会自动生成 license + 发邮件给买家
    // 我们这里只是确认收到 webhook（panel 端用 LS API 拉 license-keys 验证激活）
    return new Response(JSON.stringify({
      ok: true,
      received: eventName,
      email,
      product: productName,
      note: 'LS will auto-generate license and email buyer; panel verifies via LS API on activation'
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ ok: true, ignored: eventName }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleLicenseVerify(request, env) {
  const url = new URL(request.url);
  const licenseKey = url.searchParams.get('key');
  if (!licenseKey) {
    return new Response(JSON.stringify({ error: 'key required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (!env.LS_API_TOKEN) {
    return new Response(JSON.stringify({ error: 'LS_API_TOKEN not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }

  // 调 LS license-keys validate API
  const r = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `license_key=${encodeURIComponent(licenseKey)}`,
  });
  const data = await r.json();

  return new Response(JSON.stringify({
    ok: data.valid === true,
    valid: data.valid,
    activated: data.meta?.activated,
    productName: data.meta?.product_name,
    customerEmail: data.meta?.customer_email,
    expiresAt: data.license_key?.expires_at,
  }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 路由
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({
        ok: true,
        service: 'Xike Lab webhook + license proxy',
        version: '1.0',
        endpoints: ['POST /webhooks/lemon', 'GET /api/license/verify?key=...'],
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/webhooks/lemon' && request.method === 'POST') {
      return handleLemonWebhook(request, env);
    }

    if (url.pathname === '/api/license/verify' && request.method === 'GET') {
      return handleLicenseVerify(request, env);
    }

    return new Response(JSON.stringify({ error: 'not found', path: url.pathname }), {
      status: 404, headers: { 'Content-Type': 'application/json' }
    });
  },
};
