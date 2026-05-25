const DEFAULT_MAX_RESULTS = 20;
const MAX_QUERY_CHARS = 500;

const QUERY_ALIASES = [
  {
    name: 'budget',
    re: /(预算|budget|cost|token|quota|spend|incident|preflight|拦截|费用)/i,
    tokens: ['budget', 'preflight', 'incident', 'cost', 'token', 'blocked', 'defer'],
  },
  {
    name: 'diagnosticsActivity',
    re: /(诊断|diagnostic|diagnostics|activity|audit|审计|写入|记录|metrics|skill)/i,
    tokens: ['diagnostics', 'diagnostic', 'activity', 'audit', 'record', 'recordsafe', 'metrics', 'skill'],
  },
  {
    name: 'delegationAutostart',
    re: /(delegation|autostart|委派|自启动|approval|审批|job|target room|链路)/i,
    tokens: ['delegation', 'autostart', 'approval', 'job', 'target', 'room', 'deferred'],
  },
  {
    name: 'agentUiEntry',
    re: /(agent 图谱|图谱|入口|dom|handler|按钮|button|modal|addEventListener|dispatch preview|预演|预览|registry)/i,
    tokens: ['agent', 'registry', 'btnagentregistry', 'agentregistrymodal', 'openagentregistrymodal', 'dom', 'handler', 'button', 'modal', 'addeventlistener', 'dispatch', 'preview'],
  },
  {
    name: 'routeSymbolGraph',
    re: /(symbolgraph|symbol graph|route|routes|routeusage|route usage|关联 route|路由|符号图)/i,
    tokens: ['symbolgraph', 'symbol', 'route', 'routes', 'routeusage', 'routeusages', 'usage', 'anchor'],
  },
  {
    name: 'testIntent',
    re: /(test|tests|spec|测试|单测|e2e)/i,
    tokens: ['test', 'tests', 'describe', 'it', 'expect'],
  },
];

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function uniq(list) {
  return [...new Set((list || []).filter(Boolean))];
}

export function tokenizeCodebaseQuery(text = '') {
  const raw = safeString(text, MAX_QUERY_CHARS);
  const lower = raw.toLowerCase();
  const base = lower
    .split(/[^a-z0-9_$\u4e00-\u9fff]+/u)
    .filter((token) => token.length >= 2);
  const expanded = [...base];
  for (const rule of QUERY_ALIASES) {
    if (rule.re.test(raw)) expanded.push(...rule.tokens);
  }
  return uniq(expanded).slice(0, 64);
}

export function classifyCodebaseQuery(text = '', tokens = tokenizeCodebaseQuery(text)) {
  const raw = safeString(text, MAX_QUERY_CHARS);
  const set = new Set(tokens);
  const out = {};
  for (const rule of QUERY_ALIASES) {
    out[rule.name] = rule.re.test(raw) || rule.tokens.some((token) => set.has(token));
  }
  return out;
}

