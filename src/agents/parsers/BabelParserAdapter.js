// Babel parser adapter（P0-A）：用 @babel/parser 解析 JS/TS/TSX/JSX，
// 产出本地 symbols/imports/exports/anchors/references/type-*/member-* 证据。
// 当前是默认（也是唯一）的 AST adapter；接 Tree-sitter 时新增同接口 adapter 即可，无需改分发方。
import { analyzeJavaScriptAst } from '../JavaScriptAstAnalyzer.js';
import { createParserAdapter } from './ParserAdapter.js';

export const babelParserAdapter = createParserAdapter({
  id: 'babel',
  extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'],
  parse: ({ path, text }) => analyzeJavaScriptAst({ path, text }),
});
