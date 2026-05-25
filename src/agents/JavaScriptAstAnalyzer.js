import * as acorn from 'acorn';

const MAX_SYMBOLS = 40;
const MAX_IMPORTS = 40;
const MAX_ANCHORS = 40;
const MAX_SNIPPETS = 24;
const MAX_REFERENCES = 120;
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);
const TEST_CALLS = new Set(['describe', 'it', 'test']);

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function cleanSnippet(line = '') {
  return line.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function pushLimited(list, item, limit, keyFn = null) {
  if (!item || list.length >= limit) return;
  if (keyFn) {
    const key = keyFn(item);
    if (key && list.some((existing) => keyFn(existing) === key)) return;
  }
  list.push(item);
}

function lineAt(lines, node) {
  const lineNumber = Math.max(1, Number(node?.loc?.start?.line) || 1);
  return {
    line: lineNumber,
    text: cleanSnippet(lines[lineNumber - 1] || ''),
  };
}

function literalString(node) {
  if (!node) return '';
  if (node.type === 'Literal' && typeof node.value === 'string') return safeString(node.value, 500);
  if (node.type === 'TemplateLiteral' && node.expressions?.length === 0) {
    return safeString(node.quasis?.[0]?.value?.cooked || node.quasis?.[0]?.value?.raw || '', 500);
  }
  return '';
}

function identifierName(node) {
  return node?.type === 'Identifier' ? safeString(node.name, 120) : '';
}

function memberPropertyName(node) {
  if (!node || node.type !== 'MemberExpression') return '';
  if (!node.computed && node.property?.type === 'Identifier') return safeString(node.property.name, 80);
  return literalString(node.property);
}

function hasExportParent(parent, ancestors = []) {
  if (parent?.type?.startsWith?.('Export')) return true;
  return ancestors.some((item) => item?.type?.startsWith?.('Export'));
}

function parseSource(text) {
  const options = {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
    allowHashBang: true,
  };
  try {
    return { ok: true, ast: acorn.parse(text, options), sourceType: 'module' };
  } catch (moduleError) {
    try {
      return {
        ok: true,
        ast: acorn.parse(text, { ...options, sourceType: 'script' }),
        sourceType: 'script',
        diagnostics: [{
          code: 'module_parse_failed',
          message: safeString(moduleError.message, 180),
          line: Math.max(1, Number(moduleError.loc?.line) || 1),
          column: Math.max(0, Number(moduleError.loc?.column) || 0),
        }],
      };
    } catch (scriptError) {
      return {
        ok: false,
        diagnostics: [{
          code: 'ast_parse_failed',
          message: safeString(scriptError.message || moduleError.message, 180),
          line: Math.max(1, Number(scriptError.loc?.line || moduleError.loc?.line) || 1),
          column: Math.max(0, Number(scriptError.loc?.column || moduleError.loc?.column) || 0),
        }],
      };
    }
  }
}

function walk(node, visitor, parent = null, key = '', ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  visitor(node, parent, key, ancestors);
  const nextAncestors = ancestors.concat(node);
  for (const [childKey, value] of Object.entries(node)) {
    if (['type', 'start', 'end', 'loc', 'range', 'raw', 'value'].includes(childKey)) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') walk(child, visitor, node, childKey, nextAncestors);
      }
      continue;
    }
    if (value && typeof value.type === 'string') walk(value, visitor, node, childKey, nextAncestors);
  }
}

function isParameterIdentifier(node, parent) {
  if (!Array.isArray(parent?.params)) return false;
  return parent.params.includes(node);
}

