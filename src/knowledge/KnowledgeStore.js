// v0.55 Sprint 13-B + Sprint 14 F3 — 知识库
//
// 数据布局：
//   ~/.claude-panel/knowledge/<kb-name>/
//     - index.json    元信息 + 文档列表 + embedding 配置（model / dim）
//     - chunks.jsonl  每行一个 chunk {id, docId, text, embedding?: number[]}
//
// 检索策略（自动 fallback）：
//   1) 如果 KB 配了 embedding 且所有 chunk 都有 embedding → cosine similarity
//   2) 否则 → BM25-like（TF * IDF + 长度惩罚）
//
// embedding 默认走 ollama POST /api/embeddings（model = nomic-embed-text / bge-small-en-v1.5）
// 用户没装 ollama 不影响 — 走 fallback。embed 失败也 fallback。

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const DIR = join(homedir(), '.claude-panel');
const KB_DIR = join(DIR, 'knowledge');

const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
const EMBED_TIMEOUT_MS = 30_000;

const MAX_KBS = 50;
const MAX_NAME = 64;
const MAX_DESC = 400;
const MAX_DOC_TITLE = 200;
const MAX_DOC_CONTENT = 2_000_000;       // 单文档 2MB
const MAX_DOCS_PER_KB = 200;
const MAX_CHUNK_CHARS = 800;
const CHUNK_OVERLAP = 100;
const MAX_QUERY = 500;
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

function safeName(s) {
  if (typeof s !== 'string') return null;
  s = s.trim();
  if (!s) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(s)) return null;
  return s.slice(0, MAX_NAME);
}

/** 按段落 + 长度阈值切 chunk
 * v0.74 W10 学习：长段落按"句子"切（中英分隔符），不再按字符硬切
 * 避免把句子从中间砍掉破坏检索相关性
 */
function chunkText(text) {
  const paragraphs = text.split(/\n{2,}/g).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  for (const p of paragraphs) {
    if (p.length <= MAX_CHUNK_CHARS) {
      chunks.push(p);
    } else {
      // v0.74：按句子切（中英标点）
      const sentences = p.split(/(?<=[。！？!?\n])\s*/).filter(Boolean);
      let buf = '';
      for (const s of sentences) {
        if (buf.length + s.length <= MAX_CHUNK_CHARS) {
          buf += s;
        } else {
          if (buf) chunks.push(buf);
          // 单句已经超大 → fallback 硬切
          if (s.length > MAX_CHUNK_CHARS) {
            let i = 0;
            while (i < s.length) {
              chunks.push(s.slice(i, i + MAX_CHUNK_CHARS));
              i += (MAX_CHUNK_CHARS - CHUNK_OVERLAP);
            }
            buf = '';
          } else {
            buf = s;
          }
        }
      }
      if (buf) chunks.push(buf);
    }
  }
  return chunks;
}

