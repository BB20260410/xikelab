// Xike Lab v2.0 — Lemon Squeezy API client
// Token 存在 ~/.claude-panel/lemonsqueezy-key.txt (0o600)，永不进 LLM 对话

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TOKEN_PATH = path.join(os.homedir(), '.claude-panel', 'lemonsqueezy-key.txt');
const API_BASE = 'https://api.lemonsqueezy.com/v1';

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  return fs.readFileSync(TOKEN_PATH, 'utf8').split('\n')[0].trim();
}

async function lsFetch(path, opts = {}) {
  const token = loadToken();
  if (!token) throw new Error('LS token 不存在，请把 token 复制到 ~/.claude-panel/lemonsqueezy-key.txt');
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.api+json',
    ...(opts.body ? { 'Content-Type': 'application/vnd.api+json' } : {}),
    ...(opts.headers || {}),
  };
  const r = await fetch(API_BASE + path, { ...opts, headers });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`LS API ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

// === 用户 / store ===
export async function getMe() {
  return lsFetch('/users/me');
}

export async function listStores() {
  return lsFetch('/stores');
}

export async function getStore(storeId) {
  return lsFetch(`/stores/${storeId}`);
}

// === Products / Variants ===
export async function listProducts({ storeId } = {}) {
  const url = storeId ? `/stores/${storeId}/products` : '/products';
  return lsFetch(url);
}

export async function listVariants({ productId } = {}) {
  const url = productId ? `/products/${productId}/variants` : '/variants';
  return lsFetch(url);
}

// === Orders / Subscriptions ===
export async function listOrders({ storeId, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (storeId) params.set('filter[store_id]', storeId);
  params.set('page[size]', String(limit));
  return lsFetch(`/orders?${params}`);
}

export async function getOrder(orderId) {
  return lsFetch(`/orders/${orderId}`);
}

// === Webhooks ===
export async function listWebhooks({ storeId } = {}) {
  const params = new URLSearchParams();
  if (storeId) params.set('filter[store_id]', storeId);
  return lsFetch(`/webhooks?${params}`);
}

export async function createWebhook({ storeId, url, secret, events = ['order_created', 'subscription_created', 'subscription_payment_success'], testMode = false }) {
  return lsFetch('/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'webhooks',
        attributes: {
          url,
          events,
          secret,
          test_mode: testMode,
        },
        relationships: {
          store: { data: { type: 'stores', id: String(storeId) } },
        },
      },
    }),
  });
}

export async function deleteWebhook(webhookId) {
  await fetch(`${API_BASE}/webhooks/${webhookId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${loadToken()}`,
      'Accept': 'application/vnd.api+json',
    },
  });
  return { ok: true, deleted: webhookId };
}

// === License keys (LS 自己的 license 系统，可选用 ===
export async function listLicenseKeys({ storeId, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (storeId) params.set('filter[store_id]', storeId);
  params.set('page[size]', String(limit));
  return lsFetch(`/license-keys?${params}`);
}

// === Checkouts (创建临时 checkout link) ===
export async function createCheckout({ storeId, variantId, customData = {}, productOptions = {}, checkoutOptions = {} }) {
  return lsFetch('/checkouts', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'checkouts',
        attributes: {
          custom_price: null,
          product_options: productOptions,
          checkout_options: checkoutOptions,
          checkout_data: { custom: customData },
        },
        relationships: {
          store: { data: { type: 'stores', id: String(storeId) } },
          variant: { data: { type: 'variants', id: String(variantId) } },
        },
      },
    }),
  });
}

// === 健康检查（仅元数据，不暴露 token）===
export async function healthCheck() {
  try {
    const me = await getMe();
    const stores = await listStores();
    return {
      ok: true,
      user: me.data?.attributes?.email || null,
      storesCount: stores.data?.length || 0,
      tokenStored: true,
    };
  } catch (e) {
    return { ok: false, error: e.message, tokenStored: fs.existsSync(TOKEN_PATH) };
  }
}
