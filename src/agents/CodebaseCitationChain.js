const MAX_EVIDENCE_ITEMS = 8;
const MAX_GRAPH_ITEMS = 8;

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function uniqBy(list, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function evidenceFileFor(map, path) {
  return (map?.evidence || []).find((file) => file.path === path) || null;
}

function nearLine(item, line, tolerance = 2) {
  const itemLine = Math.max(1, Number(item?.line) || 1);
  const targetLine = Math.max(1, Number(line) || 1);
  return Math.abs(itemLine - targetLine) <= tolerance;
}

function symbolEvidence(file, result) {
  const anchor = safeString(result.anchor, 160);
  return (file?.symbols || []).filter((symbol) => (
    symbol.name === anchor ||
    nearLine(symbol, result.line, 1) ||
    (result.symbols || []).some((item) => item.name === symbol.name)
  )).map((symbol) => ({
    kind: 'symbol',
    path: file.path,
    line: Math.max(1, Number(symbol.line) || 1),
    name: symbol.name,
    type: symbol.type,
    exported: !!symbol.exported,
  }));
}

function anchorEvidence(file, result) {
  const anchor = safeString(result.anchor, 180);
  return (file?.anchors || []).filter((item) => (
    item.name === anchor ||
    nearLine(item, result.line, 1) ||
    (result.routes || []).some((route) => route.name === item.name)
  )).map((item) => ({
    kind: item.kind || 'anchor',
    path: file.path,
    line: Math.max(1, Number(item.line) || 1),
    name: item.name,
  }));
}

function textEvidence(file, result) {
  return (file?.snippets || []).filter((item) => (
    nearLine(item, result.line, 1) ||
    (result.text && item.text && safeString(result.text, 120).includes(safeString(item.text, 80)))
  )).map((item) => ({
    kind: `snippet:${item.reason || 'evidence'}`,
    path: file.path,
    line: Math.max(1, Number(item.line) || 1),
    text: safeString(item.text, 220),
  }));
}

function importExportEvidence(file, result) {
  const anchor = safeString(result.anchor, 160);
  const imports = (file?.imports || []).filter((item) => (
    nearLine(item, result.line, 1) ||
    (item.specifiers || []).some((specifier) => specifier.local === anchor || specifier.imported === anchor)
  )).map((item) => ({
    kind: `import:${item.kind || 'import'}`,
    path: file.path,
    line: Math.max(1, Number(item.line) || 1),
    source: item.source,
    specifiers: (item.specifiers || []).slice(0, 6),
  }));
  const exports = (file?.exports || []).filter((item) => (
    nearLine(item, result.line, 1) ||
    item.name === anchor ||
    item.local === anchor
  )).map((item) => ({
    kind: `export:${item.kind || 'named'}`,
    path: file.path,
    line: Math.max(1, Number(item.line) || 1),
    name: item.name,
    local: item.local,
    source: item.source || '',
  }));
  return [...imports, ...exports];
}

function referenceEvidence(file, result) {
  const anchor = safeString(result.anchor, 160);
  return (file?.references || []).filter((item) => (
    nearLine(item, result.line, 1) ||
    item.name === anchor
  )).map((item) => ({
    kind: `reference:${item.kind || 'reference'}`,
    path: file.path,
    line: Math.max(1, Number(item.line) || 1),
    name: item.name,
    text: safeString(item.text, 220),
  }));
}

function graphEvidence(map, result) {
  const graph = map?.symbolGraph || {};
  const anchor = safeString(result.anchor, 160);
  const definitions = (graph.definitions || []).filter((item) => (
    item.path === result.path && (item.name === anchor || nearLine(item, result.line, 1))
  )).slice(0, MAX_GRAPH_ITEMS);
  const references = (graph.references || []).filter((item) => (
    item.fromPath === result.path ||
    item.toPath === result.path ||
    item.symbol === anchor
  )).slice(0, MAX_GRAPH_ITEMS);
  const routeUsages = (graph.routeUsages || []).filter((item) => (
    item.fromPath === result.path ||
    item.toPath === result.path ||
    item.route === anchor
  )).slice(0, MAX_GRAPH_ITEMS);
  const routeTestChains = (graph.routeTestChains || []).filter((item) => (
    item.routePath === result.path ||
    item.testPath === result.path ||
    item.route === anchor ||
    (item.path || []).some((step) => step.path === result.path || step.toPath === result.path)
  )).slice(0, MAX_GRAPH_ITEMS);
  const unresolvedReferences = (graph.unresolvedReferences || []).filter((item) => (
    item.fromPath === result.path ||
    item.name === anchor
  )).slice(0, MAX_GRAPH_ITEMS);
  return { definitions, references, routeUsages, routeTestChains, unresolvedReferences };
}

function citationPathsFromGraph(graph = {}) {
  return (graph.routeTestChains || []).map((chain) => ({
    kind: 'route-to-test',
    label: `${chain.route} -> ${chain.testPath}:${chain.testLine}`,
    route: chain.route,
    steps: (chain.path || []).map((step) => ({
      kind: step.kind,
      path: step.path,
      line: step.line,
      label: step.label,
      toPath: step.toPath || '',
    })),
  })).slice(0, MAX_GRAPH_ITEMS);
}

export function buildCodebaseCitation(map = {}, result = {}) {
  const file = evidenceFileFor(map, result.path);
  const evidence = file ? uniqBy([
    ...symbolEvidence(file, result),
    ...anchorEvidence(file, result),
    ...textEvidence(file, result),
    ...importExportEvidence(file, result),
    ...referenceEvidence(file, result),
  ], (item) => `${item.kind}:${item.path}:${item.line}:${item.name || item.source || item.text || ''}`).slice(0, MAX_EVIDENCE_ITEMS) : [];
  const graph = graphEvidence(map, result);
  const paths = citationPathsFromGraph(graph);
  return {
    id: `${safeString(result.path, 300)}:${Math.max(1, Number(result.line) || 1)}:${safeString(result.kind, 80)}`,
    path: safeString(result.path, 300),
    line: Math.max(1, Number(result.line) || 1),
    kind: safeString(result.kind, 80) || 'file',
    anchor: result.anchor || null,
    parser: result.parser || file?.parser || 'unknown',
    reason: Array.isArray(result.reason) ? result.reason.slice(0, 9) : [],
    evidence,
    graph,
    paths,
  };
}

export function attachCodebaseCitations(map = {}, results = []) {
  return (results || []).map((result) => ({
    ...result,
    citation: buildCodebaseCitation(map, result),
  }));
}

export function summarizeCodebaseCitations(results = []) {
  const citations = (results || []).map((item) => item.citation).filter(Boolean);
  return {
    enabled: true,
    chainCount: citations.length,
    evidenceItemCount: citations.reduce((sum, item) => sum + (item.evidence || []).length, 0),
    graphReferenceCount: citations.reduce((sum, item) => sum + (item.graph?.references || []).length, 0),
    typeImplementationCount: citations.reduce((sum, item) => (
      sum + (item.graph?.references || []).filter((ref) => ref.kind === 'type-implementation').length
    ), 0),
    routeUsageCount: citations.reduce((sum, item) => sum + (item.graph?.routeUsages || []).length, 0),
    routeToTestChainCount: citations.reduce((sum, item) => sum + (item.graph?.routeTestChains || []).length, 0),
    unresolvedReferenceCount: citations.reduce((sum, item) => sum + (item.graph?.unresolvedReferences || []).length, 0),
    citationPathCount: citations.reduce((sum, item) => sum + (item.paths || []).length, 0),
  };
}
