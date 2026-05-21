// panel v1.5 — Ed25519 离线 license 系统
// 私钥只在卖家本地 ~/.claude-panel-keys/panel-license-private-key.pem (0o600)
// 公钥嵌 panel binary，任何人能验签但不能伪造

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const LICENSE_PATH = path.join(HOME, '.claude-panel', 'license.txt');

// Ed25519 公钥（嵌 panel binary，公开安全）
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATAJ6ldOJkfqX27S9HTT0z79WRACPDCizToaYNHVGmzc=
-----END PUBLIC KEY-----`;

const TIERS = ['free', 'pro', 'team'];
const FREE_FEATURES = ['chat', 'debate', 'mcp-3', 'adapters-3'];
const PRO_FEATURES = ['chat', 'debate', 'squad', 'arena', 'autopilot', 'mcp-unlimited', 'adapters-unlimited', 'webhook', 'archive'];
const TEAM_FEATURES = [...PRO_FEATURES, 'workspaces', 'priority-support'];

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// 验签：校验 license 签名 + 解析 payload + 检查过期
export function verifyLicense(licenseStr) {
  try {
    if (!licenseStr || typeof licenseStr !== 'string') {
      return { valid: false, error: 'empty-license' };
    }
    const parts = licenseStr.trim().split('.');
    if (parts.length !== 2) return { valid: false, error: 'bad-format' };
    const [payloadB64, sigB64] = parts;
    const payloadBuf = base64urlDecode(payloadB64);
    const sig = base64urlDecode(sigB64);
    const ok = crypto.verify(null, payloadBuf, PUBLIC_KEY_PEM, sig);
    if (!ok) return { valid: false, error: 'sig-mismatch' };
    const payload = JSON.parse(payloadBuf.toString('utf8'));
    if (!payload.tier || !TIERS.includes(payload.tier)) {
      return { valid: false, error: 'bad-tier', payload };
    }
    if (payload.expiresAt > 0 && Math.floor(Date.now() / 1000) > payload.expiresAt) {
      return { valid: false, error: 'expired', payload };
    }
    return { valid: true, payload };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// 签发：只在卖家本地用（需私钥）
export function signLicense(payload, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const full = {
    version: 1,
    issuedAt: now,
    expiresAt: 0,
    features: payload.tier === 'team' ? TEAM_FEATURES : payload.tier === 'pro' ? PRO_FEATURES : FREE_FEATURES,
    ...payload,
  };
  const payloadStr = JSON.stringify(full);
  const sig = crypto.sign(null, Buffer.from(payloadStr), privateKeyPem);
  return `${base64urlEncode(payloadStr)}.${base64urlEncode(sig)}`;
}

// === 运行时缓存（5s）===
let cached = null;
let cachedAt = 0;

export function loadLicense({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < 5000) return cached;
  try {
    if (!fs.existsSync(LICENSE_PATH)) {
      cached = { valid: false, tier: 'free', error: 'no-license', features: FREE_FEATURES };
    } else {
      const str = fs.readFileSync(LICENSE_PATH, 'utf8');
      const v = verifyLicense(str);
      if (v.valid) {
        cached = {
          valid: true,
          tier: v.payload.tier,
          features: v.payload.features || (v.payload.tier === 'team' ? TEAM_FEATURES : PRO_FEATURES),
          email: v.payload.email,
          expiresAt: v.payload.expiresAt,
          issuedAt: v.payload.issuedAt,
        };
      } else {
        cached = { valid: false, tier: 'free', error: v.error, features: FREE_FEATURES };
      }
    }
  } catch (e) {
    cached = { valid: false, tier: 'free', error: e.message, features: FREE_FEATURES };
  }
  cachedAt = Date.now();
  return cached;
}

export function getCurrentTier() {
  return loadLicense().tier;
}

export function isPro() {
  const t = getCurrentTier();
  return t === 'pro' || t === 'team';
}

export function isTeam() {
  return getCurrentTier() === 'team';
}

export function hasFeature(feature) {
  const l = loadLicense();
  return Array.isArray(l.features) && l.features.includes(feature);
}

export function saveLicense(licenseStr) {
  const v = verifyLicense(licenseStr);
  if (!v.valid) return v;
  const dir = path.dirname(LICENSE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(LICENSE_PATH, licenseStr, { mode: 0o600 });
  cached = null;
  return v;
}

export function clearLicense() {
  if (fs.existsSync(LICENSE_PATH)) fs.unlinkSync(LICENSE_PATH);
  cached = null;
}

export function getStatus() {
  const l = loadLicense();
  return {
    tier: l.tier,
    valid: l.valid,
    email: l.email || null,
    issuedAt: l.issuedAt || null,
    expiresAt: l.expiresAt || 0,
    expiresAtLabel: l.expiresAt ? new Date(l.expiresAt * 1000).toISOString() : '永久',
    features: l.features,
    error: l.error || null,
  };
}

export { FREE_FEATURES, PRO_FEATURES, TEAM_FEATURES, TIERS };