export function scorePathForCodebaseQuery(path = '', tokens = [], text = '') {
  const lowerPath = safeString(path, 500).toLowerCase();
  const lowerText = safeString(text, 4000).toLowerCase();
  const set = new Set(tokens);
  const reasons = [];
  let score = 0;

  const add = (value, reason) => {
    score += value;
    reasons.push(reason);
  };

  if (set.has('budget') && (/src\/room\/roomadapter\.js$/.test(lowerPath) || lowerPath.startsWith('src/budget/'))) {
    add(34, 'intent:budget-source');
  }
  if (set.has('handler') && lowerPath === 'src/agents/codebasequeryengine.js') {
    add(-220, 'avoid-query-engine-self-reference');
  }
  if (set.has('diagnostics') && set.has('activity') && lowerPath === 'src/metrics/metricsstore.js') {
    add(48, 'intent:diagnostics-activity-source');
  }
  if (set.has('diagnostics') && set.has('activity') && lowerPath === 'src/audit/activitylog.js') {
    add(32, 'intent:activity-source');
  }
  if (set.has('delegation') && set.has('autostart') && lowerPath === 'src/autopilot/delegationautostart.js') {
    add(48, 'intent:delegation-autostart-source');
  }
  if (set.has('delegation') && lowerPath === 'src/server/routes/delegations.js') {
    add(26, 'intent:delegation-route-source');
  }
  if ((set.has('btnagentregistry') || set.has('openagentregistrymodal') || set.has('handler')) && lowerPath === 'public/app.js') {
    add(64, 'intent:agent-ui-handler');
  }
  if ((set.has('btnagentregistry') || set.has('agentregistrymodal') || set.has('dom')) && lowerPath === 'public/index.html') {
    add(48, 'intent:agent-ui-dom');
  }
  if ((set.has('symbolgraph') || set.has('routeusage')) && lowerPath === 'src/agents/symbolgraph.js') {
    add(54, 'intent:symbolgraph-route-source');
  }
  if (lowerPath.startsWith('src/')) add(8, 'source-file');
  if (lowerPath.startsWith('public/') && (set.has('dom') || set.has('handler'))) add(10, 'ui-file');
  if (lowerPath.startsWith('tests/') && !set.has('test')) add(-18, 'prefer-source-over-tests');

  if (set.has('recordsafe') && lowerText.includes('recordsafe')) add(10, 'text:recordSafe');
  if (set.has('agentregistrymodal') && lowerText.includes('agentregistrymodal')) add(12, 'text:agentRegistryModal');
  if (set.has('btnagentregistry') && lowerText.includes('btnagentregistry')) add(12, 'text:btnAgentRegistry');
  if (set.has('openagentregistrymodal') && lowerText.includes('openagentregistrymodal')) add(12, 'text:openAgentRegistryModal');
  if (set.has('routeusage') && /routeusages?/i.test(lowerText)) add(12, 'text:routeUsage');

  return { score, reasons: uniq(reasons).slice(0, 6) };
}

function tokenHit(text = '', tokens = []) {
  const lower = safeString(text, 4000).toLowerCase();
  return tokens.filter((token) => lower.includes(token));
}

function snippetText(snippet) {
  if (!snippet) return '';
  return typeof snippet === 'string' ? snippet : safeString(snippet.text, 260);
}

function snippetLine(snippet) {
  return Math.max(1, Number(snippet?.line) || 1);
}

function evidenceForPath(map, path) {
  return (map.evidence || []).find((item) => item.path === path) || null;
}

function pushResult(results, item) {
  if (!item?.path) return;
  results.push({
    path: item.path,
    line: Math.max(1, Number(item.line) || 1),
    score: Math.max(0, Number(item.score) || 0),
    reason: uniq(item.reason || []).slice(0, 9),
    anchor: item.anchor || null,
    parser: item.parser || 'unknown',
    kind: item.kind || 'file',
    text: safeString(item.text, 260),
    symbols: Array.isArray(item.symbols) ? item.symbols.slice(0, 8) : [],
    routes: Array.isArray(item.routes) ? item.routes.slice(0, 8) : [],
  });
}

