// panel v2.0 Task 4.2 — embedding provider
// 双轨：
//   - hash (默认)：零依赖，128 维 character n-gram feature hashing
//   - ollama：opt-in，需要用户跑 `ollama pull nomic-embed-text`

import crypto from 'node:crypto';

const HASH_DIM = 128;

// ===== hash provider（默认，0 依赖）=====
export function hashEmbed(text, dim = HASH_DIM) {
  const vec = new Float32Array(dim);
  if (!text || typeof text !== 'string') return vec;
  const s = text.toLowerCase();
  const ngrams = [];
  for (let i = 0; i < s.length - 2; i++) ngrams.push(s.slice(i, i + 3));
  for (const ng of ngrams) {
    const h = crypto.createHash('sha256').update(ng).digest();
    const idx = h.readUInt32BE(0) % dim;
    const sign = (h[4] & 1) === 0 ? 1 : -1;
    vec[idx] += sign;
  }
  // L2 归一化
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

// ===== ollama provider（opt-in）=====
export async function ollamaEmbed(text, { model = 'nomic-embed-text', baseUrl = 'http://localhost:11434' } = {}) {
  const resp = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!resp.ok) throw new Error(`ollama embed failed ${resp.status}`);
  const j = await resp.json();
  if (!Array.isArray(j.embedding)) throw new Error('ollama embedding not array');
  const dim = j.embedding.length;
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) vec[i] = j.embedding[i];
  // L2 归一化（ollama 已归一化但再保证一次）
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

// ===== 统一接口 =====
export async function embed(text, { provider = 'hash', model, baseUrl } = {}) {
  if (provider === 'ollama') {
    try {
      return { vector: await ollamaEmbed(text, { model, baseUrl }), provider: 'ollama', model: model || 'nomic-embed-text' };
    } catch (e) {
      // ollama 失败 → 退到 hash
      return { vector: hashEmbed(text), provider: 'hash-fallback', model: `hash-${HASH_DIM}`, fallback: true, error: e.message };
    }
  }
  return { vector: hashEmbed(text), provider: 'hash', model: `hash-${HASH_DIM}` };
}

// ===== 余弦相似度 =====
export function cosineSim(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // 假设输入已 L2 归一化
}

export { HASH_DIM };
