import * as acorn from 'acorn';
import { parse as parseBabel } from '@babel/parser';

const MAX_SYMBOLS = 40;
const MAX_IMPORTS = 40;
const MAX_EXPORTS = 40;
const MAX_ANCHORS = 40;
const MAX_SNIPPETS = 24;
const MAX_REFERENCES = 120;
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);
const TEST_CALLS = new Set(['describe', 'it', 'test']);

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function extensionOf(path = '') {
  const idx = String(path || '').lastIndexOf('.');
  return idx >= 0 ? String(path || '').slice(idx).toLowerCase() : '';
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
  if (node.type === 'StringLiteral') return safeString(node.value, 500);
  if (node.type === 'TemplateLiteral' && node.expressions?.length === 0) {
    return safeString(node.quasis?.[0]?.value?.cooked || node.quasis?.[0]?.value?.raw || '', 500);
  }
  return '';
}

function identifierName(node) {
  if (node?.type === 'Identifier' || node?.type === 'JSXIdentifier') return safeString(node.name, 120);
  return literalString(node);
}

function typeName(node) {
  if (!node) return '';
  if (node.type === 'Identifier' || node.type === 'JSXIdentifier') return safeString(node.name, 120);
  if (node.type === 'TSQualifiedName') {
    return [typeName(node.left), typeName(node.right)].filter(Boolean).join('.');
  }
  if (node.type === 'StringLiteral' || node.type === 'Literal') return literalString(node);
  return '';
}

function typeReferenceNames(node, out = [], seen = new Set()) {
  if (!node || typeof node.type !== 'string') return out;
  const add = (name) => {
    const safeName = safeString(name, 120);
    if (!safeName || seen.has(safeName)) return;
    seen.add(safeName);
    out.push(safeName);
  };
  if (node.type === 'Identifier' || node.type === 'JSXIdentifier' || node.type === 'TSQualifiedName') {
    add(typeName(node));
    return out;
  }
  if (node.type === 'TSTypeReference') {
    add(typeName(node.typeName));
    typeReferenceNames(node.typeParameters || node.typeArguments, out, seen);
    return out;
  }
  if (node.type === 'TSExpressionWithTypeArguments') {
    add(typeName(node.expression));
    typeReferenceNames(node.typeParameters || node.typeArguments, out, seen);
    return out;
  }
  if (node.type === 'TSTypeQuery') {
    add(typeName(node.exprName));
    return out;
  }
  for (const [childKey, value] of Object.entries(node)) {
    if (['type', 'start', 'end', 'loc', 'range', 'raw', 'extra', 'comments', 'tokens', 'errors'].includes(childKey)) continue;
    if (Array.isArray(value)) {
      for (const child of value) typeReferenceNames(child, out, seen);
      continue;
    }
    typeReferenceNames(value, out, seen);
  }
  return out;
}

