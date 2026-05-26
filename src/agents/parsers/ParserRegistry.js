// Parser registry（P0-A）：按扩展名选择 parser adapter，未命中返回 null（调用方走 regex fallback）。
import { babelParserAdapter } from './BabelParserAdapter.js';

export class ParserRegistry {
  constructor(adapters = []) {
    this.adapters = [...adapters];
  }

  register(adapter) {
    if (adapter) this.adapters.push(adapter);
    return this;
  }

  getAdapter(ext) {
    const e = String(ext || '').toLowerCase();
    return this.adapters.find((a) => a.supports(e)) || null;
  }

  list() {
    return this.adapters.map((a) => ({ id: a.id, extensions: a.extensions }));
  }
}

export function createDefaultParserRegistry() {
  return new ParserRegistry([babelParserAdapter]);
}

export const defaultParserRegistry = createDefaultParserRegistry();