/** 调 ollama 嵌入；失败返 null 让上层 fallback */
async function embedViaOllama(text, model = DEFAULT_EMBED_MODEL, url = DEFAULT_OLLAMA_URL) {
  if (!text) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const resp = await fetch(url + '/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !Array.isArray(data.embedding)) return null;
    return data.embedding;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/** cosine similarity 两个等长 number 数组 */
function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 简易 token 切分：英文按词 + 中文按字 + 数字成串 */
function tokenize(text) {
  if (typeof text !== 'string') return [];
  const tokens = [];
  // 英文/数字词
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) tokens.push(m[0]);
  // 中文字符（单字作为 token）
  for (const m of text.matchAll(/[一-鿿]/g)) tokens.push(m[0]);
  return tokens;
}

export class KnowledgeStore {
  constructor() {
    this._ensureDirs();
  }

  _ensureDirs() {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
    if (!existsSync(KB_DIR)) mkdirSync(KB_DIR, { recursive: true, mode: 0o700 });
  }

  _kbDir(name) {
    return join(KB_DIR, name);
  }

  _readIndex(name) {
    const f = join(this._kbDir(name), 'index.json');
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return null; }
  }

  _writeIndex(name, idx) {
    const f = join(this._kbDir(name), 'index.json');
    writeFileSync(f, JSON.stringify(idx, null, 2), { mode: 0o600 });
  }

  _appendChunks(name, chunks) {
    const f = join(this._kbDir(name), 'chunks.jsonl');
    for (const c of chunks) appendFileSync(f, JSON.stringify(c) + '\n', { mode: 0o600 });
  }

  _readAllChunks(name) {
    const f = join(this._kbDir(name), 'chunks.jsonl');
    if (!existsSync(f)) return [];
    try {
      return readFileSync(f, 'utf-8').split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  list() {
    let entries;
    try { entries = readdirSync(KB_DIR, { withFileTypes: true }); }
    catch { return []; }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name;
      if (!safeName(name)) continue;
      const idx = this._readIndex(name);
      if (!idx) continue;
      out.push({
        name,
        description: idx.description || '',
        createdAt: idx.createdAt,
        docCount: (idx.docs || []).length,
        chunkCount: idx.chunkCount || 0,
      });
      if (out.length >= MAX_KBS) break;
    }
    return out;
  }

  get(name) {
    const cleanName = safeName(name);
    if (!cleanName) return null;
    const idx = this._readIndex(cleanName);
    if (!idx) return null;
    return { name: cleanName, ...idx };
  }

  /** 建 KB */
  create({ name, description = '', embedModel, embedUrl }) {
    const cleanName = safeName(name);
    if (!cleanName) throw new Error('name 不合法（仅字母数字 _ . -）');
    if (this.list().length >= MAX_KBS) throw new Error(`已达 KB 上限 ${MAX_KBS}`);
    if (typeof description !== 'string' || description.length > MAX_DESC) throw new Error(`description 不合法或过长（>${MAX_DESC}）`);
    const dir = this._kbDir(cleanName);
    if (existsSync(dir)) throw new Error(`KB "${cleanName}" 已存在`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const idx = {
      name: cleanName, description,
      createdAt: new Date().toISOString(),
      // v0.55 Sprint 14 F3：每个 KB 可独立配 embedding model；空 = 用默认 nomic-embed-text
      embedModel: (typeof embedModel === 'string' && embedModel.trim()) ? embedModel.trim().slice(0, 80) : DEFAULT_EMBED_MODEL,
      embedUrl: (typeof embedUrl === 'string' && /^https?:\/\//.test(embedUrl)) ? embedUrl.slice(0, 500) : DEFAULT_OLLAMA_URL,
      docs: [],
      chunkCount: 0,
    };
    this._writeIndex(cleanName, idx);
    return { name: cleanName, ...idx };
  }

  /** 加文档（content 是已读出的纯文本/markdown）
   *  v0.55 Sprint 14 F3：尝试调 ollama 拿 embedding；失败 fallback 到 BM25-only chunk */
  async addDocument(kbName, { title, content, sourceUrl }) {
    const cleanName = safeName(kbName);
    if (!cleanName) throw new Error('kb name 不合法');
    const idx = this._readIndex(cleanName);
    if (!idx) throw new Error(`KB "${cleanName}" 不存在`);
    if ((idx.docs || []).length >= MAX_DOCS_PER_KB) throw new Error(`KB 文档数已达上限 ${MAX_DOCS_PER_KB}`);
    if (typeof content !== 'string' || !content.trim()) throw new Error('content 必填');
    if (content.length > MAX_DOC_CONTENT) throw new Error(`content 过大（>${MAX_DOC_CONTENT / 1024 / 1024}MB）`);
    const cleanTitle = (typeof title === 'string' ? title.trim() : '').slice(0, MAX_DOC_TITLE) || '未命名文档';

    const docId = 'doc-' + randomUUID().slice(0, 8);
    const chunks = chunkText(content);
    const chunkEntries = [];
    let embedFailCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i];
      const entry = {
        id: docId + '-c' + i,
        docId,
        text,
        tokens: tokenize(text),
      };
      // 异步 embed（每个 chunk 一次调用；ollama 不可用直接跳过）
      const vec = await embedViaOllama(text, idx.embedModel || DEFAULT_EMBED_MODEL, idx.embedUrl || DEFAULT_OLLAMA_URL);
      if (vec && Array.isArray(vec) && vec.length > 0) {
        entry.embedding = vec;
      } else {
        embedFailCount++;
      }
      chunkEntries.push(entry);
    }
    this._appendChunks(cleanName, chunkEntries);

    const docEntry = {
      id: docId,
      title: cleanTitle,
      sourceUrl: typeof sourceUrl === 'string' ? sourceUrl.slice(0, 2048) : '',
      addedAt: new Date().toISOString(),
      chunkCount: chunks.length,
      charCount: content.length,
      embedFailCount,
      embeddedCount: chunks.length - embedFailCount,
    };
    idx.docs = idx.docs || [];
    idx.docs.push(docEntry);
    idx.chunkCount = (idx.chunkCount || 0) + chunks.length;
    this._writeIndex(cleanName, idx);
    return docEntry;
  }

  /** 删一个文档（同时清 chunks.jsonl 里相关 chunk） */
  removeDocument(kbName, docId) {
    const cleanName = safeName(kbName);
    if (!cleanName) return false;
    const idx = this._readIndex(cleanName);
    if (!idx) return false;
    const i = (idx.docs || []).findIndex(d => d.id === docId);
    if (i < 0) return false;
    idx.docs.splice(i, 1);
    // 重写 chunks（过滤掉该 docId）
    const all = this._readAllChunks(cleanName).filter(c => c.docId !== docId);
    const f = join(this._kbDir(cleanName), 'chunks.jsonl');
    writeFileSync(f, all.map(c => JSON.stringify(c)).join('\n') + (all.length ? '\n' : ''), { mode: 0o600 });
    idx.chunkCount = all.length;
    this._writeIndex(cleanName, idx);
    return true;
  }

  /** 删整个 KB */
  delete(name) {
    const cleanName = safeName(name);
    if (!cleanName) return false;
    const dir = this._kbDir(cleanName);
    if (!existsSync(dir)) return false;
    if (!dir.startsWith(KB_DIR + '/')) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /**
   * 检索 — 优先 cosine（如果 chunk 全有 embedding），否则 BM25-like
   * @param {object} params { name, query, topK }
   * @returns {Promise<Array<{ id, docId, text, score, mode }>>}
   */
  async search({ name, query, topK = DEFAULT_TOP_K, hybrid = false }) {
    // v0.70.3-t1: hybrid=true → 走 hybridSearch (BM25 + vector RRF)
    if (hybrid) return this.hybridSearch({ name, query, topK });
    const cleanName = safeName(name);
    if (!cleanName) throw new Error('kb name 不合法');
    if (typeof query !== 'string' || !query.trim()) throw new Error('query 必填');
    if (query.length > MAX_QUERY) throw new Error(`query 过长（>${MAX_QUERY}）`);
    const k = Math.max(1, Math.min(MAX_TOP_K, Number(topK) || DEFAULT_TOP_K));

    const chunks = this._readAllChunks(cleanName);
    if (chunks.length === 0) return [];

    // 检查是否所有 chunk 都有 embedding → 用 cosine
    const allEmbedded = chunks.every((c) => Array.isArray(c.embedding) && c.embedding.length > 0);
    if (allEmbedded) {
      const idx = this._readIndex(cleanName);
      const qvec = await embedViaOllama(query, idx?.embedModel || DEFAULT_EMBED_MODEL, idx?.embedUrl || DEFAULT_OLLAMA_URL);
      if (qvec) {
        const scored = chunks.map((c) => ({
          id: c.id, docId: c.docId, text: c.text,
          score: cosineSim(qvec, c.embedding),
          mode: 'cosine',
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, k).filter((r) => r.score > 0.1);
      }
      // qvec 失败 fallback 到 BM25
    }
    // ===== fallback BM25 =====

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    // IDF: token → log(N / (1 + df))
    const N = chunks.length;
    const df = new Map();
    for (const c of chunks) {
      const seen = new Set(c.tokens || []);
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
    const idf = new Map();
    for (const t of new Set(queryTokens)) {
      const dft = df.get(t) || 0;
      // log((N+1)/(1+df)) 在 N=df=1 时为 log(1)=0；加 0.5 保底防 0 score
      idf.set(t, Math.log((N + 1) / (1 + dft)) + 0.5);
    }

    // 评分
    const scored = chunks.map((c) => {
      const tokens = c.tokens || [];
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const qt of queryTokens) {
        const f = tf.get(qt) || 0;
        if (f === 0) continue;
        score += (idf.get(qt) || 0) * f / (f + 1.5);  // 简化 BM25
      }
      return { id: c.id, docId: c.docId, text: c.text, score, mode: 'bm25' };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).filter(r => r.score > 0);
  }

  // v0.70 W10 集成：hybrid search（BM25 + embedding 两路 RRF 融合）
  // 学自 R2R，比单路 BM25 / 单路 embedding 召回更高
  async hybridSearch({ name, query, topK = DEFAULT_TOP_K }) {
    const cleanName = safeName(name);
    if (!cleanName) throw new Error('kb name 不合法');
    if (typeof query !== 'string' || !query.trim()) throw new Error('query 必填');
    const k = Math.max(1, Math.min(MAX_TOP_K, Number(topK) || DEFAULT_TOP_K));

    const chunks = this._readAllChunks(cleanName);
    if (chunks.length === 0) return [];

    // 路 1: BM25（强制走 BM25 path，临时关掉 embedding 优先）
    const allEmbedded = chunks.every((c) => Array.isArray(c.embedding) && c.embedding.length > 0);

    // 跑 BM25 (复用现有 search 逻辑 fallback path)
    const bm25Hits = await this._bm25Only(cleanName, query, k * 2, chunks);

    // 路 2: embedding（如果有）
    let vecHits = [];
    if (allEmbedded) {
      const idx = this._readIndex(cleanName);
      const qvec = await embedViaOllama(query, idx?.embedModel || DEFAULT_EMBED_MODEL, idx?.embedUrl || DEFAULT_OLLAMA_URL);
      if (qvec) {
        vecHits = chunks.map((c) => ({
          id: c.id, docId: c.docId, text: c.text,
          score: cosineSim(qvec, c.embedding),
        })).sort((a, b) => b.score - a.score).slice(0, k * 2);
      }
    }

    // 融合
    const { mergeHybrid } = await import('./learned/hybrid-merge.js');
    const merged = mergeHybrid(bm25Hits, vecHits, { topN: k });

    // 富化 text/docId 回填
    const byId = new Map(chunks.map(c => [c.id, c]));
    return merged.map(m => {
      const orig = byId.get(m.id);
      return {
        id: m.id,
        docId: orig?.docId,
        text: orig?.text,
        score: m.rrfScore,
        mode: 'hybrid',
        sources: m.sources,
      };
    });
  }

  /** 仅 BM25 的内部 helper（hybridSearch 用） */
  async _bm25Only(name, query, k, chunks) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    const N = chunks.length;
    const df = new Map();
    for (const c of chunks) {
      const seen = new Set();
      for (const t of (c._tokens || tokenize(c.text))) {
        if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) || 0) + 1); }
      }
    }
    const idf = new Map();
    for (const t of queryTokens) {
      const dft = df.get(t) || 0;
      idf.set(t, Math.log((N + 1) / (1 + dft)) + 0.5);
    }
    const avgLen = chunks.reduce((s, c) => s + (c._tokens?.length || tokenize(c.text).length), 0) / N || 1;
    const k1 = 1.5, b = 0.75;
    const scored = chunks.map((c) => {
      const tokens = c._tokens || tokenize(c.text);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const t of queryTokens) {
        const f = tf.get(t) || 0;
        if (f === 0) continue;
        const numerator = f * (k1 + 1);
        const denominator = f + k1 * (1 - b + b * tokens.length / avgLen);
        score += (idf.get(t) || 0) * (numerator / denominator);
      }
      return { id: c.id, docId: c.docId, text: c.text, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).filter(r => r.score > 0);
  }

  /** 给 dispatcher 用：把 query 在某 KB 的 topK chunks 拼成可注入 system prompt 的段 */
  async buildContextFor({ name, query, topK = DEFAULT_TOP_K }) {
    const hits = await this.search({ name, query, topK });
    if (hits.length === 0) return '';
    const idx = this._readIndex(safeName(name));
    const docMap = new Map((idx?.docs || []).map(d => [d.id, d]));
    const parts = hits.map((h, i) => {
      const doc = docMap.get(h.docId);
      const src = doc ? doc.title + (doc.sourceUrl ? ` (${doc.sourceUrl})` : '') : '未知来源';
      return `### 段落 ${i + 1}（来源：${src}）\n\n${h.text}`;
    });
    return `# 📚 知识库检索结果（${hits.length} 段，按相关度排序）

> 这些是基于用户当前任务从知识库《${name}》检索出来的相关内容。请优先参考下面段落作答，引用时标注"来源：X"。

${parts.join('\n\n')}`;
  }
}

export const knowledgeStore = new KnowledgeStore();
