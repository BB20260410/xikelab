const MAX_CONTEXT_FILES = 40;
const MAX_PATH = 260;
const MAX_TEXT = 2000;

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function compactPath(value) {
  let text = safeString(value, MAX_PATH);
  if (!text) return '';
  text = text.replace(/^[ MADRCU?!]{1,3}\s+/, '').trim();
  if (text.includes(' -> ')) text = text.split(' -> ').pop().trim();
  return text.replace(/\\/g, '/');
}

function textLines(value) {
  return safeString(value, 32_000)
    .split(/[\n,]+/)
    .map((line) => compactPath(line))
    .filter(Boolean);
}

function normalizeFileEntry(input) {
  if (typeof input === 'string') {
    const path = compactPath(input);
    return path ? { path } : null;
  }
  if (!input || typeof input !== 'object') return null;
  const path = compactPath(input.path || input.file || input.name || input.relativePath);
  if (!path) return null;
  return {
    path,
    name: safeString(input.name || path.split('/').pop(), 120),
    content: safeString(input.content || input.snippet || input.diff || '', MAX_TEXT),
  };
}

function collectFileInputs(input = {}) {
  const out = [];
  const push = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      out.push(...textLines(value).map((path) => ({ path })));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') out.push(...textLines(item).map((path) => ({ path })));
        else out.push(item);
      }
      return;
    }
    if (typeof value === 'object') out.push(value);
  };

  if (typeof input === 'string' || Array.isArray(input)) push(input);
  else if (input && typeof input === 'object') {
    push(input.affectedFiles);
    push(input.files);
    push(input.projectFiles);
    push(input.changedFiles);
    push(input.projectContext?.files);
    push(input.bundle?.files);
  }

  const normalized = [];
  const seen = new Set();
  for (const item of out) {
    const entry = normalizeFileEntry(item);
    if (!entry) continue;
    const key = entry.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
    if (normalized.length >= MAX_CONTEXT_FILES) break;
  }
  return normalized;
}

function addSignal(signals, tag, reason, score) {
  if (!tag || !reason) return;
  const existing = signals.find((item) => item.tag === tag && item.reason === reason);
  if (existing) {
    existing.score = Math.max(existing.score, score);
    return;
  }
  signals.push({ tag, reason, score });
}

function inferFileSignals(file) {
  const path = safeString(file.path, MAX_PATH);
  const lower = path.toLowerCase();
  const text = `${lower}\n${safeString(file.content, MAX_TEXT).toLowerCase()}`;
  const signals = [];

  if (/\.(js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|go|rs|swift|kt|java|rb|php|cs)$/.test(lower)) {
    addSignal(signals, 'implementation', 'source file', 2);
  }
  if (/(^|\/)(test|tests|__tests__|e2e|spec)(\/|$)|(\.|-)(test|spec)\.(js|mjs|ts|tsx|jsx)$|playwright|vitest/.test(text)) {
    addSignal(signals, 'verification', 'test surface', 5);
  }
  if (/^public\/|\/public\/|\.css$|\.scss$|\.html$|index\.html$|component|modal|layout|ui|style/.test(lower)) {
    addSignal(signals, 'design', 'frontend surface', 4);
    addSignal(signals, 'implementation', 'frontend code', 1);
  }
  if (/src\/server\/routes\/|server\.js$|\/api\/|route|controller|middleware/.test(lower)) {
    addSignal(signals, 'implementation', 'api route', 3);
    addSignal(signals, 'architecture', 'server boundary', 2);
  }
  if (/src\/agents\/|agent|skillregistry|dispatcher|roomadapter|src\/room\/|skillinjector/.test(lower)) {
    addSignal(signals, 'architecture', 'agent runtime boundary', 4);
    addSignal(signals, 'implementation', 'agent runtime code', 2);
  }
  if (/budget|approval|audit|governance|delegation|autopilot|policy|permission|guard/.test(text)) {
    addSignal(signals, 'governance', 'governance surface', 5);
  }
  if (/storage|sqlite|database|migration|schema|db\./.test(lower)) {
    addSignal(signals, 'architecture', 'storage contract', 3);
    addSignal(signals, 'governance', 'persistent state', 2);
  }
  if (/package\.json$|package-lock\.json$|pnpm-lock|yarn\.lock|dockerfile|render\.yaml|vercel\.json|netlify\.toml|\.github\/workflows\/|release|deploy|ship/.test(lower)) {
    addSignal(signals, 'release', 'delivery config', 4);
  }
  if (/\.(md|mdx|txt)$/.test(lower) || /readme|handoff|交接|docs?\//.test(lower)) {
    addSignal(signals, 'planning', 'project context document', 3);
  }
  if (/refactor|interface|contract|dependency|import|symbol|索引|架构|迁移/.test(text)) {
    addSignal(signals, 'architecture', 'architecture language', 2);
  }
  if (/test|verify|qa|browser|screenshot|回归|验证|测试/.test(text)) {
    addSignal(signals, 'verification', 'verification language', 2);
  }
  if (/ui|ux|css|layout|modal|interaction|界面|交互|布局/.test(text)) {
    addSignal(signals, 'design', 'ui language', 2);
  }

  signals.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
  return signals;
}

export function inferCodeContextSignals(input = {}) {
  const entries = collectFileInputs(input);
  const files = entries.map((entry) => ({
    path: entry.path,
    name: entry.name || entry.path.split('/').pop(),
    signals: inferFileSignals(entry),
  })).filter((entry) => entry.signals.length > 0);

  const byTag = new Map();
  for (const file of files) {
    for (const signal of file.signals) {
      if (!byTag.has(signal.tag)) {
        byTag.set(signal.tag, {
          tag: signal.tag,
          score: 0,
          reasons: new Set(),
          paths: new Set(),
        });
      }
      const tag = byTag.get(signal.tag);
      tag.score += signal.score;
      tag.reasons.add(signal.reason);
      tag.paths.add(file.path);
    }
  }

  const tags = [...byTag.values()]
    .map((tag) => ({
      tag: tag.tag,
      score: tag.score,
      reasons: [...tag.reasons].slice(0, 8),
      paths: [...tag.paths].slice(0, 10),
    }))
    .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));

  return {
    fileCount: entries.length,
    signalFileCount: files.length,
    files,
    tags,
  };
}