function memberPropertyName(node) {
  if (!node || !['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) return '';
  if (!node.computed && node.property?.type === 'Identifier') return safeString(node.property.name, 80);
  return literalString(node.property);
}

function propertyKeyName(node) {
  if (!node) return '';
  if (node.type === 'PrivateName') return identifierName(node.id);
  return identifierName(node);
}

function ownerInfoForMethod(parent, ancestors = []) {
  const chain = [...(ancestors || []), parent].filter(Boolean).reverse();
  for (const item of chain) {
    if (item.type === 'ClassDeclaration' || item.type === 'ClassExpression') {
      return { owner: identifierName(item.id), ownerType: 'class' };
    }
    if (item.type === 'TSInterfaceDeclaration') {
      return { owner: identifierName(item.id), ownerType: 'interface' };
    }
    if (item.type === 'TSTypeAliasDeclaration') {
      return { owner: identifierName(item.id), ownerType: 'type' };
    }
    if (item.type === 'ObjectExpression') {
      return { owner: '', ownerType: 'object' };
    }
  }
  return { owner: '', ownerType: '' };
}

function hasExportParent(parent, ancestors = []) {
  if (parent?.type?.startsWith?.('Export')) return true;
  return ancestors.some((item) => item?.type?.startsWith?.('Export'));
}

function parserModeForPath(path = '') {
  const ext = extensionOf(path);
  if (['.ts', '.tsx', '.jsx'].includes(ext)) return 'babel';
  return 'acorn';
}

function babelPluginsForPath(path = '') {
  const ext = extensionOf(path);
  const plugins = [
    'decorators-legacy',
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'importAttributes',
    'topLevelAwait',
  ];
  if (['.ts', '.tsx'].includes(ext)) plugins.push('typescript');
  if (['.jsx', '.tsx'].includes(ext)) plugins.push('jsx');
  return plugins;
}

function parseWithBabel(path, text, fallbackError = null) {
  try {
    const ast = parseBabel(text, {
      sourceType: 'unambiguous',
      plugins: babelPluginsForPath(path),
      errorRecovery: false,
    });
    return {
      ok: true,
      ast,
      sourceType: ast.program?.sourceType || 'module',
      parser: 'babel',
      diagnostics: fallbackError ? [{
        code: 'acorn_parse_failed',
        message: safeString(fallbackError.message, 180),
        line: Math.max(1, Number(fallbackError.loc?.line) || 1),
        column: Math.max(0, Number(fallbackError.loc?.column) || 0),
      }] : [],
    };
  } catch (babelError) {
    return {
      ok: false,
      parser: 'regex',
      diagnostics: [{
        code: 'ast_parse_failed',
        message: safeString(babelError.message || fallbackError?.message, 180),
        line: Math.max(1, Number(babelError.loc?.line || fallbackError?.loc?.line) || 1),
        column: Math.max(0, Number(babelError.loc?.column || fallbackError?.loc?.column) || 0),
      }],
    };
  }
}

function parseSource(path, text) {
  if (parserModeForPath(path) === 'babel') return parseWithBabel(path, text);

  const options = {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
    allowHashBang: true,
  };
  try {
    return { ok: true, ast: acorn.parse(text, options), sourceType: 'module', parser: 'acorn', diagnostics: [] };
  } catch (moduleError) {
    try {
      return {
        ok: true,
        ast: acorn.parse(text, { ...options, sourceType: 'script' }),
        sourceType: 'script',
        parser: 'acorn',
        diagnostics: [{
          code: 'module_parse_failed',
          message: safeString(moduleError.message, 180),
          line: Math.max(1, Number(moduleError.loc?.line) || 1),
          column: Math.max(0, Number(moduleError.loc?.column) || 0),
        }],
      };
    } catch {
      const babel = parseWithBabel(path, text, moduleError);
      if (babel.ok) return babel;
      return {
        ok: false,
        parser: 'regex',
        diagnostics: [{
          code: 'ast_parse_failed',
          message: safeString(moduleError.message, 180),
          line: Math.max(1, Number(moduleError.loc?.line) || 1),
          column: Math.max(0, Number(moduleError.loc?.column) || 0),
        }],
      };
    }
  }
}

function walk(node, visitor, parent = null, key = '', ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  if (visitor(node, parent, key, ancestors) === false) return;
  const nextAncestors = ancestors.concat(node);
  for (const [childKey, value] of Object.entries(node)) {
    if (['type', 'start', 'end', 'loc', 'range', 'raw', 'extra', 'comments', 'tokens', 'errors'].includes(childKey)) continue;
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
  if (['Property', 'ObjectProperty'].includes(parent.type) && key === 'key' && !parent.computed) return true;
  if (['MethodDefinition', 'PropertyDefinition', 'ClassMethod', 'ClassProperty', 'ClassPrivateMethod', 'ClassPrivateProperty', 'ClassAccessorProperty'].includes(parent.type) && key === 'key' && !parent.computed) return true;
  if (['MemberExpression', 'OptionalMemberExpression'].includes(parent.type) && key === 'property' && !parent.computed) return true;
  if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') return true;
  if (parent.type === 'ExportSpecifier') return true;
  if (['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration'].includes(parent.type) && key === 'id') return true;
  if (parent.type.startsWith?.('TS')) return true;
  if (parent.type.startsWith?.('JSX')) return true;
  if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return true;
  if (parent.type === 'CatchClause' && key === 'param') return true;
  if (parent.type === 'RestElement' && key === 'argument') return true;
  if (parent.type === 'AssignmentPattern' && key === 'left') return true;
  if (isParameterIdentifier(node, parent)) return true;
  if (['CallExpression', 'NewExpression'].includes(parent.type) && key === 'callee') return true;
  return false;
}

function specifierImportedName(specifier) {
  if (!specifier) return '';
  if (specifier.type === 'ImportDefaultSpecifier') return 'default';
  if (specifier.type === 'ImportNamespaceSpecifier') return '*';
  return identifierName(specifier.imported);
}

function specifierExportedName(specifier) {
  if (!specifier) return '';
  return identifierName(specifier.exported);
}

function addImport(imports, lines, node, sourceName, specifiers = [], kind = 'import') {
  const source = safeString(sourceName, 160);
  if (!source) return;
  pushLimited(imports, {
    source,
    line: lineAt(lines, node).line,
    kind,
    specifiers: (specifiers || []).map((specifier) => ({
      imported: safeString(specifier.imported, 120),
      local: safeString(specifier.local, 120),
      kind: safeString(specifier.kind, 40) || 'named',
    })).filter((specifier) => specifier.imported || specifier.local).slice(0, 12),
  }, MAX_IMPORTS, (item) => `${item.kind}:${item.source}:${item.line}:${item.specifiers.map((specifier) => `${specifier.imported}:${specifier.local}`).join(',')}`);
}

function addExport(exports, lines, node, item) {
  const name = safeString(item?.name, 120);
  if (!name) return;
  pushLimited(exports, {
    name,
    local: safeString(item.local || name, 120),
    source: safeString(item.source, 160),
    kind: safeString(item.kind, 40) || 'named',
    line: lineAt(lines, node).line,
  }, MAX_EXPORTS, (entry) => `${entry.kind}:${entry.name}:${entry.local}:${entry.source}:${entry.line}`);
}

function declarationNames(declaration) {
  if (!declaration) return [];
  if (declaration.type === 'Identifier') return [identifierName(declaration)].filter(Boolean);
  if (['FunctionDeclaration', 'ClassDeclaration', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration'].includes(declaration.type)) {
    return [identifierName(declaration.id)].filter(Boolean);
  }
  if (declaration.type === 'VariableDeclaration') {
    return (declaration.declarations || []).map((item) => identifierName(item.id)).filter(Boolean);
  }
  return [];
}

function declarationExportKind(declaration) {
  if (!declaration) return 'named';
  if (declaration.type === 'TSInterfaceDeclaration') return 'interface';
  if (declaration.type === 'TSTypeAliasDeclaration') return 'type';
  if (declaration.type === 'TSEnumDeclaration') return 'enum';
  return 'named';
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

function addTypeReferences(references, lines, node, typeNode, kind = 'type-reference') {
  for (const name of typeReferenceNames(typeNode)) {
    addReference(references, lines, node, name, kind);
  }
}

function addDynamicImport(imports, references, snippets, lines, node, sourceNode) {
  const sourceName = literalString(sourceNode);
  if (!sourceName) return;
  addImport(imports, lines, node, sourceName, [{ imported: '*', local: 'import', kind: 'dynamic' }], 'dynamic-import');
  addReference(references, lines, node, sourceName, 'dynamic-import');
  addSnippet(snippets, lines, node, 'dynamic-import');
}

function addMethodSymbol(symbols, snippets, lines, node, parent, ancestors) {
  const name = propertyKeyName(node.key);
  if (!name || name === 'constructor') return;
  const ownerIsExported = hasExportParent(parent, ancestors);
  const owner = ownerInfoForMethod(parent, ancestors);
  pushLimited(symbols, {
    name,
    type: node.type.startsWith?.('TS') ? 'type-method' : 'method',
    line: lineAt(lines, node).line,
    exported: ownerIsExported,
    owner: owner.owner,
    ownerType: owner.ownerType,
  }, MAX_SYMBOLS, (item) => `${item.type}:${item.name}:${item.line}`);
  addSnippet(snippets, lines, node, 'symbol');
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
  const parsed = parseSource(path, source);
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
  const exports = [];
  const anchors = [];
  const snippets = [];
  const references = [];

  walk(parsed.ast, (node, parent, key, ancestors) => {
    if (['JSXIdentifier', 'JSXText', 'JSXClosingElement', 'JSXNamespacedName', 'JSXMemberExpression'].includes(node.type)) return false;

    if (node.type === 'ImportDeclaration') {
      const sourceName = literalString(node.source);
      if (sourceName) {
        const specifiers = (node.specifiers || []).map((specifier) => ({
          imported: specifierImportedName(specifier),
          local: identifierName(specifier.local),
          kind: specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.type === 'ImportNamespaceSpecifier' ? 'namespace' : safeString(specifier.importKind, 40) || 'named',
        }));
        addImport(imports, lines, node, sourceName, specifiers, safeString(node.importKind, 40) || 'import');
        addSnippet(snippets, lines, node, 'import');
      }
      for (const specifier of node.specifiers || []) {
        const kind = node.importKind === 'type' || specifier.importKind === 'type' ? 'type-import' : 'import';
        addReference(references, lines, specifier, identifierName(specifier.local), kind);
      }
      return;
    }

    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
      const sourceName = literalString(node.source);
      if (sourceName) {
        const specifiers = node.type === 'ExportNamedDeclaration'
          ? (node.specifiers || []).map((specifier) => ({
            imported: identifierName(specifier.local),
            local: specifierExportedName(specifier),
            kind: safeString(specifier.exportKind, 40) || 're-export',
          }))
          : [{ imported: '*', local: '*', kind: 're-export-all' }];
        addImport(imports, lines, node, sourceName, specifiers, node.type === 'ExportAllDeclaration' ? 're-export-all' : 're-export');
        addSnippet(snippets, lines, node, 'import');
      }
    }

    if (node.type === 'ExportNamedDeclaration') {
      for (const name of declarationNames(node.declaration)) {
        addExport(exports, lines, node, { name, local: name, kind: declarationExportKind(node.declaration) });
      }
      for (const specifier of node.specifiers || []) {
        const exported = specifierExportedName(specifier);
        const local = identifierName(specifier.local) || exported;
        addExport(exports, lines, node, {
          name: exported,
          local,
          source: literalString(node.source),
          kind: node.source ? 're-export' : 'named',
        });
      }
    }

    if (node.type === 'ExportAllDeclaration') {
      addExport(exports, lines, node, {
        name: specifierExportedName(node) || '*',
        local: '*',
        source: literalString(node.source),
        kind: 'all',
      });
    }

    if (node.type === 'ExportDefaultDeclaration') {
      const names = declarationNames(node.declaration);
      addExport(exports, lines, node, {
        name: 'default',
        local: names[0] || 'default',
        kind: 'default',
      });
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

    if (['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration'].includes(node.type) && node.id) {
      const type = node.type === 'TSInterfaceDeclaration'
        ? 'interface'
        : node.type === 'TSTypeAliasDeclaration'
          ? 'type'
          : node.type === 'TSEnumDeclaration'
            ? 'enum'
            : 'namespace';
      const name = identifierName(node.id);
      pushLimited(symbols, {
        name,
        type,
        line: lineAt(lines, node).line,
        exported: hasExportParent(parent, ancestors),
      }, MAX_SYMBOLS, (item) => `${item.type}:${item.name}`);
      if (node.type === 'TSInterfaceDeclaration') {
        for (const item of node.extends || []) addTypeReferences(references, lines, item, item, 'type-extends');
      }
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
      for (const item of node.implements || []) addTypeReferences(references, lines, item, item, 'type-implements');
      addSnippet(snippets, lines, node, 'symbol');
      return;
    }

    if (node.type === 'TSTypeReference') {
      addTypeReferences(references, lines, node, node, 'type-reference');
    }

    if (node.type === 'TSExpressionWithTypeArguments') {
      if (parent?.type === 'TSInterfaceDeclaration' && key === 'extends') {
        addTypeReferences(references, lines, node, node, 'type-extends');
      } else if (parent?.type === 'ClassDeclaration' && key === 'implements') {
        addTypeReferences(references, lines, node, node, 'type-implements');
      } else {
        addTypeReferences(references, lines, node, node, 'type-reference');
      }
    }

    if (node.type === 'TSTypeParameter' && node.constraint) {
      addTypeReferences(references, lines, node.constraint, node.constraint, 'type-constraint');
    }

    if (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion') {
      addTypeReferences(references, lines, node.typeAnnotation, node.typeAnnotation, 'type-assertion');
    }

    if (node.type === 'TSSatisfiesExpression') {
      addTypeReferences(references, lines, node.typeAnnotation, node.typeAnnotation, 'type-satisfies');
    }

    if (node.type === 'TSInstantiationExpression') {
      addTypeReferences(references, lines, node.typeParameters || node.typeArguments, node.typeParameters || node.typeArguments, 'type-instantiation');
    }

    if (node.type === 'ImportExpression') {
      addDynamicImport(imports, references, snippets, lines, node, node.source);
    }

    if (['MethodDefinition', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod', 'TSMethodSignature'].includes(node.type)) {
      addMethodSymbol(symbols, snippets, lines, node, parent, ancestors);
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
      addTypeReferences(references, lines, node, node.typeParameters || node.typeArguments, 'type-instantiation');

      if (node.type === 'CallExpression' && node.callee.type === 'Import') {
        addDynamicImport(imports, references, snippets, lines, node, node.arguments?.[0]);
      }

      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && directName === 'require') {
        const sourceName = literalString(node.arguments?.[0]);
        if (sourceName) {
          addImport(imports, lines, node, sourceName, [{ imported: '*', local: 'require', kind: 'commonjs' }], 'require');
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

      if (node.type === 'CallExpression' && ['MemberExpression', 'OptionalMemberExpression'].includes(node.callee.type)) {
        const rawMethod = memberPropertyName(node.callee);
        const method = rawMethod.toLowerCase();
        addReference(references, lines, node.callee, rawMethod, 'member-call');
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

    if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type) && !(parent?.type === 'CallExpression' && key === 'callee')) {
      addReference(references, lines, node, memberPropertyName(node), 'member-reference');
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
    parser: parsed.parser || 'acorn',
    sourceType: parsed.sourceType,
    path: safeString(path, 300),
    diagnostics: parsed.diagnostics || [],
    symbols,
    imports,
    exports,
    anchors,
    snippets,
    references,
  };
}
