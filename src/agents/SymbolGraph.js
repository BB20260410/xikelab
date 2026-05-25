import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const MAX_SYMBOLS = 80;
const MAX_REFERENCES = 240;
const MAX_ROUTE_USAGES = 80;
const MIN_SYMBOL_LEN = 3;
const COMMON_SYMBOLS = new Set([
  'app',
  'ctx',
  'err',
  'req',
  'res',
  'row',
  'set',
  'get',
  'map',
  'out',
]);

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRel(path = '') {
  return safeString(path, 300).replace(/\\/g, '/').replace(/^\/+/, '');
}

function withinRoot(root, abs) {
  const rel = relative(root, abs);
  return rel && !rel.startsWith('..') && !rel.includes('\0') && !rel.startsWith('/');
}

function readProjectFile(cwd, path, fsApi = {}) {
  const rel = normalizeRel(path);
  if (!cwd || !rel) return '';
  const root = resolve(cwd);
  const abs = resolve(root, rel);
  if (!withinRoot(root, abs)) return '';
  try {
    const read = fsApi.readFileSync || readFileSync;
    return read(abs, 'utf8');
  } catch {
    return '';
  }
}

function cleanLine(line = '') {
  return line.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function normalizeDefinition(file, symbol) {
  const name = safeString(symbol?.name, 120);
  if (!name || name.length < MIN_SYMBOL_LEN || COMMON_SYMBOLS.has(name.toLowerCase())) return null;
  return {
    id: `${file.path}:${name}:${Number(symbol.line) || 1}`,
    name,
    type: safeString(symbol.type, 40) || 'symbol',
    path: file.path,
    line: Math.max(1, Number(symbol.line) || 1),
    exported: !!symbol.exported,
  };
}

function collectDefinitions(evidence = []) {
  const definitions = [];
  const seen = new Set();
  for (const file of evidence || []) {
    for (const symbol of file.symbols || []) {
      const def = normalizeDefinition(file, symbol);
      if (!def || seen.has(def.id)) continue;
      seen.add(def.id);
      definitions.push(def);
      if (definitions.length >= MAX_SYMBOLS) return definitions;
    }
  }
  return definitions;
}

function findReferencesForDefinition(definition, file, text) {
  if (!definition?.name || !file?.path || !text) return [];
  const re = new RegExp(`\\b${escapeRegExp(definition.name)}\\b\\s*(\\()?`, 'g');
  const lines = String(text || '').split(/\r?\n/);
  const refs = [];
  lines.forEach((line, idx) => {
    let match = re.exec(line);
    while (match) {
      const lineNumber = idx + 1;
      const isDefinitionLine = definition.path === file.path && definition.line === lineNumber;
      if (!isDefinitionLine) {
        refs.push({
          symbolId: definition.id,
          symbol: definition.name,
          fromPath: file.path,
          toPath: definition.path,
          line: lineNumber,
          kind: match[1] ? 'call' : 'reference',
          text: cleanLine(line),
        });
      }
      match = re.exec(line);
    }
  });
  return refs;
}

function normalizeReferenceKind(kind = '') {
  const value = safeString(kind, 40);
  return value === 'call' ? 'call' : 'reference';
}

function resolveImportTarget(fromPath, source, availablePaths) {
  if (!source || !source.startsWith('.')) return null;
  const base = normalizeRel(join(dirname(fromPath), source));
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.jsx`,
    `${base}/index.js`,
    `${base}/index.ts`,
  ].map(normalizeRel);
  return candidates.find((candidate) => availablePaths.has(candidate)) || null;
}

function importedTargetsForFile(file, availablePaths) {
  const targets = new Set();
  for (const item of file?.imports || []) {
    const target = resolveImportTarget(file.path, item.source, availablePaths);
    if (target) targets.add(target);
  }
  return targets;
}

function definitionsForReference(name, file, definitionsByName, availablePaths) {
  const matching = definitionsByName.get(name) || [];
  if (matching.length <= 1) return matching;
  const local = matching.filter((definition) => definition.path === file.path);
  if (local.length) return local;
  const importedTargets = importedTargetsForFile(file, availablePaths);
  const imported = matching.filter((definition) => importedTargets.has(definition.path));
  if (imported.length) return imported;
  return [];
}

function collectEvidenceReferences(definitionsByName, availablePaths, file) {
  const refs = [];
  const astRefs = Array.isArray(file?.references) ? file.references : [];
  if (!astRefs.length) return refs;
  for (const item of astRefs) {
    const name = safeString(item.name || item.symbol, 120);
    if (!name) continue;
    for (const definition of definitionsForReference(name, file, definitionsByName, availablePaths)) {
      const lineNumber = Math.max(1, Number(item.line) || 1);
      const isDefinitionLine = definition.path === file.path && definition.line === lineNumber;
      if (isDefinitionLine) continue;
      refs.push({
        symbolId: definition.id,
        symbol: definition.name,
        fromPath: file.path,
        toPath: definition.path,
        line: lineNumber,
        kind: normalizeReferenceKind(item.kind),
        text: safeString(item.text, 240),
      });
    }
  }
  return refs;
}

function pushUniqueReferences(target, refs, seen, limit) {
  for (const ref of refs) {
    if (target.length >= limit) break;
    const key = `${ref.symbolId}:${ref.fromPath}:${ref.line}:${ref.kind}:${ref.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(ref);
  }
}

function routePathFromAnchor(anchor = {}) {
  const name = safeString(anchor.name, 200);
  const match = name.match(/(?:GET|POST|PUT|DELETE|PATCH)\s+(\/api\/\S+)/i) || name.match(/(\/api\/[^\s]+)/);
  return match ? match[1].replace(/[)"'`;]+$/g, '') : '';
}

function collectRoutes(evidence = []) {
  const routes = [];
  const seen = new Set();
  for (const file of evidence || []) {
    for (const anchor of file.anchors || []) {
      const route = routePathFromAnchor(anchor);
      if (!route) continue;
      const id = `${file.path}:${route}:${Number(anchor.line) || 1}`;
      if (seen.has(id)) continue;
      seen.add(id);
      routes.push({
        id,
        route,
        path: file.path,
        line: Math.max(1, Number(anchor.line) || 1),
        kind: safeString(anchor.kind, 40) || 'api',
      });
    }
  }
  return routes;
}

function findRouteUsages(routes, file, text) {
  if (!routes.length || !text) return [];
  const lines = String(text || '').split(/\r?\n/);
  const usages = [];
  for (const route of routes) {
    lines.forEach((line, idx) => {
      if (!line.includes(route.route)) return;
      const lineNumber = idx + 1;
      const isDefinitionLine = route.path === file.path && route.line === lineNumber;
      if (isDefinitionLine) return;
      usages.push({
        routeId: route.id,
        route: route.route,
        fromPath: file.path,
        toPath: route.path,
        line: lineNumber,
        text: cleanLine(line),
      });
    });
  }
  return usages;
}

export function normalizeSymbolGraph(input = {}) {
  const graph = input && typeof input === 'object'
    ? (input.symbolGraph || input.codeContextGraph || input.graph || input)
    : {};
  const definitions = Array.isArray(graph.definitions) ? graph.definitions.map((item) => ({
    id: safeString(item.id, 260),
    name: safeString(item.name, 120),
    type: safeString(item.type, 40) || 'symbol',
    path: normalizeRel(item.path),
    line: Math.max(1, Number(item.line) || 1),
    exported: !!item.exported,
    referenceCount: Math.max(0, Number(item.referenceCount) || 0),
    callCount: Math.max(0, Number(item.callCount) || 0),
  })).filter((item) => item.id && item.name && item.path).slice(0, MAX_SYMBOLS) : [];
  const references = Array.isArray(graph.references) ? graph.references.map((item) => ({
    symbolId: safeString(item.symbolId, 260),
    symbol: safeString(item.symbol, 120),
    fromPath: normalizeRel(item.fromPath),
    toPath: normalizeRel(item.toPath),
    line: Math.max(1, Number(item.line) || 1),
    kind: safeString(item.kind, 40) || 'reference',
    text: safeString(item.text, 240),
  })).filter((item) => item.symbolId && item.fromPath && item.toPath).slice(0, MAX_REFERENCES) : [];
  const routes = Array.isArray(graph.routes) ? graph.routes.map((item) => ({
    id: safeString(item.id, 260),
    route: safeString(item.route, 160),
    path: normalizeRel(item.path),
    line: Math.max(1, Number(item.line) || 1),
    kind: safeString(item.kind, 40) || 'api',
    usageCount: Math.max(0, Number(item.usageCount) || 0),
  })).filter((item) => item.id && item.route && item.path).slice(0, MAX_SYMBOLS) : [];
  const routeUsages = Array.isArray(graph.routeUsages) ? graph.routeUsages.map((item) => ({
    routeId: safeString(item.routeId, 260),
    route: safeString(item.route, 160),
    fromPath: normalizeRel(item.fromPath),
    toPath: normalizeRel(item.toPath),
    line: Math.max(1, Number(item.line) || 1),
    text: safeString(item.text, 240),
  })).filter((item) => item.routeId && item.fromPath && item.toPath).slice(0, MAX_ROUTE_USAGES) : [];
  return {
    definitionCount: Math.max(definitions.length, Number(graph.definitionCount) || 0),
    referenceCount: Math.max(references.length, Number(graph.referenceCount) || 0),
    callCount: Math.max(references.filter((item) => item.kind === 'call').length, Number(graph.callCount) || 0),
    routeCount: Math.max(routes.length, Number(graph.routeCount) || 0),
    routeUsageCount: Math.max(routeUsages.length, Number(graph.routeUsageCount) || 0),
    definitions,
    references,
    routes,
    routeUsages,
  };
}

export function summarizeSymbolGraph(input = {}) {
  const graph = normalizeSymbolGraph(input);
  return {
    definitionCount: graph.definitionCount,
    referenceCount: graph.referenceCount,
    callCount: graph.callCount,
    routeCount: graph.routeCount,
    routeUsageCount: graph.routeUsageCount,
    topDefinitions: [...graph.definitions]
      .sort((a, b) => (b.referenceCount + b.callCount) - (a.referenceCount + a.callCount) || a.name.localeCompare(b.name))
      .slice(0, 10),
    topReferences: graph.references.slice(0, 12),
    topRoutes: [...graph.routes].sort((a, b) => b.usageCount - a.usageCount || a.route.localeCompare(b.route)).slice(0, 10),
    topRouteUsages: graph.routeUsages.slice(0, 12),
  };
}

export function buildSymbolGraph({ cwd, evidence = [], fsApi = {} } = {}) {
  const files = Array.isArray(evidence) ? evidence : [];
  const definitions = collectDefinitions(files);
  const definitionsByName = new Map();
  for (const definition of definitions) {
    const bucket = definitionsByName.get(definition.name) || [];
    bucket.push(definition);
    definitionsByName.set(definition.name, bucket);
  }
  const availablePaths = new Set(files.map((file) => file.path));
  const routes = collectRoutes(files);
  const references = [];
  const routeUsages = [];
  const textByPath = new Map();
  const seenReferences = new Set();

  for (const file of files) {
    const text = readProjectFile(cwd, file.path, fsApi);
    textByPath.set(file.path, text);
  }

  for (const file of files) {
    const text = textByPath.get(file.path) || '';
    if (file.parser === 'acorn') {
      pushUniqueReferences(
        references,
        collectEvidenceReferences(definitionsByName, availablePaths, file),
        seenReferences,
        MAX_REFERENCES,
      );
    } else {
      for (const definition of definitions) {
        if (references.length >= MAX_REFERENCES) break;
        pushUniqueReferences(
          references,
          findReferencesForDefinition(definition, file, text),
          seenReferences,
          MAX_REFERENCES,
        );
      }
    }
    if (routeUsages.length < MAX_ROUTE_USAGES) {
      routeUsages.push(...findRouteUsages(routes, file, text).slice(0, MAX_ROUTE_USAGES - routeUsages.length));
    }
  }

  const referenceCountBySymbol = new Map();
  const callCountBySymbol = new Map();
  for (const ref of references) {
    referenceCountBySymbol.set(ref.symbolId, (referenceCountBySymbol.get(ref.symbolId) || 0) + 1);
    if (ref.kind === 'call') callCountBySymbol.set(ref.symbolId, (callCountBySymbol.get(ref.symbolId) || 0) + 1);
  }
  const usageCountByRoute = new Map();
  for (const usage of routeUsages) {
    usageCountByRoute.set(usage.routeId, (usageCountByRoute.get(usage.routeId) || 0) + 1);
  }

  return normalizeSymbolGraph({
    definitions: definitions.map((definition) => ({
      ...definition,
      referenceCount: referenceCountBySymbol.get(definition.id) || 0,
      callCount: callCountBySymbol.get(definition.id) || 0,
    })),
    references,
    routes: routes.map((route) => ({
      ...route,
      usageCount: usageCountByRoute.get(route.id) || 0,
    })),
    routeUsages,
  });
}
