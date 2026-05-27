// Parser adapter 接口约定（P0-A）：隔离具体 parser 实现，便于将来接 Tree-sitter 或新增语言，
// 而不改 CodeContextEvidence 的分发逻辑。
//
// adapter 形态（鸭子类型）：
//   {
//     id: string,                       // 唯一标识，如 'babel'
//     extensions: string[],             // 支持的小写扩展名，如 ['.ts', '.tsx']
//     priority: number,                 // 同扩展名多 adapter 时择优（高者胜，同分保持注册序）
//     supports(ext): boolean,           // 是否支持某扩展名
//     parse({ path, text }): evidence,  // 解析并返回本地证据（ok/diagnostics/symbols/imports/exports/anchors/references…）
//   }
// priority 让将来接入更强的 adapter（如 Tree-sitter）能覆盖既有 adapter 而无需改注册顺序。

export function createParserAdapter({ id, extensions = [], parse, priority = 0 }) {
  if (!id || typeof id !== 'string') throw new Error('parser adapter requires an id');
  if (typeof parse !== 'function') throw new Error(`parser adapter ${id} requires a parse(fn)`);
  const exts = new Set((extensions || []).map((e) => String(e || '').toLowerCase()).filter(Boolean));
  return {
    id,
    extensions: [...exts],
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
    supports(ext) { return exts.has(String(ext || '').toLowerCase()); },
    parse,
  };
}