function isDeclarationIdentifier(node, parent, key) {
  if (!parent) return false;
  if (['FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(parent.type) && key === 'id') return true;
  if (parent.type === 'VariableDeclarator' && key === 'id') return true;
  if (parent.type === 'Property' && key === 'key' && !parent.computed) return true;
  if (['MethodDefinition', 'PropertyDefinition'].includes(parent.type) && key === 'key' && !parent.computed) return true;
  if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return true;
  if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') return true;
  if (parent.type === 'ExportSpecifier') return true;
  if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return true;
  if (parent.type === 'CatchClause' && key === 'param') return true;
  if (parent.type === 'RestElement' && key === 'argument') return true;
  if (parent.type === 'AssignmentPattern' && key === 'left') return true;
  if (isParameterIdentifier(node, parent)) return true;
  if (['CallExpression', 'NewExpression'].includes(parent.type) && key === 'callee') return true;
  return false;
}

function addSnippet(snippets, lines, node, reason) {
  const { line, text } = lineAt(lines, node);
  if (!text || text.length < 4) return;
  pushLimited(snippets, { line, reason, text }, MAX_SNIPPETS, (item) => `${item.line}:${item.reason}`);
}

function addReference(references, lines, node, name, kind = 'reference') {
  const safeName = safeString(name, 120);
  if (!safeName) return;
  const { line, text } = lineAt(lines, node);
  pushLimited(references, {
    name: safeName,
    kind,
    line,
    text,
  }, MAX_REFERENCES, (item) => `${item.name}:${item.kind}:${item.line}:${item.text}`);
}

function addApiAnchor(anchors, lines, node, value) {
  const route = safeString(value, 180);
  if (!route.startsWith('/api/')) return;
  pushLimited(anchors, {
    kind: 'api',
    name: route,
    line: lineAt(lines, node).line,
  }, MAX_ANCHORS, (item) => `${item.kind}:${item.name}:${item.line}`);
}

export function analyzeJavaScriptAst({ path = '', text = '' } = {}) {
  const source = String(text || '');
  const parsed = parseSource(source);
  if (!parsed.ok) {
    return {
      ok: false,
      parser: 'regex',
      sourceType: '',
      path: safeString(path, 300),
      diagnostics: parsed.diagnostics || [],
      symbols: [],
      imports: [],
      anchors: [],
      snippets: [],
      references: [],
    };
  }

  const lines = source.split(/\r?\n/);
  const symbols = [];
  const imports = [];
  const anchors = [];
  const snippets = [];
  const references = [];

  walk(parsed.ast, (node, parent, key, ancestors) => {
    if (node.type === 'ImportDeclaration') {
      const sourceName = literalString(node.source);
      if (sourceName) {
        pushLimited(imports, { source: sourceName, line: lineAt(lines, node).line }, MAX_IMPORTS, (item) => item.source);
        addSnippet(snippets, lines, node, 'import');
      }
      for (const specifier of node.specifiers || []) {
        addReference(references, lines, specifier, identifierName(specifier.local), 'import');
      }
      return;
    }

    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
      const sourceName = literalString(node.source);
      if (sourceName) {
        pushLimited(imports, { source: sourceName, line: lineAt(lines, node).line }, MAX_IMPORTS, (item) => item.source);
        addSnippet(snippets, lines, node, 'import');
      }
    }

    if (node.type === 'FunctionDeclaration' && node.id) {
      pushLimited(symbols, {
        name: identifierName(node.id),
        type: 'function',
        line: lineAt(lines, node).line,
        exported: hasExportParent(parent, ancestors),
      }, MAX_SYMBOLS, (item) => `${item.type}:${item.name}`);
      addSnippet(snippets, lines, node, 'symbol');
      return;
    }

    if (node.type === 'ClassDeclaration' && node.id) {
      pushLimited(symbols, {
        name: identifierName(node.id),
        type: 'class',
        line: lineAt(lines, node).line,
        exported: hasExportParent(parent, ancestors),
      }, MAX_SYMBOLS, (item) => `${item.type}:${item.name}`);
      addSnippet(snippets, lines, node, 'symbol');
      return;
    }

    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
      const declaration = parent?.type === 'VariableDeclaration' ? parent : null;
      pushLimited(symbols, {
        name: identifierName(node.id),
        type: safeString(declaration?.kind, 40) || 'const',
        line: lineAt(lines, node).line,
        exported: hasExportParent(declaration, ancestors),
      }, MAX_SYMBOLS, (item) => `${item.type}:${item.name}`);
      addSnippet(snippets, lines, node, 'symbol');
    }

    if ((node.type === 'CallExpression' || node.type === 'NewExpression') && node.callee) {
      const directName = node.callee.type === 'Identifier' ? identifierName(node.callee) : '';
      if (directName) addReference(references, lines, node, directName, 'call');

      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && directName === 'require') {
        const sourceName = literalString(node.arguments?.[0]);
        if (sourceName) {
          pushLimited(imports, { source: sourceName, line: lineAt(lines, node).line }, MAX_IMPORTS, (item) => item.source);
          addSnippet(snippets, lines, node, 'import');
        }
      }

      if (node.type === 'CallExpression' && TEST_CALLS.has(directName)) {
        const name = literalString(node.arguments?.[0]);
        if (name) {
          pushLimited(anchors, { kind: directName, name: name.slice(0, 120), line: lineAt(lines, node).line }, MAX_ANCHORS, (item) => `${item.kind}:${item.name}`);
          addSnippet(snippets, lines, node, 'test');
        }
      }

      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const method = memberPropertyName(node.callee).toLowerCase();
        const route = literalString(node.arguments?.[0]);
        if (ROUTE_METHODS.has(method) && route) {
          pushLimited(anchors, {
            kind: 'route',
            name: `${method.toUpperCase()} ${route}`,
            line: lineAt(lines, node).line,
          }, MAX_ANCHORS, (item) => `${item.kind}:${item.name}`);
          addSnippet(snippets, lines, node, 'route');
        }
      }
    }

    if (node.type === 'Literal' || node.type === 'TemplateLiteral') {
      addApiAnchor(anchors, lines, node, literalString(node));
    }

    if (node.type === 'Identifier' && !isDeclarationIdentifier(node, parent, key)) {
      addReference(references, lines, node, node.name, 'reference');
    }
  });

  return {
    ok: true,
    parser: 'acorn',
    sourceType: parsed.sourceType,
    path: safeString(path, 300),
    diagnostics: parsed.diagnostics || [],
    symbols,
    imports,
    anchors,
    snippets,
    references,
  };
}
