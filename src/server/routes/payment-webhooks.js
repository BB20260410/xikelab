// panel v1.5 Task 3.3 — Lemon Squeezy / Polar 支付 webhook 接收端
// 订单成功事件触发：自动签发 license + 邮件发给买家

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const SECRETS_PATH = path.join(HOME, '.claude-panel', 'webhook-secrets.json');
const ISSUED_LOG = path.join(HOME, '.claude-panel', 'licenses-issued.jsonl');
const PRIV_KEY_PATH = path.join(HOME, '.claude-panel-keys', 'panel-license-private-key.pem');

function loadSecrets() {
  try {
    if (!fs.existsSync(SECRETS_PATH)) return {};
    return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSecrets(obj) {
  const dir = path.dirname(SECRETS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

// HMAC-SHA256 timing-safe 比较（防 timing attack）
function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function logIssued(record) {
  try {
    const dir = path.dirname(ISSUED_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(ISSUED_LOG, JSON.stringify({ ...record, ts: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } catch (e) {
    console.error('[webhook] log issued failed:', e.message);
  }
}

async function issueLicenseFor(email, tier = 'pro', days = 0) {
  if (!fs.existsSync(PRIV_KEY_PATH)) {
    throw new Error('私钥不存在，无法签发 license');
  }
  const priv = fs.readFileSync(PRIV_KEY_PATH, 'utf8');
  const m = await import('../../license/LicenseManager.js');
  const expiresAt = days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : 0;
  const licenseStr = m.signLicense({ email, tier, expiresAt }, priv);
  return licenseStr;
}

export function registerPaymentWebhookRoutes(app) {
  app.get('/api/webhooks/config', (req, res) => {
    const s = loadSecrets();
    res.json({
      ok: true,
      lemonConfigured: !!s.lemon,
      polarConfigured: !!s.polar,
    });
  });

  app.post('/api/webhooks/config', (req, res) => {
    try {
      const { provider, secret } = req.body || {};
      if (!['lemon', 'polar'].includes(provider)) return res.status(400).json({ error: 'provider must be lemon|polar' });
      if (!secret || secret.length < 16) return res.status(400).json({ error: 'secret 至少 16 字符' });
      const s = loadSecrets();
      s[provider] = secret;
      saveSecrets(s);
      res.json({ ok: true, provider });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Lemon Squeezy webhook
  app.post('/api/webhooks/lemon', async (req, res) => {
    try {
      const sig = req.get('X-Signature') || '';
      const raw = req.rawBody || JSON.stringify(req.body || {});
      const secrets = loadSecrets();
      if (!secrets.lemon) return res.status(503).json({ error: 'lemon webhook not configured' });
      if (!verifySignature(raw, sig, secrets.lemon)) {
        logIssued({ provider: 'lemon', status: 'sig-fail', sig: sig.slice(0, 16) });
        return res.status(401).json({ error: 'signature invalid' });
      }
      const body = req.body || {};
      const eventName = body.meta?.event_name || body.event_name;
      // 关心的事件：order_created / subscription_created
      if (eventName !== 'order_created' && eventName !== 'subscription_created') {
        return res.json({ ok: true, ignored: eventName });
      }
      const email = body.data?.attributes?.user_email || body.data?.attributes?.email;
      const productName = body.data?.attributes?.first_order_item?.product_name || body.data?.attributes?.product_name || '';
      const tier = productName.toLowerCase().includes('team') ? 'team' : 'pro';
      if (!email) return res.status(400).json({ error: 'no email in payload' });
      const licenseStr = await issueLicenseFor(email, tier);
      logIssued({ provider: 'lemon', event: eventName, email, tier, license: licenseStr.slice(0, 32) + '...', status: 'issued' });
      // 邮件发送（如果有 Sentry-style mail transport 配置可以发邮件，这里先存档供查）
      res.json({ ok: true, issued: true, email, tier, license: licenseStr });
    } catch (e) {
      console.error('[webhook lemon] error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Polar.sh webhook
  app.post('/api/webhooks/polar', async (req, res) => {
    try {
      const sig = req.get('webhook-signature') || req.get('X-Webhook-Signature') || '';
      const raw = req.rawBody || JSON.stringify(req.body || {});
      const secrets = loadSecrets();
      if (!secrets.polar) return res.status(503).json({ error: 'polar webhook not configured' });
      if (!verifySignature(raw, sig, secrets.polar)) {
        logIssued({ provider: 'polar', status: 'sig-fail', sig: sig.slice(0, 16) });
        return res.status(401).json({ error: 'signature invalid' });
      }
      const body = req.body || {};
      const eventType = body.type || body.event_type;
      if (eventType !== 'order.created' && eventType !== 'subscription.created') {
        return res.json({ ok: true, ignored: eventType });
      }
      const email = body.data?.customer_email || body.data?.user?.email;
      const productName = body.data?.product?.name || '';
      const tier = productName.toLowerCase().includes('team') ? 'team' : 'pro';
      if (!email) return res.status(400).json({ error: 'no email in payload' });
      const licenseStr = await issueLicenseFor(email, tier);
      logIssued({ provider: 'polar', event: eventType, email, tier, license: licenseStr.slice(0, 32) + '...', status: 'issued' });
      res.json({ ok: true, issued: true, email, tier, license: licenseStr });
    } catch (e) {
      console.error('[webhook polar] error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 查询签发记录
  app.get('/api/webhooks/issued', (req, res) => {
    try {
      if (!fs.existsSync(ISSUED_LOG)) return res.json({ ok: true, items: [] });
      const lines = fs.readFileSync(ISSUED_LOG, 'utf8').trim().split('\n').filter(Boolean);
      const items = lines.slice(-100).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
      res.json({ ok: true, items });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