export function scoreCodebaseEvidence(map, query = '', { maxResults = DEFAULT_MAX_RESULTS } = {}) {
  const tokens = tokenizeCodebaseQuery(query);
  const results = [];
  const focusByPath = new Map((map.focusFiles || []).map((file) => [file.path, file]));

  for (const focus of map.focusFiles || []) {
    const evidence = evidenceForPath(map, focus.path);
    const parser = evidence?.parser || 'unknown';
    const pathIntent = scorePathForCodebaseQuery(focus.path, tokens, [
      ...(focus.snippets || []),
      ...(focus.snippetLocations || []).map(snippetText),
    ].join('\n'));
    const baseScore = (Number(focus.score) || 0) + pathIntent.score;
    const baseReasons = [...(focus.reasons || []), ...pathIntent.reasons];
    const fileHits = tokenHit(focus.path, tokens);

    pushResult(results, {
      path: focus.path,
      line: 1,
      score: baseScore + fileHits.length * 12,
      reason: [...baseReasons, ...fileHits.map((token) => `path:${token}`)],
      anchor: focus.path,
      parser,
      kind: 'file',
      text: snippetText((focus.snippetLocations || [])[0]) || snippetText((focus.snippets || [])[0]),
      symbols: evidence?.symbols || [],
      routes: (evidence?.anchors || []).filter((anchor) => anchor.kind === 'route' || anchor.kind === 'api'),
    });

    for (const symbol of evidence?.symbols || []) {
      const hits = tokenHit(`${symbol.type} ${symbol.name} ${focus.path}`, tokens);
      if (!hits.length && tokens.length > 0) continue;
      pushResult(results, {
        path: evidence.path,
        line: symbol.line,
        score: baseScore + 30 + hits.length * 15 + (symbol.exported ? 4 : 0),
        reason: [...baseReasons, 'symbol', ...hits.map((token) => `symbol:${token}`)],
        anchor: symbol.name,
        parser,
        kind: `symbol:${symbol.type}`,
        text: `${symbol.type} ${symbol.name}`,
        symbols: [symbol],
      });
    }

    for (const anchor of evidence?.anchors || []) {
      const hits = tokenHit(`${anchor.kind} ${anchor.name} ${focus.path}`, tokens);
      if (!hits.length && tokens.length > 0) continue;
      const isRoute = anchor.kind === 'route' || anchor.kind === 'api';
      const isTest = ['describe', 'it', 'test'].includes(anchor.kind);
      pushResult(results, {
        path: evidence.path,
        line: anchor.line,
        score: baseScore + (isRoute ? 32 : isTest ? 18 : 20) + hits.length * 12,
        reason: [...baseReasons, isRoute ? 'route' : isTest ? 'test' : `anchor:${anchor.kind}`, ...hits.map((token) => `${anchor.kind}:${token}`)],
        anchor: anchor.name,
        parser,
        kind: `anchor:${anchor.kind}`,
        text: `${anchor.kind} ${anchor.name}`,
        routes: isRoute ? [anchor] : [],
      });
    }

    for (const snippet of [...(evidence?.snippets || []), ...(focus.snippetLocations || [])]) {
      const text = snippetText(snippet);
      const hits = tokenHit(`${text} ${focus.path}`, tokens);
      if (!hits.length) continue;
      pushResult(results, {
        path: evidence?.path || focus.path,
        line: snippetLine(snippet),
        score: baseScore + 12 + hits.length * 10,
        reason: [...baseReasons, `text:${snippet.reason || 'match'}`, ...hits.map((token) => `text:${token}`)],
        anchor: snippet.reason || 'match',
        parser,
        kind: 'text',
        text,
        symbols: evidence?.symbols || [],
      });
    }

    for (const ref of evidence?.references || []) {
      const hits = tokenHit(`${ref.kind} ${ref.name} ${ref.text} ${focus.path}`, tokens);
      if (!hits.length) continue;
      pushResult(results, {
        path: evidence.path,
        line: ref.line,
        score: baseScore + 14 + hits.length * 9,
        reason: [...baseReasons, `reference:${ref.kind}`, ...hits.map((token) => `reference:${token}`)],
        anchor: ref.name,
        parser,
        kind: `reference:${ref.kind}`,
        text: ref.text,
        symbols: evidence.symbols || [],
      });
    }
  }

  const edgeBoosts = new Map();
  for (const edge of map.graph?.edges || []) {
    edgeBoosts.set(edge.from, (edgeBoosts.get(edge.from) || 0) + 3);
    edgeBoosts.set(edge.to, (edgeBoosts.get(edge.to) || 0) + 3);
  }
  for (const result of results) {
    if (edgeBoosts.has(result.path)) {
      result.score += edgeBoosts.get(result.path);
      result.reason = uniq([...result.reason, 'import-graph']).slice(0, 9);
    }
    const focus = focusByPath.get(result.path);
    if (focus?.snippetLocations?.length && !result.text) result.text = snippetText(focus.snippetLocations[0]);
  }

  return results
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, Math.max(1, Math.min(100, Number(maxResults) || DEFAULT_MAX_RESULTS)));
}
